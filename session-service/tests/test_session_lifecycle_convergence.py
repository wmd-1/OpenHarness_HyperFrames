"""session-lifecycle-convergence (change 2026-08-03) tests.

Part A — stale live convergence:
    On gateway restart, any LIVE/IDLE conversation with no in-memory instance
    is orphaned (its backend subprocess died) and must be demoted to COLD with
    status_reason="gateway_restart" so the next WS connect rehydrates it.

Part B — read-only clone:
    POST /v1/sessions?clone_readonly=<id> creates a new CLOSED, read_only
    session that projects the source turns/artifacts (no backend spawned).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.models import (
    Conversation,
    ConversationTurn,
    SessionStatus,
    TurnArtifact,
    TurnStatus,
)
from app.routers.sessions import _business_fields
from app.session.supervisor import get_supervisor


# --------------------------------------------------------------------------- #
# Part A: reconcile_stale_live
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_reconcile_demotes_orphaned_live_and_idle(db_session):
    sup = get_supervisor()
    sup._sessions.clear()

    live = Conversation(
        id=uuid.uuid4(), tenant_id="default", status=SessionStatus.LIVE, turn_count=2
    )
    idle = Conversation(
        id=uuid.uuid4(), tenant_id="default", status=SessionStatus.IDLE, turn_count=1
    )
    db_session.add_all([live, idle])
    await db_session.commit()

    moved = await sup.reconcile_stale_live()

    assert moved == 2
    await db_session.refresh(live)
    await db_session.refresh(idle)
    assert live.status == SessionStatus.COLD
    assert live.status_reason == "gateway_restart"
    assert idle.status == SessionStatus.COLD
    assert idle.status_reason == "gateway_restart"


@pytest.mark.asyncio
async def test_reconcile_keeps_sessions_this_gateway_owns(db_session):
    sup = get_supervisor()
    sup._sessions.clear()

    live = Conversation(
        id=uuid.uuid4(), tenant_id="default", status=SessionStatus.LIVE, turn_count=1
    )
    db_session.add(live)
    await db_session.commit()
    # This gateway already owns the in-memory instance -> must NOT be demoted.
    sup._sessions[live.id] = object()

    moved = await sup.reconcile_stale_live()

    assert moved == 0
    await db_session.refresh(live)
    assert live.status == SessionStatus.LIVE
    assert live.status_reason is None


@pytest.mark.asyncio
async def test_reconcile_skips_terminal_states(db_session):
    sup = get_supervisor()
    sup._sessions.clear()

    closed = Conversation(
        id=uuid.uuid4(), tenant_id="default", status=SessionStatus.CLOSED, turn_count=1
    )
    cold = Conversation(
        id=uuid.uuid4(), tenant_id="default", status=SessionStatus.COLD, turn_count=1
    )
    db_session.add_all([closed, cold])
    await db_session.commit()

    moved = await sup.reconcile_stale_live()

    assert moved == 0


# --------------------------------------------------------------------------- #
# Part B: read-only clone
# --------------------------------------------------------------------------- #
async def _seed_source(db_session) -> uuid.UUID:
    src = Conversation(
        id=uuid.uuid4(),
        tenant_id="default",
        status=SessionStatus.CLOSED,
        turn_count=1,
    )
    db_session.add(src)
    db_session.add(
        ConversationTurn(
            id=uuid.uuid4(),
            conversation_id=src.id,
            turn_index=0,
            prompt="hello",
            assistant_text="world",
            status=TurnStatus.COMPLETED,
        )
    )
    db_session.add(
        TurnArtifact(
            id=uuid.uuid4(),
            conversation_id=src.id,
            turn_index=0,
            storage_kind="local",
            storage_key="art/abc.mp4",
            filename="abc.mp4",
        )
    )
    await db_session.commit()
    return src.id


@pytest.mark.asyncio
async def test_clone_readonly_projects_turns_and_artifacts(client, db_session):
    src_id = await _seed_source(db_session)

    resp = await client.post(
        "/v1/sessions", params={"clone_readonly": str(src_id)}, json={}
    )
    assert resp.status_code == 201
    body = resp.json()
    new_id = uuid.UUID(body["session_id"])
    assert body["status"] == "closed"
    assert body["ws_url"] is None

    # Turns projected into the clone.
    turns = await client.get(f"/v1/sessions/{new_id}/turns")
    assert turns.status_code == 200
    items = turns.json()["items"]
    assert len(items) == 1
    assert items[0]["prompt"] == "hello"

    # DB invariants: read_only + provenance.
    clone = await db_session.get(Conversation, new_id)
    assert clone is not None
    assert clone.read_only is True
    assert clone.source_session_id == src_id
    assert clone.status == SessionStatus.CLOSED

    # Source untouched.
    src = await db_session.get(Conversation, src_id)
    assert src.read_only is False
    assert src.source_session_id is None


@pytest.mark.asyncio
async def test_clone_readonly_appears_readonly_in_list(client, db_session):
    src_id = await _seed_source(db_session)
    resp = await client.post(
        "/v1/sessions", params={"clone_readonly": str(src_id)}, json={}
    )
    new_id = uuid.UUID(resp.json()["session_id"])

    listing = await client.get("/v1/sessions")
    assert listing.status_code == 200
    items = {uuid.UUID(i["session_id"]): i for i in listing.json()["items"]}
    assert new_id in items
    assert items[new_id]["read_only"] is True
    assert items[new_id]["resumable"] is False


@pytest.mark.asyncio
async def test_clone_unknown_source_404(client, db_session):
    resp = await client.post(
        "/v1/sessions", params={"clone_readonly": str(uuid.uuid4())}, json={}
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_clone_rejects_cross_tenant(client, db_session):
    src = Conversation(
        id=uuid.uuid4(),
        tenant_id="other-tenant",
        status=SessionStatus.CLOSED,
        turn_count=0,
    )
    db_session.add(src)
    await db_session.commit()

    resp = await client.post(
        "/v1/sessions", params={"clone_readonly": str(src.id)}, json={}
    )
    # Same tenant isolation as every other session endpoint (404, not 200).
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_read_only_contract_uses_explicit_field(db_session):
    """``read_only`` is the authoritative source (decoupled from lifecycle phase).

    Proves the explicit ``Conversation.read_only`` column wins over the
    terminal-state derivation: a non-terminal LIVE session flagged read_only
    reads as read-only, a LIVE non-read_only reads as writable, and a legacy
    CLOSED row (read_only=False, predating the column) still reads read-only
    via the status fallback.
    """
    live_ro = Conversation(
        id=uuid.uuid4(), tenant_id="default",
        status=SessionStatus.LIVE, read_only=True, turn_count=3,
    )
    db_session.add(live_ro)
    live_rw = Conversation(
        id=uuid.uuid4(), tenant_id="default",
        status=SessionStatus.LIVE, read_only=False, turn_count=3,
    )
    db_session.add(live_rw)
    closed_legacy = Conversation(
        id=uuid.uuid4(), tenant_id="default",
        status=SessionStatus.CLOSED, read_only=False, turn_count=1,
    )
    db_session.add(closed_legacy)
    await db_session.commit()
    for c in (live_ro, live_rw, closed_legacy):
        await db_session.refresh(c)

    resumable, ro = await _business_fields(live_ro)
    assert ro is True
    assert resumable is False

    resumable, ro = await _business_fields(live_rw)
    assert ro is False
    assert resumable is True

    resumable, ro = await _business_fields(closed_legacy)
    assert ro is True
    assert resumable is False


@pytest.mark.asyncio
async def test_clone_readonly_artifact_deep_copy_independent(client, db_session, tmp_path):
    """A read-only clone owns an independent copy of each source artifact.

    The clone's storage_key must differ from the source's, and deleting the
    source artifact object (by its key, as ``close()``/GC would) must NOT orphan
    the clone. The naive shared-key reference would have broken here.
    """
    from app.storage.s3 import storage_for_kind

    src_id = uuid.uuid4()
    src = Conversation(
        id=src_id, tenant_id="default",
        status=SessionStatus.CLOSED, read_only=False, turn_count=1,
    )
    turn = ConversationTurn(
        id=uuid.uuid4(), conversation_id=src_id, turn_index=0,
        prompt="p", assistant_text="a", status=TurnStatus.COMPLETED,
    )
    storage = storage_for_kind("local")
    src_key = f"{src_id}/0/source.mp4"
    payload = tmp_path / "source.mp4"
    payload.write_bytes(b"SOURCE-BYTES-1234")
    storage.save(src_key, payload)
    art = TurnArtifact(
        id=uuid.uuid4(), conversation_id=src_id, turn_index=0,
        storage_kind="local", storage_key=src_key, filename="source.mp4",
        file_size_bytes=16,
    )
    db_session.add_all([src, turn, art])
    await db_session.commit()

    resp = await client.post(
        "/v1/sessions", params={"clone_readonly": str(src_id)}, json={}
    )
    assert resp.status_code == 201
    new_id = uuid.UUID(resp.json()["session_id"])

    clone_arts = (
        await db_session.execute(
            select(TurnArtifact).where(TurnArtifact.conversation_id == new_id)
        )
    ).scalars().all()
    assert clone_arts, "clone must project artifacts"
    clone_key = clone_arts[0].storage_key
    assert clone_key != src_key, "clone must own a distinct storage key"
    assert storage.exists(clone_key), "clone artifact object must exist"

    # Simulate source GC/delete by key. The clone must survive because it owns
    # an independent copy.
    storage.delete(src_key)
    assert not storage.exists(src_key)
    assert storage.exists(clone_key), "clone artifact survives source deletion"

    storage.delete(clone_key)
