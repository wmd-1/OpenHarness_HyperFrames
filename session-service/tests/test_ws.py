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

    async def _limited(client_ip):
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
async def test_ws_capacity_full_returns_4503(sync_client, monkeypatch):
    """COLD rehydrate failing on capacity full -> error frame + close 4503
    (session-history-switch D6: capacity is distinguishable from 4500)."""
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

    class _EmptyResult:
        def first(self):
            return None  # auth open-mode probe sees an empty api_keys table

    @asynccontextmanager
    async def _fake_session_factory():
        fake = AsyncMock()
        fake.get = AsyncMock(return_value=conv)
        fake.execute = AsyncMock(return_value=_EmptyResult())
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

    # The structured error frame precedes the close (D6); the close carries
    # the machine-parseable reason constant and code 4503.
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        frame = ws.receive_json()
        assert frame["type"] == "error"
        assert frame["code"] == "CAPACITY_FULL"
        msg = ws.receive()
    assert msg["type"] == "websocket.close", msg
    assert msg["code"] == 4503, msg
    assert msg.get("reason") == "CAPACITY_FULL", msg


@pytest.mark.asyncio
async def test_ws_quota_exceeded_returns_4430(sync_client, monkeypatch):
    """Quota still exceeded after the same-tenant eviction attempt -> error
    frame TENANT_QUOTA_EXCEEDED + close 4430 (session-history-switch D6)."""
    import uuid
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from app import db as _app_db
    from app.models import Conversation, SessionStatus
    from app.session.pool import TenantQuotaExceeded
    from app.session.supervisor import SessionNotFound, get_supervisor

    sid = "22222222-2222-2222-2222-222222222222"

    conv = Conversation(
        id=uuid.UUID(sid),
        tenant_id="default",
        status=SessionStatus.COLD,
        oh_session_id="oh-" + sid,
        workspace_path=None,
        permission_policy="full_auto",
        extra_oh_args="[]",
    )

    class _EmptyResult:
        def first(self):
            return None

    @asynccontextmanager
    async def _fake_session_factory():
        fake = AsyncMock()
        fake.get = AsyncMock(return_value=conv)
        fake.execute = AsyncMock(return_value=_EmptyResult())
        yield fake

    def _get_raises(_s):
        raise SessionNotFound(str(_s))

    async def _raise_quota(*_a, **_k):
        raise TenantQuotaExceeded("Concurrent session quota exceeded")

    monkeypatch.setattr(_app_db, "async_session", _fake_session_factory)

    async def _fake_proxy(*_a, **_k):
        return False

    monkeypatch.setattr("app.session.proxy.proxy_ws", _fake_proxy)
    monkeypatch.setattr(get_supervisor(), "get", _get_raises)
    monkeypatch.setattr(get_supervisor(), "rehydrate", _raise_quota)

    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        frame = ws.receive_json()
        assert frame["type"] == "error"
        assert frame["code"] == "TENANT_QUOTA_EXCEEDED"
        msg = ws.receive()
    assert msg["type"] == "websocket.close", msg
    assert msg["code"] == 4430, msg
    assert msg.get("reason") == "TENANT_QUOTA_EXCEEDED", msg


# --- session-history-switch: end-to-end switching --------------------------------


def test_ws_switch_evicts_idle_and_switches_back(sync_client, monkeypatch):
    """Switching via the single WS admission path (spec scenarios): creating B
    makes idle A yield to COLD; connecting A's WS makes B yield and A resume."""
    from app.config import settings

    monkeypatch.setattr(settings, "tenant_max_concurrent", 1)

    a_sid = sync_client.post("/v1/sessions", json={}).json()["session_id"]
    # A is live and unattached: B's create triggers the same-tenant idle yield.
    b = sync_client.post("/v1/sessions", json={})
    assert b.status_code == 201
    b_sid = b.json()["session_id"]
    assert sync_client.get(f"/v1/sessions/{a_sid}").json()["status"] == "cold"

    # Switching back: connecting A's WS evicts B and rehydrates A.
    with sync_client.websocket_connect(f"/v1/sessions/{a_sid}/ws") as ws:
        ready = ws.receive_json()
        assert ready["type"] == "session_ready"
        assert ready["session_id"] == a_sid
        assert sync_client.get(f"/v1/sessions/{b_sid}").json()["status"] == "cold"
        assert sync_client.get(f"/v1/sessions/{a_sid}").json()["status"] == "live"


@pytest.mark.asyncio
async def test_concurrent_switch_evicts_once(monkeypatch):
    """Concurrent switches (quota=1, A idle): A is evicted exactly once, one
    admission wins and the other maps to 4430 (spec: concurrent switches).

    Exercised at the admission layer — the sync TestClient cannot drive two
    truly concurrent websockets from one thread; the WS handler maps the
    loser's TenantQuotaExceeded to the 4430 close tested above."""
    import time
    import uuid
    from pathlib import Path
    from unittest.mock import AsyncMock

    from app.config import settings
    from app.session import pool as pool_module
    from app.session.lifecycle import SessionState
    from app.session.pool import TenantQuotaExceeded
    from app.session.supervisor import LiveSession, SessionSupervisor

    monkeypatch.setattr(settings, "tenant_max_concurrent", 1)
    monkeypatch.setattr(settings, "max_live_sessions", 4)
    monkeypatch.setattr(settings, "pool_queue_size", 0)
    monkeypatch.setattr(pool_module, "make_backend", lambda **_k: object())

    sup = SessionSupervisor()
    a = LiveSession(
        sid=uuid.uuid4(),
        tenant_id="default",
        cwd=Path("/tmp"),
        oh_session_id="oh-a",
        permission_policy="full_auto",
        extra_args=[],
        epoch=1,
    )
    a.process = object()
    a.state = SessionState.LIVE
    a.idle_since = time.monotonic() - 10
    sup._sessions = {a.sid: a}
    sup.pool._slots[str(a.sid)] = "default"

    teardown = AsyncMock()
    monkeypatch.setattr(sup, "_teardown_process", teardown)
    monkeypatch.setattr(sup, "_persist_status", AsyncMock())
    monkeypatch.setattr(
        "app.session.tenant_store.stage_out", AsyncMock(return_value=True)
    )

    import asyncio

    results = await asyncio.gather(
        sup.pool.acquire("default", "sid-b"),
        sup.pool.acquire("default", "sid-c"),
        return_exceptions=True,
    )
    winners = [r for r in results if not isinstance(r, BaseException)]
    losers = [r for r in results if isinstance(r, TenantQuotaExceeded)]
    assert len(winners) == 1 and len(losers) == 1  # exactly one session_ready
    assert teardown.await_count == 1  # A evicted exactly once
    assert a.state == SessionState.COLD  # no IllegalTransition on the way
    assert a.evicting is False
    assert sup.pool.tenant_slot_count("default") == 1
