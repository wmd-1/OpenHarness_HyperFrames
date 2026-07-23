"""Tests for the loose protocol models (spec: Native backend-only protocol bridge)."""

from app.session.protocol import OHJSON_PREFIX, BackendEvent, FrontendRequest, frame_type_for


def test_ohjson_prefix_constant():
    assert OHJSON_PREFIX == "OHJSON:"


def test_backend_event_parses_known_type():
    ev = BackendEvent.model_validate({"type": "assistant_delta", "message": "hi"})
    assert ev.type == "assistant_delta"
    assert ev.message == "hi"


def test_backend_event_tolerates_unknown_type():
    """Unknown ``type`` must NOT raise (spec robustness)."""
    ev = BackendEvent.model_validate({"type": "future_event", "foo": 1})
    assert ev.type == "future_event"
    assert ev.model_dump(exclude_none=True)["foo"] == 1


def test_backend_event_tolerates_unknown_fields():
    ev = BackendEvent.model_validate({"type": "ready", "new_field": [1, 2]})
    assert ev.type == "ready"


def test_frame_mapping_for_known_events():
    assert frame_type_for("assistant_delta") == "delta"
    assert frame_type_for("tool_started") == "tool_start"
    assert frame_type_for("tool_completed") == "tool_end"
    assert frame_type_for("line_complete") == "turn_complete"
    assert frame_type_for("modal_request") == "approval_request"
    assert frame_type_for("ready") == "session_ready"
    assert frame_type_for("error") == "turn_error"


def test_frame_mapping_unknown_event_passthrough():
    """Unknown event types map to a generic 'event' frame (forwarded, not dropped)."""
    assert frame_type_for("brand_new_event") == "event"


def test_frontend_request_serializes_without_prefix():
    req = FrontendRequest(type="submit_line", line="make a video")
    payload = req.model_dump_json(exclude_none=True)
    assert "OHJSON:" not in payload
    assert '"type":"submit_line"' in payload
    assert '"line":"make a video"' in payload
