"""In-process session supervisor.

Owns the registry of live sessions and drives the full lifecycle:
creation → LIVE ⇄ IDLE → COLD → (--resume) → LIVE, with single-writer turn
serialization, crash isolation, turn timeout, idle eviction, and per-turn
artifact registration.

This is the heart of the protocol bridge (spec D1–D8). Each :class:`LiveSession`
wraps one :class:`OhBackendProcess` + :class:`ProtocolAdapter` plus turn/state
bookkeeping.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncGenerator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.models import Conversation, ConversationTurn, SessionStatus, TurnArtifact, TurnStatus
from app.observability.metrics import SESSIONS_LIVE, track_turn
from app.session import logs as log_stream
from app.session import registry as route_registry
from app.session import tenant_store, workspace_store
from app.session.adapter import ProtocolAdapter
from app.session.artifacts import locate_output_file, probe_mp4_async
from app.session.lifecycle import IllegalTransition, SessionState, is_live_process, transition
from app.session.pool import (  # noqa: F401  (CapacityFullError re-exported)
    CapacityFullError,
    ContainerPool,
    PoolAdmissionError,
)
from app.session.process import derive_oh_session_id
from app.session.protocol import BackendEvent
from app.session.runtime import BackendRuntime
from app.storage.s3 import storage_for_kind

log = logging.getLogger(__name__)


class SessionNotFound(KeyError):
    pass


class SessionBusy(Exception):
    """A turn is already in progress (single-writer)."""


class TurnCapExceeded(Exception):
    pass


class BackendCrashed(Exception):
    """Signals the subprocess exited mid-turn (handled distinctly from errors)."""


class LiveSession:
    """One live (or cold) session's in-memory state."""

    def __init__(
        self,
        *,
        sid: uuid.UUID,
        tenant_id: str,
        cwd: Path,
        oh_session_id: str,
        permission_policy: str,
        extra_args: list[str],
        epoch: int,
    ) -> None:
        self.sid = sid
        self.tenant_id = tenant_id
        self.cwd = cwd
        self.oh_session_id = oh_session_id
        self.permission_policy = permission_policy
        self.extra_args = extra_args
        self.epoch = epoch
        self.state: SessionState = SessionState.CREATING

        # Backend runtime: OhBackendProcess or OhBackendContainer (WS-C, D3).
        self.process: BackendRuntime | None = None
        self.adapter: ProtocolAdapter | None = None

        # Single-writer: at most one turn at a time.
        self._busy = False
        self._turn_index: int = 0
        self._assistant_buf: list[str] = []
        self._turn_stdout: list[str] = []  # non-prefixed lines for artifact location

        # Interactive approvals: request_id -> future awaiting client reply.
        self._pending_approvals: dict[str, asyncio.Future[dict[str, Any]]] = {}

        # WS connection tracking (for idle eviction).
        self.ws_connections: set[Any] = set()
        self.idle_since: float | None = None  # monotonic clock when entered idle (no ws)
        # Eviction re-entrancy guard (session-history-switch D3): set before
        # the first await of the eviction body, cleared in try/finally.
        self.evicting: bool = False
        # Workspace archive sync (session-workspace-archive): dirty flag +
        # at most one background worker per session; ``closing`` makes new
        # dirty marks rejected during the close ordering (rev3).
        self.closing: bool = False
        self._ws_dirty: bool = False
        self._ws_sync_task: asyncio.Task[None] | None = None
        self._idle_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._log_task: asyncio.Task[None] | None = None

    @property
    def busy(self) -> bool:
        return self._busy

    def is_live(self) -> bool:
        return self.process is not None and is_live_process(self.state)


class SessionSupervisor:
    """Process-local registry + lifecycle driver."""

    def __init__(self) -> None:
        self._sessions: dict[uuid.UUID, LiveSession] = {}
        # Serializes tenant-quota check + create (SS-3): the router holds this
        # lock across count_live_for_tenant() + create_session() so two
        # concurrent requests cannot both pass the check (TOCTOU).
        self.quota_lock = asyncio.Lock()
        # Slot pool (WS-D): the single admission point for every live backend
        # (create + rehydrate). Its check-and-claim sections are event-loop
        # atomic, so the concurrent-quota/capacity TOCTOU the quota_lock used
        # to close is handled inside the pool itself.
        self.pool = ContainerPool(
            evict_one=self._evict_longest_idle,
            evict_tenant_idle=self._evict_tenant_idle,
        )
        # Per-sid registration locks (SS-4): serialize COLD-reconnect
        # registration so only one WS client triggers rehydrate.
        self._registration_locks: dict[uuid.UUID, asyncio.Lock] = {}
        # Per-tenant eviction locks (session-history-switch D4): serialize
        # concurrent quota-triggered evictions so a session is never
        # double-evicted by two racing switch requests.
        self._tenant_evict_locks: dict[str, asyncio.Lock] = {}

    # --- registry queries ---------------------------------------------------

    def get(self, sid: uuid.UUID | str) -> LiveSession:
        sid = uuid.UUID(str(sid)) if not isinstance(sid, uuid.UUID) else sid
        if sid not in self._sessions:
            raise SessionNotFound(sid)
        return self._sessions[sid]

    def has(self, sid: uuid.UUID | str) -> bool:
        try:
            uuid.UUID(str(sid)) if not isinstance(sid, uuid.UUID) else sid
        except (ValueError, AttributeError):
            return False
        key = uuid.UUID(str(sid)) if not isinstance(sid, uuid.UUID) else sid
        return key in self._sessions

    def live_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.is_live())

    def count_live_for_tenant(self, tenant_id: str) -> int:
        """Count this tenant's live sessions (public API, SS-10 encapsulation)."""
        return sum(
            1
            for s in self._sessions.values()
            if s.tenant_id == tenant_id and s.is_live()
        )

    async def register_live_session(
        self, live: LiveSession, *, db: AsyncSession
    ) -> LiveSession:
        """Register (and rehydrate if COLD) a session under a per-sid lock.

        Single-writer guarantee (SS-4): when two WS clients reconnect to the
        same COLD session concurrently, only the first triggers ``--resume``;
        the second waits on the lock and reuses the already-live session.
        """
        lock = self._registration_locks.setdefault(live.sid, asyncio.Lock())
        async with lock:
            existing = self._sessions.get(live.sid)
            if existing is not None and existing.is_live():
                return existing
            self._sessions[live.sid] = live
            try:
                if live.state == SessionState.COLD:
                    await self.rehydrate(live, db=db)
            except Exception:
                # Failed to come up — drop the placeholder so a later attempt
                # (or another client) can retry cleanly.
                if self._sessions.get(live.sid) is live:
                    self._sessions.pop(live.sid, None)
                raise
            return live

    def remove_live_session(self, sid: uuid.UUID | str) -> None:
        """Drop a session from the registry (public API, SS-10)."""
        key = uuid.UUID(str(sid)) if not isinstance(sid, uuid.UUID) else sid
        self._sessions.pop(key, None)
        self._registration_locks.pop(key, None)

    @property
    def capacity(self) -> int:
        return settings.max_live_sessions

    # --- creation -----------------------------------------------------------

    async def create_session(
        self,
        *,
        db: AsyncSession,
        tenant_id: str,
        permission_policy: str | None = None,
        extra_args: list[str] | None = None,
        actor_key_id: str | None = None,
    ) -> Conversation:
        """Create a session: DB row + persistent workspace + spawn subprocess.

        ``oh_session_id`` is derived from ``cwd`` *before* spawning (spec D8) so
        it is available for ``--resume`` even if the first turn never reaches a
        ``state_snapshot`` event.
        """
        policy = permission_policy or settings.permission_policy
        sid = uuid.uuid4()
        cwd = Path(settings.workspace_root) / str(sid)
        # Admission FIRST (WS-D): tenant quota / capacity / eviction / queue
        # all resolve before any side effect, so a 429/503 rejection leaves no
        # DB row, workspace dir, or staged tenant data behind.
        proc = await self.pool.acquire(
            tenant_id,
            sid,
            cwd=cwd,
            permission_mode=policy,
            oh_session_id=None,
            extra_args=extra_args or [],
            env_overrides=self._tenant_env(tenant_id),
        )
        try:
            cwd.mkdir(parents=True, exist_ok=True)
            oh_session_id = derive_oh_session_id(cwd)
            # Stage-in the tenant's authoritative data BEFORE anything else (WS-B):
            # MinIO unreachable raises TenantStoreError -> router returns 503 and
            # no session row/process is created (fail-fast).
            await tenant_store.stage_in(tenant_id)
            # Per-session rules snapshot (D2.3): staged rules/ -> {cwd}/.claude/rules.
            await tenant_store.copy_rules_into_workspace(tenant_id, cwd)
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=settings.session_ttl_seconds)

            conv = Conversation(
                id=sid,
                tenant_id=tenant_id,
                actor_key_id=actor_key_id,
                oh_session_id=oh_session_id,
                workspace_path=str(cwd),
                status=SessionStatus.CREATING,
                permission_policy=policy,
                extra_oh_args=json.dumps(extra_args or []),
                expires_at=expires_at,
            )
            db.add(conv)
            await db.commit()
            await db.refresh(conv)

            epoch = await route_registry.next_epoch(str(sid))
            live = LiveSession(
                sid=sid,
                tenant_id=tenant_id,
                cwd=cwd,
                oh_session_id=oh_session_id,
                permission_policy=policy,
                extra_args=extra_args or [],
                epoch=epoch,
            )
            self._sessions[sid] = live

            await self._spawn(live, resume=False, backend=proc)
        except BaseException:
            # Release is idempotent — _spawn already released on its own
            # failures; this covers stage-in/DB/registry errors before it.
            await self.pool.release(sid)
            raise
        # Reflect the now-live state in the DB row.
        conv.status = SessionStatus.LIVE
        await db.commit()
        await db.refresh(conv)
        return conv

    async def create_session_from_existing(
        self,
        conv: Conversation,
        tenant_id: str,
        *,
        db: AsyncSession,
    ) -> None:
        """Re-arm a live session for an existing DB row (reconnect to a non-COLD,
        non-live session whose process was lost on a gateway restart)."""
        from pathlib import Path

        cwd = Path(conv.workspace_path) if conv.workspace_path else Path(settings.workspace_root) / str(conv.id)
        cwd.mkdir(parents=True, exist_ok=True)
        oh_session_id = conv.oh_session_id or derive_oh_session_id(cwd)
        # Same stage-in-before-backend guarantee as create_session (WS-B).
        await tenant_store.stage_in(tenant_id)
        # Workspace restore before spawn (spec session-workspace-archive).
        await workspace_store.stage_in(tenant_id, conv.id, cwd)
        epoch = await route_registry.next_epoch(str(conv.id))
        live = LiveSession(
            sid=conv.id,
            tenant_id=tenant_id,
            cwd=cwd,
            oh_session_id=oh_session_id,
            permission_policy=conv.permission_policy,
            extra_args=json.loads(conv.extra_oh_args or "[]"),
            epoch=epoch,
        )
        live._turn_index = conv.turn_count
        live.state = SessionState.CREATING
        self._sessions[conv.id] = live
        # Resume semantics (session-history-switch D10): the new live process
        # must restore the source session's conversation context — spawning
        # without --resume would silently drop it.
        await self._spawn(live, resume=True)
        conv.status = SessionStatus.LIVE
        await db.commit()

    async def _spawn(
        self,
        live: LiveSession,
        *,
        resume: bool,
        backend: BackendRuntime | None = None,
    ) -> None:
        """Spawn (or rehydrate) the ``oh --backend-only`` subprocess.

        The live slot is acquired through the pool (WS-D) — either by the
        caller (``backend`` pre-acquired, create path) or here (rehydrate /
        re-arm paths). Any failure before the session is fully up releases
        the slot so a queued waiter can take it.
        """
        proc = backend
        if proc is None:
            oh_sid = live.oh_session_id if resume else None
            # Runtime factory (WS-C, D3) sits behind the pool: OH_SESSION_RUNTIME
            # picks process (default) or one disposable container per session.
            # env_overrides only apply to the process runtime — the container
            # derives env from its mounts.
            proc = await self.pool.acquire(
                live.tenant_id,
                live.sid,
                cwd=live.cwd,
                permission_mode=live.permission_policy,
                oh_session_id=oh_sid,
                extra_args=live.extra_args,
                env_overrides=self._tenant_env(live.tenant_id),
            )
        try:
            await proc.start()
            adapter = ProtocolAdapter(proc)
            await adapter.start()
        except BaseException:
            await self.pool.release(live.sid)
            raise

        live.process = proc
        live.adapter = adapter
        live.state = transition(live.state, SessionState.LIVE) if resume else SessionState.LIVE
        SESSIONS_LIVE.inc()

        # Route registration + heartbeat for multi-node affinity (Phase 3).
        await route_registry.register_route(str(live.sid), proc.pid or 0, live.epoch)
        live._heartbeat_task = asyncio.create_task(self._heartbeat(live))
        # Drain diagnostic logs to the bounded Redis stream.
        live._log_task = asyncio.create_task(self._drain_logs(live))
        # Consume startup events (ready/state_snapshot/tasks_snapshot) so they
        # do not leak into the first turn's event stream.
        await self._await_ready(live)

    async def _await_ready(self, live: LiveSession, timeout: float = 15.0) -> None:
        """Drain startup events until ``ready`` is seen (or timeout).

        The native backend emits ``ready`` + ``state_snapshot`` +
        ``tasks_snapshot`` at startup; if left in the queue the first turn
        would re-emit them as frames. We consume them here so the first turn
        only sees its own events.
        """
        assert live.adapter is not None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        startup_types = {"ready", "state_snapshot", "tasks_snapshot", "compact_progress"}
        while True:
            remaining = max(0.1, deadline - loop.time())
            try:
                event = await asyncio.wait_for(live.adapter.events.get(), timeout=remaining)
            except asyncio.TimeoutError:
                log.warning("session %s: no ready event within timeout", live.sid)
                return
            if event is None:
                return  # process gone
            if event.type == "ready":
                # Drain the startup burst that follows ``ready`` (state_snapshot,
                # tasks_snapshot…). A short *timed* wait per event (not a pure
                # non-blocking drain) closes the race where the reader task has
                # not yet enqueued the burst under load — a leaked snapshot
                # would surface as a stray "event" frame in the first turn.
                # Stop at the first non-startup event or after the grace lapses.
                while True:
                    try:
                        extra = await asyncio.wait_for(
                            live.adapter.events.get(), timeout=0.25
                        )
                    except asyncio.TimeoutError:
                        break
                    if extra is None:
                        break
                    if extra.type not in startup_types:
                        # A real turn event arrived during startup drain — requeue
                        # it (at the tail) rather than dropping it.
                        await live.adapter.events.put(extra)
                        break
                return
            # Before ready: discard other startup events too.

    def _tenant_env(self, tenant_id: str) -> dict[str, str]:
        """WS-B: redirect the backend's config/data trees to the tenant's
        staging dirs so user-scope memory stays tenant-continuous and
        tenant-private. Credentials still flow via env/--api-key only."""
        return {
            "OPENHARNESS_CONFIG_DIR": str(tenant_store.local_config_dir(tenant_id)),
            "OPENHARNESS_DATA_DIR": str(tenant_store.local_data_dir(tenant_id)),
        }

    # --- workspace archive sync (spec session-workspace-archive) -------------

    def _mark_workspace_dirty(self, live: LiveSession) -> None:
        """Turn hook ①: schedule an async archive round. Synchronous (no
        await) so the ``turn_completed`` frame is never delayed; rejected
        while the close ordering is in progress (rev3 step a)."""
        if not workspace_store.enabled() or live.closing:
            return
        live._ws_dirty = True
        if live._ws_sync_task is None or live._ws_sync_task.done():
            live._ws_sync_task = asyncio.create_task(
                self._workspace_sync_worker(live)
            )

    async def _workspace_sync_worker(self, live: LiveSession) -> None:
        """Per-session single sync worker (rev2): the debounce window
        coalesces dirty bursts into one round; loops until no dirty mark is
        left; exits as soon as close begins (rev3 — the final stage-out is
        owned by the close path, never by this worker)."""
        try:
            while live._ws_dirty and not live.closing:
                await asyncio.sleep(settings.workspace_sync_debounce_ms / 1000.0)
                if live.closing:
                    return
                live._ws_dirty = False
                await workspace_store.stage_out(
                    live.tenant_id,
                    live.sid,
                    live.cwd,
                    oh_session_id=live.oh_session_id,
                    session_status=str(getattr(live.state, "value", live.state)),
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # stage_out never raises; belt and braces
            log.warning("workspace sync worker failed (sid=%s)", live.sid)

    async def _drain_workspace_sync(self, live: LiveSession) -> None:
        """Close ordering steps a+b (rev3): reject new dirty marks, then
        await the existing worker's exit — after this the final stage-out
        can never race a stale background round."""
        live.closing = True
        task = live._ws_sync_task
        if task is not None:
            try:
                await task
            except Exception:
                pass
            live._ws_sync_task = None

    async def _evict_longest_idle(self) -> bool:
        """Pool eviction hook (WS-D, spec 4.4): evict the longest-idle idle
        session to COLD and free its slot. Returns False when nothing is
        evictable (the pool then falls through to its wait queue)."""
        candidates = [
            s for s in self._sessions.values()
            if s.is_live() and not s.ws_connections and not s.busy and not s.evicting
        ]
        if not candidates:
            return False
        # Longest-idle first; sessions that never went idle rank last.
        candidates.sort(key=lambda s: s.idle_since if s.idle_since is not None else float("inf"))
        # Propagate the real eviction result (D3): a re-entrant skip must not
        # be reported as success or the pool would retry a claim for a slot
        # that was never freed.
        return await self._evict(candidates[0])

    async def _evict_tenant_idle(self, tenant_id: str) -> bool:
        """Pool tenant-quota hook (session-history-switch D2/D4): demote this
        tenant's longest-idle unattached session to COLD so a switch target
        can claim the freed slot.

        Serialized by a per-tenant eviction lock; candidates are re-scanned
        under the lock because a concurrent switch may have already evicted.
        Internal eviction errors are logged and reported as ``False`` (D5.3)
        so ``acquire`` falls back to the existing rejection/queue path.
        """
        lock = self._tenant_evict_locks.setdefault(tenant_id, asyncio.Lock())
        async with lock:
            candidates = [
                s for s in self._sessions.values()
                if s.tenant_id == tenant_id
                and s.is_live()
                and not s.ws_connections
                and not s.busy
                and not s.evicting
            ]
            if not candidates:
                return False
            candidates.sort(
                key=lambda s: s.idle_since if s.idle_since is not None else float("inf")
            )
            try:
                return await self._evict(candidates[0])
            except Exception:
                log.exception("tenant idle eviction failed (tenant=%s)", tenant_id)
                return False

    async def _persist_status(self, sid: uuid.UUID, status: SessionStatus) -> None:
        """Best-effort DB status mirror (COLD on evict/crash) so REST reads and
        the cross-restart WS rehydrate branch see the real lifecycle state."""
        try:
            from app import db as _db

            async with _db.async_session() as session:
                conv = await session.get(Conversation, sid)
                if conv is not None:
                    conv.status = status
                    await session.commit()
        except Exception:
            log.warning("status persist failed (sid=%s)", sid)

    async def _evict(self, live: LiveSession) -> bool:
        """Gracefully shut down a session to COLD (snapshot preserved).

        Returns ``True`` when the slot was actually freed, ``False`` on a
        re-entrant call or a non-evictable state (session-history-switch D3).
        Failure semantics (D5): the ``evicting`` marker is always restored in
        ``finally``; the COLD transition + pool release run in a protected
        section so a teardown exception can never leak the slot (graceful
        shutdown failure already escalates to ``kill_group`` inside
        ``_teardown_process``); stage-out stays best-effort.
        """
        # Re-entrancy guard: checked and set before the first await.
        if live.evicting:
            return False
        if live.state not in (SessionState.LIVE, SessionState.IDLE):
            return False
        live.evicting = True
        try:
            log.info("evicting session %s to COLD", live.sid)
            try:
                await self._teardown_process(live, graceful=True)
            finally:
                # Protected section: once teardown ran (even if it raised,
                # the process was force-killed on the way) the slot must not
                # leak — COLD + release + persist happen regardless.
                try:
                    live.state = transition(live.state, SessionState.COLD)
                except IllegalTransition:
                    live.state = SessionState.COLD
                SESSIONS_LIVE.dec()
                # Freed slot wakes the pool queue head (WS-D).
                await self.pool.release(live.sid)
                await self._persist_status(live.sid, SessionStatus.COLD)
            # Stage-out hook ② (WS-B): the backend is gone, mirror its final
            # memory/session state to the bucket before the node forgets it.
            try:
                await tenant_store.stage_out(live.tenant_id)
            except Exception:
                log.warning("evict stage-out failed (sid=%s)", live.sid)
            # Workspace archive hook ② (best-effort; serialized with any
            # in-flight background round by the per-session lock).
            await workspace_store.stage_out(
                live.tenant_id,
                live.sid,
                live.cwd,
                oh_session_id=live.oh_session_id,
                session_status="cold",
            )
            return True
        finally:
            live.evicting = False

    async def rehydrate(self, live: LiveSession, *, db: AsyncSession) -> None:
        """Rehydrate a COLD session via ``oh --resume <oh_session_id>``."""
        if live.state != SessionState.COLD:
            return
        # Single-writer lock prevents two nodes resuming the same cwd (spec 4.3).
        holder = f"{settings.node_id or 'local'}:{live.epoch}"
        acquired = await route_registry.acquire_lock(str(live.sid), holder)
        if not acquired:
            raise RuntimeError("session is being rehydrated by another node")
        try:
            # Refresh tenant staging from the authoritative bucket before the
            # backend resumes (WS-B; raises TenantStoreError -> 503 upstream).
            await tenant_store.stage_in(live.tenant_id)
            # Workspace restore BEFORE spawn (spec session-workspace-archive):
            # a wiped/foreign-node workspace is rebuilt from its archive so
            # OpenHarness sees the files from turn one. Best-effort.
            live.cwd.mkdir(parents=True, exist_ok=True)
            await workspace_store.stage_in(live.tenant_id, live.sid, live.cwd)
            resume = True
            if not await tenant_store.has_session_snapshot(
                live.tenant_id, live.oh_session_id
            ):
                # 0-turn COLD session with no snapshot (D8 edge case): there
                # is no context to restore and ``--resume`` would fail at the
                # CLI level — fall back to a fresh spawn.
                conv = await db.get(Conversation, live.sid)
                if conv is not None and conv.turn_count == 0:
                    resume = False
            await self._spawn(live, resume=resume)
        finally:
            await route_registry.release_lock(str(live.sid), holder)

    # --- turn execution -----------------------------------------------------

    async def stream_turn(
        self,
        sid: uuid.UUID | str,
        text: str,
        *,
        db: AsyncSession,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Run one turn: submit_line → stream events → turn_complete.

        Enforces single-writer (yields a ``busy`` frame if already running) and
        the per-turn timeout (kills the process group on expiry). Finalization
        (persist turn + register artifacts) happens BEFORE the terminal
        ``turn_complete``/``turn_error`` frame is yielded, so a consumer that
        ``break``s after the terminal frame still gets a persisted turn.
        """
        live = self.get(sid)
        if live.busy:
            yield {"type": "busy"}
            return
        if live._turn_index >= settings.max_turns_per_session:
            yield {"type": "turn_error", "message": "max_turns_per_session exceeded"}
            return

        live._busy = True
        live._assistant_buf.clear()
        live._turn_stdout.clear()
        turn_index = live._turn_index

        # Persist the turn row as RUNNING. Guarded so a persistence failure
        # (e.g. a duplicate index, SS regression) can never leave ``_busy``
        # wedged True with no terminal frame delivered.
        turn = ConversationTurn(
            conversation_id=live.sid,
            turn_index=turn_index,
            prompt=text,
            status=TurnStatus.RUNNING,
        )
        try:
            db.add(turn)
            conv = await db.get(Conversation, live.sid)
            if conv is not None:
                conv.turn_count = turn_index + 1
                conv.last_active_at = datetime.now(timezone.utc)
            await db.commit()
            await db.refresh(turn)
        except Exception as exc:
            log.warning("turn persist failed (sid=%s): %s", live.sid, exc)
            try:
                await db.rollback()
            except Exception:
                pass
            live._busy = False
            yield {"type": "turn_error", "message": "turn could not be persisted"}
            return

        loop = asyncio.get_running_loop()
        deadline = loop.time() + settings.turn_timeout_seconds
        try:
            with track_turn():
                assert live.adapter is not None
                await live.adapter.submit_line(text)
                # Inline event pump so finalization precedes the terminal yield.
                while True:
                    timeout = max(0.1, deadline - loop.time())
                    try:
                        event = await asyncio.wait_for(
                            live.adapter.events.get(), timeout=timeout
                        )
                    except asyncio.TimeoutError:
                        await live.process.kill_group() if live.process else None
                        await self._finalize_turn(live, turn, db, TurnStatus.TIMED_OUT, "turn timed out")
                        yield {"type": "turn_error", "message": "turn timed out"}
                        return
                    if event is None:
                        # stdout EOF — crash -> FAILED + COLD.
                        await self._handle_crash(live)
                        await self._finalize_turn(live, turn, db, TurnStatus.FAILED, "backend process exited unexpectedly")
                        yield {"type": "turn_error", "message": "backend process exited unexpectedly"}
                        return
                    if event.type == "modal_request" and event.modal:
                        await self._await_approval(live, event)
                    if event.type == "line_complete":
                        # Finalize BEFORE yielding the terminal frame.
                        has_artifact = await self._finalize_turn(live, turn, db, TurnStatus.COMPLETED, None)
                        yield {"type": "turn_complete", "turn_index": turn_index, "has_artifact": has_artifact}
                        return
                    frame = self._map_event(live, event, turn_index)
                    if frame is not None:
                        yield frame
        except asyncio.CancelledError:
            has_artifact = await self._finalize_turn(live, turn, db, TurnStatus.INTERRUPTED, None)
            yield {"type": "turn_complete", "turn_index": turn_index, "interrupted": True, "has_artifact": has_artifact}
            raise
        except Exception as exc:
            log.exception("turn failed: %s", exc)
            await self._finalize_turn(live, turn, db, TurnStatus.FAILED, str(exc))
            yield {"type": "turn_error", "message": str(exc)}
        finally:
            live._busy = False
            # Workspace archive hook ①: mark dirty for the per-session
            # background worker — the terminal frame was already yielded, and
            # the mark itself never awaits (WS latency unaffected).
            self._mark_workspace_dirty(live)
            # Stage-out hook ① (WS-B): push the tenant's memory increments to
            # the authoritative bucket after every turn (loss-window SLO: at
            # most one in-flight turn). Failure keeps staging + bumps metric.
            try:
                await tenant_store.stage_out(live.tenant_id)
            except Exception:
                log.warning("post-turn stage-out failed (sid=%s)", live.sid)

    def _map_event(self, live: LiveSession, event, turn_index: int) -> dict[str, Any] | None:
        """Map a BackendEvent to a WS frame dict (spec D2 event mapping)."""
        t = event.type
        if t == "assistant_delta":
            live._assistant_buf.append(event.message or "")
            return {"type": "delta", "text": event.message or "", "turn_index": turn_index}
        if t == "assistant_complete":
            live._assistant_buf.append(event.message or "")
            return {"type": "delta", "text": event.message or "", "turn_index": turn_index, "final": True}
        if t == "tool_started":
            return {"type": "tool_start", "tool_name": event.tool_name, "tool_input": event.tool_input, "turn_index": turn_index}
        if t == "tool_completed":
            return {"type": "tool_end", "tool_name": event.tool_name, "output": event.output, "is_error": event.is_error, "turn_index": turn_index}
        if t == "todo_update":
            return {"type": "todo", "todo_markdown": event.todo_markdown, "turn_index": turn_index}
        if t == "line_complete":
            return {"type": "turn_complete", "turn_index": turn_index}
        if t == "modal_request":
            modal = event.modal or {}
            return {
                "type": "approval_request",
                "request_id": modal.get("request_id"),
                "modal": modal,
                "turn_index": turn_index,
            }
        if t == "error":
            return {"type": "turn_error", "message": event.message, "turn_index": turn_index}
        if t == "approval_timeout":
            # Synthetic event injected by _await_approval on timeout (A4):
            # structured code so the client need not match on message text.
            return {
                "type": "turn_error",
                "code": "approval_timeout",
                "message": event.message or "approval request timed out; treated as rejected",
                "turn_index": turn_index,
            }
        if t == "ready":
            return {"type": "session_ready"}
        # Unknown event: transparent passthrough (spec robustness).
        return {"type": "event", "event": event.model_dump(exclude_none=True), "turn_index": turn_index}

    async def _await_approval(self, live: LiveSession, event) -> None:
        """Register a pending approval; the client replies via respond_approval."""
        modal = event.modal or {}
        rid = modal.get("request_id")
        if not rid:
            return
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        live._pending_approvals[rid] = fut
        # Auto-deny after the approval timeout (spec: unanswered -> denial).
        async def _timeout():
            try:
                await asyncio.wait_for(asyncio.shield(fut), timeout=settings.approval_timeout_seconds)
            except asyncio.TimeoutError:
                if not fut.done():
                    fut.set_result({"allowed": False, "reply": "reject", "answer": ""})
                    live._pending_approvals.pop(rid, None)
                    try:
                        if live.adapter is not None:
                            # Forward the denial so the subprocess unblocks.
                            if (modal.get("kind") or "") == "question":
                                await live.adapter.respond_question(rid, "")
                            else:
                                await live.adapter.respond_permission(rid, False, "reject")
                            # Surface a structured turn_error frame to the client
                            # (A4: code=approval_timeout, mapped in _map_event).
                            await live.adapter.events.put(
                                BackendEvent(
                                    type="approval_timeout",
                                    message="approval request timed out; treated as rejected",
                                )
                            )
                    except Exception:
                        log.warning("approval timeout forwarding failed (sid=%s)", live.sid)
        asyncio.create_task(_timeout())

    async def respond_approval(
        self, sid: uuid.UUID | str, request_id: str, *, allowed: bool, reply: str | None = None, answer: str | None = None
    ) -> None:
        live = self.get(sid)
        fut = live._pending_approvals.pop(request_id, None)
        assert live.adapter is not None
        modal_kind = None
        if fut is not None and not fut.done():
            fut.set_result({"allowed": allowed, "reply": reply, "answer": answer})
        # Forward to the subprocess.
        if answer is not None:
            await live.adapter.respond_question(request_id, answer)
        else:
            await live.adapter.respond_permission(request_id, allowed, reply)

    async def interrupt(self, sid: uuid.UUID | str) -> None:
        """Interrupt the active turn (spec: interrupt cancels the active turn)."""
        live = self.get(sid)
        assert live.adapter is not None
        await live.adapter.interrupt()

    async def _handle_crash(self, live: LiveSession) -> None:
        """Unexpected stdout EOF: fail current turn, transition to COLD."""
        log.warning("session %s backend crashed -> COLD", live.sid)
        if live.state in (SessionState.LIVE, SessionState.IDLE):
            live.state = SessionState.FAILED
            try:
                live.state = transition(live.state, SessionState.COLD)
            except IllegalTransition:
                live.state = SessionState.COLD
            SESSIONS_LIVE.dec()
            # Freed slot wakes the pool queue head (WS-D).
            await self.pool.release(live.sid)
            await self._persist_status(live.sid, SessionStatus.COLD)
        await self._cancel_helpers(live)

    async def _finalize_turn(
        self,
        live: LiveSession,
        turn: ConversationTurn,
        db: AsyncSession,
        status: TurnStatus,
        error: str | None,
    ) -> bool:
        """Persist the turn row + register artifacts (best-effort).

        Wrapped so a persistence failure never prevents the terminal frame from
        being delivered to the client — the turn record is best-effort.
        Returns whether an artifact was registered for this turn (A1: the
        ``turn_complete`` frame carries ``has_artifact``).
        """
        has_artifact = False
        # Every terminal turn consumes its index: the RUNNING row committed at
        # turn start occupies ``turn_index`` (uq_turns_conv_idx), so a FAILED/
        # TIMED_OUT/INTERRUPTED turn must advance too or the next submit would
        # violate the unique constraint. Matches ``conv.turn_count`` (bumped at
        # turn start) and the restart path (``_turn_index = conv.turn_count``).
        live._turn_index += 1
        try:
            turn.status = status
            turn.error_message = error
            turn.assistant_text = "".join(live._assistant_buf) or None
            turn.finished_at = datetime.now(timezone.utc)
            db.add(turn)
            if status in (TurnStatus.COMPLETED, TurnStatus.INTERRUPTED):
                has_artifact = await self._register_artifacts(live, turn, db)
            await db.commit()
        except Exception as exc:
            log.warning("turn finalize failed (sid=%s): %s", live.sid, exc)
            try:
                await db.rollback()
            except Exception:
                pass
            return False
        return has_artifact

    async def _register_artifacts(
        self, live: LiveSession, turn: ConversationTurn, db: AsyncSession
    ) -> bool:
        """Locate + probe + persist artifacts produced this turn (spec 3.5).

        Returns True when an artifact row was registered.
        """
        stdout_blob = "\n".join(live._turn_stdout)
        try:
            path = locate_output_file(stdout_blob, live.cwd)
        except Exception:
            return False
        try:
            # Blocking ffprobe runs in the executor (SS-1) so the event loop
            # keeps serving concurrent WS/HTTP traffic.
            meta = await probe_mp4_async(path)
        except Exception:
            meta = None
        storage = storage_for_kind(settings.storage_kind)
        key = f"{live.sid}/{turn.turn_index}/{path.name}"
        try:
            storage.save(key, path)
        except Exception as exc:
            log.warning("artifact save failed: %s", exc)
            return False
        art = TurnArtifact(
            conversation_id=live.sid,
            turn_index=turn.turn_index,
            storage_kind=settings.storage_kind,
            storage_key=key,
            filename=path.name,
            file_size_bytes=meta.file_size_bytes if meta else None,
            duration_seconds=meta.duration_seconds if meta else None,
            resolution=meta.resolution if meta else None,
            fps=meta.fps if meta else None,
        )
        db.add(art)
        return True

    async def _drain_logs(self, live: LiveSession) -> None:
        """Forward non-protocol stdout lines to the bounded Redis log stream."""
        assert live.adapter is not None
        try:
            while True:
                line = await live.adapter.logs.get()
                if line is None:
                    return
                live._turn_stdout.append(line)
                await log_stream.append_log(str(live.sid), line)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def _heartbeat(self, live: LiveSession) -> None:
        """Refresh the route TTL while the session is live (Phase 3)."""
        try:
            while live.is_live():
                await asyncio.sleep(settings.route_ttl_seconds // 2)
                if live.process is not None:
                    await route_registry.heartbeat_route(
                        str(live.sid), live.process.pid or 0, live.epoch
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    # --- connection / idle tracking -----------------------------------------

    def attach_ws(self, sid: uuid.UUID | str, ws: Any) -> LiveSession:
        live = self.get(sid)
        live.ws_connections.add(ws)
        self._cancel_idle_timer(live)
        live.idle_since = None  # has an active connection now
        if live.state == SessionState.IDLE:
            live.state = transition(SessionState.IDLE, SessionState.LIVE)
        return live

    def detach_ws(self, sid: uuid.UUID | str, ws: Any) -> None:
        try:
            live = self.get(sid)
        except SessionNotFound:
            return
        live.ws_connections.discard(ws)
        if not live.ws_connections and live.state == SessionState.LIVE:
            live.state = transition(SessionState.LIVE, SessionState.IDLE)
            live.idle_since = time.monotonic()
            self._start_idle_timer(live)

    def _start_idle_timer(self, live: LiveSession) -> None:
        self._cancel_idle_timer(live)
        live._idle_task = asyncio.create_task(self._idle_evict(live))

    def _cancel_idle_timer(self, live: LiveSession) -> None:
        if live._idle_task is not None:
            live._idle_task.cancel()
            live._idle_task = None

    async def _idle_evict(self, live: LiveSession) -> None:
        try:
            await asyncio.sleep(settings.idle_grace_seconds)
            if not live.ws_connections and live.state == SessionState.IDLE:
                await self._evict(live)
        except asyncio.CancelledError:
            pass

    # --- teardown / close ---------------------------------------------------

    async def _teardown_process(self, live: LiveSession, *, graceful: bool) -> None:
        if live.adapter is not None:
            try:
                if graceful:
                    await live.adapter.shutdown()
            except Exception:
                pass
        if live.process is not None:
            if graceful:
                try:
                    await live.process.shutdown(grace=10.0)
                except Exception:
                    await live.process.kill_group()
            else:
                await live.process.kill_group()
        await self._cancel_helpers(live)

    async def _cancel_helpers(self, live: LiveSession) -> None:
        for task_attr in ("_idle_task", "_heartbeat_task", "_log_task"):
            task = getattr(live, task_attr, None)
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                setattr(live, task_attr, None)
        if live.adapter is not None:
            await live.adapter.stop()
            live.adapter = None
        live.process = None

    async def close(
        self,
        sid: uuid.UUID | str,
        *,
        db: AsyncSession,
    ) -> None:
        """DELETE: kill process, clean workspace/snapshot/artifacts/redis, CLOSED.

        Preserves completed turns' terminal records (spec: DELETE preserves
        completed turn history).
        """
        live = self.get(sid)
        # Workspace archive close ordering (rev3) steps a+b: reject new dirty
        # marks, await the background worker's exit.
        await self._drain_workspace_sync(live)
        await self._teardown_process(live, graceful=False)
        if live.state in (SessionState.LIVE, SessionState.IDLE):
            SESSIONS_LIVE.dec()
        live.state = SessionState.CLOSED
        # Freed slot wakes the pool queue head (WS-D); no-op if already COLD.
        await self.pool.release(live.sid)
        # Stage-out hook ③ + destroy (WS-B): final mirror to the bucket, then
        # purge this session's memory/session traces locally and remotely
        # (tenant-level agent memory is kept — it outlives sessions).
        try:
            await tenant_store.stage_out(live.tenant_id)
            await tenant_store.destroy_session_data(live.tenant_id, live.oh_session_id)
        except Exception:
            log.warning("close stage-out/destroy failed (sid=%s)", live.sid)
        # Step c: final workspace stage-out under the per-session lock — no
        # concurrent round can exist now, so this manifest carries the highest
        # sync_seq. The MinIO archive is KEPT (history switching reads it).
        await workspace_store.stage_out(
            live.tenant_id,
            live.sid,
            live.cwd,
            oh_session_id=live.oh_session_id,
            session_status="closed",
        )
        # Step d: only now remove the local workspace (+ the native snapshot
        # dir; blocking rmtree offloaded to the threadpool, SS-17).
        if live.cwd.exists():
            await run_in_threadpool(shutil.rmtree, live.cwd, ignore_errors=True)
        workspace_store.discard_lock(live.sid)
        await route_registry.clear_route(str(sid))
        await route_registry.release_lock(str(sid), f"{settings.node_id or 'local'}:{live.epoch}")
        await log_stream.clear_logs(str(sid))
        # Delete artifacts' files (rows preserved for audit via ondelete CASCADE
        # — but spec wants resources cleaned; we delete storage objects + rows
        # for artifacts, keep turn rows).
        arts = (await db.execute(
            select(TurnArtifact).where(TurnArtifact.conversation_id == live.sid)
        )).scalars().all()
        storage = storage_for_kind(settings.storage_kind)
        for art in arts:
            try:
                storage.delete(art.storage_key)
            except Exception:
                pass
            await db.delete(art)
        conv = await db.get(Conversation, live.sid)
        if conv is not None:
            conv.status = SessionStatus.CLOSED
            conv.workspace_path = None
        await db.commit()
        self.remove_live_session(live.sid)

    async def shutdown_all(self) -> None:
        """Graceful gateway shutdown: tear down every live session."""
        for sid in list(self._sessions.keys()):
            try:
                live = self._sessions[sid]
                await self._teardown_process(live, graceful=True)
                SESSIONS_LIVE.dec()
                await self.pool.release(sid)
            except Exception:
                pass
        self._sessions.clear()

    async def orphan_scan(self) -> int:
        """Startup scan: reclaim workspace dirs with no live route (spec 4.5).

        Returns the count of orphaned workspaces cleaned. Residual snapshots
        from a crashed/restarted node are safe to leave (they rehydrate on the
        next connect); only workspaces whose session row is CLOSED/absent are
        removed to bound disk growth.
        """
        cleaned = 0
        # Container-mode orphan reclaim (D6): force-delete this node's session
        # containers with no live session, after a final tenant stage-out (④).
        if settings.session_runtime == "container":
            try:
                from app.session.container import reclaim_orphan_containers

                active = {str(s.sid) for s in self._sessions.values() if s.is_live()}
                await reclaim_orphan_containers(active, on_tenant=tenant_store.stage_out)
            except Exception as exc:
                log.warning("orphan container reclaim failed: %s", exc)
        root = Path(settings.workspace_root)
        if not root.exists():
            return 0
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            try:
                sid = uuid.UUID(entry.name)
            except ValueError:
                continue
            route = await route_registry.get_route(str(sid))
            if route is not None:
                continue  # owned somewhere — leave it
            # No route: check DB status. Remove only if CLOSED/EXPIRED/absent.
            from app import db as _db

            async with _db.async_session() as db:
                conv = await db.get(Conversation, sid)
                if conv is None or conv.status in (SessionStatus.CLOSED, SessionStatus.EXPIRED):
                    # Stage-out hook ④ (WS-B): flush any residual tenant staging
                    # increments before reclaiming, then drop per-session traces.
                    if conv is not None:
                        try:
                            await tenant_store.stage_out(conv.tenant_id)
                            if conv.oh_session_id:
                                await tenant_store.destroy_session_data(
                                    conv.tenant_id, conv.oh_session_id
                                )
                            # Workspace archive hook ④: flush the orphaned
                            # workspace to its archive before reclaiming it.
                            await workspace_store.stage_out(
                                conv.tenant_id,
                                sid,
                                entry,
                                oh_session_id=conv.oh_session_id or "",
                                session_status="closed",
                            )
                        except Exception:
                            log.warning("orphan stage-out failed (sid=%s)", sid)
                    # Blocking rmtree offloaded to the threadpool (SS-17).
                    await run_in_threadpool(shutil.rmtree, entry, ignore_errors=True)
                    cleaned += 1
                    if conv is not None:
                        conv.workspace_path = None
                        await db.commit()
        if cleaned:
            log.info("orphan scan cleaned %d stale workspace(s)", cleaned)
        return cleaned


# Module-level singleton (the gateway is single-process per node; multi-node
# affinity is handled by the Redis routing table + reverse proxy in Phase 3).
supervisor = SessionSupervisor()


def get_supervisor() -> SessionSupervisor:
    return supervisor
