"""Tests for the WebSocket streaming endpoint (spec: real-time turn streaming)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def test_ws_session_ready_then_turn_complete(sync_client):
    create = sync_client.post("/v1/sessions", json={}).json()
    sid = create["session_id"]
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        # session_ready precedes the first turn.
        ready = ws.receive_json()
        assert ready["type"] == "session_ready"
        ws.send_json({"op": "submit", "text": "make a video"})
        frames = []
        while True:
            frame = ws.receive_json()
            frames.append(frame)
            if frame.get("type") == "turn_complete":
                break
        types = [f["type"] for f in frames]
        assert "delta" in types
        assert "tool_start" in types
        assert "tool_end" in types
        assert types[-1] == "turn_complete"


def test_ws_busy_on_concurrent_submit(sync_client):
    import os, time

    # Set the stub turn delay BEFORE creating the session (the stub subprocess
    # inherits the env at spawn time, so this must precede the POST).
    os.environ["OH_STUB_TURN_SECONDS"] = "1"
    try:
        create = sync_client.post("/v1/sessions", json={}).json()
        sid = create["session_id"]
        with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
            ws.receive_json()  # session_ready
            ws.send_json({"op": "submit", "text": "first"})
            time.sleep(0.15)
            ws.send_json({"op": "submit", "text": "second"})
            # The busy frame arrives before the first turn completes (stub sleeps 1s).
            busy = ws.receive_json()
            assert busy["type"] == "busy"
            # Drain to turn_complete.
            while True:
                f = ws.receive_json()
                if f.get("type") == "turn_complete":
                    break
    finally:
        os.environ.pop("OH_STUB_TURN_SECONDS", None)


def test_ws_interrupt(sync_client):
    import os, time

    create = sync_client.post("/v1/sessions", json={}).json()
    sid = create["session_id"]
    os.environ["OH_STUB_TURN_SECONDS"] = "2"
    try:
        with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
            ws.receive_json()
            ws.send_json({"op": "submit", "text": "long"})
            time.sleep(0.2)
            ws.send_json({"op": "interrupt"})
            # Drain until turn_complete (interrupted).
            seen_complete = False
            for _ in range(20):
                f = ws.receive_json()
                if f.get("type") == "turn_complete":
                    seen_complete = True
                    break
            assert seen_complete
    finally:
        os.environ.pop("OH_STUB_TURN_SECONDS", None)


def test_ws_ping_pong(sync_client):
    create = sync_client.post("/v1/sessions", json={}).json()
    sid = create["session_id"]
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        ws.receive_json()
        ws.send_json({"op": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_ws_reconnect_replays_missed_turns(sync_client):
    """Spec scenario: reconnect replays completed turns."""
    create = sync_client.post("/v1/sessions", json={}).json()
    sid = create["session_id"]
    # Turn 0 while connected.
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        ws.receive_json()
        ws.send_json({"op": "submit", "text": "turn 0"})
        while ws.receive_json().get("type") != "turn_complete":
            pass
    # Reconnect with last_turn_index=-1 -> replay turn 0.
    with sync_client.websocket_connect(
        f"/v1/sessions/{sid}/ws?last_turn_index=-1"
    ) as ws:
        ready = ws.receive_json()
        assert ready["type"] == "session_ready"
        replayed = ws.receive_json()
        assert replayed["type"] == "turn_complete"
        assert replayed.get("replayed") is True


def test_ws_rate_limit_returns_4429(sync_client, monkeypatch):
    """Exceeding the WS connection-establishment rate limit -> close 4429 (openspec B)."""
    from app.routers import ws as ws_module

    state = {"n": 0}

    def _limited(client_ip):
        state["n"] += 1
        return state["n"] <= 1  # first allowed, subsequent denied

    monkeypatch.setattr(ws_module, "check_rate_limit", _limited)
    bad_sid = "00000000-0000-0000-0000-000000000000"

    # First connection passes the limiter, then closes (no session -> 4404).
    with pytest.raises(WebSocketDisconnect):
        with sync_client.websocket_connect(f"/v1/sessions/{bad_sid}/ws"):
            pass
    # Second connection is denied before accept -> 4429.
    with pytest.raises(WebSocketDisconnect) as exc:
        with sync_client.websocket_connect(f"/v1/sessions/{bad_sid}/ws"):
            pass
    assert exc.value.code == 4429


@pytest.mark.asyncio
async def test_ws_capacity_full_returns_4500(sync_client, monkeypatch):
    """COLD session rehydrate fails on capacity full -> WS close 4500 (openspec A)."""
    import uuid
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from app import db as _app_db
    from app.models import Conversation, SessionStatus
    from app.session.supervisor import (
        CapacityFullError,
        SessionNotFound,
        get_supervisor,
    )

    sid = "11111111-1111-1111-1111-111111111111"

    # Deterministic COLD conversation the handler will read. We stub the DB
    # session to avoid cross-event-loop sqlite visibility flakiness.
    conv = Conversation(
        id=uuid.UUID(sid),
        tenant_id="default",
        status=SessionStatus.COLD,
        oh_session_id="oh-" + sid,
        workspace_path=None,
        permission_policy="full_auto",
        extra_oh_args="[]",
    )

    @asynccontextmanager
    async def _fake_session_factory():
        fake = AsyncMock()
        fake.get = AsyncMock(return_value=conv)
        yield fake

    def _get_raises(_s):
        raise SessionNotFound(str(_s))

    async def _raise_capacity(*_a, **_k):
        raise CapacityFullError("capacity full and no idle session to evict")

    monkeypatch.setattr(_app_db, "async_session", _fake_session_factory)

    async def _fake_proxy(*_a, **_k):
        return False

    monkeypatch.setattr("app.session.proxy.proxy_ws", _fake_proxy)
    # Live process absent from registry -> handler takes the rehydrate branch.
    monkeypatch.setattr(get_supervisor(), "get", _get_raises)
    # Make rehydrate fail as if the node were at capacity.
    monkeypatch.setattr(get_supervisor(), "rehydrate", _raise_capacity)

    # 4500 is sent after accept(); the client observes it as a close message.
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        msg = ws.receive()
    assert msg["type"] == "websocket.close", msg
    assert msg["code"] == 4500, msg
