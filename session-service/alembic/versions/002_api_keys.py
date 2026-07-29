"""api_keys table for multi-key tenant authentication

Revision ID: 002
Revises: 001
Create Date: 2026-07-29

Adds the ``api_keys`` table (WS-A, spec: "Requests MUST be authenticated and
scoped to a tenant"). Raw keys are never stored — only ``sha256`` hex digests
(``key_hash``). Same independent ``alembic_version_session`` chain; does NOT
touch the three existing session tables or the service/ migration head.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_keys",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("key_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column("label", sa.String(256), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_api_keys_tenant_id", "api_keys", ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_api_keys_tenant_id", table_name="api_keys")
    op.drop_table("api_keys")
