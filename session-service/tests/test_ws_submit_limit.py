"""F5: WS submit text-length ceiling (change fix-session-review-2026-07).

The WS submit branch must enforce the same ``MAX_TURN_TEXT_LEN`` as the REST
``TurnSubmitRequest`` schema: over-limit text gets a structured ``error`` frame
(``code=text_too_long``) without dropping the connection or starting a turn.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import MAX_TURN_TEXT_LEN, TurnSubmitRequest


# --- single source of truth: REST schema boundary ------------------------------


def test_rest_schema_accepts_exact_limit():
    req = TurnSubmitRequest(text="x" * MAX_TURN_TEXT_LEN)
    assert len(req.text) == MAX_TURN_TEXT_LEN


def test_rest_schema_rejects_one_over_limit():
    with pytest.raises(ValidationError):
        TurnSubmitRequest(text="x" * (MAX_TURN_TEXT_LEN + 1))


# --- WS submit branch -----------------------------------------------------------


def test_ws_submit_over_limit_rejected_without_disconnect(sync_client):
    create = sync_client.post("/v1/sessions", json={}).json()
    sid = create["session_id"]
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        assert ws.receive_json()["type"] == "session_ready"

        ws.send_json({"op": "submit", "text": "x" * (MAX_TURN_TEXT_LEN + 1)})
        err = ws.receive_json()
        assert err["type"] == "error"
        assert err["code"] == "text_too_long"

        # Connection stays usable — no close, no turn started.
        ws.send_json({"op": "ping"})
        assert ws.receive_json()["type"] == "pong"

    # No turn row was persisted for the rejected submit.
    turns = sync_client.get(f"/v1/sessions/{sid}/turns").json()
    assert turns["total"] == 0


def test_ws_submit_at_exact_limit_starts_turn(sync_client):
    create = sync_client.post("/v1/sessions", json={}).json()
    sid = create["session_id"]
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        assert ws.receive_json()["type"] == "session_ready"
        ws.send_json({"op": "submit", "text": "x" * MAX_TURN_TEXT_LEN})
        while True:
            frame = ws.receive_json()
            assert not (
                frame.get("type") == "error" and frame.get("code") == "text_too_long"
            )
            if frame.get("type") == "turn_complete":
                break
