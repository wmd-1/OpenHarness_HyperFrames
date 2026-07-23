"""Tests for Task 3.7 (N9) — Celery autodiscover + task registration."""

from pathlib import Path


def test_autodiscover_uses_package_name():
    """N9: autodiscover_tasks must be called with the package name
    ``["app.workers"]``, not the module ``["app.workers.tasks"]``."""
    src = (
        Path(__file__).resolve().parent.parent
        / "app"
        / "workers"
        / "celery_app.py"
    ).read_text()
    assert 'autodiscover_tasks(["app.workers"])' in src, (
        "autodiscover_tasks must use the package name 'app.workers'"
    )
    assert 'autodiscover_tasks(["app.workers.tasks"])' not in src, (
        "autodiscover_tasks must NOT use the module name 'app.workers.tasks'"
    )


def test_beat_import_present():
    """N9: the explicit ``from app.workers import beat`` belt-and-suspenders
    import must still be present."""
    src = (
        Path(__file__).resolve().parent.parent
        / "app"
        / "workers"
        / "celery_app.py"
    ).read_text()
    assert "from app.workers import beat" in src


def test_generate_video_task_registered():
    """N9: after autodiscover, the ``generate_video`` task must be registered
    in the Celery app's task registry."""
    from app.workers.celery_app import celery_app

    # Force finalise so all imported tasks appear in .tasks
    celery_app.finalize()
    assert "generate_video" in celery_app.tasks, (
        "generate_video task is not registered — check autodiscover_tasks"
    )
