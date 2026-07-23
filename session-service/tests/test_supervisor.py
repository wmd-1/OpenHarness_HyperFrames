"""Integration tests for the SessionSupervisor using the oh backend stub.

Covers: oh_session_id derivation, turn streaming (delta→tool→turn_complete),
single-writer (busy), multi-turn context, crash isolation, artifact registration.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from app.config import settings
from app.models import Conversation, SessionStatus, TurnStatus
from app.session.process import derive_oh_session_id
from app.session.supervisor import BackendCrashed, SessionNotFound, get_supervisor


def test_derive_oh_session_id_is_deterministic(tmp_path):
    from pathlib import Path

    cwd = tmp_path / "sess-abc"
    cwd.mkdir()
    sid = derive_oh_session_id(cwd)
    assert sid.startswith("sess-abc-")
    # Same cwd -> same id (deterministic, spec D8).
    assert derive_oh_session_id(cwd) == sid


@pytest.mark.asyncio
async def test_create_session_derives_oh_session_id_before_spawn(db_session):
    sup = get_supervisor()
    conv = await sup.create_session(
        db=db_session, tenant_id="default", permission_policy="full_auto"
    )
    assert conv.oh_session_id is not None
    assert conv.status == SessionStatus.LIVE
    live = sup.get(conv.id)
    # oh_session_id was computed from cwd before spawn.
    assert live.oh_session_id == conv.oh_session_id
    await sup.close(conv.id, db=db_session)


@pytest.mark.asyncio
async def test_turn_streams_delta_then_complete(db_session):
    sup = get_supervisor()
    conv = await sup.create_session(db=db_session, tenant_id="default")
    frames = []
    async for frame in sup.stream_turn(conv.id, "make a video", db=db_session):
        frames.append(frame)
    types = [f["type"] for f in frames]
    assert "delta" in types
    assert "tool_start" in types
    assert "tool_end" in types
    assert types[-1] == "turn_complete"
    await sup.close(conv.id, db=db_session)


@pytest.mark.asyncio
async def test_multi_turn_context_preserved(db_session):
    """Consecutive turns share the same live process (spec: multi-turn context)."""
    sup = get_supervisor()
    conv = await sup.create_session(db=db_session, tenant_id="default")
    live = sup.get(conv.id)
    first_pid = live.process.pid

    async for _ in sup.stream_turn(conv.id, "turn one", db=db_session):
        pass
    # Same process for turn two.
    assert live.process.pid == first_pid
    async for _ in sup.stream_turn(conv.id, "turn two", db=db_session):
        pass
    assert live.process.pid == first_pid
    assert live._turn_index == 2
    await sup.close(conv.id, db=db_session)


@pytest.mark.asyncio
async def test_single_writer_rejects_concurrent_submit(db_session):
    """Spec scenario: concurrent submit during an active turn is rejected."""
    sup = get_supervisor()
    conv = await sup.create_session(db=db_session, tenant_id="default")
    live = sup.get(conv.id)

    # Start a slow turn and immediately attempt a second.
    import os
    os.environ["OH_STUB_TURN_SECONDS"] = "1"
    task1 = asyncio.create_task(
        _collect(sup.stream_turn(conv.id, "first", db=db_session))
    )
    await asyncio.sleep(0.1)
    assert live.busy is True
    frames2 = await _collect(sup.stream_turn(conv.id, "second", db=db_session))
    # Second submit yields a 'busy' frame and does NOT run.
    assert frames2 and frames2[0]["type"] == "busy"
    await task1
    os.environ.pop("OH_STUB_TURN_SECONDS", None)
    await sup.close(conv.id, db=db_session)


@pytest.mark.asyncio
async def test_crash_isolation_marks_failed(db_session, monkeypatch):
    """Spec scenario: unexpected subprocess exit fails only the current turn."""
    sup = get_supervisor()
    conv = await sup.create_session(db=db_session, tenant_id="default")
    live = sup.get(conv.id)
    # Kill the process abruptly to simulate a crash.
    assert live.process is not None
    live.process._proc.kill()
    frames = await _collect(sup.stream_turn(conv.id, "after crash", db=db_session))
    types = [f["type"] for f in frames]
    assert "turn_error" in types
    assert live.state in (SessionStatus.COLD, SessionStatus.FAILED)
    # Other sessions are unaffected — create a new one and it works.
    conv2 = await sup.create_session(db=db_session, tenant_id="default")
    frames2 = await _collect(sup.stream_turn(conv2.id, "works", db=db_session))
    assert frames2[-1]["type"] == "turn_complete"
    await sup.close(conv2.id, db=db_session)


@pytest.mark.asyncio
async def test_artifact_registered_on_turn_complete(db_session):
    """Spec scenario: a produced video is registered as an artifact."""
    from app.models import TurnArtifact
    from sqlalchemy import select

    sup = get_supervisor()
    conv = await sup.create_session(db=db_session, tenant_id="default")
    async for _ in sup.stream_turn(conv.id, "render it", db=db_session):
        pass
    arts = (await db_session.execute(
        select(TurnArtifact).where(TurnArtifact.conversation_id == conv.id)
    )).scalars().all()
    assert len(arts) == 1
    assert arts[0].filename == "out.mp4"
    assert arts[0].file_size_bytes is not None
    await sup.close(conv.id, db=db_session)


@pytest.mark.asyncio
async def test_get_unknown_session_raises():
    sup = get_supervisor()
    with pytest.raises(SessionNotFound):
        sup.get(uuid.uuid4())


@pytest.mark.asyncio
async def test_delete_preserves_completed_turns(db_session):
    """Spec scenario: delete preserves completed turn history."""
    from app.models import ConversationTurn
    from sqlalchemy import select

    sup = get_supervisor()
    conv = await sup.create_session(db=db_session, tenant_id="default")
    async for _ in sup.stream_turn(conv.id, "a turn", db=db_session):
        pass
    sid = conv.id
    await sup.close(sid, db=db_session)
    # Turn rows preserved.
    turns = (await db_session.execute(
        select(ConversationTurn).where(ConversationTurn.conversation_id == sid)
    )).scalars().all()
    assert len(turns) == 1
    assert turns[0].status == TurnStatus.COMPLETED
    # Session is CLOSED.
    refreshed = await db_session.get(Conversation, sid)
    assert refreshed.status == SessionStatus.CLOSED


async def _collect(gen):
    out = []
    async for frame in gen:
        out.append(frame)
    return out
