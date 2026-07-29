# session-container-runtime Specification

**Component:** `session-service/`
**Established by change:** `session-container-pool-multitenancy` (2026-07-29)

## Purpose
容器化会话运行时：以 `BackendRuntime` 抽象统一 process/container 两种后端，`container` 模式下每会话一个一次性 Docker 容器（挂载即隔离、attach 流桥接原生协议、资源与安全基线、孤儿回收），协议层与生命周期语义不变，默认 `process` 完全向后兼容。

## Requirements

### Requirement: A BackendRuntime abstraction MUST unify process and container backends

The supervisor MUST obtain backends through a `BackendRuntime` interface exposing the existing `OhBackendProcess` surface (`start`, `write_line`, `stdout_lines` queue with `None` EOF sentinel, `wait`, `shutdown`, `kill_group`, `exited`, `shutting_down`). The runtime is selected by `OH_SESSION_RUNTIME` (`process` | `container`), defaulting to `process`. The `ProtocolAdapter` and the line-framed native protocol MUST remain unchanged; OpenHarness source MUST NOT be modified.

#### Scenario: default deployment is unchanged
- **WHEN** `OH_SESSION_RUNTIME` is unset
- **THEN** sessions run as in-container subprocesses exactly as before, and all pre-existing tests pass unmodified

#### Scenario: adapter is runtime-agnostic
- **WHEN** the runtime is switched between `process` and `container`
- **THEN** no change is required in `ProtocolAdapter` / protocol parsing, and OHJSON event dispatch behaves identically

### Requirement: Container runtime MUST run one disposable container per session

In `container` runtime, each live session MUST run in a dedicated container created from the configured existing main image (`OH_SESSION_IMAGE`; no new image build). Containers MUST be labeled (`oh.sid`, `oh.tenant`, `oh.node`) and MUST be **disposable**: force-removed on COLD eviction, destroy, crash cleanup, and turn timeout, and NEVER reused for another session or tenant. COLD → LIVE rehydration MUST start a fresh container with `--resume`; because the workspace path is identical across runtimes (shared volume, same mount path), the cwd-derived `oh_session_id` MUST remain stable across runtime switches.

#### Scenario: container is destroyed on eviction and recreated on resume
- **WHEN** an idle session is evicted to `COLD` and later reconnected
- **THEN** its container is force-removed at eviction, and a new container resumes the same `oh_session_id` with prior conversation context intact

#### Scenario: containers are never reused across sessions
- **WHEN** a session ends for any reason
- **THEN** its container is removed (not returned to any reuse pool), and the next session gets a newly created container

### Requirement: The container MUST bridge stdin/stdout via attach with crash-equivalent EOF semantics

The gateway MUST create the container with an open stdin and communicate over the Docker attach stream (demultiplexing stdout/stderr frames into lines pushed to the existing queue; writing bare-JSON input lines to stdin). An attach-stream EOF or a container `die` event not initiated by our shutdown MUST push the `None` sentinel, triggering the existing crash-handling path. `kill_group()` MUST map to SIGTERM, then force-remove after a bounded grace, relying on the container boundary to reap all descendants (Chrome, ffmpeg, …).

#### Scenario: attach lines flow through the existing protocol path
- **WHEN** the containerized `oh` writes `OHJSON:`-prefixed lines
- **THEN** they arrive line-by-line on the same queue the adapter already consumes, and events dispatch as in process mode

#### Scenario: descendant processes cannot outlive the session
- **WHEN** a turn times out and the container is force-removed
- **THEN** no `oh`, Chrome, or ffmpeg process of that session survives on the host

### Requirement: Session containers MUST enforce mounts, resource limits, and a security baseline

Session containers MUST mount exactly: the tenant's staged `openharness/` directory (populated from MinIO via stage-in before container start) at `/root/.openharness`, the shared workspace volume at the same path as the gateway (`/workspaces`), the video/artifact volume, and the OpenHarness source mounts consistent with the existing compose file. They MUST apply configurable resource limits (`mem_limit` default 2g, CPU quota, `pids_limit`) and a security baseline: `no-new-privileges`, dropped capabilities (with a settings escape hatch for the minimal set Chrome requires), and NO published ports.

#### Scenario: a runaway session cannot starve the node
- **WHEN** a session's workload exceeds its memory limit
- **THEN** only that session's container is OOM-killed; the gateway and other sessions are unaffected and the turn fails via the crash path

#### Scenario: artifacts remain gateway-readable
- **WHEN** a turn produces an artifact under the session workspace inside the container
- **THEN** the gateway locates and serves it through the existing artifact registration/download path without copying

### Requirement: Orphaned session containers MUST be reclaimed at startup

In `container` runtime, gateway startup MUST list containers labeled with this node's `oh.node`, compare against the database, and force-remove any container whose session row is absent or not in a live state. Containers belonging to other nodes MUST NOT be touched.

#### Scenario: gateway crash leaves no zombie containers
- **WHEN** the gateway is killed while sessions run, then restarts
- **THEN** leftover session containers from this node are force-removed during startup scan, and other nodes' containers are untouched
