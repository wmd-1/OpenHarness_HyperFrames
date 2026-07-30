"""Backend protocol tests for harden-session-frontend (tasks 1.1–1.4).

Covers:
- A1: ``turn_complete`` frame / ``TurnResponse`` carry ``has_artifact``.
- A4: approval timeout emits a structured ``turn_error`` with
  ``code="approval_timeout"`` and forwards the denial to the subprocess.
- A2: artifact GET accepts ``?api_key=`` (valid → 200, invalid → 401);
  query-param auth does NOT apply to other REST paths; uvicorn access log
  masks the query string.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio

from app.config import settings


# --- A1: has_artifact on the WS turn_complete frame ---------------------------


def test_ws_turn_complete_includes_has_artifact(sync_client):
    create = sync_client.post("/v1/sessions", json={}).json()
    sid = create["session_id"]
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        assert ws.receive_json()["type"] == "session_ready"
        ws.send_json({"op": "submit", "text": "make a video"})
        while True:
            frame = ws.receive_json()
            if frame.get("type") == "turn_complete":
                break
    # The stub writes an mp4 every turn -> artifact registered -> True.
    assert frame["has_artifact"] is True


def test_ws_replayed_turn_complete_includes_has_artifact(sync_client):
    create = sync_client.post("/v1/sessions", json={}).json()
    sid = create["session_id"]
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        ws.receive_json()
        ws.send_json({"op": "submit", "text": "turn 0"})
        while ws.receive_json().get("type") != "turn_complete":
            pass
    with sync_client.websocket_connect(
        f"/v1/sessions/{sid}/ws?last_turn_index=-1"
    ) as ws:
        assert ws.receive_json()["type"] == "session_ready"
        replayed = ws.receive_json()
        assert replayed["type"] == "turn_complete"
        assert replayed.get("replayed") is True
        assert replayed["has_artifact"] is True


# --- A1: has_artifact on the REST TurnResponse --------------------------------


@pytest.mark.asyncio
async def test_turn_response_includes_has_artifact(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.post(f"/v1/sessions/{sid}/turns", json={"text": "render"})
    assert resp.status_code == 200
    assert resp.json()["has_artifact"] is True


def test_turn_response_schema_defaults_has_artifact_false():
    from datetime import datetime, timezone

    from app.models import TurnStatus
    from app.schemas import TurnResponse

    r = TurnResponse(
        turn_id=uuid.uuid4(),
        turn_index=0,
        status=TurnStatus.COMPLETED,
        prompt="p",
        started_at=datetime.now(timezone.utc),
    )
    assert r.has_artifact is False


# --- A4: approval timeout -> structured turn_error code -----------------------


class _FakeAdapter:
    def __init__(self) -> None:
        self.events: asyncio.Queue = asyncio.Queue()
        self.calls: list[tuple] = []

    async def respond_permission(self, rid, allowed, reply=None):
        self.calls.append(("permission", rid, allowed, reply))

    async def respond_question(self, rid, answer):
        self.calls.append(("question", rid, answer))


def _live_session(adapter) -> "LiveSession":  # noqa: F821
    from app.session.supervisor import LiveSession

    live = LiveSession(
        sid=uuid.uuid4(),
        tenant_id="default",
        cwd=Path("/tmp"),
        oh_session_id="oh-x",
        permission_policy="interactive",
        extra_args=[],
        epoch=1,
    )
    live.adapter = adapter
    return live


@pytest.mark.asyncio
async def test_approval_timeout_emits_structured_turn_error(monkeypatch):
    from app.session.supervisor import SessionSupervisor

    monkeypatch.setattr(settings, "approval_timeout_seconds", 0.05)
    sup = SessionSupervisor()
    adapter = _FakeAdapter()
    live = _live_session(adapter)

    event = SimpleNamespace(modal={"request_id": "r1", "kind": "permission"})
    await sup._await_approval(live, event)
    await asyncio.sleep(0.3)

    # Denial forwarded to the subprocess so it unblocks.
    assert adapter.calls == [("permission", "r1", False, "reject")]
    assert "r1" not in live._pending_approvals
    # F6: the fired timeout task removed its own strong reference.
    assert live._approval_timeout_tasks == {}
    # Synthetic event mapped to a structured turn_error frame.
    ev = adapter.events.get_nowait()
    assert ev.type == "approval_timeout"
    frame = sup._map_event(live, ev, 3)
    assert frame["type"] == "turn_error"
    assert frame["code"] == "approval_timeout"
    assert frame["turn_index"] == 3
    assert "approval" in frame["message"]


@pytest.mark.asyncio
async def test_approval_answered_in_time_emits_no_turn_error(monkeypatch):
    from app.session.supervisor import SessionSupervisor

    monkeypatch.setattr(settings, "approval_timeout_seconds", 0.5)
    sup = SessionSupervisor()
    adapter = _FakeAdapter()
    live = _live_session(adapter)
    sup._sessions[live.sid] = live

    event = SimpleNamespace(modal={"request_id": "r2", "kind": "permission"})
    await sup._await_approval(live, event)
    await sup.respond_approval(live.sid, "r2", allowed=True, reply="once")
    await asyncio.sleep(0.7)

    # Only the client's own reply was forwarded; no timeout injection.
    assert adapter.calls == [("permission", "r2", True, "once")]
    assert adapter.events.empty()
    # F6: respond_approval cancelled the timeout task and dropped its reference.
    assert live._approval_timeout_tasks == {}
    sup.remove_live_session(live.sid)


# --- A2: artifact GET ?api_key= auth ------------------------------------------


@pytest_asyncio.fixture
async def auth_client(db_engine):
    """Client against an app rebuilt with header/query auth enabled.

    The auth middleware branch is chosen at ``app.main`` import time, so the
    module is reloaded with the key configured, then restored afterwards.
    """
    import importlib

    from httpx import ASGITransport, AsyncClient
    from pydantic import SecretStr

    import app.main as main_module

    old_key, old_require = settings.api_key, settings.require_auth
    settings.api_key = SecretStr("sk-test")
    settings.require_auth = True
    importlib.reload(main_module)
    try:
        transport = ASGITransport(app=main_module.app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c
    finally:
        settings.api_key = old_key
        settings.require_auth = old_require
        importlib.reload(main_module)


async def _authed_session_with_artifact(auth_client) -> str:
    headers = {"X-API-Key": "sk-test"}
    create = await auth_client.post("/v1/sessions", json={}, headers=headers)
    assert create.status_code == 201
    sid = create.json()["session_id"]
    turn = await auth_client.post(
        f"/v1/sessions/{sid}/turns", json={"text": "render"}, headers=headers
    )
    assert turn.status_code == 200
    return sid


@pytest.mark.asyncio
async def test_artifact_get_accepts_valid_query_api_key(auth_client):
    sid = await _authed_session_with_artifact(auth_client)
    resp = await auth_client.get(
        f"/v1/sessions/{sid}/turns/0/artifact", params={"api_key": "sk-test"}
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "video/mp4"


@pytest.mark.asyncio
async def test_artifact_get_rejects_invalid_query_api_key(auth_client):
    sid = await _authed_session_with_artifact(auth_client)
    resp = await auth_client.get(
        f"/v1/sessions/{sid}/turns/0/artifact", params={"api_key": "sk-wrong"}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_query_api_key_rejected_on_non_artifact_paths(auth_client):
    sid = await _authed_session_with_artifact(auth_client)
    # Same valid key, non-artifact path -> header-only, still 401.
    resp = await auth_client.get(
        f"/v1/sessions/{sid}", params={"api_key": "sk-test"}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_artifact_get_header_auth_still_works(auth_client):
    sid = await _authed_session_with_artifact(auth_client)
    resp = await auth_client.get(
        f"/v1/sessions/{sid}/turns/0/artifact", headers={"X-API-Key": "sk-test"}
    )
    assert resp.status_code == 200


# --- A2: uvicorn access log must not leak the query string --------------------


def test_uvicorn_access_log_masks_api_key_query():
    import logging as _logging

    from app.observability.logging import _MaskSecretsFilter, configure_logging

    configure_logging()
    access = _logging.getLogger("uvicorn.access")
    assert any(isinstance(f, _MaskSecretsFilter) for f in access.filters)

    record = _logging.LogRecord(
        "uvicorn.access",
        _logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:1", "GET", "/v1/sessions/x/turns/0/artifact?api_key=sk-secret", "1.1", 200),
        None,
    )
    for f in access.filters:
        f.filter(record)
    assert "sk-secret" not in record.getMessage()
    assert "api_key=***" in record.getMessage()
