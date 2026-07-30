"""Workspace archive store unit tests (openspec add-session-workspace-archive, task 1.5).

All MinIO interaction is mocked with an in-memory fake client — the real-MinIO
path is covered by the e2e smoke (task 4.3). Focus areas:

- manifest structure + write ordering (marker -> bodies -> manifest -> GC/marker)
- interrupted round: previous complete manifest stays readable, debris GC'd
- incremental upload, delete propagation, rebase on remote sync_seq advance
- rev3 version-first tombstones (sidecar baseline; future mtime cannot resurrect)
- ignore rules and per-file/total quotas -> skipped[]
- stage-in: tombstone-first ordering, state comparison + mtime LWW, idempotency
- disabled store -> zero client calls
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.config import settings
from app.session import tenant_store, workspace_store
from app.session.workspace_store import MANIFEST_NAME, MARKER_NAME, SIDECAR_NAME

TID = "tenant-ws"
pytestmark = pytest.mark.asyncio


def _s3_no_such_key():
    from minio.error import S3Error

    return S3Error(
        code="NoSuchKey",
        message="missing",
        resource="res",
        request_id="rid",
        host_id="hid",
        response=None,
    )


class FakeMinio:
    """Dict-backed stand-in for the blocking minio SDK client."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}
        self.ops: list[tuple[str, str]] = []
        self.fail_fput_after: int | None = None
        self._fput_calls = 0

    # -- bucket plumbing --
    def bucket_exists(self, bucket):  # noqa: D102
        return True

    def make_bucket(self, bucket):  # noqa: D102
        pass

    # -- objects --
    def put_object(self, bucket, key, data, length, content_type=None):
        self.ops.append(("put", key))
        self.store[key] = data.read()

    def fput_object(self, bucket, key, path):
        self._fput_calls += 1
        if self.fail_fput_after is not None and self._fput_calls > self.fail_fput_after:
            raise RuntimeError("injected upload failure")
        self.ops.append(("fput", key))
        self.store[key] = Path(path).read_bytes()
        return SimpleNamespace(etag=f"etag-{self._fput_calls}")

    def fget_object(self, bucket, key, path):
        self.ops.append(("fget", key))
        if key not in self.store:
            raise _s3_no_such_key()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(self.store[key])

    def get_object(self, bucket, key):
        if key not in self.store:
            raise _s3_no_such_key()
        data = self.store[key]

        def _stream(chunk=1024 * 1024):
            yield data

        return SimpleNamespace(
            read=lambda: data,
            stream=_stream,
            close=lambda: None,
            release_conn=lambda: None,
        )

    def list_objects(self, bucket, prefix="", recursive=False):
        return [
            SimpleNamespace(object_name=k)
            for k in sorted(self.store)
            if k.startswith(prefix)
        ]

    def remove_object(self, bucket, key):
        self.ops.append(("rm", key))
        self.store.pop(key, None)


class LogRecorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def warning(self, event, **kw):
        self.events.append((event, kw))

    error = warning

    def info(self, *a, **kw):
        pass

    def has(self, event: str) -> bool:
        return any(e == event for e, _ in self.events)


@pytest.fixture()
def fake(monkeypatch):
    client = FakeMinio()
    monkeypatch.setattr(settings, "minio_endpoint", "minio:9000")
    monkeypatch.setattr(tenant_store, "_client", lambda: client)
    monkeypatch.setattr(workspace_store, "_STAGE_OUT_BACKOFF", ())
    workspace_store._workspace_locks.clear()
    yield client
    workspace_store._workspace_locks.clear()


@pytest.fixture()
def logrec(monkeypatch):
    rec = LogRecorder()
    monkeypatch.setattr(workspace_store, "logger", rec)
    return rec


def _sid() -> str:
    return str(uuid.uuid4())


def _prefix(sid: str) -> str:
    return workspace_store.workspace_remote_prefix(TID, sid)


def _manifest(fake: FakeMinio, sid: str) -> dict:
    return json.loads(fake.store[_prefix(sid) + MANIFEST_NAME])


async def _out(sid: str, cwd: Path) -> bool:
    return await workspace_store.stage_out(
        TID, sid, cwd, oh_session_id="oh-x", session_status="live"
    )


# --- stage-out core -----------------------------------------------------------


async def test_manifest_structure_and_write_order(fake, tmp_path):
    sid = _sid()
    cwd = tmp_path / sid
    cwd.mkdir()
    (cwd / "report.md").write_text("hello")
    (cwd / "sub").mkdir()
    (cwd / "sub" / "data.json").write_text("{}")

    assert await _out(sid, cwd) is True
    m = _manifest(fake, sid)
    assert m["schema_version"] == 1
    assert m["tenant_id"] == TID and m["session_id"] == sid
    assert m["oh_session_id"] == "oh-x"
    assert m["sync_state"] == "complete"
    assert m["sync_seq"] == 1 and m["last_synced_at"]
    assert m["files_prefix"] == _prefix(sid) + "files/"
    assert m["total_files"] == 2 and m["total_bytes"] == 7
    by_path = {e["path"]: e for e in m["files"]}
    assert set(by_path) == {"report.md", str(Path("sub") / "data.json")}
    assert all(e["last_seen_sync_seq"] == 1 and e["etag"] for e in m["files"])

    # Write ordering: marker first, bodies before manifest, marker removed last.
    keys = [k for _, k in fake.ops]
    marker = _prefix(sid) + MARKER_NAME
    manifest_key = _prefix(sid) + MANIFEST_NAME
    assert keys[0] == marker
    assert keys.index(manifest_key) > max(
        i for i, (op, k) in enumerate(fake.ops) if op == "fput"
    )
    assert fake.ops[-1] == ("rm", marker)
    assert marker not in fake.store

    # Sidecar advanced locally, hard-excluded from the archive.
    assert json.loads((cwd / SIDECAR_NAME).read_text())["base_sync_seq"] == 1
    assert not any(k.endswith(SIDECAR_NAME) for k in fake.store)


async def test_interrupted_round_keeps_previous_complete_manifest(fake, tmp_path, logrec):
    sid = _sid()
    cwd = tmp_path / sid
    cwd.mkdir()
    (cwd / "a.txt").write_text("a1")
    assert await _out(sid, cwd) is True

    # Round 2: one upload succeeds, the next blows up mid-round.
    (cwd / "a.txt").write_text("a2-changed")
    (cwd / "b.txt").write_text("b1")
    fake.fail_fput_after = fake._fput_calls + 1
    assert await _out(sid, cwd) is False

    m = _manifest(fake, sid)
    assert m["sync_seq"] == 1 and m["sync_state"] == "complete"  # previous snapshot
    assert _prefix(sid) + MARKER_NAME in fake.store  # identifiable debris

    # Next successful round recovers: new complete manifest, marker gone.
    fake.fail_fput_after = None
    assert await _out(sid, cwd) is True
    m = _manifest(fake, sid)
    assert m["sync_seq"] == 2 and {e["path"] for e in m["files"]} == {"a.txt", "b.txt"}
    assert _prefix(sid) + MARKER_NAME not in fake.store


async def test_incremental_upload_and_delete_propagation(fake, tmp_path):
    sid = _sid()
    cwd = tmp_path / sid
    cwd.mkdir()
    (cwd / "keep.txt").write_text("keep")
    (cwd / "gone.txt").write_text("gone")
    assert await _out(sid, cwd) is True

    # Unchanged files are not re-uploaded but confirmed at the new seq.
    fake.ops.clear()
    (cwd / "keep.txt").write_text("keep-v2")
    os.utime(cwd / "keep.txt", (time.time() + 5, time.time() + 5))
    assert await _out(sid, cwd) is True
    fputs = [k for op, k in fake.ops if op == "fput"]
    assert fputs == [_prefix(sid) + "files/keep.txt"]
    m = _manifest(fake, sid)
    assert {e["path"]: e["last_seen_sync_seq"] for e in m["files"]} == {
        "keep.txt": 2,
        "gone.txt": 2,
    }

    # Local delete -> tombstone + remote body removed.
    (cwd / "gone.txt").unlink()
    assert await _out(sid, cwd) is True
    m = _manifest(fake, sid)
    assert [e["path"] for e in m["files"]] == ["keep.txt"]
    assert m["deleted"] == [
        {
            "path": "gone.txt",
            "deleted_seq": 3,
            "deleted_at": m["deleted"][0]["deleted_at"],
        }
    ]
    assert _prefix(sid) + "files/gone.txt" not in fake.store


async def test_rebase_on_remote_sync_seq_advance(fake, tmp_path):
    sid = _sid()
    cwd = tmp_path / sid
    cwd.mkdir()
    (cwd / "f.txt").write_text("x")
    assert await _out(sid, cwd) is True

    # Another node advanced the archive to seq 41 meanwhile.
    m = _manifest(fake, sid)
    m["sync_seq"] = 41
    fake.store[_prefix(sid) + MANIFEST_NAME] = json.dumps(m).encode()
    assert await _out(sid, cwd) is True
    assert _manifest(fake, sid)["sync_seq"] == 42


# --- rev3 version-first tombstones ---------------------------------------------


async def _archive_with_tombstone(fake, tmp_path) -> tuple[str, Path]:
    """Two rounds: create a.txt+b.txt, then delete a.txt (tombstone seq=2)."""
    sid = _sid()
    cwd = tmp_path / sid
    cwd.mkdir()
    (cwd / "a.txt").write_text("a")
    (cwd / "b.txt").write_text("b")
    assert await _out(sid, cwd) is True
    (cwd / "a.txt").unlink()
    assert await _out(sid, cwd) is True
    m = _manifest(fake, sid)
    assert m["deleted"][0] == {
        "path": "a.txt",
        "deleted_seq": 2,
        "deleted_at": m["deleted"][0]["deleted_at"],
    }
    return sid, cwd


async def test_stale_residual_never_resurrects_even_with_future_mtime(
    fake, tmp_path, logrec
):
    sid, cwd = await _archive_with_tombstone(fake, tmp_path)
    # Simulate a stale node: residual back on disk with an anomalous FUTURE
    # mtime, and a baseline older than the deletion round.
    (cwd / "a.txt").write_text("zombie")
    future = time.time() + 10 * 86400
    os.utime(cwd / "a.txt", (future, future))
    (cwd / SIDECAR_NAME).write_text(json.dumps({"base_sync_seq": 1}))

    fake.ops.clear()
    assert await _out(sid, cwd) is True
    m = _manifest(fake, sid)
    assert [e["path"] for e in m["files"]] == ["b.txt"]  # no resurrection
    assert m["deleted"][0]["path"] == "a.txt"  # tombstone carried forward
    assert not any(k.endswith("files/a.txt") for op, k in fake.ops if op == "fput")
    assert logrec.has("workspace_stale_residual_skipped")


async def test_recreation_after_observed_deletion_is_reuploaded(fake, tmp_path):
    sid, cwd = await _archive_with_tombstone(fake, tmp_path)
    # The deleting node's sidecar is at seq 2 (>= deleted_seq): a new a.txt is
    # a genuine recreation.
    assert json.loads((cwd / SIDECAR_NAME).read_text())["base_sync_seq"] == 2
    (cwd / "a.txt").write_text("recreated")
    assert await _out(sid, cwd) is True
    m = _manifest(fake, sid)
    assert {e["path"] for e in m["files"]} == {"a.txt", "b.txt"}
    assert m["deleted"] == []  # tombstone removed on recreation


async def test_missing_sidecar_falls_back_to_mtime_with_warning(
    fake, tmp_path, logrec
):
    sid, cwd = await _archive_with_tombstone(fake, tmp_path)
    (cwd / SIDECAR_NAME).unlink()
    # Residual OLDER than deleted_at -> not re-uploaded (fallback), logged.
    (cwd / "a.txt").write_text("old residual")
    past = time.time() - 86400
    os.utime(cwd / "a.txt", (past, past))
    assert await _out(sid, cwd) is True
    assert [e["path"] for e in _manifest(fake, sid)["files"]] == ["b.txt"]
    assert logrec.has("workspace_tombstone_mtime_fallback")


# --- ignore rules and quotas -----------------------------------------------------


async def test_ignore_and_quota_limits_record_skipped(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_sync_max_file_mb", 1)
    monkeypatch.setattr(settings, "workspace_sync_max_total_mb", 1)
    sid = _sid()
    cwd = tmp_path / sid
    (cwd / "node_modules").mkdir(parents=True)
    (cwd / "node_modules" / "pkg.js").write_text("ignored")
    (cwd / "big.bin").write_bytes(b"x" * (1024 * 1024 + 1))  # over per-file cap
    (cwd / "new.bin").write_bytes(b"y" * (700 * 1024))
    (cwd / "old.bin").write_bytes(b"z" * (700 * 1024))
    os.utime(cwd / "old.bin", (time.time() - 3600,) * 2)  # loses the quota race
    link = cwd / "link.txt"
    link.symlink_to(cwd / "new.bin")

    assert await _out(sid, cwd) is True
    m = _manifest(fake, sid)
    assert [e["path"] for e in m["files"]] == ["new.bin"]
    skipped = {s["path"]: s["reason"] for s in m["skipped"]}
    assert skipped == {
        "big.bin": "file_too_large",
        "old.bin": "total_quota_exceeded",
    }
    uploaded = {k for op, k in fake.ops if op == "fput"}
    assert uploaded == {_prefix(sid) + "files/new.bin"}  # no ignored/symlinked


# --- stage-in ---------------------------------------------------------------------


async def test_stage_in_state_comparison_lww_and_idempotency(
    fake, tmp_path, logrec
):
    sid = _sid()
    src = tmp_path / "src"
    src.mkdir()
    (src / "x.txt").write_text("archived-x")
    (src / "y.txt").write_text("archived-y")
    assert await _out(sid, src) is True
    m = _manifest(fake, sid)
    x_mtime = next(e["mtime"] for e in m["files"] if e["path"] == "x.txt")

    dest = tmp_path / "dest"
    dest.mkdir()
    # Pre-existing same-name init file OLDER than the archive -> overwritten.
    (dest / "x.txt").write_text("init-file")
    os.utime(dest / "x.txt", (x_mtime - 100, x_mtime - 100))
    assert await workspace_store.stage_in(TID, sid, dest) is True
    assert (dest / "x.txt").read_text() == "archived-x"
    assert (dest / "y.txt").read_text() == "archived-y"
    assert abs(os.stat(dest / "x.txt").st_mtime - x_mtime) < 0.01  # aligned
    assert json.loads((dest / SIDECAR_NAME).read_text())["base_sync_seq"] == 1
    assert any(
        e == "workspace_stage_in_conflict" and kw["resolution"] == "archive_wins"
        for e, kw in logrec.events
    )

    # Idempotent: a second stage-in downloads nothing.
    fake.ops.clear()
    assert await workspace_store.stage_in(TID, sid, dest) is True
    assert not [k for op, k in fake.ops if op == "fget"]

    # Local NEWER edit is an un-archived change -> kept.
    (dest / "y.txt").write_text("local-newer")
    os.utime(dest / "y.txt", (time.time() + 60,) * 2)
    assert await workspace_store.stage_in(TID, sid, dest) is True
    assert (dest / "y.txt").read_text() == "local-newer"
    assert any(
        e == "workspace_stage_in_conflict" and kw["resolution"] == "local_kept"
        for e, kw in logrec.events
    )


async def test_stage_in_tombstone_first_blocks_future_mtime_bypass(
    fake, tmp_path, logrec
):
    sid, src = await _archive_with_tombstone(fake, tmp_path)
    dest = tmp_path / "dest"
    dest.mkdir()
    # Stale node residual at the tombstoned path with a FUTURE mtime, and a
    # pre-stage-in baseline older than the deletion.
    (dest / "a.txt").write_text("zombie")
    future = time.time() + 10 * 86400
    os.utime(dest / "a.txt", (future, future))
    (dest / SIDECAR_NAME).write_text(json.dumps({"base_sync_seq": 1}))

    assert await workspace_store.stage_in(TID, sid, dest) is True
    # Deleted locally BEFORE the baseline advanced — never entered LWW.
    assert not (dest / "a.txt").exists()
    assert logrec.has("workspace_stale_residual_removed")
    assert json.loads((dest / SIDECAR_NAME).read_text())["base_sync_seq"] == 2

    # The follow-up stage-out cannot resurrect it either.
    fake.ops.clear()
    assert await _out(sid, dest) is True
    assert [e["path"] for e in _manifest(fake, sid)["files"]] == ["b.txt"]


async def test_stage_in_keeps_genuine_recreation(fake, tmp_path):
    sid, src = await _archive_with_tombstone(fake, tmp_path)
    dest = tmp_path / "dest"
    dest.mkdir()
    # Node already observed the deletion (baseline == deleted_seq): the
    # residual is a real recreation and must survive stage-in.
    (dest / "a.txt").write_text("recreated")
    (dest / SIDECAR_NAME).write_text(json.dumps({"base_sync_seq": 2}))
    assert await workspace_store.stage_in(TID, sid, dest) is True
    assert (dest / "a.txt").read_text() == "recreated"


async def test_stage_in_rejects_escaping_manifest_paths(fake, tmp_path):
    sid = _sid()
    cwd = tmp_path / sid
    cwd.mkdir()
    (cwd / "ok.txt").write_text("ok")
    assert await _out(sid, cwd) is True
    # Poison the manifest with traversal paths.
    m = _manifest(fake, sid)
    m["files"].append({"path": "../evil.txt", "size": 1, "mtime": 1.0})
    m["files"].append({"path": "/abs/evil.txt", "size": 1, "mtime": 1.0})
    fake.store[_prefix(sid) + MANIFEST_NAME] = json.dumps(m).encode()
    fake.store[_prefix(sid) + "files/../evil.txt"] = b"evil"

    dest = tmp_path / "dest"
    dest.mkdir()
    assert await workspace_store.stage_in(TID, sid, dest) is True
    assert not (tmp_path / "evil.txt").exists()
    assert (dest / "ok.txt").read_text() == "ok"


# --- disabled / guards ------------------------------------------------------------


async def test_disabled_store_makes_zero_client_calls(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "minio_endpoint", None)

    def _boom():
        raise AssertionError("client must not be constructed when disabled")

    monkeypatch.setattr(tenant_store, "_client", _boom)
    sid = _sid()
    cwd = tmp_path / sid
    cwd.mkdir()
    (cwd / "f.txt").write_text("x")
    assert await workspace_store.stage_out(TID, sid, cwd) is True
    assert await workspace_store.stage_in(TID, sid, cwd) is True
    assert await workspace_store.load_manifest(TID, sid) is None


async def test_remote_prefix_validation():
    assert (
        workspace_store.workspace_remote_prefix("t1", "abc")
        == "tenants/t1/workspaces/abc/"
    )
    with pytest.raises(ValueError):
        workspace_store.workspace_remote_prefix("../evil", "abc")
    with pytest.raises(ValueError):
        workspace_store.workspace_remote_prefix("t1", "a/../b")


async def test_stage_out_failure_is_swallowed_and_counted(fake, tmp_path, logrec):
    sid = _sid()
    cwd = tmp_path / sid
    cwd.mkdir()
    (cwd / "f.txt").write_text("x")
    fake.fail_fput_after = 0
    assert await _out(sid, cwd) is False  # returned, never raised
    assert logrec.has("workspace_stage_out_failed")
