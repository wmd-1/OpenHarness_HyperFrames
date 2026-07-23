"""Tests for runner.py subprocess wrapper (N7/N8/N12)."""

import inspect
import subprocess
from unittest.mock import MagicMock, patch

import pytest

from app.workers.runner import RunResult, run_oh


# ---- RunResult dataclass ----


def test_run_result_has_timed_out_field():
    """RunResult MUST carry a timed_out: bool flag (N7)."""
    result = RunResult(exit_code=0, stdout="", timed_out=True)
    assert result.timed_out is True


def test_run_result_timed_out_defaults_false():
    """timed_out defaults to False for normal exits."""
    result = RunResult(exit_code=0, stdout="")
    assert result.timed_out is False


# ---- Source inspection (structural guarantees) ----


def test_run_oh_uses_start_new_session():
    """Popen MUST use start_new_session=True, not preexec_fn (N12)."""
    source = inspect.getsource(run_oh)
    assert "start_new_session=True" in source
    assert "preexec_fn" not in source


def test_stdout_cap_present():
    """run_oh MUST cap accumulated stdout with a truncation marker (N7/N8)."""
    source = inspect.getsource(run_oh)
    assert "_STDOUT_CAP" in source
    assert "truncat" in source.lower()


def test_timed_out_set_on_timeout_path():
    """The timeout path MUST set timed_out=True (N7)."""
    source = inspect.getsource(run_oh)
    assert "timed_out = True" in source or "timed_out=True" in source


# ---- Functional test: timeout sets timed_out ----


def test_timeout_sets_timed_out_flag():
    """When proc.wait raises TimeoutExpired, RunResult.timed_out MUST be True (N7)."""
    mock_proc = MagicMock()
    # Simulate a process that times out
    mock_proc.wait.side_effect = [subprocess.TimeoutExpired(cmd="oh", timeout=1), None]
    mock_proc.poll.return_value = None
    mock_proc.returncode = -15
    mock_proc.stdout = iter([])  # no output
    mock_proc.pid = 12345

    with patch("app.workers.runner.Popen", return_value=mock_proc):
        with patch("app.workers.runner.os.getpgid", return_value=12345):
            with patch("app.workers.runner.os.killpg"):
                result = run_oh(
                    prompt="test",
                    cwd="/tmp",
                    timeout=1,
                    oh_bin="/bin/echo",
                )

    assert result.timed_out is True
    assert result.exit_code == -15
