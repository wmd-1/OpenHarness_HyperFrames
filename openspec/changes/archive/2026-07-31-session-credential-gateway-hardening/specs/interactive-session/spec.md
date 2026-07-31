# interactive-session Delta Specification

> Change: `session-credential-gateway-hardening` — backend spawn 生命周期硬失败 + CREATING 收敛 + FAILED 恢复语义。

## ADDED Requirements

### Requirement: Backend spawn MUST hard-fail before LIVE when ready is not reached

The backend spawn lifecycle MUST follow this state contract:

```
SPAWN
  |
  +-- ready (within startup timeout) --> LIVE
  |
  +-- fail --> FAILED + cleanup
       (backend exit != 0 / stdout EOF before ready / ready timeout —
        including startup-time credential absence causing an immediate exit)
```

A session MUST NOT transition to LIVE unless the backend emitted `ready`. On failure the gateway MUST perform full cleanup — cancel the session's helper tasks (heartbeat/log drain), kill the backend process group (idempotent), release the pool slot (idempotent), decrement the live-sessions gauge — and propagate an explicit error (HTTP 5xx on create, WS rejection on reconnect paths). The EOF failure MUST carry the backend's exit code; the timeout failure MUST kill the process group before raising. The silent-pass behavior (timeout or EOF during startup still entering LIVE) is REMOVED. This contract applies uniformly to all three spawn paths: create, COLD rehydrate, and re-arm.

#### Scenario: backend exiting before ready fails the create explicitly
- **WHEN** the spawned backend prints an error and exits non-zero before emitting `ready` (e.g. no credential resolvable)
- **THEN** create-session fails with an explicit error carrying the exit code, the session is not registered as live, the pool slot is released, and no later turn can hit a closed-stdin transport error

#### Scenario: ready timeout kills the group and fails the spawn
- **WHEN** the backend emits no `ready` within the startup timeout
- **THEN** the process group is terminated, the spawn raises, and cleanup leaves no leaked slot, task, or gauge increment

#### Scenario: rehydrate and re-arm share the hard-fail semantics
- **WHEN** a COLD rehydrate or a re-arm spawn fails before `ready`
- **THEN** the WS connection is rejected with an explicit error, the placeholder live session is dropped, and a later attempt can retry cleanly

### Requirement: CREATING MUST NOT persist beyond the spawn attempt

A DB session row MUST NOT remain in `CREATING` after its spawn attempt concludes: when create-session fails after the row was committed, the gateway MUST best-effort converge the row to `FAILED` (logging but never masking the original error). At service startup, a one-shot sweep MUST mark every remaining `CREATING` row as `FAILED` — a live session is bound to a gateway process, so no legitimate `CREATING` row can survive a restart. The sweep carries single-node semantics only (see Non-goals: multi-node ownership reconciliation is out of scope).

#### Scenario: create failure converges the row to FAILED
- **WHEN** the backend spawn fails after the session row was committed as `CREATING`
- **THEN** the caller receives the explicit error and the row ends as `FAILED`, not `CREATING`

#### Scenario: startup sweep clears stale CREATING rows
- **WHEN** session-service restarts while the DB holds rows stuck in `CREATING` (e.g. from a crash mid-create)
- **THEN** after startup those rows are `FAILED` and are reported consistently by the REST API

### Requirement: FAILED MUST be recoverable via the standard rehydrate path

`FAILED` is NOT a terminal state: it MUST be treated like `COLD` for recovery — the router's resumability predicate includes `FAILED` (resumable when the native snapshot exists), and a client reconnecting to a `FAILED` session MUST trigger the same single-writer rehydrate (`--resume`) path as a `COLD` session. No dedicated retry API is introduced; sessions whose snapshot is absent are reported not resumable and remain readable history.

#### Scenario: reconnecting to a FAILED session rehydrates it
- **WHEN** a client opens the session WS for a `FAILED` session whose native snapshot exists
- **THEN** the gateway rehydrates it via `--resume` exactly as for a `COLD` session and the session returns to LIVE on `ready`

#### Scenario: a FAILED session without a snapshot is not resumable
- **WHEN** a session failed before any turn produced a native snapshot
- **THEN** the API reports it not resumable and reconnect attempts receive an explicit error instead of a spawn loop
