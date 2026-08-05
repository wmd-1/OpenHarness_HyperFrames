# test-infra-startup-failure-hook Specification

## Purpose
E2E 测试基建能力：在起栈后、跑用例前对后端做启动失败早检测。当目标服务容器进入终态（exited/dead/removing）或宽限期内 healthz 始终未 200 时，立即以非零退出并输出可读诊断（容器 id/status/exit_code、脱敏日志尾部、端口占用、最近 healthz 探测）；若容器仍 running 视作「启动慢」继续等，不误判。该 hook 仅负责就绪/失败检测，与既有 `healthz` 含 `oh_backend_stub` 校验共存、互不重复。源 change：`2026-08-04-test-infra-startup-failure-hook`。
## Requirements
### Requirement: Backend startup-failure early detection
The E2E stack runner SHALL detect a backend startup failure before proceeding to run test cases, and SHALL abort with a non-zero exit code plus actionable diagnostics when the backend does not become ready.

The runner SHALL distinguish "slow startup" (container still running, healthz not yet 200 within the grace period) from "startup failure" (container exited/dead, or healthz never succeeds within the grace period), and SHALL NOT treat a slow-but-alive container as a failure.

The startup-failure hook SHALL coexist with the existing `healthz` payload check (verifying the `oh_backend_stub` override is active); it is responsible only for readiness/failure detection, not for configuration-correctness assertions.

#### Scenario: Backend container exits during startup
- **WHEN** the backend container for the target service enters a terminal state (`exited`/`dead`/`removing`) before healthz returns 200
- **THEN** the runner aborts early (before the full grace period elapses) and prints a diagnostic block containing the container status and exit code

#### Scenario: Backend stays alive but never becomes ready
- **WHEN** the backend container remains running but healthz never returns 200 within the configured grace period (`STARTUP_READY_TIMEOUT`, default 120s)
- **THEN** the runner aborts with a non-zero exit and prints the diagnostic block

#### Scenario: Slow-but-healthy startup is tolerated
- **WHEN** the backend container stays running and healthz returns 200 within the grace period
- **THEN** the runner proceeds to the test cases without aborting and without false-positive diagnostics

### Requirement: Startup-failure diagnostics
On detected startup failure, the runner SHALL emit a diagnostics block that includes at minimum: the container id/status/exit code, the trailing container logs (sensitized), the port occupancy for the backend port, and the most recent healthz probe response.

#### Scenario: Diagnostics are desensitized
- **WHEN** the container logs or healthz response contain secret material matching `*_API_KEY`, `X-API-Key`, `Authorization: Bearer`, or a JSON `"api_key"` field
- **THEN** the emitted diagnostics redact the secret value and SHALL NOT print the raw secret

