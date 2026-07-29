"""Disposable per-session docker container backend (WS-C, spec D4).

One container per session, bridged over the docker attach stream:

- **create**: ``stdin_open``, tenant staging + workspace + videos + shared
  config mounts, resource limits, security baseline (``cap_drop=ALL``,
  ``no-new-privileges``, ``pids_limit``, no published ports) and the
  ``oh.sid`` / ``oh.tenant`` / ``oh.node`` labels used by orphan reclaim.
- **attach**: aiodocker demultiplexes the stream frames; stdout+stderr are
  merged and split into lines pushed onto the same ``stdout_lines`` queue the
  ProtocolAdapter already consumes. EOF (attach closed or container die)
  pushes the ``None`` sentinel — the existing crash path fires unchanged.
- **disposable**: the container is force-deleted on teardown, never reused —
  no cross-tenant residue to reason about. COLD → resume spawns a fresh
  container over the same ``/workspaces/{sid}`` volume path (D3).

``kill_group`` = SIGTERM → 5s → ``delete(force=True)``: the container *is*
the process group, covering Chrome/ffmpeg descendants.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

from app.config import settings
from app.session import tenant_store

log = logging.getLogger(__name__)

# Env vars copied from the gateway into the session container (the backend
# needs provider keys + Chrome/hyperframes knobs; never caller-controlled).
_ENV_PASSTHROUGH_PREFIXES = (
    "ANTHROPIC_",
    "OPENAI_",
    "QWENTTS_",
    "HYPERFRAMES_",
    "PRODUCER_",
    "CHROME_",
    "OPENHARNESS_PERMISSION_MODE",
)


def _mem_to_bytes(spec: str) -> int:
    """Parse ``2g`` / ``512m`` / ``1024`` into bytes."""
    m = re.fullmatch(r"(\d+)([kmg]?)", spec.strip().lower())
    if not m:
        raise ValueError(f"invalid mem limit: {spec!r}")
    mult = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[m.group(2)]
    return int(m.group(1)) * mult


def _parse_binds(raw: str) -> list[str]:
    return [b.strip() for b in raw.split(",") if b.strip()]


class OhBackendContainer:
    """Owns one disposable ``oh --backend-only`` container (BackendRuntime)."""

    def __init__(
        self,
        *,
        sid: str,
        tenant_id: str,
        cwd: Path,
        permission_mode: str,
        oh_session_id: str | None = None,
        extra_args: list[str] | None = None,
        docker_factory=None,
    ) -> None:
        self._sid = sid
        self._tenant_id = tenant_id
        self._cwd = cwd
        self._permission_mode = permission_mode
        self._oh_session_id = oh_session_id
        self._extra_args = extra_args or []
        # Test seam: inject a fake aiodocker.Docker builder (task 3.7).
        self._docker_factory = docker_factory

        self._docker = None
        self._container = None
        self._stream = None
        self._reader_task: asyncio.Task[None] | None = None
        self._waiter_task: asyncio.Task[None] | None = None
        self.stdout_lines: asyncio.Queue[str | None] = asyncio.Queue()
        self._shutting_down = False
        self._exited = False
        self._exit_code: int | None = None

    # --- BackendRuntime surface ----------------------------------------------

    @property
    def pid(self) -> int | None:
        # No host-visible pid; route heartbeats tolerate 0 (``pid or 0``).
        return None

    @property
    def shutting_down(self) -> bool:
        return self._shutting_down

    @property
    def exited(self) -> bool:
        return self._exited

    def build_command(self) -> list[str]:
        """Same server-fixed ``oh`` invocation as the process runtime."""
        cmd = [
            settings.oh_bin,
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

    def build_container_config(self) -> dict:
        """Docker create payload (asserted directly by the 3.7 unit tests)."""
        import os

        env = ["PYTHONUNBUFFERED=1"]
        for key, value in os.environ.items():
            if key.startswith(_ENV_PASSTHROUGH_PREFIXES):
                env.append(f"{key}={value}")
        # Tenant staging redirect: same volume, same paths inside the container
        # (the /tenants bind carries the staged tree — task 3.4).
        env.append(
            f"OPENHARNESS_CONFIG_DIR={tenant_store.local_config_dir(self._tenant_id)}"
        )
        env.append(
            f"OPENHARNESS_DATA_DIR={tenant_store.local_data_dir(self._tenant_id)}"
        )

        host_config: dict = {
            "Binds": _parse_binds(settings.container_binds),
            "Memory": _mem_to_bytes(settings.container_mem_limit),
            "NanoCpus": int(settings.container_cpus * 1_000_000_000),
            "PidsLimit": settings.container_pids_limit,
            "SecurityOpt": ["no-new-privileges:true"],
            # Chrome needs a real /dev/shm; 1g is plenty for headless-shell.
            "ShmSize": 1024**3,
        }
        if settings.container_cap_drop:
            host_config["CapDrop"] = ["ALL"]

        return {
            "Image": settings.session_image,
            "Cmd": self.build_command(),
            "WorkingDir": str(self._cwd),
            "Env": env,
            "OpenStdin": True,
            "StdinOnce": False,
            "AttachStdin": True,
            "AttachStdout": True,
            "AttachStderr": True,
            "Tty": False,
            "Entrypoint": [],
            "Labels": {
                "oh.sid": self._sid,
                "oh.tenant": self._tenant_id,
                "oh.node": settings.node_id or "local",
            },
            "HostConfig": host_config,
            # No published ports: the bridge is stdio-only (D4).
        }

    def _make_docker(self):
        if self._docker_factory is not None:
            return self._docker_factory()
        import aiodocker

        return aiodocker.Docker(url=settings.docker_host or None)

    async def start(self) -> None:
        """create → attach → start (attach first so no early output is lost)."""
        import uuid as _uuid

        self._docker = self._make_docker()
        name = f"oh-session-{self._sid[:13]}-{_uuid.uuid4().hex[:6]}"
        log.info("spawning oh backend container: sid=%s name=%s", self._sid, name)
        self._container = await self._docker.containers.create(
            config=self.build_container_config(), name=name
        )
        self._stream = self._container.attach(
            stdin=True, stdout=True, stderr=True, logs=True
        )
        await self._stream.__aenter__()
        await self._container.start()
        self._reader_task = asyncio.create_task(self._read_stream())
        self._waiter_task = asyncio.create_task(self._watch_exit())

    async def _read_stream(self) -> None:
        """Demuxed attach frames -> merged, line-buffered queue entries."""
        buf = b""
        try:
            while True:
                msg = await self._stream.read_out()
                if msg is None:
                    break  # attach EOF (container exited / stream closed)
                buf += msg.data
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    line = raw.decode("utf-8", errors="replace").rstrip("\r")
                    await self.stdout_lines.put(line)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("container attach reader error (sid=%s): %s", self._sid, exc)
        finally:
            if buf:
                await self.stdout_lines.put(
                    buf.decode("utf-8", errors="replace").rstrip("\r")
                )
            self._exited = True
            await self.stdout_lines.put(None)

    async def _watch_exit(self) -> None:
        """Second EOF insurance (D4): container die -> sentinel, even if the
        attach stream wedges without closing."""
        try:
            result = await self._container.wait()
            self._exit_code = (result or {}).get("StatusCode")
        except asyncio.CancelledError:
            raise
        except Exception:
            return
        if not self._exited:
            self._exited = True
            await self.stdout_lines.put(None)

    async def write_line(self, payload: str) -> None:
        if self._stream is None:
            raise RuntimeError("container stdin not available")
        try:
            await self._stream.write_in((payload + "\n").encode("utf-8"))
        except Exception:
            log.warning("container stdin write failed (sid=%s, gone?)", self._sid)

    async def wait(self, timeout: float | None = None) -> int:
        if self._container is None:
            return -1
        try:
            if timeout is not None:
                result = await asyncio.wait_for(self._container.wait(), timeout=timeout)
            else:
                result = await self._container.wait()
            self._exit_code = (result or {}).get("StatusCode", -1)
        except asyncio.TimeoutError:
            pass
        except Exception:
            pass
        return self._exit_code if self._exit_code is not None else -1

    async def shutdown(self, grace: float = 10.0) -> int:
        """Graceful exit: the adapter already wrote the shutdown request; wait
        for the container to stop, then dispose of it."""
        self._shutting_down = True
        code = await self.wait(grace)
        await self._dispose()
        return code

    async def kill_group(self) -> None:
        """SIGTERM → 5s → force delete (covers every descendant, D4)."""
        if self._container is None:
            return
        self._shutting_down = True
        try:
            await self._container.kill(signal="SIGTERM")
        except Exception:
            pass
        try:
            await asyncio.wait_for(self._container.wait(), timeout=5.0)
        except Exception:
            pass
        await self._dispose()

    async def _dispose(self) -> None:
        """Disposable containers: always force-delete, never reuse (D4)."""
        for task_attr in ("_reader_task", "_waiter_task"):
            task = getattr(self, task_attr)
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                setattr(self, task_attr, None)
        if self._stream is not None:
            try:
                await self._stream.__aexit__(None, None, None)
            except Exception:
                pass
            self._stream = None
        if self._container is not None:
            try:
                await self._container.delete(force=True)
            except Exception:
                pass
            self._container = None
        if self._docker is not None:
            try:
                await self._docker.close()
            except Exception:
                pass
            self._docker = None
        if not self._exited:
            self._exited = True
            await self.stdout_lines.put(None)


async def reclaim_orphan_containers(
    active_sids: set[str], *, on_tenant=None
) -> int:
    """Force-delete this node's session containers with no live session (D6).

    Filters on the ``oh.node`` label so other nodes' containers are never
    touched. ``on_tenant`` (async, tenant_id) runs once per affected tenant
    BEFORE its containers are deleted — the supervisor passes the final
    stage-out hook ④ here. Returns the reclaim count.
    """
    import aiodocker

    node = settings.node_id or "local"
    docker = aiodocker.Docker(url=settings.docker_host or None)
    reclaimed = 0
    try:
        containers = await docker.containers.list(
            all=True, filters={"label": [f"oh.node={node}"]}
        )
        victims: list[tuple[object, str, str]] = []
        for container in containers:
            info = await container.show()
            labels = (info.get("Config") or {}).get("Labels") or {}
            sid = labels.get("oh.sid", "")
            if sid in active_sids:
                continue
            victims.append((container, sid, labels.get("oh.tenant", "")))
        if on_tenant is not None:
            for tenant_id in {t for _c, _s, t in victims if t}:
                try:
                    await on_tenant(tenant_id)
                except Exception as exc:
                    log.warning("orphan reclaim stage-out failed (tenant=%s): %s", tenant_id, exc)
        for container, sid, _tenant in victims:
            try:
                await container.delete(force=True)
                reclaimed += 1
                log.info("reclaimed orphan container (sid=%s)", sid)
            except Exception as exc:
                log.warning("orphan container delete failed (sid=%s): %s", sid, exc)
    finally:
        await docker.close()
    if reclaimed:
        log.info("orphan container scan reclaimed %d container(s)", reclaimed)
    return reclaimed
