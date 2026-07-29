"""Live-backend slot pool: the single admission point for WS-D.

``ContainerPool.acquire(tenant_id, sid) -> BackendRuntime`` encapsulates the
four-stage admission sequence (interactive-session resource-limits, spec
session-pool-scheduling):

1. per-tenant concurrent quota  -> :class:`TenantQuotaExceeded` (HTTP 429)
2. node capacity (< ``max_live_sessions``) -> immediate admission
3. eviction of the longest-idle IDLE session (via the supervisor-provided
   ``evict_one`` hook) to free a slot
4. bounded FIFO wait queue (``OH_POOL_QUEUE_SIZE`` / ``OH_POOL_QUEUE_TIMEOUT``);
   queue-full / timeout -> 503 + ``Retry-After``; queue size 0 degrades to the
   previous fail-fast behaviour (:class:`CapacityFullError` -> plain 503).

``release(sid)`` frees the slot and hands it *directly* to the queue head
(explicit hand-off: strict FIFO, no thundering herd). Concurrency note: every
check-and-claim critical section below is a plain synchronous block with no
``await`` inside, which makes it atomic on the (single-threaded) event loop —
no lock is needed, and the eviction hook (which tears a backend down and calls
``release`` re-entrantly) runs safely *outside* those sections.

The pool is the single substitution point for a future warm-pool (Variant A)
implementation: admission, lifecycle and protocol layers only ever see
``acquire``/``release``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from app.config import settings
from app.observability.metrics import (
    POOL_BACKENDS_LIVE,
    POOL_EVICTIONS,
    POOL_QUEUE_DEPTH,
    POOL_QUEUE_WAIT,
    POOL_REJECTED,
)
from app.session.runtime import BackendRuntime, make_backend

log = logging.getLogger(__name__)

# At-capacity admission attempts one eviction per loop iteration; a freed slot
# may be handed to the queue head instead of us, so retry a bounded number of
# times before falling through to the queue.
_EVICT_ATTEMPTS = 3


class CapacityFullError(Exception):
    """Node live-session capacity exhausted; no idle session to evict -> HTTP 503.

    Raised only when the wait queue is disabled (``pool_queue_size=0``),
    preserving the pre-pool fail-fast behaviour. Re-exported by
    ``app.session.supervisor`` for backward-compatible imports.
    """


class PoolAdmissionError(Exception):
    """Base for structured admission rejections (reason + optional Retry-After)."""

    reason: str = "queue_full"

    def __init__(self, message: str, *, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class TenantQuotaExceeded(PoolAdmissionError):
    """Tenant already holds ``tenant_max_concurrent`` live or queued slots -> 429."""

    reason = "tenant_quota"


class QueueFullError(PoolAdmissionError):
    """The bounded FIFO queue is at ``pool_queue_size`` -> 503 + Retry-After."""

    reason = "queue_full"


class QueueTimeoutError(PoolAdmissionError):
    """Waited ``pool_queue_timeout`` without a freed slot -> 503 + Retry-After."""

    reason = "queue_timeout"


@dataclass(eq=False)  # identity comparison: deque.remove must drop *this* waiter
class _Waiter:
    tenant_id: str
    sid: str
    future: asyncio.Future[None]


class ContainerPool:
    """Slot accounting + admission for live backends (process or container)."""

    def __init__(
        self, *, evict_one: Callable[[], Awaitable[bool]] | None = None
    ) -> None:
        # sid -> tenant_id for every held slot. After WS-D wiring, one entry
        # per live backend; every teardown path must release().
        self._slots: dict[str, str] = {}
        self._queue: deque[_Waiter] = deque()
        # Supervisor hook: evict the longest-idle IDLE session to COLD and
        # release its slot; returns True when a session was evicted.
        self._evict_one = evict_one

    # --- introspection --------------------------------------------------

    def live_count(self) -> int:
        return len(self._slots)

    def queue_depth(self) -> int:
        return len(self._queue)

    def holds(self, sid: Any) -> bool:
        return str(sid) in self._slots

    def reset(self) -> None:
        """Drop all slot/queue state (test isolation helper)."""
        self._slots.clear()
        for w in self._queue:
            if not w.future.done():
                w.future.cancel()
        self._queue.clear()

    def tenant_slot_count(self, tenant_id: str) -> int:
        return sum(1 for t in self._slots.values() if t == tenant_id)

    def _tenant_queue_count(self, tenant_id: str) -> int:
        return sum(
            1
            for w in self._queue
            if w.tenant_id == tenant_id and not w.future.cancelled()
        )

    # --- acquire / release ------------------------------------------------

    async def acquire(
        self, tenant_id: str, sid: Any, **backend_kwargs: Any
    ) -> BackendRuntime:
        """Admit ``sid`` to a live slot and return its (unstarted) backend.

        ``backend_kwargs`` are forwarded to the runtime factory
        (``cwd``/``permission_mode``/``oh_session_id``/``extra_args``/
        ``env_overrides``). Raises :class:`TenantQuotaExceeded`,
        :class:`QueueFullError`, :class:`QueueTimeoutError` or (queue
        disabled) :class:`CapacityFullError`.
        """
        sid = str(sid)
        # Stages 1-3: claim, or evict-then-claim. Each _try_claim call is one
        # atomic critical section; the eviction await sits between them.
        for _ in range(_EVICT_ATTEMPTS):
            if self._try_claim(tenant_id, sid):
                return self._build(tenant_id, sid, backend_kwargs)
            if self._evict_one is None:
                break
            if not await self._evict_one():
                break  # nothing evictable -> fall through to the queue
            POOL_EVICTIONS.inc()
        else:
            # Attempts exhausted (freed slots kept going to the queue head).
            pass

        # Stage 4: bounded FIFO wait queue.
        if settings.pool_queue_size <= 0:
            # Degraded mode: identical to the pre-pool fail-fast 503.
            POOL_REJECTED.labels(reason="queue_full").inc()
            raise CapacityFullError("capacity full and no idle session to evict")
        if len(self._queue) >= settings.pool_queue_size:
            POOL_REJECTED.labels(reason="queue_full").inc()
            raise QueueFullError(
                "admission queue is full",
                retry_after=max(1, int(settings.pool_queue_timeout)),
            )
        if self._tenant_queue_count(tenant_id) >= settings.tenant_max_concurrent:
            # One tenant cannot flood the queue: reject instead of enqueueing.
            POOL_REJECTED.labels(reason="tenant_quota").inc()
            raise TenantQuotaExceeded("Concurrent session quota exceeded")

        waiter = _Waiter(
            tenant_id=tenant_id,
            sid=sid,
            future=asyncio.get_running_loop().create_future(),
        )
        self._queue.append(waiter)
        POOL_QUEUE_DEPTH.inc()
        start = time.monotonic()
        try:
            await asyncio.wait_for(waiter.future, timeout=settings.pool_queue_timeout)
        except asyncio.TimeoutError:
            # wait_for guarantees the future was cancelled (never granted):
            # _grant_from_queue skips cancelled waiters.
            self._drop_waiter(waiter)
            POOL_QUEUE_WAIT.observe(time.monotonic() - start)
            POOL_REJECTED.labels(reason="queue_timeout").inc()
            raise QueueTimeoutError(
                "timed out waiting for a live slot",
                retry_after=max(1, int(settings.pool_queue_timeout)),
            )
        except asyncio.CancelledError:
            # Caller went away while queued: give back a slot granted in the
            # race window, or withdraw from the queue.
            if waiter.future.done() and not waiter.future.cancelled():
                self._free_slot(sid)
            else:
                self._drop_waiter(waiter)
            raise
        POOL_QUEUE_WAIT.observe(time.monotonic() - start)
        return self._build(tenant_id, sid, backend_kwargs)

    async def release(self, sid: Any) -> None:
        """Free ``sid``'s slot; a freed slot admits the queue head."""
        self._free_slot(str(sid))

    # --- internals (each method is await-free, hence loop-atomic) ----------

    def _try_claim(self, tenant_id: str, sid: str) -> bool:
        """Stages 1-2: tenant quota check + capacity claim (atomic)."""
        # Drain grantable waiters FIRST: a newcomer never jumps the queue, and
        # the tenant count below already includes any just-granted waiter (a
        # same-tenant grant after the check could otherwise oversell the quota).
        self._grant_from_queue()
        if sid in self._slots:
            # Defensive: double acquire for the same session keeps its slot.
            log.warning("pool: sid %s already holds a slot", sid)
            return True
        if self.tenant_slot_count(tenant_id) >= settings.tenant_max_concurrent:
            POOL_REJECTED.labels(reason="tenant_quota").inc()
            raise TenantQuotaExceeded("Concurrent session quota exceeded")
        if len(self._slots) < settings.max_live_sessions:
            self._slots[sid] = tenant_id
            POOL_BACKENDS_LIVE.inc()
            return True
        return False

    def _build(
        self, tenant_id: str, sid: str, backend_kwargs: dict[str, Any]
    ) -> BackendRuntime:
        """Construct (not start) the backend; un-claim the slot on failure."""
        try:
            return make_backend(sid=sid, tenant_id=tenant_id, **backend_kwargs)
        except BaseException:
            self._free_slot(sid)
            raise

    def _free_slot(self, sid: str) -> None:
        if self._slots.pop(sid, None) is None:
            return
        POOL_BACKENDS_LIVE.dec()
        self._grant_from_queue()

    def _grant_from_queue(self) -> None:
        """Hand free capacity to queue heads (strict FIFO, skip cancelled)."""
        while self._queue and len(self._slots) < settings.max_live_sessions:
            waiter = self._queue.popleft()
            POOL_QUEUE_DEPTH.dec()
            if waiter.future.cancelled() or waiter.future.done():
                continue  # timed out / withdrawn while queued
            self._slots[waiter.sid] = waiter.tenant_id
            POOL_BACKENDS_LIVE.inc()
            waiter.future.set_result(None)

    def _drop_waiter(self, waiter: _Waiter) -> None:
        try:
            self._queue.remove(waiter)
            POOL_QUEUE_DEPTH.dec()
        except ValueError:
            pass  # already popped by _grant_from_queue
