"""Pydantic request / response schemas for the session API."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models import SessionStatus, TurnStatus
from app.security import vet_extra_oh_args, InvalidOhArgError


# ---- Request ----

# Single source of truth for the max turn-submit text length. Referenced by both
# the REST schema (below) and the WS submit branch (F5) so the ceiling stays in
# lock-step across transports. Aligned with the frontend MAX_INPUT_LENGTH.
MAX_TURN_TEXT_LEN = 32000


class SessionCreateRequest(BaseModel):
    permission_policy: str = Field(default="full_auto", pattern="^(full_auto|interactive)$")
    extra_oh_args: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("extra_oh_args")
    @classmethod
    def _vet_extra_oh_args(cls, v: list[str]) -> list[str]:
        try:
            return vet_extra_oh_args(v)
        except InvalidOhArgError as exc:
            raise ValueError(str(exc)) from exc


class TurnSubmitRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TURN_TEXT_LEN)


class ApprovalRequest(BaseModel):
    request_id: str
    allowed: bool = True
    # Enum-constrained (SS-15): an unvalidated reply would pass through to the
    # subprocess protocol; anything else fails validation with a 422.
    reply: str | None = Field(default=None, pattern="^(once|always|reject)$")
    answer: str | None = None  # for question modals


# ---- Response ----

class SessionResponse(BaseModel):
    session_id: uuid.UUID
    status: SessionStatus
    permission_policy: str
    turn_count: int
    oh_session_id: str | None = None
    created_at: datetime
    last_active_at: datetime
    ws_url: str | None = None

    model_config = {"from_attributes": True}


class TurnResponse(BaseModel):
    turn_id: uuid.UUID
    turn_index: int
    status: TurnStatus
    prompt: str
    assistant_text: str | None = None
    error_message: str | None = None
    # A1: mirrors the WS turn_complete frame's artifact marker so the REST
    # fallback path drives artifact preview/download the same way.
    has_artifact: bool = False
    started_at: datetime
    finished_at: datetime | None = None

    model_config = {"from_attributes": True}


class SessionSummary(BaseModel):
    """List item for ``GET /v1/sessions`` (session-history-switch D7/D9).

    ``resumable``/``read_only`` are the frontend's sole decision inputs —
    clients never interpret the internal ``status`` enum.
    """

    session_id: uuid.UUID
    status: SessionStatus
    # First turn's prompt truncated to 80 chars; None for 0-turn sessions.
    title: str | None = None
    turn_count: int
    resumable: bool
    read_only: bool
    created_at: datetime
    last_active_at: datetime

    model_config = {"from_attributes": True}


class SessionListResponse(BaseModel):
    items: list[SessionSummary]
    total: int
    limit: int
    offset: int


class TurnListResponse(BaseModel):
    """Cursor-paged historical turns for ``GET /v1/sessions/{sid}/turns``."""

    items: list[TurnResponse]
    total: int


class ArtifactResponse(BaseModel):
    artifact_id: uuid.UUID
    turn_index: int
    storage_kind: str
    filename: str | None = None
    file_size_bytes: int | None = None
    duration_seconds: float | None = None
    resolution: str | None = None
    fps: int | None = None

    model_config = {"from_attributes": True}


class DeleteResponse(BaseModel):
    session_id: uuid.UUID
    status: SessionStatus
    message: str


class HealthResponse(BaseModel):
    status: str
    db: str
    redis: str
    # P1-3 可观测字段：服务版本（pyproject source of truth）、oh 后端二进制路径、
    # 会话运行时（process/container）——实况验收/排障时可直接从 healthz 读取。
    version: str
    oh_bin: str
    runtime: str


class ReadyResponse(BaseModel):
    status: str
    db: str
    redis: str
    live_sessions: int
    capacity: int


class WorkspaceFileEntry(BaseModel):
    """One workspace file (live directory or archive manifest entry)."""

    path: str
    size: int
    mtime: float | None = None
    etag: str | None = None


class WorkspaceFileListResponse(BaseModel):
    """``GET /v1/sessions/{sid}/workspace/files`` (session-workspace-archive D7).

    ``source``: ``live`` (real-time local dir), ``archive`` (manifest-backed,
    with ``sync_seq``/``last_synced_at``) or ``none`` (no archive, no local
    dir). ``stale=true`` marks a LIVE/IDLE session served from the archive
    (e.g. live on another node) — a snapshot lagging at most one turn.
    """

    source: str
    stale: bool = False
    sync_seq: int | None = None
    last_synced_at: str | None = None
    total: int = 0
    files: list[WorkspaceFileEntry] = []
    next_page_token: str | None = None

