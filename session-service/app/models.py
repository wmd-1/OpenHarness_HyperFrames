"""SQLAlchemy ORM models for the session service (spec D5).

Three tables — ``conversations``, ``conversation_turns``, ``turn_artifacts`` —
on the shared Postgres instance via an *independent* Alembic migration chain
(``version_table=alembic_version_session``) that never touches ``video_tasks``
or the ``service/`` migration head.

A session has **no** ``lease_token`` — that is a stateless-replay mechanism
specific to ``service/``; stateful sessions are not replayable (spec non-goal).
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class SessionStatus(str, enum.Enum):
    CREATING = "creating"
    LIVE = "live"
    IDLE = "idle"
    COLD = "cold"
    CLOSED = "closed"
    EXPIRED = "expired"
    FAILED = "failed"


class TurnStatus(str, enum.Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    TIMED_OUT = "timed_out"


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        Index("ix_conversations_tenant_created", "tenant_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    # tenant_id is NOT NULL — every session is scoped to a tenant (R: auth).
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    actor_key_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    oh_session_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    workspace_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    status: Mapped[SessionStatus] = mapped_column(
        Enum(SessionStatus), nullable=False, default=SessionStatus.CREATING, index=True
    )
    permission_policy: Mapped[str] = mapped_column(
        String(32), nullable=False, default="full_auto"
    )
    extra_oh_args: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    turn_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_active_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ConversationTurn(Base):
    __tablename__ = "conversation_turns"
    __table_args__ = (
        UniqueConstraint("conversation_id", "turn_index", name="uq_turns_conv_idx"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    assistant_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[TurnStatus] = mapped_column(
        Enum(TurnStatus), nullable=False, default=TurnStatus.RUNNING
    )
    usage: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TurnArtifact(Base):
    __tablename__ = "turn_artifacts"
    __table_args__ = (
        Index("ix_turn_artifacts_turn", "conversation_id", "turn_index"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="local")
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    filename: Mapped[str | None] = mapped_column(String(256), nullable=True)
    file_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(nullable=True)
    resolution: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
