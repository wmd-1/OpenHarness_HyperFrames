"""``oh --backend-only`` subprocess wrapper.

Spawns one ``oh --backend-only`` process per session in its own OS session/
process group (``start_new_session=True``) so a crash or timeout can kill the
whole group without affecting the gateway. Provides async line-buffered stdout
reads and bare-JSON stdin writes.

Spec: "Native backend-only protocol bridge" + "Subprocess crash MUST be isolated".
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from pathlib import Path

from app.config import settings

log = logging.getLogger(__name__)


class BackendProcessError(RuntimeError):
    """Raised when the subprocess cannot be started or has exited."""


class OhBackendProcess:
    """Owns one ``oh --backend-only`` subprocess.

    stdout lines are read asynchronously into :attr:`stdout_lines` (an
    asyncio.Queue). Callers (the ProtocolAdapter) consume from there.
    """

    def __init__(
        self,
        *,
        cwd: Path,
        permission_mode: str,
        oh_session_id: str | None = None,
        extra_args: list[str] | None = None,
        oh_bin: str | None = None,
    ) -> None:
        self._cwd = cwd
        self._permission_mode = permission_mode
        self._oh_session_id = oh_session_id
        self._extra_args = extra_args or []
        self._oh_bin = oh_bin or settings.oh_bin
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self.stdout_lines: asyncio.Queue[str | None] = asyncio.Queue()
        # ``True`` only when WE initiated shutdown (distinguishes graceful exit
        # from a crash -> spec "stdout EOF not initiated by our shutdown").
        self._shutting_down = False
        self._exited = False

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc else None

    @property
    def shutting_down(self) -> bool:
        return self._shutting_down

    @property
    def exited(self) -> bool:
        return self._exited

    def build_command(self) -> list[str]:
        """Build the ``oh`` invocation with server-fixed flags.

        Server-fixed (never caller-controllable): ``--backend-only --cwd
        --permission-mode`` (+ ``--api-key`` / ``--resume`` when applicable).
        Caller-supplied ``extra_args`` are vetted by app.security beforehand.
        """
        cmd = [
            self._oh_bin,
            "--backend-only",
            "--cwd",
            str(self._cwd),
            "--permission-mode",
            self._permission_mode,
        ]
        if settings.oh_api_key is not None:
            cmd.extend(["--api-key", settings.oh_api_key.get_secret_value()])
        if self._oh_session_id:
            cmd.extend(["--resume", self._oh_session_id])
        cmd.extend(self._extra_args)
        return cmd

    async def start(self) -> None:
        """Spawn the subprocess in a new session/process group."""
        cmd = self.build_command()
        log.info("spawning oh backend: cwd=%s resume=%s", self._cwd, self._oh_session_id)
        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(self._cwd),
            env=self._build_env(),
            start_new_session=True,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())

    def _build_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.setdefault("PYTHONUNBUFFERED", "1")
        return env

    async def _read_stdout(self) -> None:
        """Read stdout line-by-line; push each line to the queue.

        On EOF (process exit) push ``None`` as a sentinel so the adapter can
        distinguish "stream ended" from an empty line.
        """
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while True:
                raw = await self._proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                await self.stdout_lines.put(line)
        except Exception as exc:
            log.warning("stdout reader error: %s", exc)
        finally:
            self._exited = True
            await self.stdout_lines.put(None)

    async def write_line(self, payload: str) -> None:
        """Write a single bare-JSON line to stdin (no prefix)."""
        if self._proc is None or self._proc.stdin is None:
            raise BackendProcessError("process stdin not available")
        data = (payload + "\n").encode("utf-8")
        self._proc.stdin.write(data)
        try:
            await self._proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            log.warning("stdin write failed (process gone)")

    async def wait(self, timeout: float | None = None) -> int:
        """Wait for the process to exit; return its exit code."""
        if self._proc is None:
            return -1
        try:
            if timeout is not None:
                await asyncio.wait_for(self._proc.wait(), timeout=timeout)
            else:
                await self._proc.wait()
        except asyncio.TimeoutError:
            pass
        return self._proc.returncode if self._proc.returncode is not None else -1

    async def shutdown(self, grace: float = 10.0) -> int:
        """Graceful shutdown: send ``shutdown`` request then wait.

        Marks ``_shutting_down`` so the adapter treats the subsequent EOF as
        expected rather than a crash.
        """
        self._shutting_down = True
        # The adapter is responsible for writing the shutdown FrontendRequest;
        # here we just wait for the process to exit after it has been written.
        return await self.wait(grace)

    async def kill_group(self) -> None:
        """Kill the whole process group (SIGTERM then SIGKILL).

        Used on timeout / crash-cleanup. ``start_new_session=True`` made the
        child a session leader, so ``os.killpg(os.getpgid(pid))`` reaches every
        descendant (Chrome, ffmpeg, …).
        """
        if self._proc is None:
            return
        self._shutting_down = True
        pid = self._proc.pid
        try:
            pgid = os.getpgid(pid)
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            try:
                pgid = os.getpgid(pid)
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            await self._proc.wait()
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass


def derive_oh_session_id(cwd: Path) -> str:
    """Derive the native snapshot id from ``cwd`` (spec D8 / R: oh_session_id).

    ``{cwd.name}-{sha1(str(resolve(cwd)))[:12]}`` — computed *before* the
    subprocess is spawned so it is available for ``--resume`` without waiting
    for a runtime ``state_snapshot`` event.
    """
    import hashlib

    resolved = str(cwd.resolve())
    digest = hashlib.sha1(resolved.encode("utf-8")).hexdigest()[:12]
    return f"{cwd.name}-{digest}"
