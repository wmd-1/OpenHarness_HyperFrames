"""Tests for worker liveness, heartbeat, and lost-task recovery (X5/X6)."""

import inspect
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, TaskStatus, VideoTask
from app.workers import beat as beat_mod
from app.workers import tasks as worker_tasks


@pytest.fixture
def sync_db():
    """Point the worker's sync engine at a fresh in-memory sqlite DB."""
    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng)
    worker_tasks._sync_engine = eng
    yield eng
    worker_tasks._sync_engine = None
    eng.dispose()


# --- X5: STALE_AFTER must tolerate at least 3 missed heartbeats ---


def test_stale_after_tolerates_missed_heartbeats():
    """STALE_AFTER must be >= 4 × HEARTBEAT_INTERVAL (X5).

    This guarantees a worker can miss up to 3 consecutive heartbeat
    refreshes before its tasks are reclaimed, preventing premature reclaim
    under transient slowness (GC pause, network blip).
    """
    assert beat_mod.STALE_AFTER >= 4 * beat_mod.HEARTBEAT_INTERVAL, (
        f"STALE_AFTER ({beat_mod.STALE_AFTER}) must be >= "
        f"4 × HEARTBEAT_INTERVAL ({4 * beat_mod.HEARTBEAT_INTERVAL})"
    )


# --- X6: reclaim must route through the scheduler, not delay() ---


def test_recover_source_uses_scheduler_not_delay():
    """recover_lost_tasks source MUST use get_scheduler().enqueue(), not
    generate_video_task.delay() (X6)."""
    source = inspect.getsource(beat_mod.recover_lost_tasks)
    assert "get_scheduler" in source, "recover_lost_tasks must use get_scheduler()"
    assert "get_scheduler().enqueue" in source, "must call enqueue() on the scheduler"
    assert ".delay(" not in source, "must not use .delay() for re-enqueue"


def test_recover_reclaims_stale_task_via_scheduler(sync_db):
    """A stale RUNNING task with a dead owner is flipped to RETRYING and
    re-enqueued through the scheduler with its priority preserved (X6)."""
    with Session(sync_db) as s:
        t = VideoTask(
            prompt="x",
            status=TaskStatus.RUNNING,
            worker_id="dead-worker",
            heartbeat_at=datetime.utcnow() - timedelta(seconds=120),
            priority=8,  # high priority
        )
        s.add(t)
        s.commit()
        tid = str(t.id)

    # Simulate Redis with no live workers (dead-worker is gone).
    import fakeredis

    fake = fakeredis.FakeStrictRedis()

    mock_scheduler = MagicMock()
    mock_scheduler.enqueue = MagicMock(return_value="new-celery-id")

    with patch("app.workers.scheduler.get_scheduler", return_value=mock_scheduler):
        reclaimed = beat_mod.recover_lost_tasks(
            redis_client=fake,
            db_session_factory=worker_tasks._sync_session,
        )

    assert reclaimed == 1

    # Scheduler.enqueue MUST have been called with the task's priority.
    mock_scheduler.enqueue.assert_called_once_with(tid, priority=8)

    # Task is now RETRYING and worker_id is cleared.
    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.RETRYING
        assert got.worker_id is None


def test_reclaim_does_not_touch_task_owned_by_live_worker(sync_db):
    """A task owned by a live worker MUST NOT be reclaimed even if its
    heartbeat is stale (the owner is still alive)."""
    with Session(sync_db) as s:
        t = VideoTask(
            prompt="x",
            status=TaskStatus.RUNNING,
            worker_id="live-worker",
            heartbeat_at=datetime.utcnow() - timedelta(seconds=120),
            priority=5,
        )
        s.add(t)
        s.commit()

    import fakeredis

    fake = fakeredis.FakeStrictRedis()
    fake.set("oh:worker:live-worker", "1", ex=20)

    mock_scheduler = MagicMock()
    with patch("app.workers.scheduler.get_scheduler", return_value=mock_scheduler):
        reclaimed = beat_mod.recover_lost_tasks(
            redis_client=fake,
            db_session_factory=worker_tasks._sync_session,
        )

    assert reclaimed == 0
    mock_scheduler.enqueue.assert_not_called()
