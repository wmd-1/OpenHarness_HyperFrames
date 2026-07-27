"""Redis-backed token-bucket rate limiter (fail-open).

Mirrors ``service/app/ratelimit.py``. Applied to ``POST /v1/sessions`` and WS
handshake establishment (spec: Session creation MUST be rate-limited).

Hardening (harden-session-service):
- SS-12: uses the async ``redis.asyncio`` client (no sync Redis calls that
  would block the event loop).
- SS-9: the bucket read-modify-write runs as a single atomic Lua script so
  concurrent requests cannot race between HGETALL and HSET.
- SS-5: ``X-Forwarded-For`` is only honored when the direct peer is a
  configured trusted proxy (``OH_TRUSTED_PROXY``); otherwise the socket peer
  address is used, so clients cannot forge their rate-limit key.

Fail-open: a Redis outage never takes the API offline (returns True).
"""

from __future__ import annotations

import logging
import time

import redis.asyncio as aioredis

from app.config import settings

logger = logging.getLogger(__name__)

_redis: aioredis.Redis | None = None

# Atomic token bucket (SS-9). KEYS[1] = bucket key.
# ARGV = capacity, refill_per_sec, now, ttl. Returns 1 if allowed else 0.
_TOKEN_BUCKET_LUA = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local bucket = redis.call('hmget', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])
if tokens == nil then tokens = capacity end
if ts == nil then ts = now end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = tokens + elapsed * refill
if tokens > capacity then tokens = capacity end

local allowed = 0
if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
end

redis.call('hset', key, 'tokens', tokens, 'ts', now)
redis.call('expire', key, ttl)
return allowed
"""


def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(
            settings.broker_url,
            decode_responses=True,
            max_connections=32,
        )
    return _redis


async def close_redis() -> None:
    """Dispose the shared pool (shutdown hook / tests)."""
    global _redis
    if _redis is not None:
        try:
            await _redis.aclose()
        except Exception:
            pass
        _redis = None


def _trusted_proxies() -> set[str]:
    return {p.strip() for p in settings.trusted_proxy.split(",") if p.strip()}


def _client_ip(request) -> str:
    """Extract the client IP for rate-limit keying (SS-5).

    ``X-Forwarded-For`` is honored only when the direct peer is a configured
    trusted proxy; unverified XFF headers are ignored so clients cannot forge
    their bucket key.
    """
    peer = request.client.host if request.client else "unknown"
    fwd = request.headers.get("X-Forwarded-For")
    if fwd and peer in _trusted_proxies():
        return fwd.split(",")[0].strip()
    return peer


async def check_rate_limit(client_ip: str) -> bool:
    """Return True if a token is available (allowed), False if rate-limited.

    Token-bucket per IP, executed atomically via Lua (SS-9); fail-open on
    Redis error.
    """
    try:
        r = _get_redis()
        key = f"oh:session:ratelimit:{client_ip}"
        ttl = int(settings.rate_limit_capacity / settings.rate_limit_refill) + 10
        allowed = await r.eval(
            _TOKEN_BUCKET_LUA,
            1,
            key,
            settings.rate_limit_capacity,
            settings.rate_limit_refill,
            time.time(),
            ttl,
        )
        return bool(int(allowed))
    except Exception:
        logger.warning(
            "Rate limiter Redis error for ip=%s — failing open", client_ip
        )
        return True
