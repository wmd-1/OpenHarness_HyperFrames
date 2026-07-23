"""Pydantic request / response schemas for the session API."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models import SessionStatus, TurnStatus
from app.security import vet_extra_oh_args, InvalidOhArgError


# ---- Request ----

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
    text: str = Field(min_length=1, max_length=32000)


class ApprovalRequest(BaseModel):
    request_id: str
    allowed: bool = True
    reply: str | None = None  # "once" | "always" | "reject" (edit_diff)
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
    started_at: datetime
    finished_at: datetime | None = None

    model_config = {"from_attributes": True}


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


class ReadyResponse(BaseModel):
    status: str
    db: str
    redis: str
    live_sessions: int
    capacity: int
