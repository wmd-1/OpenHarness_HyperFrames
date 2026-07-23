"""Bounded per-session log stream backed by Redis Streams (spec: 5.8 / R).

Non-protocol stdout lines (diagnostics) are appended to a Redis Stream keyed
``oh:session:logs:<sid>`` with ``XADD MAXLEN ~ N approximate=True`` so a verbose
session cannot grow the stream without bound. Tail reads use
``XREVRANGE ... COUNT N`` (most-recent first).

Mirrors the ``service/`` SSE log pattern but adapted for sessions.
"""

from __future__ import annotations

import logging
from typing import Any

import redis.asyncio as aioredis

from app.config import settings

log = logging.getLogger(__name__)

_STREAM_KEY_PREFIX = "oh:session:logs:"
_LOG_FIELD = "line"


def _stream_key(session_id: str) -> str:
    return f"{_STREAM_KEY_PREFIX}{session_id}"


async def _client() -> aioredis.Redis:
    return aioredis.from_url(settings.broker_url, decode_responses=True)


async def append_log(session_id: str, line: str) -> None:
    """Append one diagnostic line to the bounded session log stream.

    Failures are logged and swallowed — a Redis outage must not crash a turn.
    """
    if not line:
        return
    try:
        r = await _client()
        try:
            await r.xadd(
                _stream_key(session_id),
                {_LOG_FIELD: line},
                maxlen=settings.log_stream_maxlen,
                approximate=True,
            )
        finally:
            await r.aclose()
    except Exception as exc:
        log.debug("log append failed (sid=%s): %s", session_id, exc)


async def tail_logs(session_id: str, count: int | None = None) -> list[str]:
    """Return up to ``count`` most-recent log lines (newest first)."""
    n = count if count is not None else settings.log_stream_maxlen
    try:
        r = await _client()
        try:
            entries: list[tuple[str, dict[str, Any]]] = await r.xrevrange(
                _stream_key(session_id), count=n
            )
        finally:
            await r.aclose()
    except Exception as exc:
        log.debug("log tail failed (sid=%s): %s", session_id, exc)
        return []
    out: list[str] = []
    for _entry_id, fields in entries:
        val = fields.get(_LOG_FIELD, "")
        if isinstance(val, bytes):
            val = val.decode("utf-8", errors="replace")
        out.append(str(val))
    return out


async def clear_logs(session_id: str) -> None:
    """Delete the session log stream (called on DELETE)."""
    try:
        r = await _client()
        try:
            await r.delete(_stream_key(session_id))
        finally:
            await r.aclose()
    except Exception:
        pass
