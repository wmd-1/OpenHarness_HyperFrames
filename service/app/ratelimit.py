"""Redis-backed token-bucket rate limiter (fail-open).

Provides a global DoS floor on ``POST /v1/videos`` keyed per tenant (R18);
the ``default`` tenant (open / single-key mode) falls back to the client IP
key, preserving the pre-tenant semantics. When Redis is unavailable, the
limiter fails open (allows the request) so a Redis outage does not take the
API offline (S3).
"""

from __future__ import annotations

import logging
import time

import redis as _redis

from app.config import settings

logger = logging.getLogger(__name__)

_pool: _redis.ConnectionPool | None = None


def _get_redis() -> _redis.Redis:
    global _pool
    if _pool is None:
        _pool = _redis.ConnectionPool.from_url(settings.broker_url)
    return _redis.Redis(connection_pool=_pool)


def _client_ip(request) -> str:
    """Extract the client IP, honoring ``X-Forwarded-For`` when present."""
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit_key(tenant_id: str, request) -> str:
    """Bucket key for a submission (R18): per-tenant, IP fallback.

    Non-default tenants get an isolated ``tenant:`` bucket (the prefix keeps
    IP-shaped tenant ids from colliding with IP buckets). The ``default``
    tenant keeps the bare client-IP key so open / single-key deployments
    retain the existing per-IP semantics.
    """
    if tenant_id != "default":
        return f"tenant:{tenant_id}"
    return _client_ip(request)


def check_rate_limit(key: str) -> bool:
    """Return True if a token is available (allowed), False if rate-limited.

    Implements a token-bucket: each key (tenant or client IP, see
    ``rate_limit_key``) gets a bucket with ``capacity`` tokens that refills
    at ``refill`` tokens/second. Each request consumes 1 token.

    Fail-open: if Redis is unreachable, always returns True.
    """
    try:
        r = _get_redis()
        rkey = f"oh:ratelimit:{key}"
        now = time.time()

        # Read current bucket state.
        bucket = r.hgetall(rkey)
        if not bucket:
            tokens = float(settings.rate_limit_capacity)
            ts = now
        else:
            raw_tokens = bucket.get(b"tokens") or bucket.get("tokens")
            raw_ts = bucket.get(b"ts") or bucket.get("ts")
            tokens = float(raw_tokens) if raw_tokens is not None else float(settings.rate_limit_capacity)
            ts = float(raw_ts) if raw_ts is not None else now

        # Refill: add tokens proportional to elapsed time, capped at capacity.
        elapsed = max(0.0, now - ts)
        tokens = min(float(settings.rate_limit_capacity), tokens + elapsed * settings.rate_limit_refill)

        # Try to consume one token.
        if tokens >= 1:
            tokens -= 1
            allowed = True
        else:
            allowed = False

        # Persist bucket state.
        r.hset(rkey, mapping={"tokens": tokens, "ts": now})
        ttl = int(settings.rate_limit_capacity / settings.rate_limit_refill) + 10
        r.expire(rkey, ttl)

        return allowed
    except Exception:
        logger.warning("Rate limiter Redis error for key=%s — failing open", key)
        return True
