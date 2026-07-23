"""add composite index on (created_at, status)

Improves performance of the ordered list endpoint (ORDER BY created_at)
and the status-filtered cleanup scan (N6).

Revision ID: 004_task_list_index
Revises: 003_storage_kind
Create Date: 2026-07-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "004_task_list_index"
down_revision: Union[str, None] = "003_storage_kind"
branch_labels: Union[str, Sequence[str] | None] = None
depends_on: Union[str, Sequence[str] | None] = None


def upgrade() -> None:
    op.create_index(
        "ix_video_tasks_created_at_status",
        "video_tasks",
        ["created_at", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_video_tasks_created_at_status", table_name="video_tasks")
