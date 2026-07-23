"""initial session tables

Revision ID: 001
Revises:
Create Date: 2026-07-23

Creates conversations / conversation_turns / turn_artifacts on the shared
Postgres instance via the independent ``alembic_version_session`` version table.
Does NOT touch video_tasks or the service/ migration head.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", sa.String(128), nullable=False, index=True),
        sa.Column("actor_key_id", sa.String(128), nullable=True),
        sa.Column("oh_session_id", sa.String(256), nullable=True),
        sa.Column("workspace_path", sa.String(512), nullable=True),
        sa.Column(
            "status",
            sa.Enum("creating", "live", "idle", "cold", "closed", "expired", "failed", name="sessionstatus"),
            nullable=False,
            server_default="creating",
            index=True,
        ),
        sa.Column("permission_policy", sa.String(32), nullable=False, server_default="full_auto"),
        sa.Column("extra_oh_args", sa.Text(), nullable=True),
        sa.Column("turn_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_active_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_conversations_tenant_created", "conversations", ["tenant_id", "created_at"]
    )

    op.create_table(
        "conversation_turns",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("turn_index", sa.Integer(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("assistant_text", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("running", "completed", "failed", "interrupted", "timed_out", name="turnstatus"),
            nullable=False,
            server_default="running",
        ),
        sa.Column("usage", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("conversation_id", "turn_index", name="uq_turns_conv_idx"),
    )

    op.create_table(
        "turn_artifacts",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("turn_index", sa.Integer(), nullable=False),
        sa.Column("storage_kind", sa.String(16), nullable=False, server_default="local"),
        sa.Column("storage_key", sa.String(512), nullable=False),
        sa.Column("filename", sa.String(256), nullable=True),
        sa.Column("file_size_bytes", sa.Integer(), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("resolution", sa.String(32), nullable=True),
        sa.Column("fps", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_turn_artifacts_turn", "turn_artifacts", ["conversation_id", "turn_index"]
    )


def downgrade() -> None:
    op.drop_index("ix_turn_artifacts_turn", table_name="turn_artifacts")
    op.drop_table("turn_artifacts")
    op.drop_table("conversation_turns")
    op.drop_index("ix_conversations_tenant_created", table_name="conversations")
    op.drop_table("conversations")
    # Drop the enum types we created.
    sa.Enum(name="turnstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="sessionstatus").drop(op.get_bind(), checkfirst=True)
