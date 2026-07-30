"""F9: strictly monotonic per-session epoch (change fix-session-review-2026-07).

``next_epoch`` moved from ``int(time.time()*1000)`` (could tie within the same
millisecond or regress on a clock jump) to a per-session Redis ``INCR`` counter
seeded once to ``max(now_ms, existing route epoch)``. Fencing comparisons are
equality-based, so ties were enough to defeat the fence.
"""

from __future__ import annotations

import time

import pytest

from app.session import registry
from app.session.registry import RouteEntry


@pytest.mark.asyncio
async def test_next_epoch_strictly_increasing_back_to_back():
    sid = "sid-epoch-incr"
    e1 = await registry.next_epoch(sid)
    e2 = await registry.next_epoch(sid)
    e3 = await registry.next_epoch(sid)
    # Strict — even back-to-back calls inside one millisecond never tie.
    assert e1 < e2 < e3


@pytest.mark.asyncio
async def test_next_epoch_seeds_above_legacy_route_epoch():
    """A legacy time-based epoch already in the route table is never regressed
    below: the counter is seeded from it, so the next epoch is strictly greater."""
    sid = "sid-epoch-seed"
    legacy = int(time.time() * 1000) + 10_000_000  # far ahead of now_ms
    r = await registry._client()
    entry = RouteEntry(node_id="other-node", pid=1, epoch=legacy)
    await r.set(registry._route_key(sid), entry.to_json())

    assert await registry.next_epoch(sid) > legacy


@pytest.mark.asyncio
async def test_clear_route_drops_epoch_counter():
    sid = "sid-epoch-clear"
    await registry.next_epoch(sid)
    r = await registry._client()
    assert await r.get(registry._epoch_key(sid)) is not None

    await registry.clear_route(sid)
    assert await r.get(registry._epoch_key(sid)) is None
    assert await r.get(registry._route_key(sid)) is None


@pytest.mark.asyncio
async def test_next_epoch_falls_back_to_timestamp_when_redis_down(monkeypatch):
    async def _broken_client():
        raise ConnectionError("redis down")

    monkeypatch.setattr(registry, "_client", _broken_client)
    before = int(time.time() * 1000)
    epoch = await registry.next_epoch("sid-epoch-down")
    after = int(time.time() * 1000)
    assert before <= epoch <= after
