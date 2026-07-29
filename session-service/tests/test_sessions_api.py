"""Tests for the /v1/sessions REST API."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_create_session_returns_201(client):
    resp = await client.post("/v1/sessions", json={"permission_policy": "full_auto"})
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "live"
    assert data["ws_url"].endswith("/ws")
    assert data["oh_session_id"]


@pytest.mark.asyncio
async def test_create_session_rejects_bad_extra_args(client):
    resp = await client.post(
        "/v1/sessions", json={"extra_oh_args": ["--permission-mode", "x"]}
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_get_session(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.get(f"/v1/sessions/{sid}")
    assert resp.status_code == 200
    assert resp.json()["session_id"] == sid


@pytest.mark.asyncio
async def test_get_unknown_session_404(client):
    resp = await client.get("/v1/sessions/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_session(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.delete(f"/v1/sessions/{sid}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "closed"


@pytest.mark.asyncio
async def test_rest_turn_returns_409_when_not_live(client):
    """Non-WS turn on a non-live session returns 409 (spec scenario)."""
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    # The session IS live here (just created); this checks the 409 path requires
    # a live process. We delete first to make it non-live.
    await client.delete(f"/v1/sessions/{sid}")
    resp = await client.post(
        f"/v1/sessions/{sid}/turns", json={"text": "hello"}
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_rest_turn_completes(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.post(f"/v1/sessions/{sid}/turns", json={"text": "hello"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "completed"
    assert data["turn_index"] == 0


@pytest.mark.asyncio
async def test_create_session_503_when_capacity_full(client, monkeypatch):
    """Node capacity exhausted, nothing evictable, queue disabled -> 503 (openspec A)."""
    from app.config import settings

    # Zero capacity + no wait queue: pool admission degrades to the pre-pool
    # fail-fast CapacityFullError (WS-D queue_size=0 semantics).
    monkeypatch.setattr(settings, "max_live_sessions", 0)
    monkeypatch.setattr(settings, "pool_queue_size", 0)
    # Unique XFF isolates this test from the shared rate-limit bucket.
    resp = await client.post(
        "/v1/sessions", json={}, headers={"X-Forwarded-For": "203.0.113.1"}
    )
    assert resp.status_code == 503
    assert "capacity full" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_session_rate_limited_returns_429(client, monkeypatch):
    """POST /v1/sessions is rate-limited (shared token bucket) -> 429 (openspec B)."""
    from app.routers import sessions as sessions_module

    state = {"n": 0}

    async def _limited(client_ip):
        state["n"] += 1
        return state["n"] <= 1  # first allowed, subsequent denied

    monkeypatch.setattr(sessions_module, "check_rate_limit", _limited)
    r1 = await client.post("/v1/sessions", json={})
    assert r1.status_code == 201
    r2 = await client.post("/v1/sessions", json={})
    assert r2.status_code == 429


# --- Artifact download Range handling (Task 3.5) ------------------------------


async def _session_with_artifact(client) -> tuple[str, int]:
    """Create a session, run one turn, and return (sid, artifact size)."""
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    turn = await client.post(f"/v1/sessions/{sid}/turns", json={"text": "render"})
    assert turn.status_code == 200
    full = await client.get(f"/v1/sessions/{sid}/turns/0/artifact")
    assert full.status_code == 200
    return sid, int(full.headers["content-length"])


@pytest.mark.asyncio
async def test_artifact_range_parsed_to_206_partial_content(client):
    sid, size = await _session_with_artifact(client)
    if size < 8:
        pytest.skip("stub mp4 too small for range test")
    resp = await client.get(
        f"/v1/sessions/{sid}/turns/0/artifact", headers={"Range": "bytes=0-4"}
    )
    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes 0-4/{size}"
    assert resp.headers["content-length"] == "5"
    assert len(resp.content) == 5


@pytest.mark.asyncio
async def test_artifact_open_ended_range_returns_tail(client):
    sid, size = await _session_with_artifact(client)
    if size < 8:
        pytest.skip("stub mp4 too small for range test")
    resp = await client.get(
        f"/v1/sessions/{sid}/turns/0/artifact", headers={"Range": f"bytes={size - 4}-"}
    )
    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes {size - 4}-{size - 1}/{size}"
    assert int(resp.headers["content-length"]) == 4
    assert len(resp.content) == 4


@pytest.mark.asyncio
async def test_artifact_no_range_returns_200_full_body(client):
    sid, size = await _session_with_artifact(client)
    resp = await client.get(f"/v1/sessions/{sid}/turns/0/artifact")
    assert resp.status_code == 200
    assert resp.headers.get("accept-ranges") == "bytes"
    assert len(resp.content) == size


# --- session-history-switch: GET /v1/sessions + GET /{sid}/turns (D9) ----------

import uuid as _uuid
from datetime import datetime, timedelta, timezone


async def _mk_conv(
    db,
    *,
    tenant: str = "default",
    status=None,
    turn_count: int = 0,
    created_offset: int = 0,
    oh_session_id: str | None = None,
):
    """Insert a Conversation row directly (no live process needed)."""
    from app.models import Conversation, SessionStatus

    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    conv = Conversation(
        id=_uuid.uuid4(),
        tenant_id=tenant,
        status=status or SessionStatus.LIVE,
        oh_session_id=oh_session_id,
        turn_count=turn_count,
        extra_oh_args="[]",
        created_at=base + timedelta(minutes=created_offset),
        last_active_at=base + timedelta(minutes=created_offset),
    )
    db.add(conv)
    await db.commit()
    return conv


async def _mk_turn(db, conv_id, index: int, prompt: str = "hello"):
    from app.models import ConversationTurn, TurnStatus

    turn = ConversationTurn(
        conversation_id=conv_id,
        turn_index=index,
        prompt=prompt,
        assistant_text=f"reply {index}",
        status=TurnStatus.COMPLETED,
    )
    db.add(turn)
    await db.commit()
    return turn


@pytest.mark.asyncio
async def test_list_sessions_paged_newest_first(client, db_session):
    convs = [await _mk_conv(db_session, created_offset=i) for i in range(3)]
    resp = await client.get("/v1/sessions", params={"limit": 2})
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    assert data["limit"] == 2 and data["offset"] == 0
    assert [it["session_id"] for it in data["items"]] == [
        str(convs[2].id),
        str(convs[1].id),
    ]
    page2 = (await client.get("/v1/sessions", params={"limit": 2, "offset": 2})).json()
    assert [it["session_id"] for it in page2["items"]] == [str(convs[0].id)]


@pytest.mark.asyncio
async def test_list_sessions_status_filter(client, db_session):
    from app.models import SessionStatus

    await _mk_conv(db_session, status=SessionStatus.LIVE, created_offset=0)
    cold = await _mk_conv(db_session, status=SessionStatus.COLD, created_offset=1)
    data = (await client.get("/v1/sessions", params={"status": "cold"})).json()
    assert data["total"] == 1
    assert [it["session_id"] for it in data["items"]] == [str(cold.id)]


@pytest.mark.asyncio
async def test_list_sessions_title_truncated_to_80_chars(client, db_session):
    conv = await _mk_conv(db_session, turn_count=1)
    await _mk_turn(db_session, conv.id, 0, prompt="x" * 120)
    item = (await client.get("/v1/sessions")).json()["items"][0]
    assert item["title"] == "x" * 80
    assert item["turn_count"] == 1


@pytest.mark.asyncio
async def test_list_sessions_cross_tenant_invisible(client, db_session):
    mine = await _mk_conv(db_session)
    await _mk_conv(db_session, tenant="tenant-b", created_offset=5)
    data = (await client.get("/v1/sessions")).json()
    assert data["total"] == 1
    assert [it["session_id"] for it in data["items"]] == [str(mine.id)]


@pytest.mark.asyncio
async def test_list_sessions_business_fields(client, db_session, tmp_path, monkeypatch):
    """resumable/read_only mapping (D7/D8): closed -> view-only; cold with
    turns needs a snapshot; 0-turn cold stays resumable (fresh-spawn fallback)."""
    from app.config import settings
    from app.models import SessionStatus
    from app.session import tenant_store

    monkeypatch.setattr(settings, "tenants_root", tmp_path / "tenants")

    closed = await _mk_conv(db_session, status=SessionStatus.CLOSED, created_offset=0)
    live = await _mk_conv(db_session, status=SessionStatus.LIVE, created_offset=1)
    cold_no_snap = await _mk_conv(
        db_session, status=SessionStatus.COLD, turn_count=2,
        oh_session_id="oh-no-snap", created_offset=2,
    )
    cold_zero = await _mk_conv(
        db_session, status=SessionStatus.COLD, turn_count=0,
        oh_session_id="oh-zero-turns", created_offset=3,
    )
    failed_snap = await _mk_conv(
        db_session, status=SessionStatus.FAILED, turn_count=2,
        oh_session_id="oh-with-snap", created_offset=4,
    )
    # Fabricate a local staging snapshot for failed_snap only.
    snap_dir = tenant_store.local_data_dir("default") / "sessions"
    snap_dir.mkdir(parents=True, exist_ok=True)
    (snap_dir / "oh-with-snap.jsonl").write_text("{}")

    resp = await client.get("/v1/sessions", params={"limit": 100})
    by_id = {it["session_id"]: it for it in resp.json()["items"]}
    assert by_id[str(closed.id)]["read_only"] is True
    assert by_id[str(closed.id)]["resumable"] is False
    assert by_id[str(live.id)]["read_only"] is False
    assert by_id[str(live.id)]["resumable"] is True
    # cold with turns but no snapshot: not resumable, yet not read-only
    assert by_id[str(cold_no_snap.id)]["resumable"] is False
    assert by_id[str(cold_no_snap.id)]["read_only"] is False
    # 0-turn cold without a snapshot: resumable via fresh-spawn fallback
    assert by_id[str(cold_zero.id)]["resumable"] is True
    # failed with a recoverable snapshot: resumable
    assert by_id[str(failed_snap.id)]["resumable"] is True


@pytest.mark.asyncio
async def test_list_turns_cursor_paged(client, db_session):
    conv = await _mk_conv(db_session, turn_count=5)
    for i in range(5):
        await _mk_turn(db_session, conv.id, i, prompt=f"turn {i}")
    resp = await client.get(
        f"/v1/sessions/{conv.id}/turns", params={"after_index": 1, "limit": 2}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 5
    assert [t["turn_index"] for t in data["items"]] == [2, 3]
    assert data["items"][0]["prompt"] == "turn 2"
    assert data["items"][0]["assistant_text"] == "reply 2"


@pytest.mark.asyncio
async def test_list_turns_closed_session_still_readable(client, db_session):
    from app.models import SessionStatus

    conv = await _mk_conv(db_session, status=SessionStatus.CLOSED, turn_count=1)
    await _mk_turn(db_session, conv.id, 0)
    resp = await client.get(f"/v1/sessions/{conv.id}/turns")
    assert resp.status_code == 200
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_list_turns_cross_tenant_404(client, db_session):
    conv = await _mk_conv(db_session, tenant="tenant-b", turn_count=1)
    await _mk_turn(db_session, conv.id, 0)
    resp = await client.get(f"/v1/sessions/{conv.id}/turns")
    assert resp.status_code == 404
