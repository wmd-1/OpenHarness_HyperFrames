"""VideoTask ORM model and TaskStatus enum."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
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


class TaskStatus(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    RETRYING = "retrying"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


class VideoTask(Base):
    __tablename__ = "video_tasks"
    __table_args__ = (
        Index("ix_video_tasks_created_at_status", "created_at", "status"),
        # Tenant-scoped listing + idempotency (WS-B): the same idempotency_key
        # may be reused by different tenants without collision (R17).
        Index("ix_video_tasks_tenant_created", "tenant_id", "created_at"),
        UniqueConstraint("tenant_id", "idempotency_key", name="uq_video_tasks_tenant_idem"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, default=uuid.uuid4
    )
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    skill: Mapped[str] = mapped_column(String(64), nullable=False, default="hyperframes")
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus), nullable=False, default=TaskStatus.QUEUED, index=True
    )
    celery_task_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    workspace_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    output_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    file_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(nullable=True)
    resolution: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    log_tail: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=900)
    extra_oh_args: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # --- Multi-instance scaling columns (scale-multi-instance, Phase 1) ---
    worker_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cancellation_requested: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=5)

    # --- Storage backend (scale-multi-instance Phase 3, R4) ---
    # Which backend the artifact was written to, so the download endpoint can
    # resolve the matching backend (default "local" for legacy/backfilled rows).
    storage_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="local")

    # --- Multi-tenancy (WS-B, R14) ---
    # Owning tenant, resolved from the API key (R15). Legacy/open-mode rows
    # belong to 'default'; all read/write endpoints scope on this column.
    tenant_id: Mapped[str] = mapped_column(
        String(128), nullable=False, default="default", server_default="default"
    )


class ApiKey(Base):
    """Multi-key tenant authentication (WS-A, R15).

    Maps the ``api_keys`` table SHARED with session-service in the same
    database (design D1.3 — the session-side definition is authoritative for
    shape; do not diverge). Only the ``sha256`` hex digest of a key is stored
    (``key_hash``); raw keys are printed once by ``scripts/manage_api_keys.py``
    and never persisted. ``active=False`` deactivates a key (effective within
    the resolver's TTL cache window).
    """

    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    label: Mapped[str | None] = mapped_column(String(256), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
