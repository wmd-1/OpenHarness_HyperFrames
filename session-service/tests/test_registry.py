"""Tests for app.session.registry — routing table + rehydration lock (Task 3.2).

Covers: route register/heartbeat/get/clear, lock acquire success/contention,
atomic Lua lock release (SS-7), and the module-level connection pool
singleton (SS-2).
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.session import registry
from app.session.registry import RouteEntry

# Captured at import (collection) time, BEFORE the autouse _fakeredis fixture
# monkeypatches ``registry._client`` — this is the real singleton factory.
_REAL_CLIENT = registry._client


@pytest.mark.asyncio
async def test_register_and_get_route_roundtrip():
    await registry.register_route("sid-1", pid=123, epoch=7)
    entry = await registry.get_route("sid-1")
    assert entry is not None
    assert entry.node_id == settings.node_id
    assert entry.pid == 123
    assert entry.epoch == 7


@pytest.mark.asyncio
async def test_get_route_missing_returns_none():
    assert await registry.get_route("no-such-sid") is None


@pytest.mark.asyncio
async def test_heartbeat_refreshes_route_ttl():
    await registry.register_route("sid-hb", pid=1, epoch=1)
    r = await registry._client()
    ttl_before = await r.ttl(registry._route_key("sid-hb"))
    assert ttl_before > 0
    # Heartbeat re-publishes the entry with a fresh TTL.
    await registry.heartbeat_route("sid-hb", pid=1, epoch=1)
    ttl_after = await r.ttl(registry._route_key("sid-hb"))
    assert 0 < ttl_after <= settings.route_ttl_seconds


@pytest.mark.asyncio
async def test_clear_route():
    await registry.register_route("sid-clear", pid=1, epoch=1)
    await registry.clear_route("sid-clear")
    assert await registry.get_route("sid-clear") is None


@pytest.mark.asyncio
async def test_owns_locally():
    # No route published -> assume local.
    assert await registry.owns_locally("sid-own", pid=1, epoch=1) is True
    await registry.register_route("sid-own", pid=1, epoch=1)
    assert await registry.owns_locally("sid-own", pid=1, epoch=1) is True
    # Same node but different pid -> not ours.
    assert await registry.owns_locally("sid-own", pid=2, epoch=1) is False
    # Route owned by another node -> not ours.
    r = await registry._client()
    entry = RouteEntry(node_id="other-node", pid=1, epoch=1)
    await r.set(registry._route_key("sid-own"), entry.to_json())
    assert await registry.owns_locally("sid-own", pid=1, epoch=1) is False


@pytest.mark.asyncio
async def test_acquire_lock_success_and_contention():
    assert await registry.acquire_lock("sid-lock", "holder-a") is True
    # Second holder cannot steal a held lock.
    assert await registry.acquire_lock("sid-lock", "holder-b") is False
    await registry.release_lock("sid-lock", "holder-a")
    assert await registry.acquire_lock("sid-lock", "holder-b") is True


@pytest.mark.asyncio
async def test_release_lock_lua_is_atomic_holder_checked():
    """SS-7: release only deletes the lock when the caller still holds it."""
    assert await registry.acquire_lock("sid-atomic", "holder-a") is True
    # Holder B tries to release A's lock -> no-op, A still holds it.
    await registry.release_lock("sid-atomic", "holder-b")
    r = await registry._client()
    assert await r.get(registry._lock_key("sid-atomic")) == "holder-a"
    # Holder A releases its own lock -> gone.
    await registry.release_lock("sid-atomic", "holder-a")
    assert await r.get(registry._lock_key("sid-atomic")) is None


@pytest.mark.asyncio
async def test_client_is_connection_pool_singleton():
    """SS-2: repeated _client() calls reuse one module-level client/pool."""
    saved = registry._redis
    registry._redis = None
    try:
        c1 = await _REAL_CLIENT()
        c2 = await _REAL_CLIENT()
        assert c1 is c2
        await registry.close_client()
        assert registry._redis is None
    finally:
        registry._redis = saved


@pytest.mark.asyncio
async def test_next_epoch_monotonic():
    e1 = await registry.next_epoch("sid-e")
    e2 = await registry.next_epoch("sid-e")
    assert e2 >= e1 > 0
