"""Prometheus metrics for the session service.

Exposes session-specific gauges (live sessions, in-flight turns) plus a
``/metrics`` scrape endpoint. Mirrors ``service/app/observability/metrics.py``.
"""

from __future__ import annotations

import time
from contextlib import contextmanager

from fastapi import APIRouter, Response
from prometheus_client import CONTENT_TYPE_LATEST, Gauge, Histogram, generate_latest

SESSIONS_LIVE = Gauge(
    "oh_session_live",
    "Number of live oh --backend-only subprocesses on this node.",
)

TURNS_INFLIGHT = Gauge(
    "oh_session_turns_inflight",
    "Number of turns currently streaming on this node.",
)

TURN_DURATION = Histogram(
    "oh_session_turn_duration_seconds",
    "Wall-clock duration of a single turn, in seconds.",
    buckets=(1, 5, 15, 30, 60, 120, 300, 600, 900),
)


@contextmanager
def track_turn():
    TURNS_INFLIGHT.inc()
    start = time.monotonic()
    try:
        yield
    finally:
        TURNS_INFLIGHT.dec()
        TURN_DURATION.observe(time.monotonic() - start)


metrics_router = APIRouter(tags=["metrics"])


@metrics_router.get("/metrics")
async def metrics() -> Response:
    body = generate_latest()
    return Response(content=body, media_type=CONTENT_TYPE_LATEST)
