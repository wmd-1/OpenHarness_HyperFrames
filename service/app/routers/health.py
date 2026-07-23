"""/healthz and /readyz endpoints (scale-multi-instance Phase 5).

Separation of concerns (X8/O1):
- ``/healthz`` — liveness probe. Always 200 while the process is up. Reports
  dependency status in the body (ok/degraded) but never returns 5xx.
- ``/readyz`` — readiness probe. Returns 503 when Redis or DB is down so the
  load balancer stops routing traffic to a degraded replica.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Response
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import engine
from app.deps import get_db
from app.models import TaskStatus, VideoTask
from app.schemas import HealthResponse, ReadyResponse

router = APIRouter(tags=["health"])


async def _db_ok() -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


async def _redis_ok() -> bool:
    """Async Redis ping with a 2s timeout (X8).

    Uses ``redis.asyncio`` so the event loop is not blocked by a sync
    ``ping()`` call. Returns ``False`` on any failure (connection refused,
    timeout, etc.).
    """
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


async def _s3_ok() -> bool | None:
    """Return None when not on S3; True/False when an S3 probe succeeds/fails.

    A failing probe degrades ``/healthz`` but never makes it fatal (R8).

    The probe is a blocking boto3 call, so it is run off the event loop with a
    hard 2s cap. This guarantees ``/healthz`` degrades within ~2s (instead of
    hanging for the full client timeout) even when the S3 endpoint is
    unreachable / blackholed (R8/R11).
    """
    if settings.storage_kind != "s3":
        return None
    try:
        from app.deps import storage_for_kind

        storage = storage_for_kind("s3")

        def _probe() -> bool:
            try:
                storage.exists("__health_probe__")
                return True
            except Exception:
                return False

        return await asyncio.wait_for(asyncio.to_thread(_probe), timeout=2.0)
    except Exception:
        return False


@router.get("/healthz", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Liveness probe. Always 200 — dependency status is reported in the body.

    ``/healthz`` never returns 5xx so the orchestrator does not restart the
    process during a transient Redis/DB outage (X8/O1).
    """
    db_status = "ok" if await _db_ok() else "error"
    redis_status = "ok" if await _redis_ok() else "error"
    s3_status = await _s3_ok()
    s3_field = None if s3_status is None else ("ok" if s3_status else "error")

    overall = "ok"
    if db_status == "error" or redis_status == "error" or s3_field == "error":
        overall = "degraded"

    return HealthResponse(status=overall, db=db_status, redis=redis_status, s3=s3_field)


@router.get("/readyz", response_model=ReadyResponse)
async def ready_check(
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> ReadyResponse:
    """Readiness probe. Returns 503 when Redis or DB is down (O1).

    When dependencies are healthy, returns 200 with queue-consumption stats
    (pending / running / heartbeat lag). When Redis or DB is unreachable,
    returns 503 so the load balancer stops routing traffic.
    """
    db_ok = await _db_ok()
    redis_ok = await _redis_ok()

    if not db_ok or not redis_ok:
        response.status_code = 503

    pending = await db.scalar(
        select(func.count()).where(VideoTask.status.in_([TaskStatus.QUEUED, TaskStatus.RETRYING]))
    )
    running = await db.scalar(
        select(func.count()).where(VideoTask.status == TaskStatus.RUNNING)
    )
    last_beat = await db.scalar(
        select(func.max(VideoTask.heartbeat_at)).where(VideoTask.status == TaskStatus.RUNNING)
    )

    lag: float | None = None
    if last_beat is not None:
        lb = last_beat
        if lb.tzinfo is None:
            lb = lb.replace(tzinfo=timezone.utc)
        lag = (datetime.now(timezone.utc) - lb).total_seconds()

    return ReadyResponse(
        status="ok" if (db_ok and redis_ok) else "degraded",
        pending=int(pending or 0),
        running=int(running or 0),
        heartbeat_lag_seconds=float(lag) if lag is not None else None,
    )
