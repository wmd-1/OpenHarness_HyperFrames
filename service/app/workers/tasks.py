"""Core Celery tasks for video generation."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

import redis as _redis
from sqlalchemy import create_engine, func, select, update as sa_update
from sqlalchemy.orm import Session

from app.config import settings
from app.models import TaskStatus, VideoTask
from app.storage.local import LocalVideoStorage
from app.workers.celery_app import celery_app
from app.workers.parser import OutputNotFoundError, locate_output_file, probe_mp4
from app.workers.identity import get_worker_id
from app.workers.runner import run_oh
from app.observability.metrics import render_inflight
from app.observability.logging import bind_task_context

logger = logging.getLogger(__name__)

# --- Redis connection pooling -----------------------------------------------
# A single process-global pool reused by every log push / tail read / abort
# check, instead of opening a fresh connection per stdout line.
_LOG_POOL: _redis.ConnectionPool | None = None


def _redis_client() -> _redis.Redis:
    """Return a Redis client backed by a shared connection pool."""
    global _LOG_POOL
    if _LOG_POOL is None:
        _LOG_POOL = _redis.ConnectionPool.from_url(settings.broker_url)
    return _redis.Redis(connection_pool=_LOG_POOL)


# Sync DB engine for Celery workers (they can't use async)
_sync_engine = None


def _get_sync_engine():
    global _sync_engine
    if _sync_engine is None:
        _sync_engine = create_engine(
            settings.db_sync_url,
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,  # P4: detect stale connections before use
        )
    return _sync_engine


def _sync_session() -> Session:
    engine = _get_sync_engine()
    return Session(engine)


# Markers used inside the Redis Stream that backs task logs.
_DONE_MARKER = "__DONE__"
_LOG_CAP = 10000  # max retained entries per task stream

# Circuit-break: after N consecutive Redis push failures, stop trying to push
# log lines for the rest of this task (avoids log storms during Redis outage).
_log_push_failed: set[str] = set()  # task_ids that have circuit-broken


def _append_log(task_id: str, line: str) -> None:
    """Append a log line to the task's Redis Stream.

    Uses a single XADD per line (replayed and tailed by the SSE endpoint via
    XREAD). Connection is taken from the shared pool. The stream is bounded
    with MAXLEN so heavy logging cannot exhaust Redis memory (P1/P2).
    Push failures circuit-break per-task so a Redis outage does not flood
    logs (N14).
    """
    # Circuit-break: skip if this task already failed to push.
    if str(task_id) in _log_push_failed:
        return
    try:
        r = _redis_client()
        r.xadd(
            f"oh:logs:{task_id}",
            {"line": line},
            maxlen=_LOG_CAP,
            approximate=True,
        )
    except Exception:
        logger.warning("Failed to push log line to Redis for task %s", task_id)
        _log_push_failed.add(str(task_id))


def claim(task_id: uuid.UUID, worker_id: str) -> bool:
    """Atomically claim a queued/retrying task for ``worker_id``.

    A single conditional UPDATE (row lock) serializes concurrent workers so
    exactly one becomes the owner. Returns True if this worker won the claim.
    See OpenSpec scale-multi-instance R7.
    """
    task_id = uuid.UUID(str(task_id))
    with _sync_session() as db:
        result = db.execute(
            sa_update(VideoTask)
            .where(
                VideoTask.id == task_id,
                VideoTask.status.in_([TaskStatus.QUEUED, TaskStatus.RETRYING]),
            )
            .values(
                status=TaskStatus.RUNNING,
                started_at=func.now(),
                worker_id=worker_id,
                attempt=VideoTask.attempt + 1,
                heartbeat_at=func.now(),
            )
        )
        affected = result.rowcount
        db.commit()
        return affected == 1


def _mark_succeeded(
    task_id: str,
    storage_key: str,
    meta,  # VideoMeta
    result,  # RunResult
    worker_id: str | None = None,
) -> bool:
    """Persist a successful render.

    Success guard (scale-multi-instance R9): the terminal state is only written
    when the row is still RUNNING *for this worker*. A stale/previous owner
    (e.g. after a reclaim) matches 0 rows, so the existing terminal state is
    left untouched. Returns True if the write happened.
    """
    conditions = [VideoTask.id == uuid.UUID(str(task_id)), VideoTask.status == TaskStatus.RUNNING]
    if worker_id is not None:
        conditions.append(VideoTask.worker_id == worker_id)
    with _sync_session() as db:
        exec_result = db.execute(
            sa_update(VideoTask)
            .where(*conditions)
            .values(
                status=TaskStatus.SUCCEEDED,
                finished_at=func.now(),
                output_path=storage_key,
                file_size_bytes=meta.file_size_bytes,
                duration_seconds=meta.duration_seconds,
                resolution=meta.resolution,
                fps=meta.fps,
                exit_code=result.exit_code,
            )
        )
        db.commit()
        return exec_result.rowcount == 1


def _mark_failed(task_id: str, exc: Exception, exit_code: int | None = None, worker_id: str | None = None) -> bool:
    """Persist a failed render.

    Ownership guard (scale-multi-instance R9): only writes when the row is
    still RUNNING for this worker, so a reclaimed/stale owner cannot flip a
    task another replica has taken over into FAILED.
    """
    conditions = [VideoTask.id == uuid.UUID(str(task_id)), VideoTask.status == TaskStatus.RUNNING]
    if worker_id is not None:
        conditions.append(VideoTask.worker_id == worker_id)
    with _sync_session() as db:
        result = db.execute(
            sa_update(VideoTask)
            .where(*conditions)
            .values(
                status=TaskStatus.FAILED,
                error_message=str(exc)[:4000],
                exit_code=exit_code,
                finished_at=func.now(),
            )
        )
        db.commit()
        return result.rowcount == 1


def _mark_canceled(task_id: str, exc: Exception | None = None, worker_id: str | None = None) -> bool:
    """Mark a task CANCELED (user-requested cancellation).

    Ownership guard (scale-multi-instance R9): only writes when the row is
    still RUNNING for this worker, so a reclaimed/stale owner cannot clobber a
    task another replica has since taken over.
    """
    conditions = [VideoTask.id == uuid.UUID(str(task_id)), VideoTask.status == TaskStatus.RUNNING]
    if worker_id is not None:
        conditions.append(VideoTask.worker_id == worker_id)
    with _sync_session() as db:
        result = db.execute(
            sa_update(VideoTask)
            .where(*conditions)
            .values(
                status=TaskStatus.CANCELED,
                finished_at=func.now(),
                error_message=str(exc)[:4000] if exc else None,
            )
        )
        db.commit()
        return result.rowcount == 1


def _abort_requested(task_id: str) -> bool:
    """True if a cancellation flag was set for this task (cross-replica safe).

    Falls back to the DB when Redis is unreachable: a task already CANCELED
    in DB counts as aborted (N3/X4). The ``cancellation_requested`` flag is
    also checked so a cancel that set the DB flag but failed to reach Redis
    still aborts the worker.
    """
    try:
        r = _redis_client()
        if r.get(f"oh:abort:{task_id}") is not None:
            return True
    except Exception:
        # Redis unavailable -- fall back to DB (N3/X4).
        pass

    # DB fallback: check status and cancellation_requested flag.
    try:
        with _sync_session() as db:
            row = db.execute(
                select(VideoTask.status, VideoTask.cancellation_requested).where(
                    VideoTask.id == uuid.UUID(str(task_id))
                )
            ).first()
            if row is None:
                return False
            status, cancelled = row
            if status == TaskStatus.CANCELED or cancelled:
                return True
    except Exception:
        logger.warning("DB fallback for abort check failed for task %s", task_id)

    return False


def _update_log_tail(task_id: str) -> None:
    """Read the tail of the log stream from Redis and write it to DB.

    Uses XREVRANGE (reverse, newest-first) with COUNT so the full stream
    is never loaded into memory (P2).
    """
    try:
        r = _redis_client()
        # Read the last N entries (newest-first), then reverse to oldest-first.
        tail_count = 500
        entries = r.xrevrange(f"oh:logs:{task_id}", count=tail_count)
        entries.reverse()  # oldest-first for chronological order
        raw = "".join(
            _as_str(fields.get(b"line")) + "\n" for _id, fields in entries
        )
        tail = raw[-settings.log_tail_bytes:]
        with _sync_session() as db:
            task = db.get(VideoTask, uuid.UUID(str(task_id)))
            if task is not None:
                task.log_tail = tail
                db.commit()
    except Exception:
        logger.warning("Failed to update log tail for task %s", task_id)


def _as_str(value) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)


def _cleanup_workspace(workspace: Path) -> None:
    """Eagerly remove the workspace directory after a task reaches terminal state (P5).

    This prevents workspace dirs from accumulating on disk between periodic
    cleanup_expired_tasks runs. Failures are logged, not raised, so a missing
    or read-only workspace never blocks the terminal state write.
    """
    try:
        import shutil

        if workspace.exists():
            shutil.rmtree(workspace, ignore_errors=True)
            logger.info("Eagerly cleaned up workspace %s", workspace)
    except Exception:
        logger.warning("Failed to clean up workspace %s", workspace)


class TransientError(Exception):
    """Errors that should trigger automatic retry."""


def _is_transient(exc: Exception) -> bool:
    """True if *exc* is a transient infrastructure error that should retry (L2).

    ``OperationalError`` (DB) and Redis ``ConnectionError``/``TimeoutError`` are
    classified as transient so ``autoretry_for``/``retry_backoff`` fires.
    All other exceptions are deterministic and mark the task FAILED.
    """
    from sqlalchemy.exc import OperationalError as SAOperationalError

    from redis.exceptions import ConnectionError as RedisConnectionError
    from redis.exceptions import TimeoutError as RedisTimeoutError

    return isinstance(exc, (SAOperationalError, RedisConnectionError, RedisTimeoutError))


@celery_app.task(
    bind=True,
    name="generate_video",
    acks_late=True,
    autoretry_for=(TransientError,),
    retry_backoff=True,
    max_retries=2,
)
def generate_video_task(self, task_id: str) -> None:
    """Celery task: run oh CLI to generate a video and persist results."""
    # Celery serializes the task id as a string; the model's UUID primary key
    # needs a uuid.UUID object for DB lookups, so coerce once up front.
    task_id = uuid.UUID(str(task_id))
    wid = get_worker_id()

    # --- Atomic claim (X1/L3) -------------------------------------------
    # Exactly one worker flips QUEUED/RETRYING -> RUNNING via the conditional
    # UPDATE in claim(). A redelivered or reclaimed task already owned by
    # another live worker matches 0 rows and is skipped -- no run_oh.
    if not claim(task_id, wid):
        logger.warning("Task %s already claimed or terminal; skipping", task_id)
        return

    storage = LocalVideoStorage()

    with _sync_session() as db:
        task = db.get(VideoTask, task_id)
        if task is None:
            logger.error("Task %s not found in DB after claim", task_id)
            return
        if task.status == TaskStatus.CANCELED:
            return
        # Persist the celery task id so revoke is possible for the duration
        # of the run (L4 -- celery_task_id persistence).
        task.celery_task_id = self.request.id
        db.commit()

        # X7: bind task/worker/attempt into structlog contextvars so every
        # log line in the task body carries this context.
        bind_task_context(
            task_id=str(task_id),
            worker_id=wid,
            attempt=task.attempt,
        )

        prompt = task.prompt
        timeout = task.timeout_seconds
        extra_oh_args = json.loads(task.extra_oh_args) if task.extra_oh_args else []

    workspace = Path(settings.workspace_root) / str(task_id)
    workspace.mkdir(parents=True, exist_ok=True)

    with _sync_session() as db:
        task = db.get(VideoTask, task_id)
        if task is not None:
            task.workspace_path = str(workspace)
            db.commit()

    try:
        # Track an in-flight render so Grafana can see per-replica concurrency
        # (Phase 5 / R8). Process-local render semaphore removed (X3): under
        # Celery prefork, each child gets its own semaphore copy, making it
        # ineffective as a node-level cap. Concurrency is instead controlled
        # via Celery ``-c`` (worker processes) + ``prefetch=1`` (one task per
        # child). ``max_concurrent_renders`` in config remains as an advisory
        # hint for capacity planning, not an enforcement mechanism.
        with render_inflight():
            result = run_oh(
                prompt=prompt,
                cwd=workspace,
                timeout=timeout,
                on_log_line=lambda line: _append_log(task_id, line),
                extra_args=extra_oh_args,
                is_aborted=lambda: _abort_requested(task_id),
                oh_bin=settings.oh_bin,
                headless_shell_path=settings.headless_shell_path,
                watchdog_poll_interval=settings.watchdog_poll_interval,  # N15
            )

        # Guard: if the user canceled while running, do NOT overwrite the
        # status back to SUCCEEDED/FAILED. The worker is authoritative here.
        if _abort_requested(task_id):
            _mark_canceled(task_id, RuntimeError("canceled by user"), worker_id=wid)
            _cleanup_workspace(workspace)
            return

        _update_log_tail(task_id)

        if result.timed_out:
            _mark_failed(
                task_id,
                RuntimeError(f"timed out after {timeout}s"),
                exit_code=result.exit_code,
                worker_id=wid,
            )
            _cleanup_workspace(workspace)
            return

        if result.exit_code != 0:
            _mark_failed(
                task_id,
                RuntimeError(f"oh exited with code {result.exit_code}"),
                exit_code=result.exit_code,
                worker_id=wid,
            )
            _cleanup_workspace(workspace)
            return

        mp4 = locate_output_file(result.stdout, workspace)
        meta = probe_mp4(mp4)
        final_key = storage.save(task_id, mp4)
        _mark_succeeded(task_id, final_key, meta, result, worker_id=wid)
        _cleanup_workspace(workspace)

        # Publish done marker into the log stream (consumed by SSE).
        try:
            _redis_client().xadd(f"oh:logs:{task_id}", {"line": _DONE_MARKER})
        except Exception:
            logger.warning("Failed to publish done marker for task %s", task_id)

    except OutputNotFoundError as exc:
        # Deterministic failure — record and stop (do NOT re-raise, so the
        # message is acked rather than infinitely redelivered).
        _update_log_tail(task_id)
        _mark_failed(task_id, exc, worker_id=wid)
        _cleanup_workspace(workspace)
    except TransientError:
        # Transient infrastructure errors still trigger the autoretry_for retry.
        raise
    except Exception as exc:
        # Classify: transient infrastructure errors (DB/Redis) should retry (L2).
        if _is_transient(exc):
            raise TransientError(str(exc)) from exc
        # Deterministic failure — record and stop (no re-raise).
        _update_log_tail(task_id)
        _mark_failed(task_id, exc, worker_id=wid)
        _cleanup_workspace(workspace)
        return


@celery_app.task(name="cleanup_expired_tasks")
def cleanup_expired_tasks() -> None:
    """Remove workspace dirs and log entries for tasks older than retention period.

    Batched and per-task-resilient (P6/N13): processes tasks in batches of
    100, wraps each task's cleanup in try/except so one failure does not abort
    the entire sweep, and commits per batch so partial progress is durable.
    """
    from datetime import timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.cleanup_retention_days)
    storage = LocalVideoStorage()
    batch_size = 100
    total_cleaned = 0

    while True:
        with _sync_session() as db:
            expired = (
                db.query(VideoTask)
                .filter(
                    VideoTask.created_at < cutoff,
                    VideoTask.status.in_([
                        TaskStatus.SUCCEEDED,
                        TaskStatus.FAILED,
                        TaskStatus.CANCELED,
                    ]),
                    # Only process tasks that still have resources to clean up.
                    (VideoTask.output_path.isnot(None) | VideoTask.workspace_path.isnot(None)),
                )
                .limit(batch_size)
                .all()
            )

            if not expired:
                break

            for task in expired:
                try:
                    # Clean up workspace (P5 eager cleanup already handles the
                    # common case, but stale workspaces from crashed workers
                    # still need the periodic sweep).
                    if task.workspace_path:
                        wp = Path(task.workspace_path)
                        if wp.exists():
                            import shutil
                            shutil.rmtree(wp, ignore_errors=True)

                    # Clean up stored video
                    if task.output_path:
                        storage.delete(task.output_path)

                    # Clean up Redis log stream
                    try:
                        _redis_client().delete(f"oh:logs:{str(task.id)}")
                    except Exception:
                        pass

                    # Null the now-stale pointers so a later download returns
                    # a clean 404 instead of pointing at a deleted file.
                    task.output_path = None
                    task.workspace_path = None
                    total_cleaned += 1
                except Exception:
                    logger.warning(
                        "Failed to clean up expired task %s — continuing (N13)",
                        task.id,
                        exc_info=True,
                    )
                    # Rollback this task's changes so the next sweep retries.
                    db.rollback()

            db.commit()

        if len(expired) < batch_size:
            break

    logger.info("Cleaned up %d expired tasks", total_cleaned)
