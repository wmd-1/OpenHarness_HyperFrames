"""Tests for ``cleanup_expired_tasks`` (#4 scheduling + #14 stale pointer fix).

Drives the real task body (via ``.run()``) with a sqlite sync engine, a temp
local storage, and a fakeredis client so no Postgres/Redis server is required.
Proves that expired tasks have their artifacts reclaimed and their stale
``output_path`` / ``workspace_path`` nulled, while non-expired tasks are left
untouched.
"""

import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import fakeredis
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, TaskStatus, VideoTask
from app.storage.local import LocalVideoStorage
from app.workers import tasks as worker_tasks

pytest.importorskip("fakeredis")


@pytest.fixture
def sync_db():
    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng)
    worker_tasks._sync_engine = eng
    yield eng
    worker_tasks._sync_engine = None
    eng.dispose()


def test_cleanup_expired_reclaims_artifacts_and_nulls_pointers(sync_db):
    tmp = tempfile.mkdtemp()
    storage = LocalVideoStorage(root=Path(tmp))

    old = VideoTask(
        prompt="old",
        status=TaskStatus.SUCCEEDED,
        created_at=datetime.now(timezone.utc) - timedelta(days=30),
    )
    fresh = VideoTask(
        prompt="fresh",
        status=TaskStatus.SUCCEEDED,
        created_at=datetime.now(timezone.utc),
        workspace_path=str(Path(tmp) / "keep_ws"),
        output_path="keep.mp4",
    )
    with Session(sync_db) as s:
        s.add_all([old, fresh])
        s.commit()
        old_id = old.id
        fresh_id = fresh.id

    # Seed artifacts for the expired task.
    old_key = f"{old_id}.mp4"
    (Path(tmp) / old_key).write_bytes(b"video-bytes")
    old_ws = Path(tmp) / f"ws_{old_id}"
    old_ws.mkdir()
    (old_ws / "x.txt").write_text("workspace file")

    # Seed artifact for the fresh task (must survive cleanup).
    (Path(tmp) / "keep.mp4").write_bytes(b"keep-bytes")
    Path(tmp, "keep_ws").mkdir(parents=True, exist_ok=True)

    with Session(sync_db) as s:
        t = s.get(VideoTask, old_id)
        t.output_path = old_key
        t.workspace_path = str(old_ws)
        s.commit()

    fake = fakeredis.FakeStrictRedis()
    with patch.object(worker_tasks, "LocalVideoStorage", return_value=storage), patch.object(
        worker_tasks, "_redis_client", return_value=fake
    ):
        worker_tasks.cleanup_expired_tasks.run()

    # Expired task: artifact file + workspace dir gone, pointers nulled.
    assert not (Path(tmp) / old_key).exists()
    assert not old_ws.exists()
    with Session(sync_db) as s:
        t = s.get(VideoTask, old_id)
        assert t.output_path is None
        assert t.workspace_path is None

    # Fresh task: untouched (still has its artifact + pointers).
    assert (Path(tmp) / "keep.mp4").exists()
    with Session(sync_db) as s:
        f = s.get(VideoTask, fresh_id)
        assert f.output_path == "keep.mp4"
        assert f.workspace_path is not None

    shutil.rmtree(tmp, ignore_errors=True)


def test_cleanup_is_resilient_to_individual_failures(sync_db):
    """One task's cleanup failure MUST NOT abort the entire sweep (N13/P6).

    If storage.delete() raises for one task, the remaining tasks must still
    be processed and their pointers nulled.
    """
    import tempfile

    tmp = tempfile.mkdtemp()
    storage = LocalVideoStorage(root=Path(tmp))

    old_time = datetime.now(timezone.utc) - timedelta(days=30)

    # Task 1: will fail during storage.delete (key doesn't exist on disk)
    task1 = VideoTask(
        prompt="fail",
        status=TaskStatus.SUCCEEDED,
        created_at=old_time,
        output_path="missing-key.mp4",
        workspace_path=str(Path(tmp) / "ws1"),
    )
    # Task 2: normal, will succeed
    task2_key = "good.mp4"
    (Path(tmp) / task2_key).write_bytes(b"good")
    task2 = VideoTask(
        prompt="good",
        status=TaskStatus.SUCCEEDED,
        created_at=old_time,
        output_path=task2_key,
        workspace_path=str(Path(tmp) / "ws2"),
    )
    Path(tmp, "ws1").mkdir(exist_ok=True)
    Path(tmp, "ws2").mkdir(exist_ok=True)

    with Session(sync_db) as s:
        s.add_all([task1, task2])
        s.commit()
        task1_id = task1.id
        task2_id = task2.id

    fake = fakeredis.FakeStrictRedis()
    with patch.object(worker_tasks, "LocalVideoStorage", return_value=storage), patch.object(
        worker_tasks, "_redis_client", return_value=fake
    ):
        worker_tasks.cleanup_expired_tasks.run()

    # Task 2 should be cleaned up despite task 1's failure.
    with Session(sync_db) as s:
        t2 = s.get(VideoTask, task2_id)
        assert t2.output_path is None
        assert t2.workspace_path is None

    assert not (Path(tmp) / task2_key).exists()

    shutil.rmtree(tmp, ignore_errors=True)


def test_cleanup_uses_batched_query(sync_db):
    """cleanup_expired_tasks MUST process in batches, not load all at once (P6)."""
    import inspect

    source = inspect.getsource(worker_tasks.cleanup_expired_tasks)
    assert "limit" in source.lower(), "cleanup must use .limit() for batched query (P6)"
    assert "while True" in source or "while" in source, "must loop over batches"
