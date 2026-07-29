"""Unit tests for supervisor capacity eviction ordering (spec 4.4).

Verifies that the pool eviction hook `_evict_longest_idle` evicts the
longest-idle session rather than an arbitrary registry-order candidate.
"""
import asyncio
import time
import uuid
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.config import settings
from app.models import Conversation, SessionStatus
from app.session import pool as pool_module
from app.session.lifecycle import SessionState
from app.session.pool import TenantQuotaExceeded
from app.session.supervisor import LiveSession, SessionSupervisor


def _make_live(
    suffix: str, idle_since: float | None, tenant: str = "default"
) -> LiveSession:
    live = LiveSession(
        sid=uuid.uuid4(),
        tenant_id=tenant,
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
    """The pool eviction hook evicts the longest-idle session; never one that
    has never gone idle (idle_since is None ranks last)."""
    sup = SessionSupervisor()
    now = time.monotonic()
    s_old = _make_live("old", now - 100.0)  # idle the longest
    s_mid = _make_live("mid", now - 50.0)
    s_new = _make_live("new", None)  # recent, never idle-ranked
    sup._sessions = {s.sid: s for s in (s_old, s_mid, s_new)}

    evicted: list[LiveSession] = []

    async def _fake_evict(live: LiveSession) -> bool:
        evicted.append(live)
        return True

    sup._evict = _fake_evict

    assert await sup._evict_longest_idle() is True

    assert evicted == [s_old]


@pytest.mark.asyncio
async def test_evict_hook_returns_false_when_nothing_evictable():
    """Busy / ws-attached sessions are not evictable -> hook reports False so
    the pool falls through to its wait queue (WS-D)."""
    sup = SessionSupervisor()
    busy = _make_live("busy", None)
    busy._busy = True
    attached = _make_live("attached", None)
    attached.ws_connections = {object()}
    sup._sessions = {s.sid: s for s in (busy, attached)}

    assert await sup._evict_longest_idle() is False


# --- session-history-switch: same-tenant idle yield (D2/D4) --------------------


@pytest.mark.asyncio
async def test_evict_tenant_idle_filters_candidates():
    """Candidates must satisfy all five conditions (same tenant, live, no WS,
    not busy, not evicting); the longest-idle one is chosen."""
    sup = SessionSupervisor()
    now = time.monotonic()
    other = _make_live("other", now - 500.0, tenant="tenant-b")
    busy = _make_live("busy", now - 400.0)
    busy._busy = True
    attached = _make_live("attached", now - 300.0)
    attached.ws_connections = {object()}
    mid_evict = _make_live("mid-evict", now - 200.0)
    mid_evict.evicting = True
    target = _make_live("target", now - 100.0)
    newer = _make_live("newer", now - 10.0)
    sup._sessions = {
        s.sid: s for s in (other, busy, attached, mid_evict, target, newer)
    }

    evicted: list[LiveSession] = []

    async def _fake_evict(live: LiveSession) -> bool:
        evicted.append(live)
        return True

    sup._evict = _fake_evict

    assert await sup._evict_tenant_idle("default") is True
    assert evicted == [target]


@pytest.mark.asyncio
async def test_evict_tenant_idle_no_candidate_returns_false():
    sup = SessionSupervisor()
    other = _make_live("other", None, tenant="tenant-b")
    sup._sessions = {other.sid: other}
    assert await sup._evict_tenant_idle("default") is False


# --- session-history-switch: eviction re-entrancy + failure safety (D3/D5) -----


@pytest.mark.asyncio
async def test_concurrent_evict_runs_once(monkeypatch):
    """Two racing _evict calls: teardown/release/stage-out each run exactly
    once; the re-entrant call returns False (spec: concurrent eviction)."""
    sup = SessionSupervisor()
    live = _make_live("victim", None)
    sup._sessions = {live.sid: live}
    sup.pool._slots[str(live.sid)] = "default"

    gate = asyncio.Event()
    teardown_calls = 0

    async def _teardown(_live: LiveSession, *, graceful: bool) -> None:
        nonlocal teardown_calls
        teardown_calls += 1
        await gate.wait()

    monkeypatch.setattr(sup, "_teardown_process", _teardown)
    persist = AsyncMock()
    monkeypatch.setattr(sup, "_persist_status", persist)
    stage_out = AsyncMock(return_value=True)
    monkeypatch.setattr("app.session.tenant_store.stage_out", stage_out)

    first = asyncio.create_task(sup._evict(live))
    await asyncio.sleep(0.01)  # first is parked inside teardown
    assert await sup._evict(live) is False  # re-entrant call skips
    gate.set()
    assert await first is True

    assert teardown_calls == 1
    assert stage_out.await_count == 1
    assert persist.await_count == 1
    assert live.state == SessionState.COLD
    assert not sup.pool.holds(live.sid)
    assert live.evicting is False


@pytest.mark.asyncio
async def test_evict_teardown_failure_frees_slot_and_persists_cold(monkeypatch):
    """Teardown raising must not leak the slot: COLD + release + persist run in
    the protected section, the evicting marker is restored (spec D5)."""
    sup = SessionSupervisor()
    live = _make_live("crashy", None)
    sup._sessions = {live.sid: live}
    sup.pool._slots[str(live.sid)] = "default"

    async def _boom(_live: LiveSession, *, graceful: bool) -> None:
        raise RuntimeError("teardown blew up")

    monkeypatch.setattr(sup, "_teardown_process", _boom)
    persist = AsyncMock()
    monkeypatch.setattr(sup, "_persist_status", persist)
    stage_out = AsyncMock(return_value=True)
    monkeypatch.setattr("app.session.tenant_store.stage_out", stage_out)

    with pytest.raises(RuntimeError):
        await sup._evict(live)

    assert live.evicting is False
    assert live.state == SessionState.COLD
    assert not sup.pool.holds(live.sid)  # slot did not leak
    persist.assert_awaited_once_with(live.sid, SessionStatus.COLD)
    stage_out.assert_not_awaited()  # teardown raised before the mirror hook


@pytest.mark.asyncio
async def test_evict_stage_out_failure_still_reports_cold(monkeypatch):
    """Stage-out stays best-effort: its failure leaves the session COLD with
    the status persisted and the eviction still reported as success."""
    sup = SessionSupervisor()
    live = _make_live("mirror-fail", None)
    sup._sessions = {live.sid: live}
    sup.pool._slots[str(live.sid)] = "default"

    monkeypatch.setattr(sup, "_teardown_process", AsyncMock())
    persist = AsyncMock()
    monkeypatch.setattr(sup, "_persist_status", persist)
    monkeypatch.setattr(
        "app.session.tenant_store.stage_out",
        AsyncMock(side_effect=RuntimeError("bucket down")),
    )

    assert await sup._evict(live) is True
    assert live.state == SessionState.COLD
    assert live.evicting is False
    assert not sup.pool.holds(live.sid)
    persist.assert_awaited_once_with(live.sid, SessionStatus.COLD)


@pytest.mark.asyncio
async def test_failed_tenant_eviction_reports_false_and_acquire_rejects(monkeypatch):
    """An eviction that raises through _evict_tenant_idle is caught (False):
    acquire keeps the TenantQuotaExceeded rejection, no internal error leaks."""
    monkeypatch.setattr(settings, "tenant_max_concurrent", 1)
    monkeypatch.setattr(settings, "max_live_sessions", 4)
    monkeypatch.setattr(pool_module, "make_backend", lambda **_k: object())

    sup = SessionSupervisor()
    live = _make_live("victim", None)
    sup._sessions = {live.sid: live}
    sup.pool._slots[str(live.sid)] = "default"

    async def _boom(_live: LiveSession, *, graceful: bool) -> None:
        raise RuntimeError("teardown blew up")

    monkeypatch.setattr(sup, "_teardown_process", _boom)
    monkeypatch.setattr(sup, "_persist_status", AsyncMock())

    with pytest.raises(TenantQuotaExceeded):
        await sup.pool.acquire("default", "new-sid")
    assert live.evicting is False


# --- session-history-switch: resume decision (D8/D10) --------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "has_snapshot,turns,expected_resume",
    [
        (False, 0, False),  # 0-turn, no snapshot -> fresh spawn fallback
        (True, 0, True),
        (False, 3, True),  # turns exist: still attempt --resume
    ],
)
async def test_rehydrate_resume_decision(
    db_session, monkeypatch, has_snapshot, turns, expected_resume
):
    sup = SessionSupervisor()
    live = _make_live("cold", None)
    live.process = None
    live.state = SessionState.COLD
    conv = Conversation(
        id=live.sid,
        tenant_id="default",
        status=SessionStatus.COLD,
        oh_session_id=live.oh_session_id,
        turn_count=turns,
        extra_oh_args="[]",
    )
    db_session.add(conv)
    await db_session.commit()

    monkeypatch.setattr("app.session.tenant_store.stage_in", AsyncMock())
    monkeypatch.setattr(
        "app.session.tenant_store.has_session_snapshot",
        AsyncMock(return_value=has_snapshot),
    )
    spawn = AsyncMock()
    monkeypatch.setattr(sup, "_spawn", spawn)

    await sup.rehydrate(live, db=db_session)

    spawn.assert_awaited_once()
    assert spawn.await_args.kwargs["resume"] is expected_resume


@pytest.mark.asyncio
async def test_create_session_from_existing_spawns_with_resume(
    db_session, monkeypatch, tmp_path
):
    """D10 bug fix: re-arming an existing session must resume its context."""
    sup = SessionSupervisor()
    conv = Conversation(
        id=uuid.uuid4(),
        tenant_id="default",
        status=SessionStatus.LIVE,
        oh_session_id="oh-existing",
        workspace_path=str(tmp_path / "ws"),
        turn_count=2,
        permission_policy="full_auto",
        extra_oh_args="[]",
    )
    db_session.add(conv)
    await db_session.commit()

    monkeypatch.setattr("app.session.tenant_store.stage_in", AsyncMock())
    spawn = AsyncMock()
    monkeypatch.setattr(sup, "_spawn", spawn)

    await sup.create_session_from_existing(conv, "default", db=db_session)

    spawn.assert_awaited_once()
    assert spawn.await_args.kwargs["resume"] is True


def test_build_command_resume_flag():
    """The backend command carries --resume <oh_session_id> iff one is set."""
    from app.session.process import OhBackendProcess

    resuming = OhBackendProcess(
        cwd=Path("/tmp"), permission_mode="full_auto", oh_session_id="oh-resume-me"
    ).build_command()
    assert resuming[resuming.index("--resume") + 1] == "oh-resume-me"

    fresh = OhBackendProcess(
        cwd=Path("/tmp"), permission_mode="full_auto", oh_session_id=None
    ).build_command()
    assert "--resume" not in fresh
