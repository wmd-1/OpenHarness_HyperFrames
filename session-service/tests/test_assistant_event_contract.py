"""Assistant event contract (session-acceptance-hardening P0-1).

``assistant_complete`` is the authoritative final overwrite: its message
REPLACES the delta accumulation in ``_assistant_buf`` (never appended), and the
wire frame is a compatibility envelope (``text: ""``, ``final: true``,
``full_text``). See app/session/protocol.py docstring.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from types import SimpleNamespace


def _live_session() -> "LiveSession":  # noqa: F821
    from app.session.supervisor import LiveSession

    return LiveSession(
        sid=uuid.uuid4(),
        tenant_id="default",
        cwd=Path("/tmp"),
        oh_session_id="oh-x",
        permission_policy="interactive",
        extra_args=[],
        epoch=1,
    )


def _sup():
    from app.session.supervisor import SessionSupervisor

    return SessionSupervisor()


def test_complete_overwrites_stub_style_duplicate():
    """Stub-style same-text double emit (delta 'X' + complete 'X') → single 'X'."""
    sup, live = _sup(), _live_session()
    sup._map_event(live, SimpleNamespace(type="assistant_delta", message="X"), 0)
    sup._map_event(live, SimpleNamespace(type="assistant_complete", message="X"), 0)
    assert "".join(live._assistant_buf) == "X"


def test_complete_overwrites_multi_delta_accumulation():
    """Real-oh style: deltas 'a','b' then complete 'ab' → 'ab', not 'abab'."""
    sup, live = _sup(), _live_session()
    sup._map_event(live, SimpleNamespace(type="assistant_delta", message="a"), 0)
    sup._map_event(live, SimpleNamespace(type="assistant_delta", message="b"), 0)
    sup._map_event(live, SimpleNamespace(type="assistant_complete", message="ab"), 0)
    assert "".join(live._assistant_buf) == "ab"


def test_complete_without_deltas_sets_full_text():
    """Complete alone (all delta frames lost upstream) still yields the reply."""
    sup, live = _sup(), _live_session()
    sup._map_event(live, SimpleNamespace(type="assistant_complete", message="hello"), 0)
    assert "".join(live._assistant_buf) == "hello"


def test_complete_frame_is_compat_envelope():
    """Complete maps to text='' + final + full_text (envelope, not one more delta)."""
    sup, live = _sup(), _live_session()
    frame = sup._map_event(live, SimpleNamespace(type="assistant_complete", message="full reply"), 5)
    assert frame == {
        "type": "delta",
        "text": "",
        "turn_index": 5,
        "final": True,
        "full_text": "full reply",
    }


def test_delta_frame_shape_unchanged():
    """Plain deltas keep the incremental shape (no final/full_text fields)."""
    sup, live = _sup(), _live_session()
    frame = sup._map_event(live, SimpleNamespace(type="assistant_delta", message="chunk"), 2)
    assert frame == {"type": "delta", "text": "chunk", "turn_index": 2}
