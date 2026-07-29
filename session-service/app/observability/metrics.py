"""Prometheus metrics for the session service.

Exposes session-specific gauges (live sessions, in-flight turns) plus a
``/metrics`` scrape endpoint. Mirrors ``service/app/observability/metrics.py``.
"""

from __future__ import annotations

import time
from contextlib import contextmanager

from fastapi import APIRouter, Response
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

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

TENANT_SYNC_FAILURES = Counter(
    "oh_tenant_sync_failures_total",
    "Tenant stage-in/stage-out mirror operations that exhausted retries.",
    labelnames=("direction",),  # "in" | "out"
)

# --- Pool scheduling (WS-D, spec session-pool-scheduling) -------------------

POOL_BACKENDS_LIVE = Gauge(
    "oh_pool_backends_live",
    "Live-backend slots currently held in the pool on this node.",
)

POOL_QUEUE_DEPTH = Gauge(
    "oh_pool_queue_depth",
    "Requests currently waiting in the pool admission queue.",
)

POOL_QUEUE_WAIT = Histogram(
    "oh_pool_queue_wait_seconds",
    "Time spent waiting in the pool admission queue, in seconds.",
    buckets=(0.1, 0.5, 1, 2, 5, 10, 15, 30, 60),
)

POOL_EVICTIONS = Counter(
    "oh_pool_evictions_total",
    "Sessions evicted to COLD by the pool to free a live slot.",
)

POOL_REJECTED = Counter(
    "oh_pool_admission_rejected_total",
    "Admission requests rejected by the pool, by reason.",
    labelnames=("reason",),  # tenant_quota | queue_full | queue_timeout
)

SESSION_CREATE_DURATION = Histogram(
    "oh_session_create_duration_seconds",
    "End-to-end session creation duration (admission through backend ready), "
    "in seconds. Cold-start P95 feeds the Variant A warm-pool trigger.",
    buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120),
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
