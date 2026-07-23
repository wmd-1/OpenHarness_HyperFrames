"""Tests for the WebSocket streaming endpoint (spec: real-time turn streaming)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient


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
