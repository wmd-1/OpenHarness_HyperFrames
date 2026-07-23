"""Loose Pydantic models for the native ``oh --backend-only`` protocol.

The upstream protocol is defined in ``openharness.ui.protocol`` (BackendEvent /
FrontendRequest). We deliberately do **not** import it — the session service is
a *client* of the protocol over a process boundary, and must stay resilient to
upstream field/type drift. These models use ``extra="allow"`` and a permissive
``type`` field so unknown events are forwarded/transmitted without error.

Design source: add-interactive-session-service spec D2 ("protocol bridge details")
and the "Native backend-only protocol bridge" requirement.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# The stdout line prefix that distinguishes a protocol event from a diagnostic
# log line. Matches ``openharness.ui.backend_host._PROTOCOL_PREFIX``.
OHJSON_PREFIX = "OHJSON:"


class BackendEvent(BaseModel):
    """A parsed event emitted by the ``oh --backend-only`` subprocess.

    ``extra="allow"`` keeps unknown fields so protocol drift does not drop data;
    ``type`` is a plain ``str`` (not a Literal) so an unrecognized type still
    parses and can be transparently forwarded to the client.
    """

    model_config = ConfigDict(extra="allow")

    type: str
    # Common fields (all optional — only ``type`` is guaranteed).
    message: str | None = None
    item: dict[str, Any] | None = None
    state: dict[str, Any] | None = None
    tasks: list[dict[str, Any]] | None = None
    mcp_servers: list[dict[str, Any]] | None = None
    bridge_sessions: list[dict[str, Any]] | None = None
    commands: list[str] | None = None
    modal: dict[str, Any] | None = None
    tool_name: str | None = None
    tool_input: dict[str, Any] | None = None
    output: str | None = None
    is_error: bool | None = None
    todo_markdown: str | None = None
    plan_mode: str | None = None
    compact_phase: str | None = None
    compact_trigger: str | None = None
    attempt: int | None = None
    select_options: list[dict[str, Any]] | None = None
    swarm_teammates: list[dict[str, Any]] | None = None
    swarm_notifications: list[dict[str, Any]] | None = None


class FrontendRequest(BaseModel):
    """A request written to the subprocess stdin (bare JSON, no prefix).

    Only the request types the session service needs to emit are modeled; the
    upstream ``FrontendRequest`` accepts more (list_sessions, select_command…)
    but those are TUI-only and not driven by the gateway.
    """

    model_config = ConfigDict(extra="allow")

    type: str
    line: str | None = None
    request_id: str | None = None
    allowed: bool | None = None
    permission_reply: str | None = None
    answer: str | None = None
    images: list[dict[str, Any]] = Field(default_factory=list)


# --- Mapping helpers (BackendEvent.type -> WS frame type) ---------------------
# Centralizes the protocol→wire mapping so the adapter stays a thin translator.
# Spec D2 event mapping.

EVENT_TO_FRAME: dict[str, str] = {
    "ready": "session_ready",
    "assistant_delta": "delta",
    "assistant_complete": "delta",  # final assistant text; emitted as a delta flush
    "tool_started": "tool_start",
    "tool_completed": "tool_end",
    "todo_update": "todo",
    "line_complete": "turn_complete",
    "modal_request": "approval_request",
    "error": "turn_error",
    "state_snapshot": "state_snapshot",
    "tasks_snapshot": "tasks_snapshot",
    "transcript_item": "transcript",
    "compact_progress": "compact_progress",
    "plan_mode_change": "plan_mode_change",
    "swarm_status": "swarm_status",
    "shutdown": "backend_shutdown",
    # Unknown types fall through to a transparent ``event`` frame (see adapter).
}


def frame_type_for(event_type: str) -> str:
    """Return the WS frame type for a backend event type.

    Unknown event types map to a generic ``event`` frame carrying the raw event,
    so protocol additions are forwarded rather than dropped (spec D2 robustness).
    """
    return EVENT_TO_FRAME.get(event_type, "event")


__all__ = [
    "OHJSON_PREFIX",
    "BackendEvent",
    "FrontendRequest",
    "EVENT_TO_FRAME",
    "frame_type_for",
]
