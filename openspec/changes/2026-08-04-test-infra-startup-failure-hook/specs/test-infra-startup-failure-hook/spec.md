## ADDED Requirements

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
