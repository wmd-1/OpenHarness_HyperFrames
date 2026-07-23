"""Multi-node session affinity routing (spec D4 / Phase 3).

A Redis routing table ``session:route:<sid>`` records ``{node_id, pid, epoch}``
with a heartbeat TTL. On connect a gateway serves locally if it owns the
process; if another node owns it the gateway transparently reverse-proxies the
connection to the owning node (no client-facing redirect). A single-writer lock
``session:lock:<sid>`` serializes cold rehydration so two nodes cannot
concurrently ``--resume`` the same ``cwd``.

This module is Redis-backed and degrades gracefully: when Redis is unavailable
the gateway falls back to single-node behavior (serve locally).
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

import redis.asyncio as aioredis

from app.config import settings

log = logging.getLogger(__name__)

_ROUTE_PREFIX = "session:route:"
_LOCK_PREFIX = "session:lock:"


@dataclass
class RouteEntry:
    node_id: str
    pid: int
    epoch: int

    def to_json(self) -> str:
        return json.dumps(
            {"node_id": self.node_id, "pid": self.pid, "epoch": self.epoch}
        )

    @classmethod
    def from_json(cls, raw: str) -> "RouteEntry":
        data = json.loads(raw)
        return cls(
            node_id=data["node_id"], pid=int(data["pid"]), epoch=int(data["epoch"])
        )


async def _client() -> aioredis.Redis:
    return aioredis.from_url(settings.broker_url, decode_responses=True)


def _route_key(sid: str) -> str:
    return f"{_ROUTE_PREFIX}{sid}"


def _lock_key(sid: str) -> str:
    return f"{_LOCK_PREFIX}{sid}"


def _node_id() -> str:
    return settings.node_id or "local"


async def register_route(sid: str, pid: int, epoch: int) -> None:
    """Publish/refresh this node's ownership of ``sid`` with a TTL."""
    try:
        r = await _client()
        try:
            entry = RouteEntry(node_id=_node_id(), pid=pid, epoch=epoch)
            await r.set(
                _route_key(sid), entry.to_json(), ex=settings.route_ttl_seconds
            )
        finally:
            await r.aclose()
    except Exception as exc:
        log.debug("register_route failed (sid=%s): %s", sid, exc)


async def heartbeat_route(sid: str, pid: int, epoch: int) -> None:
    """Refresh the TTL on an existing route (alias of register_route)."""
    await register_route(sid, pid, epoch)


async def get_route(sid: str) -> RouteEntry | None:
    try:
        r = await _client()
        try:
            raw = await r.get(_route_key(sid))
        finally:
            await r.aclose()
        if not raw:
            return None
        return RouteEntry.from_json(raw)
    except Exception as exc:
        log.debug("get_route failed (sid=%s): %s", sid, exc)
        return None


async def clear_route(sid: str) -> None:
    try:
        r = await _client()
        try:
            await r.delete(_route_key(sid))
        finally:
            await r.aclose()
    except Exception:
        pass


async def owns_locally(sid: str, pid: int, epoch: int) -> bool:
    """True if the route table points at this node+pid+epoch."""
    entry = await get_route(sid)
    if entry is None:
        return True  # no route published -> assume local (single-node)
    return entry.node_id == _node_id() and entry.pid == pid and entry.epoch == epoch


async def acquire_lock(sid: str, holder: str, ttl: int = 60) -> bool:
    """Try to acquire the single-writer rehydration lock.

    Returns True if acquired. The lock is released on DELETE or after ``ttl``.
    """
    try:
        r = await _client()
        try:
            ok = await r.set(_lock_key(sid), holder, nx=True, ex=ttl)
        finally:
            await r.aclose()
        return bool(ok)
    except Exception as exc:
        log.debug("acquire_lock failed (sid=%s): %s", sid, exc)
        return True  # fail-open: allow local rehydration when Redis is down


async def release_lock(sid: str, holder: str) -> None:
    try:
        r = await _client()
        try:
            current = await r.get(_lock_key(sid))
            if current == holder:
                await r.delete(_lock_key(sid))
        finally:
            await r.aclose()
    except Exception:
        pass


async def next_epoch(sid: str) -> int:
    """Return a monotonically increasing epoch for ``sid`` (time-based)."""
    return int(time.time() * 1000)
