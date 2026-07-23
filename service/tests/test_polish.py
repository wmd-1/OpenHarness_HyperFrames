"""Tests for Tasks 3.8 (O2/O3/O4) and 3.9 (N15/N16)."""

import json
from pathlib import Path
from unittest.mock import patch, MagicMock


# ────────────────────────── O2: unified DB host ──────────────────────────

def test_db_url_and_migration_url_same_default_host():
    """O2: ``db_url`` and ``db_migration_url`` must share the same default host
    so migration scripts connect to the same server as the runtime engine."""
    from app.config import Settings

    s = Settings()
    # Both should reference 'localhost' (not 'postgres' for migration)
    assert "localhost" in s.db_url
    assert "localhost" in s.db_migration_url


def test_no_plaintext_password_in_default_db_urls():
    """N16: default DB URLs must not embed credentials (no ``user:pass@``)."""
    from app.config import Settings

    s = Settings()
    for url in (s.db_url, s.db_sync_url, s.db_migration_url):
        # The default should be e.g. postgresql+asyncpg://localhost:5432/oh
        assert "oh:oh@" not in url, f"Plaintext credentials found in {url}"


def test_warn_no_db_credentials_called_at_startup():
    """N16: the startup warning function must exist and be invoked."""
    import app.main as main_mod

    # Verify the function exists
    assert hasattr(main_mod, "_warn_no_db_credentials")
    # Verify it's called (source-level check: the call must be present)
    src = Path(main_mod.__file__).read_text()
    assert "_warn_no_db_credentials()" in src


# ────────────────────────── O3: fps round() ──────────────────────────

def test_fps_rounds_instead_of_truncating():
    """O3: ``probe_mp4`` must use ``round()`` so 29.97 fps → 30, not 29."""
    from app.workers.parser import probe_mp4, VideoMeta

    # Mock ffprobe output with r_frame_rate = "30000/1001" (≈29.97)
    ffprobe_json = json.dumps({
        "format": {"duration": "10.0"},
        "streams": [{
            "codec_type": "video",
            "width": 1920,
            "height": 1080,
            "r_frame_rate": "30000/1001",  # ~29.97 fps
        }],
    })

    fake_result = MagicMock()
    fake_result.returncode = 0
    fake_result.stdout = ffprobe_json

    with (
        patch("app.workers.parser.run", return_value=fake_result),
        patch("pathlib.Path.exists", return_value=True),
        patch("pathlib.Path.stat", return_value=MagicMock(st_size=1000)),
    ):
        meta = probe_mp4(Path("/fake.mp4"))

    assert meta.fps == 30, f"Expected 30 (round of 29.97), got {meta.fps}"


def test_fps_round_source_check():
    """O3: source code must use ``round()`` not ``int()`` for fps calculation."""
    src = (
        Path(__file__).resolve().parent.parent
        / "app"
        / "workers"
        / "parser.py"
    ).read_text()
    assert "round(int(num) / int(den))" in src
    # Ensure the old truncation is gone
    assert "int(int(num) / int(den))" not in src


# ────────────────────────── O4: locate_output_file scope ──────────────────────────

def test_locate_output_file_rejects_path_outside_workspace(tmp_path):
    """O4: a regex-matched absolute path outside the workspace must be rejected."""
    from app.workers.parser import locate_output_file, OutputNotFoundError

    # Create an mp4 *outside* the workspace
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"\x00\x00\x00\x20 ftypisom")

    stdout = f"**Output:** `{outside}`"
    # Should raise because the path is outside workspace
    try:
        locate_output_file(stdout, tmp_path / "workspace")
        assert False, "Should have raised OutputNotFoundError"
    except OutputNotFoundError:
        pass  # Expected


def test_locate_output_file_accepts_path_inside_workspace(tmp_path):
    """O4: a regex-matched path inside the workspace must still work."""
    from app.workers.parser import locate_output_file

    ws = tmp_path / "workspace"
    ws.mkdir()
    mp4 = ws / "output.mp4"
    mp4.write_bytes(b"\x00\x00\x00\x20 ftypisom")

    stdout = f"**Output:** `output.mp4`"
    result = locate_output_file(stdout, ws)
    assert result == mp4


def test_locate_output_file_rglob_scoped_to_workspace(tmp_path):
    """O4: rglob fallback must search within the resolved workspace only."""
    from app.workers.parser import locate_output_file

    ws = tmp_path / "workspace"
    ws.mkdir()
    mp4 = ws / "video.mp4"
    mp4.write_bytes(b"\x00\x00\x00\x20 ftypisom")

    # No regex match — should fall back to rglob within workspace
    result = locate_output_file("no match here", ws)
    assert result == mp4


# ────────────────────────── N15: watchdog interval ──────────────────────────

def test_watchdog_poll_interval_config_default():
    """N15: ``watchdog_poll_interval`` must default to >= 2.0 seconds."""
    from app.config import Settings

    s = Settings()
    assert s.watchdog_poll_interval >= 2.0, (
        f"watchdog_poll_interval must be >= 2.0, got {s.watchdog_poll_interval}"
    )


def test_runner_uses_configurable_watchdog_interval():
    """N15: ``run_oh`` must accept a ``watchdog_poll_interval`` parameter."""
    import inspect
    from app.workers.runner import run_oh

    sig = inspect.signature(run_oh)
    assert "watchdog_poll_interval" in sig.parameters, (
        "run_oh must accept watchdog_poll_interval parameter"
    )
    assert sig.parameters["watchdog_poll_interval"].default == 2.0


def test_runner_no_hardcoded_0_5_sleep():
    """N15: the hard-coded ``time.sleep(0.5)`` must be removed."""
    src = (
        Path(__file__).resolve().parent.parent
        / "app"
        / "workers"
        / "runner.py"
    ).read_text()
    assert "time.sleep(0.5)" not in src, (
        "Hard-coded 0.5 s sleep must be removed from runner.py"
    )
    assert "watchdog_poll_interval" in src


def test_tasks_passes_watchdog_interval():
    """N15: tasks.py must pass ``settings.watchdog_poll_interval`` to run_oh."""
    src = (
        Path(__file__).resolve().parent.parent
        / "app"
        / "workers"
        / "tasks.py"
    ).read_text()
    assert "watchdog_poll_interval=settings.watchdog_poll_interval" in src
