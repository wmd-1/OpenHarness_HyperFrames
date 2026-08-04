"""session-lifecycle-convergence columns

Adds three nullable/boolean columns to ``conversations`` (spec
session-lifecycle-convergence, change 2026-08-03):

- ``status_reason``: why a session was demoted to a non-live state by the
  gateway (e.g. ``gateway_restart``). NULL for normal transitions.
- ``read_only``: marks read-only clones projected from another session's
  turns (never spawn a backend).
- ``source_session_id``: the session a read-only clone was projected from.

Same independent ``alembic_version_session`` chain; does NOT touch
``video_tasks`` or the service/ migration head.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("status_reason", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "read_only",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "source_session_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "source_session_id")
    op.drop_column("conversations", "read_only")
    op.drop_column("conversations", "status_reason")
