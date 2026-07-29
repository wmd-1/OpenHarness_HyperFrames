"""Unit tests for the WS-D slot pool (spec session-pool-scheduling + tasks 4.4).

Covers: evict-then-claim at capacity, queue-then-wake on release, queue
timeout (with Retry-After via HTTP), queue-full rejection, single-tenant
queue flooding, queue_size=0 fail-fast degradation, and pool metrics.
"""

from __future__ import annotations

import asyncio

import pytest
from prometheus_client import REGISTRY

from app.config import settings
from app.session import pool as pool_module
from app.session.pool import (
    CapacityFullError,
    ContainerPool,
    QueueFullError,
    QueueTimeoutError,
    TenantQuotaExceeded,
)


@pytest.fixture(autouse=True)
def _fake_backend(monkeypatch):
    """Stub the runtime factory: acquire returns a plain sentinel object."""
    monkeypatch.setattr(pool_module, "make_backend", lambda **_k: object())


@pytest.fixture(autouse=True)
def _pool_settings(monkeypatch):
    """Small, deterministic pool bounds for every test in this module."""
    monkeypatch.setattr(settings, "max_live_sessions", 1)
    monkeypatch.setattr(settings, "tenant_max_concurrent", 1)
    monkeypatch.setattr(settings, "pool_queue_size", 4)
    monkeypatch.setattr(settings, "pool_queue_timeout", 0.3)


def _counter(name: str, **labels) -> float:
    return REGISTRY.get_sample_value(name, labels or None) or 0.0


@pytest.mark.asyncio
async def test_capacity_full_evicts_then_claims():
    """Stage 3: at capacity, the eviction hook frees a slot for the newcomer."""
    pool = ContainerPool()
    evictions = 0

    async def _evict_one() -> bool:
        nonlocal evictions
        evictions += 1
        await pool.release("sid-a")  # supervisor._evict releases the slot
        return True

    pool._evict_one = _evict_one
    await pool.acquire("tenant-a", "sid-a")
    before = _counter("oh_pool_evictions_total")
    await pool.acquire("tenant-b", "sid-b")
    assert evictions == 1
    assert pool.holds("sid-b") and not pool.holds("sid-a")
    assert _counter("oh_pool_evictions_total") == before + 1


@pytest.mark.asyncio
async def test_nothing_evictable_queues_then_release_wakes():
    """Stage 4: no evictable session -> FIFO queue; a freed slot wakes the head."""

    async def _nothing(_pool=None) -> bool:
        return False

    pool = ContainerPool(evict_one=_nothing)
    await pool.acquire("tenant-a", "sid-a")

    task = asyncio.create_task(pool.acquire("tenant-b", "sid-b"))
    await asyncio.sleep(0.05)
    assert not task.done()
    assert pool.queue_depth() == 1

    await pool.release("sid-a")
    await asyncio.wait_for(task, timeout=1.0)
    assert pool.holds("sid-b")
    assert pool.queue_depth() == 0


@pytest.mark.asyncio
async def test_queue_grants_are_fifo():
    """Two waiters (distinct tenants): the freed slot goes to the queue head."""
    pool = ContainerPool()
    await pool.acquire("tenant-a", "sid-a")
    first = asyncio.create_task(pool.acquire("tenant-b", "sid-b"))
    await asyncio.sleep(0.02)
    second = asyncio.create_task(pool.acquire("tenant-c", "sid-c"))
    await asyncio.sleep(0.02)

    await pool.release("sid-a")
    await asyncio.wait_for(first, timeout=1.0)
    assert pool.holds("sid-b")
    assert not second.done()  # still queued, strictly behind the head

    await pool.release("sid-b")
    await asyncio.wait_for(second, timeout=1.0)
    assert pool.holds("sid-c")


@pytest.mark.asyncio
async def test_queue_timeout_raises_with_retry_after():
    """Waiting longer than pool_queue_timeout -> QueueTimeoutError (503 upstream)."""
    pool = ContainerPool()
    await pool.acquire("tenant-a", "sid-a")
    before = _counter("oh_pool_admission_rejected_total", reason="queue_timeout")
    with pytest.raises(QueueTimeoutError) as exc:
        await pool.acquire("tenant-b", "sid-b")
    assert exc.value.retry_after >= 1
    assert pool.queue_depth() == 0  # timed-out waiter fully withdrawn
    assert _counter("oh_pool_admission_rejected_total", reason="queue_timeout") == before + 1


@pytest.mark.asyncio
async def test_queue_full_rejects_immediately(monkeypatch):
    """A queue at pool_queue_size rejects new waiters without enqueueing."""
    monkeypatch.setattr(settings, "pool_queue_size", 1)
    pool = ContainerPool()
    await pool.acquire("tenant-a", "sid-a")
    waiter = asyncio.create_task(pool.acquire("tenant-b", "sid-b"))
    await asyncio.sleep(0.02)
    before = _counter("oh_pool_admission_rejected_total", reason="queue_full")
    with pytest.raises(QueueFullError) as exc:
        await pool.acquire("tenant-c", "sid-c")
    assert exc.value.retry_after >= 1
    assert _counter("oh_pool_admission_rejected_total", reason="queue_full") == before + 1
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter


@pytest.mark.asyncio
async def test_tenant_cannot_flood_the_queue():
    """A tenant at tenant_max_concurrent queue slots is rejected, not enqueued."""
    pool = ContainerPool()
    await pool.acquire("tenant-a", "sid-a")
    waiter = asyncio.create_task(pool.acquire("tenant-b", "sid-b1"))
    await asyncio.sleep(0.02)
    with pytest.raises(TenantQuotaExceeded):
        await pool.acquire("tenant-b", "sid-b2")  # second queue slot for tenant-b
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert pool.queue_depth() == 0


@pytest.mark.asyncio
async def test_tenant_live_quota_rejected_before_queue():
    """Stage 1: a tenant holding tenant_max_concurrent live slots gets 429."""
    pool = ContainerPool()
    await pool.acquire("tenant-a", "sid-a")
    before = _counter("oh_pool_admission_rejected_total", reason="tenant_quota")
    with pytest.raises(TenantQuotaExceeded):
        await pool.acquire("tenant-a", "sid-a2")
    assert _counter("oh_pool_admission_rejected_total", reason="tenant_quota") == before + 1


@pytest.mark.asyncio
async def test_queue_size_zero_degrades_to_fail_fast(monkeypatch):
    """queue_size=0: full + nothing evictable -> CapacityFullError (plain 503)."""
    monkeypatch.setattr(settings, "pool_queue_size", 0)

    async def _nothing() -> bool:
        return False

    pool = ContainerPool(evict_one=_nothing)
    await pool.acquire("tenant-a", "sid-a")
    with pytest.raises(CapacityFullError):
        await pool.acquire("tenant-b", "sid-b")


@pytest.mark.asyncio
async def test_backends_live_gauge_tracks_slots():
    pool = ContainerPool()
    base = REGISTRY.get_sample_value("oh_pool_backends_live") or 0.0
    await pool.acquire("tenant-a", "sid-a")
    assert REGISTRY.get_sample_value("oh_pool_backends_live") == base + 1
    await pool.release("sid-a")
    assert REGISTRY.get_sample_value("oh_pool_backends_live") == base
    # Double release is a no-op (idempotent slot accounting).
    await pool.release("sid-a")
    assert REGISTRY.get_sample_value("oh_pool_backends_live") == base


# --- session-history-switch: same-tenant idle yield (stage 1b) -----------------


@pytest.mark.asyncio
async def test_tenant_quota_evicts_same_tenant_idle_then_claims():
    """Quota miss triggers the tenant hook; the freed slot lets the retry claim."""
    calls: list[str] = []
    pool: ContainerPool | None = None

    async def _yield_idle(tenant_id: str) -> bool:
        calls.append(tenant_id)
        assert pool is not None
        await pool.release("sid-a")  # supervisor._evict frees the slot
        return True

    pool = ContainerPool(evict_tenant_idle=_yield_idle)
    await pool.acquire("tenant-a", "sid-a")
    before = _counter("oh_pool_evictions_total")
    await pool.acquire("tenant-a", "sid-b")
    assert calls == ["tenant-a"]
    assert pool.holds("sid-b") and not pool.holds("sid-a")
    assert pool.tenant_slot_count("tenant-a") == 1
    assert _counter("oh_pool_evictions_total") == before + 1


@pytest.mark.asyncio
async def test_tenant_quota_hook_false_raises_and_never_queues():
    """A False hook result (no candidate / internal failure) keeps the existing
    rejection semantics: TenantQuotaExceeded, never the capacity queue."""
    calls = 0

    async def _no_candidate(_tenant_id: str) -> bool:
        nonlocal calls
        calls += 1
        return False

    pool = ContainerPool(evict_tenant_idle=_no_candidate)
    await pool.acquire("tenant-a", "sid-a")
    with pytest.raises(TenantQuotaExceeded):
        await pool.acquire("tenant-a", "sid-b")
    assert calls == 1
    assert pool.queue_depth() == 0  # quota-limited tenants never enqueue


@pytest.mark.asyncio
async def test_tenant_quota_evict_retry_is_bounded():
    """A lying hook (True but nothing freed) cannot loop: the shared
    _EVICT_ATTEMPTS bound raises on the final attempt without calling it."""
    calls = 0

    async def _lies(_tenant_id: str) -> bool:
        nonlocal calls
        calls += 1
        return True

    pool = ContainerPool(evict_tenant_idle=_lies)
    await pool.acquire("tenant-a", "sid-a")
    with pytest.raises(TenantQuotaExceeded):
        await pool.acquire("tenant-a", "sid-b")
    assert calls == pool_module._EVICT_ATTEMPTS - 1


@pytest.mark.asyncio
async def test_tenant_yield_does_not_jump_the_queue():
    """A slot freed by a same-tenant yield is handed to the queue head first
    (strict FIFO): the yielding tenant's own retry cannot overtake a waiter."""
    pool: ContainerPool | None = None

    async def _yield_idle(_tenant_id: str) -> bool:
        assert pool is not None
        await pool.release("sid-a")
        return True

    pool = ContainerPool(evict_tenant_idle=_yield_idle)
    await pool.acquire("tenant-a", "sid-a")
    waiter = asyncio.create_task(pool.acquire("tenant-b", "sid-b"))
    await asyncio.sleep(0.02)
    assert pool.queue_depth() == 1

    # tenant-a's yield frees a slot, but the queue head (tenant-b) gets it;
    # the retry then sees capacity full again and ends up queue-timing out.
    with pytest.raises(QueueTimeoutError):
        await pool.acquire("tenant-a", "sid-a2")
    await asyncio.wait_for(waiter, timeout=1.0)
    assert pool.holds("sid-b") and not pool.holds("sid-a2")


@pytest.mark.asyncio
async def test_create_503_retry_after_on_queue_timeout(client, monkeypatch):
    """HTTP mapping (task 4.2): queue timeout -> 503 with a Retry-After header."""
    monkeypatch.setattr(settings, "max_live_sessions", 0)
    monkeypatch.setattr(settings, "pool_queue_size", 4)
    monkeypatch.setattr(settings, "pool_queue_timeout", 0.2)
    resp = await client.post(
        "/v1/sessions", json={}, headers={"X-Forwarded-For": "203.0.113.77"}
    )
    assert resp.status_code == 503
    assert "Retry-After" in resp.headers
    assert int(resp.headers["Retry-After"]) >= 1
