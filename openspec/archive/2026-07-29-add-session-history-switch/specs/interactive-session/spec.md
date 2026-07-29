# interactive-session Delta Specification

## MODIFIED Requirements

### Requirement: Idle sessions MUST be evicted and cold sessions MUST rehydrate via native resume

When all WebSocket connections for a session close and `idle_grace_seconds` elapses, the supervisor MUST gracefully shut down the subprocess (`shutdown` request) and transition the session to `COLD` (snapshot remains on the shared volume). A subsequent connection MUST rehydrate by spawning `oh --resume <oh_session_id> --backend-only` with the session's persistent `cwd`, restoring history losslessly except for at most one turn that was in-flight and unsnapshotted when the process was killed.

Eviction MUST be re-entrancy-safe and failure-safe:

- The session MUST carry an `evicting` in-progress marker set before the first await of the eviction body; a re-entrant call MUST skip and report no eviction. The marker MUST be cleared in a `try/finally` so that a teardown or stage-out exception can never leave the session permanently marked as evicting.
- The eviction operation MUST return an explicit result (`True` = the slot was actually freed; `False` = skipped or not evictable), and eviction hooks MUST propagate this result instead of unconditionally reporting success, so callers do not retry a claim after a skipped eviction.
- On eviction failure the slot MUST NOT leak: a graceful-shutdown failure escalates to a force kill and processing continues; the `COLD` transition and the pool slot release MUST complete in the same protected section once the process is dead, regardless of a subsequent stage-out failure (release is idempotent). Stage-out remains best-effort (logged warning).

Rehydration of a `COLD` session whose snapshot does not exist and whose `turn_count == 0` MUST fall back to a fresh spawn (no `--resume`), since there is no context to restore; spawning `--resume` without a snapshot would fail at the CLI level.

#### Scenario: idle session is evicted to COLD
- **WHEN** a session has no WS connections for longer than `idle_grace_seconds`
- **THEN** the subprocess is shut down gracefully and the session status becomes `COLD` with `oh_session_id` and `workspace_path` retained

#### Scenario: reconnect to a COLD session rehydrates history
- **WHEN** a client reconnects to a `COLD` session
- **THEN** the supervisor spawns `oh --resume <oh_session_id> --backend-only` in the session's `cwd`, and prior turns remain available for follow-up

#### Scenario: concurrent eviction of the same session runs once
- **WHEN** two eviction calls race on the same live session
- **THEN** teardown, slot release, and stage-out each happen exactly once, and the re-entrant call returns `False`

#### Scenario: eviction failure does not leak state or slots
- **WHEN** teardown or stage-out raises during eviction
- **THEN** the `evicting` marker is restored to `False`, the pool slot is released (live count falls, a subsequent acquire can claim it), and a stage-out failure still leaves the session in `COLD` with its status persisted

#### Scenario: cold session with no turns rehydrates as a fresh spawn
- **WHEN** a client connects to a `COLD` session that has `turn_count == 0` and no snapshot
- **THEN** the backend is spawned without `--resume` and the session becomes usable

### Requirement: Resource limits MUST bound sessions, turns, and lifetime

The service MUST enforce a node-level `max_live_sessions` (in `container` runtime this bounds the number of live session containers), a per-tenant concurrent/daily session quota (`429` on exceed; `tenant_max_concurrent` MUST default to **1** — one active session per tenant/user at a time, which together with the per-tenant sync lock eliminates concurrent writes to the tenant's MinIO prefix; operators raising it above 1 accept last-writer-wins on tenant data), a `session_ttl_seconds` total lifetime, a `turn_timeout_seconds` per turn, and a `max_turns_per_session` cap to bound snapshot growth.

Admission for a live slot MUST proceed in order, under the supervisor's quota lock: (1) per-tenant quota check — when exceeded, the pool MUST first attempt a **same-tenant idle eviction** (via the supervisor-injected hook, see `session-pool-scheduling`) and retry the claim within the shared eviction-attempt bound; only when no same-tenant candidate can yield is the request rejected (`429` on REST, `4430` on WS). The eviction candidate MUST satisfy all of: same tenant, live (`LIVE`/`IDLE`), no WS connections attached, not busy running a turn, and not already evicting; among candidates the longest-idle one is chosen and demoted to `COLD` with its snapshot preserved. Concurrent quota-triggered evictions for one tenant MUST be serialized by a per-tenant eviction lock, re-scanning candidates after acquiring the lock so a session is never double-evicted; (2) node capacity check — below `max_live_sessions` admits immediately; (3) eviction — when full, the longest-idle `IDLE` session is evicted to `COLD` (snapshot preserved) to free a slot; (4) bounded FIFO wait queue — when nothing is evictable, the request waits up to `pool_queue_timeout` in a queue bounded by `pool_queue_size`; queue-full or timeout MUST return `503` with a `Retry-After` header. A single tenant MUST NOT hold more queue slots than `tenant_max_concurrent`. A freed slot (container/process exit or session destroy) MUST wake the queue head. Setting the queue size to 0 MUST degrade to the previous fail-fast behavior (full → `503`).

#### Scenario: capacity full evicts the longest-idle session
- **WHEN** `max_live_sessions` is reached and a new session needs a live process
- **THEN** the longest-idle session is evicted to `COLD` (its snapshot preserved) to free a slot

#### Scenario: per-tenant quota exceeded is rejected
- **WHEN** a tenant already holds its maximum concurrent sessions and no same-tenant candidate can yield (all busy or attached)
- **THEN** a new session request is rejected with `429`

#### Scenario: default quota allows a single active session
- **WHEN** `tenant_max_concurrent` is left at its default and a tenant with one live/idle session issues a second create request
- **THEN** the second request is rejected with `429` while the first session remains unaffected, unless the first session is idle and unattached, in which case it yields its slot

#### Scenario: quota exceeded with an idle same-tenant session yields the slot
- **WHEN** a tenant at quota requests a live slot while its other session is `IDLE` with no WS attached and not busy
- **THEN** that session is evicted to `COLD` (snapshot preserved) and the claim retry succeeds without rejection

#### Scenario: concurrent switches evict only once
- **WHEN** two clients of one tenant (quota 1, session A idle) concurrently connect the WS of sessions B and C
- **THEN** A is evicted exactly once, exactly one connection wins with `session_ready`, the other closes with `4430`, no illegal state transition occurs, and the tenant's live slot count remains 1

#### Scenario: turn cap is enforced
- **WHEN** a session reaches `max_turns_per_session`
- **THEN** further submits are rejected until the session is closed/renewed

#### Scenario: nothing evictable queues then times out
- **WHEN** all live slots are busy (no `IDLE` session to evict) and a create request waits longer than `pool_queue_timeout`
- **THEN** the request receives `503` with a `Retry-After` header and no session is created

#### Scenario: a freed slot admits the queue head
- **WHEN** a request is waiting in the queue and another session is destroyed
- **THEN** the waiting request acquires the freed slot and session creation proceeds

#### Scenario: one tenant cannot flood the queue
- **WHEN** a tenant already holds `tenant_max_concurrent` queue slots and submits another create request
- **THEN** that request is rejected immediately instead of enqueueing

## ADDED Requirements

### Requirement: Creating a session from an existing one MUST resume its context

`create_session_from_existing` MUST spawn the backend with resume semantics (`--resume <oh_session_id>`) so the new live process restores the source session's conversation context. Spawning without resume (losing context) contradicts the endpoint's semantics and is a defect.

#### Scenario: continued session keeps prior context
- **WHEN** a session is created from an existing session with prior turns
- **THEN** the backend command includes `--resume <oh_session_id>` and prior context is available to the next turn
