"""Workspace files API tests (openspec add-session-workspace-archive, task 3.3).

GET /v1/sessions/{sid}/workspace/files            — live/archive/none listing
GET /v1/sessions/{sid}/workspace/files/{path}     — download (presigned/proxy)

Covers: closed-session archive listing + download, cross-tenant 404, path
traversal 400, stale flag for a cross-node LIVE session, source "none" empty
list, presigned vs streaming branches, pagination (no gaps/duplicates,
prefix filter, final next_page_token=null).
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from pydantic import SecretStr

from app.config import settings
from app.models import Conversation, SessionStatus
from app.session import tenant_store, workspace_store
from app.session.lifecycle import SessionState
from app.session.supervisor import LiveSession, get_supervisor
from tests.test_workspace_store import FakeMinio

TID = "default"  # open-mode requests resolve to the default tenant
pytestmark = pytest.mark.asyncio


@pytest.fixture()
def fake(monkeypatch):
    client = FakeMinio()
    monkeypatch.setattr(settings, "minio_endpoint", "minio:9000")
    monkeypatch.setattr(tenant_store, "_client", lambda: client)
    monkeypatch.setattr(workspace_store, "_STAGE_OUT_BACKOFF", ())
    workspace_store._workspace_locks.clear()
    yield client
    workspace_store._workspace_locks.clear()


async def _mk_conv(
    db_engine,
    *,
    tenant: str = TID,
    status: SessionStatus = SessionStatus.CLOSED,
    workspace_path: str | None = None,
) -> uuid.UUID:
    conv = Conversation(
        id=uuid.uuid4(),
        tenant_id=tenant,
        status=status,
        oh_session_id="oh-files",
        turn_count=1,
        extra_oh_args="[]",
        workspace_path=workspace_path,
    )
    async with db_engine() as session:
        session.add(conv)
        await session.commit()
    return conv.id


async def _seed_archive(sid: uuid.UUID, tmp_path: Path, files: dict[str, bytes]) -> None:
    """Archive a synthetic workspace for ``sid`` through the real stage-out."""
    src = tmp_path / f"src-{sid}"
    src.mkdir()
    for rel, data in files.items():
        p = src / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    assert await workspace_store.stage_out(
        TID, sid, src, oh_session_id="oh-files", session_status="closed"
    )


# --- archive source (closed session) ---------------------------------------------


async def test_closed_session_lists_and_downloads_from_archive(
    fake, client, db_engine, tmp_path
):
    sid = await _mk_conv(db_engine, status=SessionStatus.CLOSED)
    await _seed_archive(sid, tmp_path, {"report.md": b"hello", "out/v.mp4": b"mm"})

    resp = await client.get(f"/v1/sessions/{sid}/workspace/files")
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "archive"
    assert body["stale"] is False  # closed, the archive IS the final state
    assert body["sync_seq"] == 1 and body["last_synced_at"]
    assert {f["path"] for f in body["files"]} == {"report.md", "out/v.mp4"}
    assert body["next_page_token"] is None

    # No public endpoint configured -> gateway streaming proxy.
    resp = await client.get(f"/v1/sessions/{sid}/workspace/files/report.md")
    assert resp.status_code == 200
    assert resp.content == b"hello"
    assert resp.headers["content-length"] == "5"
    assert "report.md" in resp.headers["content-disposition"]

    # A path absent from the manifest is 404.
    resp = await client.get(f"/v1/sessions/{sid}/workspace/files/nope.txt")
    assert resp.status_code == 404


async def test_presigned_redirect_when_public_endpoint_configured(
    fake, client, db_engine, tmp_path, monkeypatch
):
    sid = await _mk_conv(db_engine)
    await _seed_archive(sid, tmp_path, {"clip.mp4": b"vv"})
    monkeypatch.setattr(settings, "s3_public_endpoint", "http://public.minio:9000")
    monkeypatch.setattr(settings, "minio_access_key", SecretStr("ohminio"))
    monkeypatch.setattr(settings, "minio_secret_key", SecretStr("ohminio-secret"))

    resp = await client.get(f"/v1/sessions/{sid}/workspace/files/clip.mp4")
    assert resp.status_code == 302
    assert "public.minio:9000" in resp.headers["location"]
    assert "clip.mp4" in resp.headers["location"]

    # mode=stream forces the gateway proxy even with presigning available.
    resp = await client.get(f"/v1/sessions/{sid}/workspace/files/clip.mp4?mode=stream")
    assert resp.status_code == 200
    assert resp.content == b"vv"


# --- tenant isolation / traversal --------------------------------------------------


async def test_cross_tenant_access_is_404(fake, client, db_engine, tmp_path):
    sid = await _mk_conv(db_engine, tenant="tenant-other")
    resp = await client.get(f"/v1/sessions/{sid}/workspace/files")
    assert resp.status_code == 404
    resp = await client.get(f"/v1/sessions/{sid}/workspace/files/a.txt")
    assert resp.status_code == 404


async def test_path_traversal_rejected_with_400(fake, client, db_engine, tmp_path):
    sid = await _mk_conv(db_engine)
    await _seed_archive(sid, tmp_path, {"a.txt": b"a"})
    for encoded in ("..%2Fsecret", "%2Fetc%2Fpasswd", "sub%2F..%2F..%2Fx"):
        resp = await client.get(f"/v1/sessions/{sid}/workspace/files/{encoded}")
        assert resp.status_code == 400, encoded
    # The local-only sidecar is never exposed.
    resp = await client.get(
        f"/v1/sessions/{sid}/workspace/files/{workspace_store.SIDECAR_NAME}"
    )
    assert resp.status_code == 404


# --- source & stale semantics -------------------------------------------------------


async def test_live_session_on_this_node_lists_local_source(client, db_engine, tmp_path):
    # MinIO disabled entirely: the live listing must still work (spec).
    assert not workspace_store.enabled()
    sid = await _mk_conv(db_engine, status=SessionStatus.LIVE)
    cwd = tmp_path / str(sid)
    cwd.mkdir()
    (cwd / "draft.txt").write_text("d")
    (cwd / workspace_store.SIDECAR_NAME).write_text("{}")
    sup = get_supervisor()
    live = LiveSession(
        sid=sid,
        tenant_id=TID,
        cwd=cwd,
        oh_session_id="oh-files",
        permission_policy="full_auto",
        extra_args=[],
        epoch=1,
    )
    live.state = SessionState.LIVE
    sup._sessions[sid] = live

    resp = await client.get(f"/v1/sessions/{sid}/workspace/files")
    body = resp.json()
    assert body["source"] == "live" and body["stale"] is False
    assert [f["path"] for f in body["files"]] == ["draft.txt"]  # sidecar hidden

    resp = await client.get(f"/v1/sessions/{sid}/workspace/files/draft.txt")
    assert resp.status_code == 200 and resp.content == b"d"


async def test_cross_node_live_session_served_from_archive_with_stale(
    fake, client, db_engine, tmp_path
):
    # Status LIVE in the DB but no live session on THIS node -> archive + stale.
    sid = await _mk_conv(db_engine, status=SessionStatus.LIVE)
    await _seed_archive(sid, tmp_path, {"wip.txt": b"w"})

    resp = await client.get(f"/v1/sessions/{sid}/workspace/files")
    body = resp.json()
    assert body["source"] == "archive"
    assert body["stale"] is True
    assert body["last_synced_at"]


async def test_no_archive_no_local_dir_returns_source_none(fake, client, db_engine):
    sid = await _mk_conv(db_engine, status=SessionStatus.CLOSED)
    resp = await client.get(f"/v1/sessions/{sid}/workspace/files")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "source": "none",
        "stale": False,
        "sync_seq": None,
        "last_synced_at": None,
        "total": 0,
        "files": [],
        "next_page_token": None,
    }
    resp = await client.get(f"/v1/sessions/{sid}/workspace/files/a.txt")
    assert resp.status_code == 404


# --- pagination ---------------------------------------------------------------------


async def test_pagination_walks_without_gaps_or_duplicates(
    fake, client, db_engine, tmp_path
):
    sid = await _mk_conv(db_engine)
    names = [f"f{i}.txt" for i in range(5)] + ["sub/inner.txt"]
    await _seed_archive(sid, tmp_path, {n: b"x" for n in names})

    seen: list[str] = []
    token: str | None = None
    pages = 0
    while True:
        url = f"/v1/sessions/{sid}/workspace/files?limit=2"
        if token:
            url += f"&page_token={token}"
        body = (await client.get(url)).json()
        assert body["source"] == "archive" and body["total"] == 6
        seen.extend(f["path"] for f in body["files"])
        token = body["next_page_token"]
        pages += 1
        if token is None:
            break
    assert pages == 3 and seen == sorted(names)  # exactly once each, in order

    # prefix filter narrows both the page and the total.
    body = (await client.get(
        f"/v1/sessions/{sid}/workspace/files?prefix=sub/"
    )).json()
    assert body["total"] == 1
    assert [f["path"] for f in body["files"]] == ["sub/inner.txt"]
    assert body["next_page_token"] is None

    # Garbage cursors are a client error, not a 500.
    resp = await client.get(
        f"/v1/sessions/{sid}/workspace/files?page_token=%3F%3F%3F"
    )
    assert resp.status_code == 400
