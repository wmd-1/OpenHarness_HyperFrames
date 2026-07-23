"""Redis-backed token-bucket rate limiter (fail-open).

Mirrors ``service/app/ratelimit.py``. Applied to ``POST /v1/sessions`` and WS
handshake establishment (spec: Session creation MUST be rate-limited).

Fail-open: a Redis outage never takes the API offline (returns True).
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


def check_rate_limit(client_ip: str) -> bool:
    """Return True if a token is available (allowed), False if rate-limited.

    Token-bucket per IP; fail-open on Redis error.
    """
    try:
        r = _get_redis()
        key = f"oh:session:ratelimit:{client_ip}"
        now = time.time()

        bucket = r.hgetall(key)
        if not bucket:
            tokens = float(settings.rate_limit_capacity)
            ts = now
        else:
            raw_tokens = bucket.get(b"tokens") or bucket.get("tokens")
            raw_ts = bucket.get(b"ts") or bucket.get("ts")
            tokens = (
                float(raw_tokens)
                if raw_tokens is not None
                else float(settings.rate_limit_capacity)
            )
            ts = float(raw_ts) if raw_ts is not None else now

        elapsed = max(0.0, now - ts)
        tokens = min(
            float(settings.rate_limit_capacity),
            tokens + elapsed * settings.rate_limit_refill,
        )

        if tokens >= 1:
            tokens -= 1
            allowed = True
        else:
            allowed = False

        r.hset(key, mapping={"tokens": tokens, "ts": now})
        ttl = int(settings.rate_limit_capacity / settings.rate_limit_refill) + 10
        r.expire(key, ttl)
        return allowed
    except Exception:
        logger.warning(
            "Rate limiter Redis error for ip=%s — failing open", client_ip
        )
        return True
