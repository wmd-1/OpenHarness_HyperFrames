"""/healthz and /readyz endpoints (mirrors service/app/routers/health.py).

- ``/healthz``: cheap liveness, always 200 while up.
- ``/readyz``: aggregates DB/Redis/process-pool headroom; 503 when degraded.
  Redis probe is async (``redis.asyncio``) so it never blocks the event loop.
"""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app import db
from app.deps import get_db
from app.schemas import HealthResponse, ReadyResponse
from app.session.supervisor import get_supervisor

router = APIRouter(tags=["health"])

# F10: cache the dependency probe results for a short window so frequent
# liveness/readiness polling (k8s/compose, often 1-2s) does not open a fresh DB
# connection + Redis socket on every hit. Single-threaded asyncio, so a plain
# dict without a lock is sufficient; a rare concurrent double-probe on expiry is
# harmless. Semantics and response bodies are unchanged (healthz stays 200).
_PROBE_TTL_SECONDS = 5.0
_probe_cache: dict[str, tuple[float, bool]] = {}


async def _cached_probe(name: str, probe) -> bool:
    now = time.monotonic()
    cached = _probe_cache.get(name)
    if cached is not None and (now - cached[0]) < _PROBE_TTL_SECONDS:
        return cached[1]
    ok = await probe()
    _probe_cache[name] = (time.monotonic(), ok)
    return ok


async def _db_ok() -> bool:
    async def _probe() -> bool:
        try:
            async with db.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            return True
        except Exception:
            return False

    return await _cached_probe("db", _probe)


async def _redis_ok() -> bool:
    async def _probe() -> bool:
        try:
            import redis.asyncio as aioredis

            r = aioredis.from_url(settings.broker_url, socket_timeout=2, socket_connect_timeout=2)
            try:
                await asyncio.wait_for(r.ping(), timeout=2.0)
                return True
            finally:
                await r.aclose()
        except Exception:
            return False

    return await _cached_probe("redis", _probe)


@router.get("/healthz", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Liveness probe — always 200; dependency status reported in the body."""
    db_status = "ok" if await _db_ok() else "error"
    redis_status = "ok" if await _redis_ok() else "error"
    overall = "ok" if (db_status == "ok" and redis_status == "ok") else "degraded"
    return HealthResponse(status=overall, db=db_status, redis=redis_status)


@router.get("/readyz", response_model=ReadyResponse)
async def ready_check(response: Response, db: AsyncSession = Depends(get_db)) -> ReadyResponse:
    """Readiness probe — 503 when DB/Redis down or process pool saturated."""
    db_ok = await _db_ok()
    redis_ok = await _redis_ok()
    sup = get_supervisor()
    headroom = sup.capacity - sup.live_count()

    if not db_ok or not redis_ok or headroom <= 0:
        response.status_code = 503

    return ReadyResponse(
        status="ok" if (db_ok and redis_ok and headroom > 0) else "degraded",
        db="ok" if db_ok else "error",
        redis="ok" if redis_ok else "error",
        live_sessions=sup.live_count(),
        capacity=sup.capacity,
    )
