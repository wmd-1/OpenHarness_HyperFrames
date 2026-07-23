"""Subprocess wrapper for running the oh CLI."""

from __future__ import annotations

import os
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from subprocess import PIPE, STDOUT, Popen
from threading import Thread
from typing import Callable

# Cap accumulated stdout so a verbose oh run does not exhaust worker memory (N7/N8).
_STDOUT_CAP = 1024 * 1024  # 1 MB
_TRUNCATION_MARKER = "\n... [stdout truncated: exceeded 1 MB] ...\n"


@dataclass
class RunResult:
    exit_code: int
    stdout: str
    timed_out: bool = False  # N7: distinguishes timeout-kill from normal exit


def run_oh(
    prompt: str,
    cwd: Path,
    timeout: int = 900,
    on_log_line: Callable[[str], None] | None = None,
    extra_args: list[str] | None = None,
    is_aborted: Callable[[], bool] | None = None,
    oh_bin: str = "/root/.local/bin/oh",
    headless_shell_path: str = "/opt/chrome-headless-shell-linux64/chrome-headless-shell",
    watchdog_poll_interval: float = 2.0,  # N15: coarsened from 0.5 s
) -> RunResult:
    """Spawn ``oh -p <prompt>`` as a subprocess and collect output.

    Args:
        prompt: The text prompt to pass to ``oh -p``.
        cwd: Working directory (workspace) for the subprocess.
        timeout: Maximum wall-clock seconds before killing the process.
        on_log_line: Callback invoked for each line of combined stdout/stderr.
        extra_args: Additional CLI flags forwarded to ``oh``.
        is_aborted: Optional predicate polled during execution. When it returns
            ``True``, the whole ``oh`` process group is terminated (SIGTERM then
            SIGKILL). Used to honor user cancellation without relying on the
            Celery worker receiving the revoke signal.
        oh_bin: Path to the ``oh`` binary.
        headless_shell_path: Path to chrome-headless-shell binary.

    Returns:
        A :class:`RunResult` with exit code and captured stdout.
    """
    cmd = [
        oh_bin,
        "-p", prompt,
        "--output-format", "text",
        "--permission-mode", "full_auto",
        *(extra_args or []),
    ]

    env = {
        **os.environ,
        "PRODUCER_HEADLESS_SHELL_PATH": headless_shell_path,
        "CHROME_HEADLESS_BIN": headless_shell_path,
    }

    proc = Popen(
        cmd,
        cwd=str(cwd),
        stdout=PIPE,
        stderr=STDOUT,
        text=True,
        bufsize=1,
        env=env,
        start_new_session=True,  # N12: safe process-group creation
    )

    # ``setsid`` makes ``oh`` its own session/process-group leader, so
    # ``proc.pid`` is the pgid. Killing it tears down ``oh`` *and* its chrome
    # children (important for cancellation).
    pgid = proc.pid

    def _kill_group(signum: int) -> None:
        try:
            os.killpg(pgid, signum)
        except OSError:
            pass

    def _watchdog() -> None:
        # N15: poll the abort predicate while the process is alive, using the
        # configurable interval (default 2 s) instead of a hard-coded 0.5 s.
        while proc.poll() is None:
            if is_aborted is not None and is_aborted():
                _kill_group(signal.SIGTERM)
                return
            time.sleep(watchdog_poll_interval)

    watchdog_thread = Thread(target=_watchdog, daemon=True)
    watchdog_thread.start()

    lines: list[str] = []
    accumulated_bytes = 0
    stdout_capped = False

    def _reader() -> None:
        nonlocal accumulated_bytes, stdout_capped
        assert proc.stdout is not None
        for line in proc.stdout:
            # Always forward to the log stream (streaming is unaffected by the cap).
            if on_log_line is not None:
                on_log_line(line)
            # Only accumulate up to the cap to bound memory (N7/N8).
            if not stdout_capped:
                accumulated_bytes += len(line.encode("utf-8"))
                if accumulated_bytes > _STDOUT_CAP:
                    lines.append(_TRUNCATION_MARKER)
                    stdout_capped = True
                else:
                    lines.append(line)

    reader_thread = Thread(target=_reader, daemon=True)
    reader_thread.start()

    timed_out = False
    # Wait with timeout
    try:
        proc.wait(timeout=timeout)
    except Exception:
        timed_out = True  # N7: timeout-kill is distinguishable
        # Kill the entire process group
        _kill_group(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except Exception:
            _kill_group(signal.SIGKILL)
            proc.wait()

    reader_thread.join(timeout=5)
    watchdog_thread.join(timeout=2)

    return RunResult(
        exit_code=proc.returncode if proc.returncode is not None else -1,
        stdout="".join(lines),
        timed_out=timed_out,
    )
