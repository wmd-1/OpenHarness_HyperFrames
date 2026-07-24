"""Unit tests for supervisor capacity eviction ordering (spec 4.4).

Verifies that when the node is at capacity, `_ensure_capacity` evicts the
longest-idle session rather than an arbitrary registry-order candidate.
"""
import time
import uuid
from pathlib import Path

import pytest

from app.config import settings
from app.session.lifecycle import SessionState
from app.session.supervisor import LiveSession, SessionSupervisor


def _make_live(suffix: str, idle_since: float | None) -> LiveSession:
    live = LiveSession(
        sid=uuid.uuid4(),
        tenant_id="default",
        cwd=Path("/tmp"),
        oh_session_id=f"oh-{suffix}",
        permission_policy="full_auto",
        extra_args=[],
        epoch=1,
    )
    live.process = object()  # non-None -> is_live() returns True
    live.state = SessionState.LIVE
    live.ws_connections = set()
    live._busy = False
    live.idle_since = idle_since
    return live


@pytest.mark.asyncio
async def test_evict_longest_idle_on_capacity(monkeypatch):
    """At capacity, evict the longest-idle session; never one that has
    never gone idle (idle_since is None ranks last)."""
    monkeypatch.setattr(settings, "max_live_sessions", 1)

    sup = SessionSupervisor()
    now = time.monotonic()
    s_old = _make_live("old", now - 100.0)  # idle the longest
    s_mid = _make_live("mid", now - 50.0)
    s_new = _make_live("new", None)  # recent, never idle-ranked
    sup._sessions = {s.sid: s for s in (s_old, s_mid, s_new)}

    evicted: list[LiveSession] = []

    async def _fake_evict(live: LiveSession) -> None:
        evicted.append(live)

    sup._evict = _fake_evict

    await sup._ensure_capacity()

    assert evicted == [s_old]
