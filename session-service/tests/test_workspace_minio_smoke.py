"""Real-MinIO workspace archive smoke path (openspec
add-session-workspace-archive, task 4.3).

Runs only under the e2e harness (``e2e/run-session-minio-tests.sh`` exports
``OH_TEST_MINIO_ENDPOINT`` and starts the compose ``minio`` service); skipped
everywhere else. Two flows against a REAL MinIO:

- turn hook -> archive objects exist (manifest + files/, no marker left)
  -> close (local gone, archive kept) -> files API lists & downloads;
- ``scripts/purge_workspace_archives.py``: dry-run keeps, real run purges.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from pydantic import SecretStr

from app.config import settings
from app.models import Conversation, SessionStatus
from app.session import registry as route_registry
from app.session import tenant_store, workspace_store
from app.session.lifecycle import SessionState
from app.session.supervisor import LiveSession, get_supervisor
from app.session.workspace_store import MANIFEST_NAME, MARKER_NAME

pytestmark = pytest.mark.asyncio


@pytest.fixture()
def minio_live(monkeypatch):
    """Wire settings at a real MinIO (compose ``minio`` service) or skip."""
    endpoint = os.environ.get("OH_TEST_MINIO_ENDPOINT")
    if not endpoint:
        pytest.skip("OH_TEST_MINIO_ENDPOINT not set — MinIO integration harness only")
    monkeypatch.setattr(settings, "minio_endpoint", endpoint)
    monkeypatch.setattr(
        settings,
        "minio_access_key",
        SecretStr(os.environ.get("OH_TEST_MINIO_ACCESS_KEY", "ohminio")),
    )
    monkeypatch.setattr(
        settings,
        "minio_secret_key",
        SecretStr(os.environ.get("OH_TEST_MINIO_SECRET_KEY", "ohminio-secret")),
    )
    monkeypatch.setattr(settings, "minio_bucket", "oh-tenants-test")
    monkeypatch.setattr(settings, "minio_secure", False)
    monkeypatch.setattr(settings, "workspace_sync_debounce_ms", 20)
    monkeypatch.setattr(workspace_store, "_STAGE_OUT_BACKOFF", ())
    workspace_store._workspace_locks.clear()
    client = tenant_store._client()
    if not client.bucket_exists(settings.minio_bucket):
        client.make_bucket(settings.minio_bucket)
    yield endpoint
    workspace_store._workspace_locks.clear()


def _remote_names(prefix: str) -> set[str]:
    client = tenant_store._client()
    return {
        o.object_name
        for o in client.list_objects(settings.minio_bucket, prefix=prefix, recursive=True)
    }


def _mock_collaborators(sup, monkeypatch) -> None:
    """Mock the non-workspace collaborators (test_workspace_lifecycle pattern);
    tenant_store._client stays REAL so workspace_store talks to MinIO."""
    monkeypatch.setattr(sup.pool, "release", AsyncMock())
    monkeypatch.setattr(tenant_store, "stage_in", AsyncMock())
    monkeypatch.setattr(tenant_store, "stage_out", AsyncMock())
    monkeypatch.setattr(tenant_store, "destroy_session_data", AsyncMock())
    monkeypatch.setattr(
        tenant_store, "has_session_snapshot", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(route_registry, "acquire_lock", AsyncMock(return_value=True))
    monkeypatch.setattr(route_registry, "release_lock", AsyncMock())
    monkeypatch.setattr(route_registry, "clear_route", AsyncMock())
    from app.session import logs as log_stream

    monkeypatch.setattr(log_stream, "clear_logs", AsyncMock())


# --- turn -> archive -> close -> files API ----------------------------------------


async def test_turn_close_files_api_roundtrip(
    minio_live, client, db_engine, db_session, tmp_path, monkeypatch
):
    sup = get_supervisor()
    _mock_collaborators(sup, monkeypatch)

    # Session on this node for the "default" tenant (open-mode requests).
    conv = Conversation(
        id=uuid.uuid4(),
        tenant_id="default",
        status=SessionStatus.LIVE,
        oh_session_id="oh-smoke",
        turn_count=1,
        extra_oh_args="[]",
    )
    async with db_engine() as session:
        session.add(conv)
        await session.commit()

    cwd = tmp_path / str(conv.id)
    cwd.mkdir()
    (cwd / "report.md").write_bytes(b"smoke-hello")
    (cwd / "out").mkdir()
    (cwd / "out" / "frame.png").write_bytes(b"\x89PNG smoke")
    live = LiveSession(
        sid=conv.id,
        tenant_id="default",
        cwd=cwd,
        oh_session_id="oh-smoke",
        permission_policy="full_auto",
        extra_args=[],
        epoch=1,
    )
    live.state = SessionState.LIVE
    sup._sessions[conv.id] = live

    # Turn completion hook -> archive round against the real MinIO.
    sup._mark_workspace_dirty(live)
    await live._ws_sync_task

    prefix = workspace_store.workspace_remote_prefix("default", conv.id)
    names = _remote_names(prefix)
    assert prefix + MANIFEST_NAME in names
    assert prefix + "files/report.md" in names
    assert prefix + "files/out/frame.png" in names
    assert prefix + MARKER_NAME not in names  # round finished cleanly

    # Close: local workspace removed, archive retained with final manifest.
    await sup.close(conv.id, db=db_session)
    assert not cwd.exists()
    assert prefix + "files/report.md" in _remote_names(prefix)

    # Files API reads the archive of the closed session.
    resp = await client.get(f"/v1/sessions/{conv.id}/workspace/files")
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "archive"
    assert {f["path"] for f in body["files"]} == {"report.md", "out/frame.png"}
    assert body["sync_seq"] == 2  # turn round + final close round

    resp = await client.get(f"/v1/sessions/{conv.id}/workspace/files/report.md")
    assert resp.status_code == 200
    assert resp.content == b"smoke-hello"


# --- purge script against a real archive -------------------------------------------


def _load_purge_module():
    path = Path(__file__).resolve().parent.parent / "scripts" / "purge_workspace_archives.py"
    spec = importlib.util.spec_from_file_location("purge_workspace_archives", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


async def test_purge_script_dry_run_keeps_then_real_run_purges(
    minio_live, tmp_path, monkeypatch
):
    tid = f"tenant-smoke-{uuid.uuid4().hex[:8]}"
    sid = uuid.uuid4()
    src = tmp_path / "ws"
    src.mkdir()
    (src / "old.txt").write_text("expired")
    assert await workspace_store.stage_out(
        tid, sid, src, oh_session_id="oh-purge", session_status="closed"
    )
    prefix = workspace_store.workspace_remote_prefix(tid, sid)
    assert prefix + MANIFEST_NAME in _remote_names(prefix)

    purge = _load_purge_module()
    argv = [
        "purge_workspace_archives.py",
        "--older-than-days", "0",
        "--tenant", tid,
        "--gc-grace-hours", "0",
    ]

    monkeypatch.setattr(sys, "argv", argv + ["--dry-run"])
    assert purge.main() == 0
    assert prefix + MANIFEST_NAME in _remote_names(prefix)  # dry-run keeps

    monkeypatch.setattr(sys, "argv", argv)
    assert purge.main() == 0
    assert _remote_names(prefix) == set()  # files/, manifest, everything gone
