"""WS-C container runtime unit tests (task 3.7) — fake docker client, no dockerd.

Covers: factory selection, container create-spec assertions (mounts/labels/
resources/security/no ports), attach line bridging, die -> crash sentinel,
kill_group disposal, and label-filtered orphan reclaim.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.config import settings
from app.session import tenant_store
from app.session.container import (
    OhBackendContainer,
    _mem_to_bytes,
    reclaim_orphan_containers,
)
from app.session.runtime import make_backend


# --- fakes ------------------------------------------------------------------------


class FakeStream:
    """Stands in for the aiodocker attach Stream."""

    def __init__(self, chunks: list[bytes] | None = None, block: bool = False):
        self._chunks = list(chunks or [])
        self._block = block
        self.written: list[bytes] = []
        self.exited = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.exited = True
        return False

    async def read_out(self):
        if self._chunks:
            return SimpleNamespace(stream=1, data=self._chunks.pop(0))
        if self._block:
            await asyncio.Event().wait()  # wedged stream (die-event test)
        return None  # EOF

    async def write_in(self, data: bytes) -> None:
        self.written.append(data)


class FakeContainer:
    def __init__(self, stream: FakeStream, exit_code: int = 0, wait_blocks: bool = False):
        self._stream = stream
        self._exit_code = exit_code
        self._wait_blocks = wait_blocks
        self.started = False
        self.kill_signals: list[str] = []
        self.deleted_force: bool | None = None

    def attach(self, **_kw):
        return self._stream

    async def start(self):
        self.started = True

    async def wait(self, **_kw):
        if self._wait_blocks:
            await asyncio.Event().wait()
        return {"StatusCode": self._exit_code}

    async def kill(self, signal="SIGKILL"):
        self.kill_signals.append(signal)

    async def delete(self, force=False, **_kw):
        self.deleted_force = force


class FakeDocker:
    def __init__(self, container: FakeContainer):
        self._container = container
        self.created_config: dict | None = None
        self.created_name: str | None = None
        self.closed = False
        outer = self

        class _Containers:
            async def create(self, config: dict, name: str):
                outer.created_config = config
                outer.created_name = name
                return outer._container

        self.containers = _Containers()

    async def close(self):
        self.closed = True


def _backend(stream=None, container=None, **kw) -> tuple[OhBackendContainer, FakeDocker]:
    stream = stream or FakeStream()
    container = container or FakeContainer(stream)
    docker = FakeDocker(container)
    backend = OhBackendContainer(
        sid=kw.pop("sid", str(uuid.uuid4())),
        tenant_id=kw.pop("tenant_id", "acme"),
        cwd=kw.pop("cwd", Path("/workspaces/test-sid")),
        permission_mode="full_auto",
        docker_factory=lambda: docker,
        **kw,
    )
    return backend, docker


# --- factory (D3) -----------------------------------------------------------------


def test_factory_defaults_to_process():
    from app.session.process import OhBackendProcess

    backend = make_backend(
        sid="s", tenant_id="t", cwd=Path("/tmp/x"), permission_mode="full_auto"
    )
    assert isinstance(backend, OhBackendProcess)


def test_factory_container_mode(monkeypatch):
    monkeypatch.setattr(settings, "session_runtime", "container")
    backend = make_backend(
        sid="s", tenant_id="t", cwd=Path("/tmp/x"), permission_mode="full_auto"
    )
    assert isinstance(backend, OhBackendContainer)


# --- create spec (D4 security/resource baseline) ------------------------------------


def test_mem_to_bytes():
    assert _mem_to_bytes("2g") == 2 * 1024**3
    assert _mem_to_bytes("512m") == 512 * 1024**2
    assert _mem_to_bytes("1024") == 1024
    with pytest.raises(ValueError):
        _mem_to_bytes("lots")


def test_container_config_spec(monkeypatch):
    monkeypatch.setattr(settings, "node_id", "node-9")
    sid = str(uuid.uuid4())
    backend, _ = _backend(sid=sid, tenant_id="acme", cwd=Path("/workspaces/" + sid))
    cfg = backend.build_container_config()

    assert cfg["Image"] == settings.session_image
    # Server-fixed oh invocation.
    assert cfg["Cmd"][0] == settings.oh_bin
    assert "--backend-only" in cfg["Cmd"]
    assert cfg["WorkingDir"] == "/workspaces/" + sid
    # stdio bridge, no tty.
    assert cfg["OpenStdin"] is True and cfg["Tty"] is False
    # Orphan-reclaim labels.
    assert cfg["Labels"] == {"oh.sid": sid, "oh.tenant": "acme", "oh.node": "node-9"}
    # Tenant staging redirect rides the /tenants mount, not supervisor env.
    env = cfg["Env"]
    assert f"OPENHARNESS_CONFIG_DIR={tenant_store.local_config_dir('acme')}" in env
    assert f"OPENHARNESS_DATA_DIR={tenant_store.local_data_dir('acme')}" in env

    hc = cfg["HostConfig"]
    binds = hc["Binds"]
    assert any(b.endswith(":/workspaces") for b in binds)
    assert any(b.endswith(":/tenants") for b in binds)
    assert hc["Memory"] == _mem_to_bytes(settings.container_mem_limit)
    assert hc["NanoCpus"] == int(settings.container_cpus * 1_000_000_000)
    assert hc["PidsLimit"] == settings.container_pids_limit
    assert hc["CapDrop"] == ["ALL"]
    assert "no-new-privileges:true" in hc["SecurityOpt"]
    # No published ports (stdio-only bridge).
    assert "PortBindings" not in hc and "ExposedPorts" not in cfg


def test_container_config_cap_drop_toggle(monkeypatch):
    monkeypatch.setattr(settings, "container_cap_drop", False)
    backend, _ = _backend()
    assert "CapDrop" not in backend.build_container_config()["HostConfig"]


def test_container_config_resume_flag():
    backend, _ = _backend(oh_session_id="ws-abc-123")
    cmd = backend.build_container_config()["Cmd"]
    assert "--resume" in cmd and "ws-abc-123" in cmd


# --- attach bridging / EOF semantics -------------------------------------------------


@pytest.mark.asyncio
async def test_attach_line_bridging_and_eof_sentinel():
    """Chunks spanning line boundaries come out as clean lines, then None."""
    stream = FakeStream(chunks=[b'{"a"', b': 1}\r\npar', b"tial\nlast"])
    container = FakeContainer(stream, wait_blocks=True)
    backend, docker = _backend(stream=stream, container=container)
    await backend.start()
    assert container.started and docker.created_config is not None

    assert await backend.stdout_lines.get() == '{"a": 1}'
    assert await backend.stdout_lines.get() == "partial"
    assert await backend.stdout_lines.get() == "last"  # flushed tail
    assert await backend.stdout_lines.get() is None  # EOF sentinel
    assert backend.exited
    await backend.kill_group()


@pytest.mark.asyncio
async def test_die_event_pushes_sentinel_when_stream_wedges():
    """Container exit (wait() resolves) yields the crash sentinel even if the
    attach stream never returns EOF (D4 double insurance)."""
    stream = FakeStream(block=True)
    container = FakeContainer(stream, exit_code=137)  # wait resolves at once
    backend, _ = _backend(stream=stream, container=container)
    await backend.start()
    sentinel = await asyncio.wait_for(backend.stdout_lines.get(), timeout=2.0)
    assert sentinel is None
    assert backend.exited
    await backend.kill_group()


@pytest.mark.asyncio
async def test_write_line_goes_to_attach_stdin():
    stream = FakeStream(block=True)
    container = FakeContainer(stream, wait_blocks=True)
    backend, _ = _backend(stream=stream, container=container)
    await backend.start()
    await backend.write_line('{"type":"submit"}')
    assert stream.written == [b'{"type":"submit"}\n']
    await backend.kill_group()


@pytest.mark.asyncio
async def test_kill_group_force_deletes_disposable_container():
    stream = FakeStream(block=True)
    container = FakeContainer(stream)
    backend, docker = _backend(stream=stream, container=container)
    await backend.start()
    await backend.kill_group()
    assert container.kill_signals == ["SIGTERM"]
    assert container.deleted_force is True  # disposable: rm -f, never reused
    assert stream.exited  # attach stream closed
    assert docker.closed
    assert backend.shutting_down


# --- orphan reclaim (D6) --------------------------------------------------------------


class FakeListedContainer(FakeContainer):
    def __init__(self, sid: str, tenant: str, node: str):
        super().__init__(FakeStream())
        self._labels = {"oh.sid": sid, "oh.tenant": tenant, "oh.node": node}

    async def show(self):
        return {"Config": {"Labels": self._labels}}


@pytest.mark.asyncio
async def test_reclaim_orphans_filters_by_active_and_calls_on_tenant(monkeypatch):
    monkeypatch.setattr(settings, "node_id", "local")
    live_sid, dead_sid = str(uuid.uuid4()), str(uuid.uuid4())
    live_c = FakeListedContainer(live_sid, "t-live", "local")
    dead_c = FakeListedContainer(dead_sid, "t-dead", "local")

    class _Containers:
        async def list(self, all=True, filters=None):
            # The docker-side label filter is part of the request contract.
            assert filters == {"label": ["oh.node=local"]}
            return [live_c, dead_c]

    fake_docker = SimpleNamespace(containers=_Containers())

    async def _close():
        pass

    fake_docker.close = _close
    import aiodocker

    monkeypatch.setattr(aiodocker, "Docker", lambda url=None: fake_docker)

    staged: list[str] = []

    async def on_tenant(tid: str) -> None:
        staged.append(tid)

    reclaimed = await reclaim_orphan_containers({live_sid}, on_tenant=on_tenant)
    assert reclaimed == 1
    assert dead_c.deleted_force is True
    assert live_c.deleted_force is None  # active session untouched
    assert staged == ["t-dead"]  # final stage-out before delete (hook ④)
