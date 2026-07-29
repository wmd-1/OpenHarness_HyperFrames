"""api_keys table for multi-key tenant authentication (WS-A)

Shared with session-service in the same database (design D1.3): both sides
carry an IDEMPOTENT migration for the same table — whichever side lands first
creates it, the other skips (Q1: the two backends never run concurrently, so
there is no race). Raw keys are never stored — only ``sha256`` hex digests
(``key_hash``).

Revision ID: 004a_api_keys
Revises: 004_task_list_index
Create Date: 2026-07-29

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "004a_api_keys"
down_revision: Union[str, None] = "004_task_list_index"
branch_labels: Union[str, Sequence[str] | None] = None
depends_on: Union[str, Sequence[str] | None] = None


def upgrade() -> None:
    # Idempotent: skip when the table already exists (created by the
    # session-service chain, which tracks its own alembic_version_session).
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("api_keys"):
        return
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("key_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column("label", sa.String(256), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_api_keys_tenant_id", "api_keys", ["tenant_id"])


def downgrade() -> None:
    # Only drop the table we created ourselves. If the session-service chain
    # has applied its own api_keys revision ("002" in the linear
    # alembic_version_session chain), that side owns the table — leave it.
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("api_keys"):
        return
    if inspector.has_table("alembic_version_session"):
        row = bind.execute(
            sa.text("SELECT version_num FROM alembic_version_session")
        ).first()
        if row is not None and str(row[0]) >= "002":
            return
    op.drop_index("ix_api_keys_tenant_id", table_name="api_keys")
    op.drop_table("api_keys")
