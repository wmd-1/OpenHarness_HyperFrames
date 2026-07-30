"""Workspace archive lifecycle integration tests (openspec
add-session-workspace-archive, task 2.5).

Exercises the supervisor wiring around workspace_store with a direct-built
LiveSession (test_supervisor pattern) and the in-memory FakeMinio
(test_workspace_store pattern):

 ① a slow stage-out never delays the turn hook (mark is synchronous)
 ② a dirty burst is coalesced by ONE worker + debounce into one round
 ③ close removes the local workspace but KEEPS the MinIO archive
 ④ resume (rehydrate) restores a wiped workspace BEFORE backend spawn
 ⑤ quota-skipped files -> skipped[] while the round still succeeds
 ⑥ MinIO unreachable: worker / evict / close all stay healthy
 ⑦ rehydrate overwrites a stale same-name seed file + conflict log
 ⑧ close during a running worker: new dirty rejected, worker awaited,
    final stage-out carries the globally highest sync_seq (rev3)
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.config import settings
from app.session import registry as route_registry
from app.session import tenant_store, workspace_store
from app.session.lifecycle import SessionState
from app.session.supervisor import LiveSession, SessionSupervisor
from app.session.workspace_store import MANIFEST_NAME, MARKER_NAME
from tests.test_workspace_store import FakeMinio, LogRecorder

TID = "tenant-wsl"
DEBOUNCE_MS = 20
pytestmark = pytest.mark.asyncio


def _install(monkeypatch, client: FakeMinio) -> FakeMinio:
    """Enable the store against an in-memory client (unit-test pattern)."""
    monkeypatch.setattr(settings, "minio_endpoint", "minio:9000")
    monkeypatch.setattr(settings, "workspace_sync_debounce_ms", DEBOUNCE_MS)
    monkeypatch.setattr(tenant_store, "_client", lambda: client)
    monkeypatch.setattr(workspace_store, "_STAGE_OUT_BACKOFF", ())
    workspace_store._workspace_locks.clear()
    return client


@pytest.fixture()
def fake(monkeypatch):
    yield _install(monkeypatch, FakeMinio())
    workspace_store._workspace_locks.clear()


@pytest.fixture()
def logrec(monkeypatch):
    rec = LogRecorder()
    monkeypatch.setattr(workspace_store, "logger", rec)
    return rec


@pytest.fixture()
def sup(monkeypatch):
    """Supervisor with non-workspace collaborators mocked out: the tests
    target the workspace hooks' wiring/ordering, not tenant staging, the
    pool, redis routing or backend processes."""
    s = SessionSupervisor()
    monkeypatch.setattr(s.pool, "release", AsyncMock())
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
    return s


def _make_live(tmp_path: Path, tenant: str = TID) -> LiveSession:
    sid = uuid.uuid4()
    cwd = tmp_path / str(sid)
    cwd.mkdir()
    live = LiveSession(
        sid=sid,
        tenant_id=tenant,
        cwd=cwd,
        oh_session_id=f"oh-{sid.hex[:6]}",
        permission_policy="full_auto",
        extra_args=[],
        epoch=1,
    )
    live.state = SessionState.LIVE
    return live


def _prefix(live: LiveSession) -> str:
    return workspace_store.workspace_remote_prefix(live.tenant_id, live.sid)


def _manifest(fake: FakeMinio, live: LiveSession) -> dict:
    return json.loads(fake.store[_prefix(live) + MANIFEST_NAME])


# --- ① turn hook is synchronous / never blocked by a slow round -----------------


async def test_slow_stage_out_never_delays_turn_hook(fake, sup, tmp_path, monkeypatch):
    live = _make_live(tmp_path)
    release = asyncio.Event()
    calls: list[dict] = []

    async def slow_stage_out(tid, sid, cwd, **kw):
        calls.append(kw)
        await release.wait()  # artificially stuck round
        return True

    monkeypatch.setattr(workspace_store, "stage_out", slow_stage_out)

    # The stream_turn hook is a plain (non-awaitable) call: yielding the
    # terminal frame can never wait on the archive round.
    assert not asyncio.iscoroutinefunction(sup._mark_workspace_dirty)
    sup._mark_workspace_dirty(live)
    assert live._ws_dirty is True
    assert live._ws_sync_task is not None and not live._ws_sync_task.done()
    assert calls == []  # nothing ran synchronously

    # After the debounce the worker is stuck inside stage_out — the event
    # loop (i.e. the WS path) stays fully responsive meanwhile.
    await asyncio.sleep(DEBOUNCE_MS / 1000.0 + 0.05)
    assert len(calls) == 1 and not live._ws_sync_task.done()
    release.set()
    await live._ws_sync_task
    assert calls[0]["oh_session_id"] == live.oh_session_id
    assert calls[0]["session_status"] == "live"


# --- ② dirty burst -> one worker, coalesced rounds ------------------------------


async def test_dirty_burst_coalesced_by_single_worker(fake, sup, tmp_path, monkeypatch):
    live = _make_live(tmp_path)
    calls = 0

    async def counting_stage_out(*a, **kw):
        nonlocal calls
        calls += 1
        return True

    monkeypatch.setattr(workspace_store, "stage_out", counting_stage_out)

    for _ in range(5):
        sup._mark_workspace_dirty(live)
    worker = live._ws_sync_task
    for _ in range(5):
        sup._mark_workspace_dirty(live)
        assert live._ws_sync_task is worker  # never a second worker
    await worker
    assert calls == 1  # the whole burst collapsed into one round

    # A fresh mark after the worker exited starts a new round.
    sup._mark_workspace_dirty(live)
    assert live._ws_sync_task is not worker
    await live._ws_sync_task
    assert calls == 2


# --- ③ close: local gone, archive kept ------------------------------------------


async def test_close_removes_local_but_keeps_archive(fake, sup, tmp_path, db_session):
    live = _make_live(tmp_path)
    (live.cwd / "result.mp4").write_bytes(b"x" * 32)
    (live.cwd / "notes.md").write_text("draft")
    sup._sessions[live.sid] = live

    await sup.close(live.sid, db=db_session)

    # Step d ran: the local workspace is gone...
    assert not live.cwd.exists()
    assert not sup.has(live.sid)
    # ...while the archive (manifest + bodies) is intact and final.
    m = _manifest(fake, live)
    assert m["sync_state"] == "complete"
    assert m["session_status"] == "closed"
    assert {e["path"] for e in m["files"]} == {"result.mp4", "notes.md"}
    assert _prefix(live) + "files/result.mp4" in fake.store
    # Per-session lock entry released after close.
    assert str(live.sid) not in workspace_store._workspace_locks


# --- ④ resume: stage-in BEFORE spawn restores a wiped workspace ------------------


async def test_rehydrate_restores_wiped_workspace_before_spawn(
    fake, sup, tmp_path, monkeypatch
):
    live = _make_live(tmp_path)
    (live.cwd / "video.mp4").write_bytes(b"m" * 16)
    assert await workspace_store.stage_out(
        live.tenant_id, live.sid, live.cwd, oh_session_id=live.oh_session_id
    )
    # Container switch: the whole local workspace vanishes.
    for p in live.cwd.iterdir():
        p.unlink()
    live.cwd.rmdir()
    live.state = SessionState.COLD

    order: list[str] = []
    real_stage_in = workspace_store.stage_in

    async def recording_stage_in(*a, **kw):
        order.append("stage_in")
        return await real_stage_in(*a, **kw)

    files_at_spawn: list[str] = []

    async def fake_spawn(l: LiveSession, *, resume: bool) -> None:
        order.append("spawn")
        files_at_spawn.extend(p.name for p in l.cwd.iterdir())
        l.process = object()
        l.state = SessionState.LIVE

    monkeypatch.setattr(workspace_store, "stage_in", recording_stage_in)
    sup._spawn = fake_spawn

    await sup.rehydrate(live, db=None)  # snapshot mocked present -> db unused

    assert order == ["stage_in", "spawn"]  # restore strictly before spawn
    assert "video.mp4" in files_at_spawn  # backend sees files from turn one
    assert (live.cwd / "video.mp4").read_bytes() == b"m" * 16


# --- ⑤ quota-skipped round still succeeds ----------------------------------------


async def test_quota_skipped_files_round_still_succeeds(
    fake, sup, tmp_path, monkeypatch
):
    live = _make_live(tmp_path)
    (live.cwd / "huge.bin").write_bytes(b"h" * 128)
    monkeypatch.setattr(settings, "workspace_sync_max_file_mb", 0)

    sup._mark_workspace_dirty(live)
    await live._ws_sync_task  # worker exits cleanly, nothing raised

    m = _manifest(fake, live)
    assert m["sync_state"] == "complete" and m["sync_seq"] == 1
    assert m["files"] == []
    assert {"path": "huge.bin", "reason": "file_too_large"} in m["skipped"]


# --- ⑥ MinIO down: worker / evict / close stay healthy ---------------------------


async def test_minio_unreachable_never_breaks_lifecycle(
    sup, tmp_path, db_session, monkeypatch
):
    monkeypatch.setattr(settings, "minio_endpoint", "minio:9000")
    monkeypatch.setattr(settings, "workspace_sync_debounce_ms", DEBOUNCE_MS)
    monkeypatch.setattr(workspace_store, "_STAGE_OUT_BACKOFF", ())

    def down():
        raise RuntimeError("minio unreachable")

    monkeypatch.setattr(tenant_store, "_client", down)
    live = _make_live(tmp_path)
    (live.cwd / "f.txt").write_text("x")
    sup._sessions[live.sid] = live

    # Direct round: swallowed, reported via return value only.
    assert await workspace_store.stage_out(live.tenant_id, live.sid, live.cwd) is False
    # Worker round: exits without raising.
    sup._mark_workspace_dirty(live)
    await live._ws_sync_task
    # Evict hook ②: still demotes to COLD and frees the slot.
    assert await sup._evict(live) is True
    assert live.state == SessionState.COLD
    # Close: the archive round fails, the local cleanup still completes.
    live.state = SessionState.LIVE
    await sup.close(live.sid, db=db_session)
    assert not live.cwd.exists()
    assert not sup.has(live.sid)


# --- ⑦ stale same-name seed file overwritten on resume + conflict log ------------


async def test_rehydrate_overwrites_stale_seed_file_with_conflict_log(
    fake, sup, tmp_path, logrec, monkeypatch
):
    live = _make_live(tmp_path)
    (live.cwd / "config.json").write_text('{"v": "archived"}')
    assert await workspace_store.stage_out(live.tenant_id, live.sid, live.cwd)
    archived_mtime = _manifest(fake, live)["files"][0]["mtime"]

    # New container seeds a same-name file with an OLDER mtime (init template).
    for p in live.cwd.iterdir():
        p.unlink()
    seed = live.cwd / "config.json"
    seed.write_text('{"v": "template"}')
    os.utime(seed, (archived_mtime - 100, archived_mtime - 100))
    live.state = SessionState.COLD

    async def fake_spawn(l: LiveSession, *, resume: bool) -> None:
        l.process = object()
        l.state = SessionState.LIVE

    sup._spawn = fake_spawn
    await sup.rehydrate(live, db=None)

    assert seed.read_text() == '{"v": "archived"}'  # archive won LWW
    assert any(
        e == "workspace_stage_in_conflict" and kw.get("resolution") == "archive_wins"
        for e, kw in logrec.events
    )


# --- ⑧ close during a running worker (rev3 ordering) -----------------------------


class GatedFakeMinio(FakeMinio):
    """Blocks the FIRST marker PUT (i.e. mid-round, inside the worker's
    to_thread) until the test releases the gate."""

    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.gate = threading.Event()
        self._armed = True

    def put_object(self, bucket, key, data, length, content_type=None):
        if self._armed and key.endswith(MARKER_NAME):
            self._armed = False
            self.entered.set()
            assert self.gate.wait(timeout=10)
        super().put_object(bucket, key, data, length, content_type)


async def test_close_during_running_worker_rejects_dirty_and_finalizes(
    sup, tmp_path, db_session, monkeypatch
):
    gated = _install(monkeypatch, GatedFakeMinio())
    live = _make_live(tmp_path)
    (live.cwd / "wip.txt").write_text("work in progress")
    sup._sessions[live.sid] = live

    # Kick a worker round and wait until its stage-out is genuinely running
    # (blocked on the gated marker PUT inside the worker thread).
    sup._mark_workspace_dirty(live)
    worker = live._ws_sync_task
    assert await asyncio.to_thread(gated.entered.wait, 5)

    close_task = asyncio.create_task(sup.close(live.sid, db=db_session))
    await asyncio.sleep(0.05)  # close is inside drain, awaiting the worker
    assert live.closing is True and not close_task.done()

    # Step a: new dirty marks are rejected while closing.
    sup._mark_workspace_dirty(live)
    assert live._ws_dirty is False

    # Step b..d: release the round; worker finishes, close takes over.
    gated.gate.set()
    await close_task
    assert worker.done()
    assert not live.cwd.exists()

    # Final manifest owns the globally highest sync_seq: worker round wrote
    # seq 1, the close-path final stage-out wrote seq 2 with status closed.
    m = json.loads(gated.store[_prefix(live) + MANIFEST_NAME])
    assert m["sync_seq"] == 2
    assert m["session_status"] == "closed"
    assert m["sync_state"] == "complete"
