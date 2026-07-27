"""Tests for app.session.logs — bounded Redis Stream log tail (Task 3.3).

Covers: XADD MAXLEN bounded append, XREVRANGE COUNT newest-first tail,
clear, empty-line skip, and the connection pool singleton (SS-2).
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.session import logs

# Captured at import (collection) time, BEFORE the autouse _fakeredis fixture
# monkeypatches ``logs._client`` — this is the real singleton factory.
_REAL_CLIENT = logs._client


@pytest.mark.asyncio
async def test_append_and_tail_roundtrip_newest_first():
    for i in range(5):
        await logs.append_log("sid-log", f"line-{i}")
    lines = await logs.tail_logs("sid-log")
    assert len(lines) == 5
    assert lines[0] == "line-4"  # newest first
    assert lines[-1] == "line-0"


@pytest.mark.asyncio
async def test_tail_count_limits_result():
    for i in range(10):
        await logs.append_log("sid-count", f"l{i}")
    lines = await logs.tail_logs("sid-count", count=3)
    assert lines == ["l9", "l8", "l7"]


@pytest.mark.asyncio
async def test_stream_is_bounded_by_maxlen(monkeypatch):
    """XADD MAXLEN ~ N keeps a verbose session from growing without bound."""
    monkeypatch.setattr(settings, "log_stream_maxlen", 5)
    for i in range(50):
        await logs.append_log("sid-bound", f"x{i}")
    r = await logs._client()
    length = await r.xlen(logs._stream_key("sid-bound"))
    assert length < 50  # trimming happened
    lines = await logs.tail_logs("sid-bound")
    assert lines[0] == "x49"


@pytest.mark.asyncio
async def test_empty_line_is_skipped():
    await logs.append_log("sid-empty", "")
    assert await logs.tail_logs("sid-empty") == []


@pytest.mark.asyncio
async def test_clear_logs_deletes_stream():
    await logs.append_log("sid-del", "hello")
    await logs.clear_logs("sid-del")
    assert await logs.tail_logs("sid-del") == []


@pytest.mark.asyncio
async def test_tail_unknown_session_returns_empty():
    assert await logs.tail_logs("never-logged") == []


@pytest.mark.asyncio
async def test_client_is_connection_pool_singleton():
    """SS-2: repeated _client() calls reuse one module-level client/pool."""
    saved = logs._redis
    logs._redis = None
    try:
        c1 = await _REAL_CLIENT()
        c2 = await _REAL_CLIENT()
        assert c1 is c2
        await logs.close_client()
        assert logs._redis is None
    finally:
        logs._redis = saved
