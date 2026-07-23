"""Tests for structured logging in worker subprocess (X7)."""

import inspect


def test_worker_process_init_calls_configure_logging():
    """_on_worker_process_init MUST call configure_logging() (X7).

    Every Celery prefork child must configure structured JSON logging at
    startup so all log lines carry task/worker context.
    """
    from app.workers import beat

    source = inspect.getsource(beat._on_worker_process_init)
    assert "configure_logging" in source, (
        "worker_process_init must call configure_logging()"
    )


def test_task_body_calls_bind_task_context():
    """generate_video_task body MUST call bind_task_context() (X7).

    The task entry must bind task_id/worker_id/attempt into structlog
    contextvars so all subsequent log lines carry this context.
    """
    from app.workers import tasks

    source = inspect.getsource(tasks.generate_video_task)
    assert "bind_task_context" in source, (
        "task body must call bind_task_context()"
    )


def test_bind_task_context_sets_contextvars():
    """bind_task_context MUST bind values into structlog contextvars."""
    import structlog
    from structlog.contextvars import merge_contextvars

    from app.observability.logging import bind_task_context

    # Clear any existing context
    structlog.contextvars.clear_contextvars()

    bind_task_context(task_id="test-123", worker_id="w-abc", attempt=2)

    # Verify the contextvars are bound by checking a rendered log line.
    log = structlog.get_logger()
    # Capture the merged context
    merged = merge_contextvars(log, "", {})
    # The processor returns a dict with __merged__ keys — check directly
    bound = structlog.contextvars.get_contextvars()
    assert bound.get("task_id") == "test-123"
    assert bound.get("worker_id") == "w-abc"
    assert bound.get("attempt") == 2

    # Cleanup
    structlog.contextvars.clear_contextvars()


def test_bind_task_context_partial():
    """bind_task_context with only some args binds only those."""
    import structlog

    from app.observability.logging import bind_task_context

    structlog.contextvars.clear_contextvars()
    bind_task_context(task_id="only-task")
    bound = structlog.contextvars.get_contextvars()
    assert bound.get("task_id") == "only-task"
    assert "worker_id" not in bound
    assert "attempt" not in bound
    structlog.contextvars.clear_contextvars()
