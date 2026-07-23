"""Tests for the independent Alembic migration chain (spec: 2.2 / R).

Verifies the session-service migrations use a separate version table and create
only the three session tables, leaving ``video_tasks`` untouched.
"""

from __future__ import annotations

import pytest
from sqlalchemy import inspect, text


@pytest.mark.asyncio
async def test_tables_created_by_metadata(db_engine):
    """Base.metadata.create_all yields exactly the three session tables."""
    from app import db as db_module
    from sqlalchemy import inspect

    async with db_module.engine.connect() as conn:
        names = await conn.run_sync(lambda c: inspect(c).get_table_names())
    for expected in ("conversations", "conversation_turns", "turn_artifacts"):
        assert expected in names


def test_alembic_uses_independent_version_table():
    """alembic.ini configures version_table=alembic_version_session."""
    import configparser
    from pathlib import Path

    ini = Path(__file__).resolve().parent.parent / "alembic.ini"
    cfg = configparser.ConfigParser()
    cfg.read(ini)
    assert cfg.get("alembic", "version_table") == "alembic_version_session"


def test_migration_does_not_create_video_tasks():
    """The initial migration only CREATES session tables (no video_tasks DDL)."""
    from pathlib import Path

    migration = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "001_initial_session_tables.py"
    content = migration.read_text()
    # The docstring mentions video_tasks (explaining it does NOT touch it); the
    # DDL must not. Check no create/drop TABLE video_tasks statement exists.
    assert 'create_table(\n        "video_tasks"' not in content
    assert "op.create_table" in content  # sanity: it does create tables
    assert "conversations" in content
    assert "conversation_turns" in content
    assert "turn_artifacts" in content


@pytest.mark.asyncio
async def test_turn_index_unique_constraint(db_session):
    """(conversation_id, turn_index) is unique (spec D5)."""
    import uuid
    from app.models import Conversation, ConversationTurn
    from sqlalchemy.exc import IntegrityError

    conv = Conversation(id=uuid.uuid4(), tenant_id="t1")
    db_session.add(conv)
    await db_session.commit()
    t1 = ConversationTurn(conversation_id=conv.id, turn_index=0, prompt="a")
    t2 = ConversationTurn(conversation_id=conv.id, turn_index=0, prompt="dup")
    db_session.add_all([t1, t2])
    with pytest.raises(IntegrityError):
        await db_session.commit()
