"""tenant_id column + tenant-scoped idempotency on video_tasks (WS-B)

Adds ``video_tasks.tenant_id`` (existing rows backfilled to ``'default'`` via
the server default, which is kept so legacy writers stay valid), a
``(tenant_id, created_at)`` listing index, and converts the global
``idempotency_key`` unique into ``UNIQUE (tenant_id, idempotency_key)`` (R17:
the same key may be reused by different tenants without collision).

Revision ID: 005_tenant_id
Revises: 004a_api_keys
Create Date: 2026-07-29

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "005_tenant_id"
down_revision: Union[str, None] = "004a_api_keys"
branch_labels: Union[str, Sequence[str] | None] = None
depends_on: Union[str, Sequence[str] | None] = None


def upgrade() -> None:
    # NOT NULL + server_default backfills existing rows to 'default' in one
    # statement; the default is kept in place for legacy writers.
    op.add_column(
        "video_tasks",
        sa.Column("tenant_id", sa.String(128), nullable=False, server_default="default"),
    )
    op.create_index(
        "ix_video_tasks_tenant_created", "video_tasks", ["tenant_id", "created_at"]
    )

    # idempotency_key: global unique -> unique per tenant. 001 created the
    # constraint via Column(unique=True), so discover the actual name instead
    # of hardcoding the backend's auto-generated one.
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dropped = False
    for uc in inspector.get_unique_constraints("video_tasks"):
        if uc.get("column_names") == ["idempotency_key"]:
            op.drop_constraint(uc["name"], "video_tasks", type_="unique")
            dropped = True
    if not dropped:
        # Some backends surface a plain unique index instead of a constraint.
        for ix in inspector.get_indexes("video_tasks"):
            if ix.get("unique") and ix.get("column_names") == ["idempotency_key"]:
                op.drop_index(ix["name"], table_name="video_tasks")
    op.create_unique_constraint(
        "uq_video_tasks_tenant_idem", "video_tasks", ["tenant_id", "idempotency_key"]
    )


def downgrade() -> None:
    # NOTE: restoring the global unique fails if different tenants share an
    # idempotency_key — operators must resolve duplicates before downgrading
    # (design source, Migration Plan rollback note).
    op.drop_constraint("uq_video_tasks_tenant_idem", "video_tasks", type_="unique")
    op.create_unique_constraint(
        "video_tasks_idempotency_key_key", "video_tasks", ["idempotency_key"]
    )
    op.drop_index("ix_video_tasks_tenant_created", table_name="video_tasks")
    op.drop_column("video_tasks", "tenant_id")
