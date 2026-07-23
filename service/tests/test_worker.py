"""Tests for the Celery worker task state machine (mocking run_oh).

These drive the *real* ``generate_video_task`` body (not just the Celery
enqueue) by patching ``run_oh`` and the storage/parser helpers, plus a sqlite
sync engine so no Postgres/Redis is required for the happy path.
"""

from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, TaskStatus, VideoTask
from app.storage.local import LocalVideoStorage
from app.workers import tasks as worker_tasks
from app.workers.parser import VideoMeta


@pytest.fixture
def sync_db():
    """Point the worker's sync engine at a fresh in-memory sqlite DB."""
    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng)
    worker_tasks._sync_engine = eng
    yield eng
    worker_tasks._sync_engine = None
    eng.dispose()


def _class_with(**attrs):
    attrs.setdefault("timed_out", False)
    return type("Stub", (), attrs)


def test_happy_path_marks_succeeded(sync_db):
    import tempfile

    with Session(sync_db) as s:
        t = VideoTask(prompt="make a video", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "out.mp4"
        mp4.write_bytes(b"\x00" * 2048)  # real file so storage.save can copy it
        meta = VideoMeta(
            file_size_bytes=2048,
            duration_seconds=1.0,
            resolution="2x2",
            fps=1,
        )
        with patch.object(worker_tasks, "run_oh") as m_run, patch.object(
            worker_tasks, "locate_output_file"
        ) as m_locate, patch.object(worker_tasks, "probe_mp4") as m_probe, patch.object(
            worker_tasks, "LocalVideoStorage"
        ) as m_storage:
            m_run.return_value = _class_with(
                exit_code=0, stdout="**输出文件:** `out.mp4`"
            )
            m_locate.return_value = mp4
            m_probe.return_value = meta
            m_storage.return_value = LocalVideoStorage(root=Path(tmp) / "store")

            worker_tasks.generate_video_task.run(task_id=tid)

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.SUCCEEDED
        assert got.output_path is not None
        assert got.output_path.endswith(".mp4")
        assert got.file_size_bytes == 2048


def test_nonzero_exit_marks_failed(sync_db):
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "run_oh") as m_run:
        m_run.return_value = _class_with(exit_code=3, stdout="boom")
        worker_tasks.generate_video_task.run(task_id=tid)

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.FAILED
        assert got.exit_code == 3


def test_cancel_guard_prevents_overwrite_to_succeeded(sync_db):
    """If the user cancels mid-run, the task must stay CANCELED, never flip to
    SUCCEEDED (the original bug)."""
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "run_oh") as m_run, patch.object(
        worker_tasks, "_abort_requested", return_value=True
    ):
        m_run.return_value = _class_with(
            exit_code=0, stdout="**输出文件:** `ghost.mp4`"
        )
        worker_tasks.generate_video_task.run(task_id=tid)

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.CANCELED
        # locate/probe/save must NOT have run for a canceled task
        assert got.output_path is None


def test_vet_rejects_dangerous_args():
    """Sanity that the allowlist lives in the worker path's validator."""
    from app.security import InvalidOhArgError, vet_extra_oh_args

    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--permission-mode", "evil"])


def test_redelivery_to_running_task_is_skipped(sync_db):
    """A redelivered task already RUNNING and owned by another worker MUST NOT
    be re-rendered (X1/L3). claim() affects 0 rows, run_oh is never called."""
    with Session(sync_db) as s:
        t = VideoTask(
            prompt="x",
            status=TaskStatus.RUNNING,
            worker_id="another-live-worker",
        )
        s.add(t)
        s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "run_oh") as m_run:
        worker_tasks.generate_video_task.run(task_id=tid)
        # run_oh must NOT have been called for a task owned by another worker
        m_run.assert_not_called()

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.RUNNING
        assert got.worker_id == "another-live-worker"


def test_cas_owner_fence_prevents_stale_owner_write(sync_db):
    """A stale owner calling _mark_succeeded after reclaim MUST affect 0 rows
    and return False (L1/N18). The task stays RUNNING under the new owner."""
    from app.workers.parser import VideoMeta
    from app.workers.runner import RunResult

    with Session(sync_db) as s:
        t = VideoTask(
            prompt="x",
            status=TaskStatus.RUNNING,
            worker_id="new-owner",
        )
        s.add(t)
        s.commit()
        tid = str(t.id)

    meta = VideoMeta(file_size_bytes=100, duration_seconds=1.0, resolution="2x2", fps=1)
    result = RunResult(exit_code=0, stdout="")

    # Stale owner tries to mark succeeded -- must fail (0 rows, return False)
    ok = worker_tasks._mark_succeeded(tid, "key.mp4", meta, result, worker_id="stale-owner")
    assert ok is False

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.RUNNING
        assert got.worker_id == "new-owner"
        assert got.output_path is None


def test_cas_prevents_overwrite_of_canceled_task(sync_db):
    """_mark_succeeded on a CANCELED task MUST affect 0 rows and return False."""
    from app.workers.parser import VideoMeta
    from app.workers.runner import RunResult

    with Session(sync_db) as s:
        t = VideoTask(
            prompt="x",
            status=TaskStatus.CANCELED,
            worker_id="some-worker",
        )
        s.add(t)
        s.commit()
        tid = str(t.id)

    meta = VideoMeta(file_size_bytes=100, duration_seconds=1.0, resolution="2x2", fps=1)
    result = RunResult(exit_code=0, stdout="")

    ok = worker_tasks._mark_succeeded(tid, "key.mp4", meta, result, worker_id="some-worker")
    assert ok is False

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.CANCELED


def test_abort_falls_back_to_db_when_redis_down(sync_db):
    """When Redis is unreachable, _abort_requested MUST fall back to DB:
    a CANCELED task counts as aborted (N3/X4)."""
    with Session(sync_db) as s:
        t = VideoTask(
            prompt="x",
            status=TaskStatus.CANCELED,
            worker_id="w1",
            cancellation_requested=True,
        )
        s.add(t)
        s.commit()
        tid = str(t.id)

    # Simulate Redis being down by making _redis_client raise.
    with patch.object(worker_tasks, "_redis_client", side_effect=Exception("redis down")):
        assert worker_tasks._abort_requested(tid) is True


def test_abort_returns_false_when_redis_down_and_task_running(sync_db):
    """When Redis is down and the task is still RUNNING, _abort_requested
    MUST return False (no spurious abort)."""
    with Session(sync_db) as s:
        t = VideoTask(
            prompt="x",
            status=TaskStatus.RUNNING,
            worker_id="w1",
            cancellation_requested=False,
        )
        s.add(t)
        s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "_redis_client", side_effect=Exception("redis down")):
        assert worker_tasks._abort_requested(tid) is False


# --- Log stream tests (P1/P2/N14) ---


def test_append_log_bounds_stream_with_maxlen(sync_db):
    """XADD must use MAXLEN so the stream stays bounded under heavy logging (P1)."""
    import fakeredis

    fake = fakeredis.FakeStrictRedis()
    worker_tasks._log_push_failed.clear()
    with patch.object(worker_tasks, "_redis_client", return_value=fake):
        for i in range(100):
            worker_tasks._append_log("task-maxlen-test", f"line {i}")

    # Stream must not exceed _LOG_CAP
    length = fake.xlen("oh:logs:task-maxlen-test")
    assert length <= worker_tasks._LOG_CAP
    assert length > 0


def test_append_log_circuit_breaks_on_redis_failure(sync_db):
    """After the first Redis push failure, subsequent pushes are skipped (N14)."""
    worker_tasks._log_push_failed.clear()
    call_count = 0

    class FailingRedis:
        def xadd(self, *a, **kw):
            nonlocal call_count
            call_count += 1
            raise Exception("redis down")

    with patch.object(
        worker_tasks, "_redis_client", return_value=FailingRedis()
    ):
        # First call should attempt and fail, circuit-breaking.
        worker_tasks._append_log("task-cb", "line 1")
        # Subsequent calls should be skipped (circuit-broken).
        worker_tasks._append_log("task-cb", "line 2")
        worker_tasks._append_log("task-cb", "line 3")

    # Only the first call should have reached Redis.
    assert call_count == 1
    assert "task-cb" in worker_tasks._log_push_failed


def test_update_log_tail_uses_xrevrange(sync_db):
    """_update_log_tail MUST use XREVRANGE with COUNT, not xrange (P2)."""
    import fakeredis

    fake = fakeredis.FakeStrictRedis()
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.SUCCEEDED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    # Seed 600 entries (> tail_count=500) into the SAME key the function reads.
    # XREVRANGE COUNT=500 should trim the oldest 100, keeping only entries 100–599.
    log_key = f"oh:logs:{tid}"
    for i in range(600):
        fake.xadd(log_key, {"line": f"line {i}"})

    worker_tasks._log_push_failed.clear()
    with patch.object(worker_tasks, "_redis_client", return_value=fake):
        worker_tasks._update_log_tail(tid)

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.log_tail is not None
        # Should contain the newest entries, not the oldest.
        assert "line 599" in got.log_tail
        assert "line 0" not in got.log_tail  # trimmed by XREVRANGE COUNT


# --- Transient error classification tests (L2) ---


def test_operational_error_triggers_transient_retry(sync_db):
    """OperationalError (DB) is classified as TransientError for retry (L2)."""
    from sqlalchemy.exc import OperationalError as SAOperationalError

    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "run_oh") as m_run:
        m_run.side_effect = SAOperationalError("SELECT 1", {}, Exception("conn lost"))
        with pytest.raises(worker_tasks.TransientError):
            worker_tasks.generate_video_task.run(task_id=tid)


def test_redis_connection_error_triggers_transient_retry(sync_db):
    """Redis ConnectionError is classified as TransientError for retry (L2)."""
    from redis.exceptions import ConnectionError as RedisConnectionError

    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "run_oh") as m_run:
        m_run.side_effect = RedisConnectionError("Redis down")
        with pytest.raises(worker_tasks.TransientError):
            worker_tasks.generate_video_task.run(task_id=tid)


def test_redis_timeout_error_triggers_transient_retry(sync_db):
    """Redis TimeoutError is classified as TransientError for retry (L2)."""
    from redis.exceptions import TimeoutError as RedisTimeoutError

    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "run_oh") as m_run:
        m_run.side_effect = RedisTimeoutError("Redis timeout")
        with pytest.raises(worker_tasks.TransientError):
            worker_tasks.generate_video_task.run(task_id=tid)


def test_non_transient_error_marks_failed(sync_db):
    """Non-transient exceptions continue to mark the task FAILED, not retry (L2)."""
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "run_oh") as m_run:
        m_run.side_effect = ValueError("not transient")
        # Should NOT raise TransientError — should mark FAILED and return.
        worker_tasks.generate_video_task.run(task_id=tid)

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.FAILED


# --- Render semaphore removal tests (X3) ---


def test_render_semaphore_not_present():
    """The process-local render_semaphore MUST NOT exist (X3).

    Under Celery prefork, each child gets its own semaphore copy, making it
    ineffective as a node-level concurrency cap. Concurrency is controlled
    via Celery ``-c`` + ``prefetch=1`` instead.
    """
    assert not hasattr(worker_tasks, "render_semaphore"), (
        "render_semaphore must be removed — it is ineffective under prefork"
    )
    assert not hasattr(worker_tasks, "MAX_CONCURRENT_RENDERS"), (
        "MAX_CONCURRENT_RENDERS must be removed — use config advisory instead"
    )


def test_task_body_source_has_no_semaphore():
    """The generate_video_task body MUST NOT acquire any semaphore (X3)."""
    import inspect

    source = inspect.getsource(worker_tasks.generate_video_task)
    assert "render_semaphore" not in source, (
        "task body must not reference render_semaphore"
    )
    assert "BoundedSemaphore" not in source, (
        "task body must not use BoundedSemaphore"
    )


def test_happy_path_works_without_semaphore(sync_db):
    """The happy path MUST work after removing render_semaphore (X3).

    This is a regression guard: the task body runs without acquiring any
    semaphore and still succeeds.
    """
    import tempfile

    with Session(sync_db) as s:
        t = VideoTask(prompt="no sem test", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "out.mp4"
        mp4.write_bytes(b"\x00" * 1024)
        meta = VideoMeta(file_size_bytes=1024, duration_seconds=1.0, resolution="2x2", fps=1)
        with patch.object(worker_tasks, "run_oh") as m_run, patch.object(
            worker_tasks, "locate_output_file"
        ) as m_locate, patch.object(
            worker_tasks, "probe_mp4"
        ) as m_probe, patch.object(
            worker_tasks, "LocalVideoStorage"
        ) as m_storage:
            m_run.return_value = _class_with(exit_code=0, stdout="**输出文件:** `out.mp4`")
            m_locate.return_value = mp4
            m_probe.return_value = meta
            m_storage.return_value = LocalVideoStorage(root=Path(tmp) / "store")

            worker_tasks.generate_video_task.run(task_id=tid)

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.SUCCEEDED


# --- P4: sync engine pool_pre_ping ---


def test_sync_engine_uses_pool_pre_ping():
    """The sync engine MUST use pool_pre_ping=True (P4).

    Stale pooled connections (after a DB restart or idle timeout) cause
    ``OperationalError`` on the next checkout. ``pool_pre_ping`` sends a
    lightweight ``SELECT 1`` before handing out a connection, transparently
    recycling stale ones.
    """
    import inspect

    source = inspect.getsource(worker_tasks._get_sync_engine)
    assert "pool_pre_ping" in source, "sync engine must use pool_pre_ping=True (P4)"


# --- P5: eager workspace cleanup ---


def test_workspace_cleaned_after_success(sync_db):
    """After SUCCEEDED, the workspace directory MUST be eagerly removed (P5).

    The workspace holds transient oh artifacts (HTML, screenshots, temp
    files). Leaving them until the daily cleanup_expired_tasks sweep wastes
    disk. The task body removes them as soon as the terminal state is written.
    """
    import tempfile

    with Session(sync_db) as s:
        t = VideoTask(prompt="cleanup test", status=TaskStatus.QUEUED)
        s.add(t)
        s.commit()
        tid = str(t.id)

    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "out.mp4"
        mp4.write_bytes(b"\x00" * 512)
        meta = VideoMeta(file_size_bytes=512, duration_seconds=1.0, resolution="2x2", fps=1)
        ws_root = Path(tmp) / "ws_root"

        with patch.object(worker_tasks, "settings") as mock_settings:
            mock_settings.workspace_root = ws_root
            mock_settings.oh_bin = "/bin/true"
            mock_settings.headless_shell_path = "/bin/true"
            mock_settings.task_timeout_default = 900
            mock_settings.task_timeout_min = 30
            mock_settings.task_timeout_max = 3600
            mock_settings.video_dir = Path(tmp) / "videos"

            with patch.object(worker_tasks, "run_oh") as m_run, patch.object(
                worker_tasks, "locate_output_file"
            ) as m_locate, patch.object(
                worker_tasks, "probe_mp4"
            ) as m_probe, patch.object(
                worker_tasks, "LocalVideoStorage"
            ) as m_storage:
                m_run.return_value = _class_with(exit_code=0, stdout="**输出文件:** `out.mp4`")
                m_locate.return_value = mp4
                m_probe.return_value = meta
                m_storage.return_value = LocalVideoStorage(root=Path(tmp) / "store")

                worker_tasks.generate_video_task.run(task_id=tid)

        # Workspace should be eagerly cleaned up after success (P5).
        ws_path = ws_root / str(tid)
        assert not ws_path.exists(), (
            f"workspace {ws_path} must be cleaned up after SUCCEEDED (P5)"
        )

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.SUCCEEDED