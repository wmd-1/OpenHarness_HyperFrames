"""Change 2 failure-injection tests.

Backend startup failure (C3) and recovery failure (C4) must converge to a
terminal ``FAILED`` DB state, the runtime live instance must be cleaned up, and
the WS client must receive a business-classified ``error`` frame
(``BACKEND_START_FAILED`` / ``RECOVERY_FAILED``) followed by a ``1011`` close —
never an unhandled traceback, never a custom WS close code, and never silent
recycling of the failed session.
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app import db as app_db
from app.config import settings
from app.models import Conversation, ConversationTurn, SessionStatus, TurnStatus
from app.session import tenant_store
from app.session.lifecycle import SessionState
from app.session.supervisor import (
    LiveSession,
    SessionNotFound,
    SessionSupervisor,
    get_supervisor,
)
from app.session.process import BackendProcessError
from app.session.recovery import RecoveryFailedError


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _write_stub(tmp_path: Path, body: str) -> Path:
    """Drop an executable fake ``oh`` binary that exits immediately."""
    stub = tmp_path / "oh-stub.py"
    stub.write_text("#!/usr/bin/env python3\n" + body)
    stub.chmod(0o755)
    return stub


@pytest.fixture()
def _hermetic(monkeypatch, tmp_path):
    """Local-only staging + per-test workspace root for real spawn paths."""
    monkeypatch.setattr(settings, "minio_endpoint", None)
    monkeypatch.setattr(settings, "tenants_root", tmp_path / "tenants")
    ws_root = tmp_path / "workspaces"
    ws_root.mkdir()
    monkeypatch.setattr(settings, "workspace_root", ws_root)
    tenant_store._tenant_locks.clear()
    yield ws_root
    tenant_store._tenant_locks.clear()


def _make_live(suffix: str, tenant: str = "default") -> LiveSession:
    live = LiveSession(
        sid=uuid.uuid4(),
        tenant_id=tenant,
        cwd=Path("/tmp"),
        oh_session_id=f"oh-{suffix}",
        permission_policy="full_auto",
        extra_args=[],
        epoch=1,
    )
    live.process = object()
    live.state = SessionState.LIVE
    live.ws_connections = set()
    live._busy = False
    live.idle_since = None
    return live


def _insert_conv_sync(
    status=SessionStatus.LIVE,
    turn_count: int = 0,
    completed_turns: int = 0,
    oh_session_id: str | None = None,
    workspace_path: str | None = None,
):
    """Insert a Conversation (+ optional completed turns) on the test engine.

    Returns ``(sid_str, oh_session_id)``. Safe to call from a sync test because
    there is no running loop at that point.
    """
    sid = uuid.uuid4()
    ohs = oh_session_id or f"oh-{sid}"

    async def _go():
        async with app_db.async_session() as s:
            conv = Conversation(
                id=sid,
                tenant_id="default",
                status=status,
                oh_session_id=ohs,
                workspace_path=workspace_path or str(Path("/tmp") / f"ws-{sid}"),
                turn_count=turn_count,
                permission_policy="full_auto",
                extra_oh_args="[]",
            )
            s.add(conv)
            for i in range(completed_turns):
                s.add(
                    ConversationTurn(
                        conversation_id=sid,
                        turn_index=i,
                        prompt="x",
                        status=TurnStatus.COMPLETED,
                        assistant_text="x",
                    )
                )
            await s.commit()
            return str(sid), ohs

    return asyncio.run(_go())


async def _reload(sid) -> Conversation:
    """Reload from a fresh session to avoid expired-attribute lazy loads."""
    async with app_db.async_session() as s:
        return (
            await s.execute(select(Conversation).where(Conversation.id == sid))
        ).scalar_one()


# --------------------------------------------------------------------------- #
# supervisor-level: C3 (backend startup failure) on the re-arm path
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_cse_backend_exit_converges_failed(db_session, tmp_path, monkeypatch, _hermetic):
    """D10 re-arm: backend exits before ready -> BackendProcessError, the live
    instance is never registered, the pool slot is released, and the DB row is
    FAILED (never left CREATING). No turn is created."""
    stub = _write_stub(tmp_path, "import sys\nsys.exit(1)\n")
    monkeypatch.setattr(settings, "oh_bin", str(stub))

    sup = SessionSupervisor()
    conv = Conversation(
        id=uuid.uuid4(),
        tenant_id="default",
        status=SessionStatus.LIVE,
        oh_session_id="oh-cse",
        workspace_path=str(tmp_path / "ws"),
        turn_count=0,
        permission_policy="full_auto",
        extra_oh_args="[]",
    )
    db_session.add(conv)
    await db_session.commit()

    with pytest.raises(BackendProcessError, match="exited during startup"):
        await sup.create_session_from_existing(conv, "default", db=db_session)

    # 2) runtime live instance cleaned; 3) resource released
    assert sup._sessions == {}
    assert sup.pool.live_count() == 0
    # 1) DB retains FAILED
    refreshed = await _reload(conv.id)
    assert refreshed.status == SessionStatus.FAILED
    # 4) turn-count protection: no turn row, count untouched
    turns = (
        await db_session.execute(
            select(ConversationTurn).where(ConversationTurn.conversation_id == conv.id)
        )
    ).scalars().all()
    assert turns == []
    assert refreshed.turn_count == 0


# --------------------------------------------------------------------------- #
# supervisor-level: C4 (recovery failed) on the re-arm path
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_cse_recovery_failed_converges_failed(db_session, _hermetic):
    """completed>0 + no snapshot -> RecoveryFailedError (raised before any spawn);
    the row is FAILED and the completed turns are preserved (no silent degrade)."""
    sup = SessionSupervisor()
    conv = Conversation(
        id=uuid.uuid4(),
        tenant_id="default",
        status=SessionStatus.LIVE,
        oh_session_id="oh-c4",
        workspace_path=str(Path("/tmp") / "ws"),
        turn_count=2,
        permission_policy="full_auto",
        extra_oh_args="[]",
    )
    db_session.add(conv)
    for i in range(2):
        db_session.add(
            ConversationTurn(
                conversation_id=conv.id,
                turn_index=i,
                prompt="x",
                status=TurnStatus.COMPLETED,
                assistant_text="x",
            )
        )
    await db_session.commit()

    with pytest.raises(RecoveryFailedError):
        await sup.create_session_from_existing(conv, "default", db=db_session)

    assert sup._sessions == {}
    refreshed = await _reload(conv.id)
    assert refreshed.status == SessionStatus.FAILED
    assert refreshed.turn_count == 2  # completed turns preserved


# --------------------------------------------------------------------------- #
# supervisor-level: C3 on the rehydrate (COLD) path via register_live_session
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_register_live_session_backend_exit_failed(db_session, tmp_path, monkeypatch, _hermetic):
    """COLD rehydrate whose backend exits must also converge to FAILED (the WS
    handler reaches this via register_live_session)."""
    stub = _write_stub(tmp_path, "import sys\nsys.exit(1)\n")
    monkeypatch.setattr(settings, "oh_bin", str(stub))

    sup = SessionSupervisor()
    live = _make_live("cold")
    live.process = None
    live.state = SessionState.COLD
    db_session.add(
        Conversation(
            id=live.sid,
            tenant_id="default",
            status=SessionStatus.COLD,
            oh_session_id=live.oh_session_id,
            workspace_path=str(tmp_path / "ws"),
            turn_count=0,
            permission_policy="full_auto",
            extra_oh_args="[]",
        )
    )
    await db_session.commit()

    with pytest.raises(BackendProcessError, match="exited during startup"):
        await sup.register_live_session(live, db=db_session)

    assert sup._sessions == {}
    refreshed = await _reload(live.sid)
    assert refreshed.status == SessionStatus.FAILED


# --------------------------------------------------------------------------- #
# assert removal: no AssertionError leaks (-O safe) on adapter=None
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_interrupt_adapter_none_is_session_not_found():
    sup = SessionSupervisor()
    live = _make_live("x")
    live.adapter = None
    sup._sessions[live.sid] = live
    with pytest.raises(SessionNotFound):
        await sup.interrupt(live.sid)


@pytest.mark.asyncio
async def test_stream_turn_adapter_none_is_session_not_found(db_session):
    # stream_turn persists a RUNNING turn row before the adapter check, so the
    # live session needs a backing Conversation row (FK). The adapter=None branch
    # must surface a clean ``turn_error`` frame (track_turn finalizes it) rather
    # than leaking an AssertionError under python -O.
    sup = SessionSupervisor()
    live = _make_live("y")
    live.adapter = None
    db_session.add(
        Conversation(
            id=live.sid, tenant_id="default", status=SessionStatus.LIVE,
            oh_session_id=live.oh_session_id, workspace_path="/tmp/wy",
            turn_count=0, permission_policy="full_auto", extra_oh_args="[]",
        )
    )
    await db_session.commit()
    sup._sessions[live.sid] = live
    frames = [f async for f in sup.stream_turn(live.sid, "text", db=db_session)]
    assert any(f.get("type") == "turn_error" for f in frames)
    # the live instance is released, never left wedged busy
    assert live._busy is False


# --------------------------------------------------------------------------- #
# WS: C3 backend startup failure -> error frame + 1011 (no traceback)
# --------------------------------------------------------------------------- #
def test_ws_backend_start_failed_closes_1011(sync_client, tmp_path, monkeypatch, _hermetic):
    stub = _write_stub(tmp_path, "import sys\nsys.exit(1)\n")
    monkeypatch.setattr(settings, "oh_bin", str(stub))

    sid, _ = _insert_conv_sync(status=SessionStatus.LIVE, workspace_path=str(tmp_path / "ws"))

    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        frames = []
        with pytest.raises(WebSocketDisconnect) as exc:
            while True:
                frames.append(ws.receive_json())
    # 2) business error.code; 3) close 1011
    assert any(
        f.get("type") == "error" and f.get("code") == "BACKEND_START_FAILED" for f in frames
    )
    assert exc.value.code == 1011
    # 1) DB FAILED; 2) no dangling live instance
    sid_uuid = uuid.UUID(sid)
    refreshed = asyncio.run(_reload_async(sid_uuid))
    assert refreshed.status == SessionStatus.FAILED
    assert get_supervisor().live_count() == 0


# --------------------------------------------------------------------------- #
# WS: C4 recovery failed -> error frame + 1011 (no backend spawned)
# --------------------------------------------------------------------------- #
def test_ws_recovery_failed_closes_1011(sync_client, tmp_path, _hermetic):
    sid, _ = _insert_conv_sync(
        status=SessionStatus.LIVE,
        turn_count=2,
        completed_turns=2,
        workspace_path=str(tmp_path / "ws"),
    )

    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        frames = []
        with pytest.raises(WebSocketDisconnect) as exc:
            while True:
                frames.append(ws.receive_json())
    assert any(
        f.get("type") == "error" and f.get("code") == "RECOVERY_FAILED" for f in frames
    )
    assert exc.value.code == 1011
    sid_uuid = uuid.UUID(sid)
    refreshed = asyncio.run(_reload_async(sid_uuid))
    assert refreshed.status == SessionStatus.FAILED
    assert refreshed.turn_count == 2  # completed turns preserved


# --------------------------------------------------------------------------- #
# idempotent reconnect: identical failure surfaced every time, no traceback
# --------------------------------------------------------------------------- #
def test_ws_reconnect_idempotent_failure(sync_client, tmp_path, monkeypatch, _hermetic):
    stub = _write_stub(tmp_path, "import sys\nsys.exit(1)\n")
    monkeypatch.setattr(settings, "oh_bin", str(stub))
    sid, _ = _insert_conv_sync(status=SessionStatus.LIVE, workspace_path=str(tmp_path / "ws"))

    codes_seen = []
    for _ in range(3):
        with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
            frames = []
            with pytest.raises(WebSocketDisconnect) as exc:
                while True:
                    frames.append(ws.receive_json())
        assert exc.value.code == 1011
        codes_seen.append(
            next(f["code"] for f in frames if f.get("type") == "error")
        )
    # every reconnect surfaces the same classified failure (no silent success,
    # no traceback) — backend is attempted once per reconnect, nothing extra.
    assert codes_seen == ["BACKEND_START_FAILED"] * 3


# --------------------------------------------------------------------------- #
# no auto-recycle: FAILED is excluded from orphan reclaim
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_failed_session_not_auto_recycled(db_session, _hermetic):
    """orphan_scan only deletes CLOSED/EXPIRED/absent workspaces; a FAILED
    session (and its workspace dir) must survive auto-reclaim."""
    sup = SessionSupervisor()
    ws_root = Path(settings.workspace_root)

    failed_sid = uuid.uuid4()
    failed_dir = ws_root / str(failed_sid)
    failed_dir.mkdir()
    failed = Conversation(
        id=failed_sid, tenant_id="default", status=SessionStatus.FAILED,
        oh_session_id="oh-failed", workspace_path=str(failed_dir), turn_count=0,
        permission_policy="full_auto", extra_oh_args="[]",
    )
    closed_sid = uuid.uuid4()
    closed_dir = ws_root / str(closed_sid)
    closed_dir.mkdir()
    closed = Conversation(
        id=closed_sid, tenant_id="default", status=SessionStatus.CLOSED,
        oh_session_id="oh-closed", workspace_path=str(closed_dir), turn_count=0,
        permission_policy="full_auto", extra_oh_args="[]",
    )
    db_session.add_all([failed, closed])
    await db_session.commit()

    cleaned = await sup.orphan_scan()
    remaining = (await db_session.execute(select(Conversation.id))).scalars().all()
    # FAILED survives (row kept); CLOSED's workspace is reclaimed (proves the
    # reclaim actually ran and excluded FAILED).
    assert failed_sid in remaining
    assert failed_dir.exists()
    assert not closed_dir.exists()
    assert cleaned >= 1


# --------------------------------------------------------------------------- #
# REST: C3 -> 503 backend_start_failed, DB FAILED (no traceback / no 500)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_rest_backend_start_failed_returns_503(client, monkeypatch):
    """REST mapping (change 2, task 3.4): a backend startup failure raised by
    create_session must surface as HTTP 503 with the business error code (not a
    500 traceback, not an internal C1–C4 number)."""
    from app.session.supervisor import get_supervisor

    async def _boom(*args, **kwargs):
        raise BackendProcessError("backend exited during startup")

    monkeypatch.setattr(get_supervisor(), "create_session", _boom)

    resp = await client.post("/v1/sessions", json={})
    assert resp.status_code == 503
    body = resp.json()
    # REST follows the same ``detail={code,message}`` envelope as the 403 quota
    # error in this router (FastAPI wraps ``detail``), not the WS ``error.code``
    # frame shape — they are different protocols.
    assert body["detail"]["code"] == "backend_start_failed"


# helper used by the sync WS tests
async def _reload_async(sid_uuid):
    async with app_db.async_session() as s:
        s.expire_all()
        return (
            await s.execute(select(Conversation).where(Conversation.id == sid_uuid))
        ).scalar_one()
