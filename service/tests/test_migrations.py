"""Tests for Alembic migration correctness (X9)."""

from pathlib import Path


def _migration_002_source() -> str:
    """Load migration 002 source by file path (module name starts with a digit)."""
    p = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "002_scale_multi_instance_columns.py"
    return p.read_text()


def test_migration_002_add_retrying_is_transaction_safe():
    """Migration 002 MUST run ADD VALUE outside a transaction and use
    IF NOT EXISTS for idempotency (X9).

    ALTER TYPE ADD VALUE cannot run inside a PostgreSQL transaction block.
    Without an explicit COMMIT, Alembic wraps the migration in a transaction
    and the DDL fails. IF NOT EXISTS makes the migration idempotent so
    re-running it (e.g. after a partial failure) does not error.
    """
    source = _migration_002_source()
    assert "COMMIT" in source, (
        "migration 002 must COMMIT before ADD VALUE (transaction-safe, X9)"
    )
    assert "IF NOT EXISTS" in source, (
        "migration 002 must use IF NOT EXISTS for idempotency (X9)"
    )
    assert "ADD VALUE IF NOT EXISTS" in source, (
        "must be 'ADD VALUE IF NOT EXISTS' (not just 'ADD VALUE')"
    )


def test_migration_002_skips_non_postgres():
    """Migration 002 MUST guard the ADD VALUE with a dialect check so
    non-Postgres backends (sqlite for tests) skip it."""
    source = _migration_002_source()
    assert "postgresql" in source, (
        "ADD VALUE must be guarded by a PostgreSQL dialect check"
    )
    assert "get_context" in source, "must check dialect via op.get_context()"
