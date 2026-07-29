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
