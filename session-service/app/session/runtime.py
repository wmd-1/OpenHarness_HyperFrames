"""Backend runtime abstraction + factory (WS-C, spec D3).

``BackendRuntime`` formalizes the duck-type interface the supervisor/adapter
already use against :class:`app.session.process.OhBackendProcess`. The factory
:func:`make_backend` picks the implementation from ``OH_SESSION_RUNTIME``:

- ``process`` (default): the existing ``oh --backend-only`` subprocess —
  existing deployments and the whole existing test suite are unaffected.
- ``container``: one *disposable* docker container per session (spec D4),
  bridged over the docker attach stream.

``cwd`` lives on the same shared volume at the same path in both runtimes
(``/workspaces/{sid}``), so ``derive_oh_session_id`` hashes identically and a
COLD session can be resumed across runtimes (D3).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from app.config import settings


@runtime_checkable
class BackendRuntime(Protocol):
    """What the supervisor/ProtocolAdapter require from a backend."""

    # Queue of stdout lines; ``None`` is the EOF/crash sentinel.
    stdout_lines: Any

    @property
    def pid(self) -> int | None: ...

    @property
    def shutting_down(self) -> bool: ...

    @property
    def exited(self) -> bool: ...

    async def start(self) -> None: ...

    async def write_line(self, payload: str) -> None: ...

    async def wait(self, timeout: float | None = None) -> int: ...

    async def shutdown(self, grace: float = 10.0) -> int: ...

    async def kill_group(self) -> None: ...


def make_backend(
    *,
    sid: str,
    tenant_id: str,
    cwd: Path,
    permission_mode: str,
    oh_session_id: str | None = None,
    extra_args: list[str] | None = None,
    env_overrides: dict[str, str] | None = None,
) -> BackendRuntime:
    """Build the backend for one session per ``OH_SESSION_RUNTIME``.

    ``env_overrides`` only applies to the ``process`` runtime (WS-B tenant
    staging redirect); the container runtime derives its env + mounts from
    ``tenant_id`` itself (task 3.4: mounts replace env injection).
    """
    if settings.session_runtime == "container":
        from app.session.container import OhBackendContainer  # lazy: aiodocker

        return OhBackendContainer(
            sid=sid,
            tenant_id=tenant_id,
            cwd=cwd,
            permission_mode=permission_mode,
            oh_session_id=oh_session_id,
            extra_args=extra_args,
        )

    from app.session.process import OhBackendProcess

    return OhBackendProcess(
        cwd=cwd,
        permission_mode=permission_mode,
        oh_session_id=oh_session_id,
        extra_args=extra_args,
        env_overrides=env_overrides,
    )
