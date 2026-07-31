# interactive-session Specification

## Purpose
A stateful, multi-turn interactive session service that bridges the native
`oh --backend-only` line protocol to a WebSocket/REST gateway. It runs as a
sibling backend to the video-task `service/`, spawning one `oh --backend-only`
subprocess per session (isolated in its own process group), streaming
`assistant_delta` / `tool_*` / `turn_complete` events to clients in real time,
and preserving multi-turn context across idle eviction and reconnect via
`oh --resume`. Per-turn artifacts are registered and served with HTTP Range;
multi-node affinity is maintained through a Redis routing table with transparent
reverse-proxy forwarding. Caller-supplied CLI flags are allowlist- and
value-validated; safety-critical flags (`--permission-mode`, `--cwd`,
`--api-key`, `--resume`, `--backend-only`) are always server-fixed-injected.
## Requirements
### Requirement: Native backend-only protocol bridge (zero OpenHarness modification)

The service MUST drive multi-turn conversations by spawning `oh --backend-only` subprocesses and bridging their native line-delimited protocol; it MUST NOT require any modification to OpenHarness source. Output frames are lines prefixed with `OHJSON:` carrying a `BackendEvent` JSON; input frames are bare-JSON `FrontendRequest` lines (no prefix). Non-`OHJSON:` output lines MUST be treated as diagnostic logs (routed to the session log stream), never parsed as events.

#### Scenario: OHJSON output line is parsed as an event
- **WHEN** a subprocess writes a line `OHJSON:{"type":"assistant_delta","message":"hi"}`
- **THEN** the adapter strips the `OHJSON:` prefix, parses the JSON, and dispatches it as an `assistant_delta` event

#### Scenario: non-prefixed output line is treated as a diagnostic log
- **WHEN** a subprocess writes a plain line without the `OHJSON:` prefix
- **THEN** the adapter appends it to the session log stream and does NOT dispatch it as a protocol event

#### Scenario: input frame is written without prefix
- **WHEN** the adapter forwards a user turn to the subprocess
- **THEN** it writes a single-line bare JSON `{"type":"submit_line","line":"..."}` to stdin (no `OHJSON:` prefix)

---

### Requirement: A WebSocket turn MUST stream native events in real time

`GET /v1/sessions/{sid}/ws` MUST accept a `submit` message, forward it as `submit_line`, and stream the subprocess events back to the client in order: incremental text (`delta`), tool lifecycle (`tool_start`/`tool_end`), and a terminal `turn_complete` upon the native `line_complete`. Each native `BackendEvent` MUST map to a defined WS frame.

#### Scenario: a turn streams delta then completes
- **WHEN** a client sends `{"op":"submit","text":"make a video"}` over an established session WS
- **THEN** the client receives one or more `delta` frames, zero or more `tool_start`/`tool_end` frames, and finally a `turn_complete` frame carrying `turn_index` and any `usage`

#### Scenario: session readiness precedes the first turn
- **WHEN** a WS connects and the subprocess emits `ready`
- **THEN** the client receives a `session_ready` frame before any turn is accepted

---

### Requirement: Multi-turn context MUST be preserved within a live session

Within a session backed by a single live `oh --backend-only` process, consecutive turns MUST share the accumulated `QueryEngine` context, so a follow-up turn can reference prior turns. The service MUST persist each completed turn (`turn_index` monotonic from 0) and its assistant text.

#### Scenario: follow-up turn references prior context
- **WHEN** turn 0 produces a video and turn 1 says "make it shorter" on the same live session
- **THEN** turn 1 is executed in the same process with turn 0's context available, and both turns are recorded with `turn_index` 0 and 1

---

### Requirement: A session MUST enforce single-writer turn serialization

A session MUST run at most one turn at a time (aligning with the native `_busy` flag). A `submit` received while a turn is in progress MUST be rejected with a `busy` WS frame (and the non-WS turn endpoint MUST return `409`), and MUST NOT be forwarded to the subprocess.

#### Scenario: concurrent submit during an active turn is rejected
- **WHEN** a client sends a second `submit` while the first turn is still streaming
- **THEN** the service replies with a `busy` frame and does not write a second `submit_line` to the subprocess

#### Scenario: non-WS concurrent turn returns 409
- **WHEN** `POST /v1/sessions/{sid}/turns` is called while a turn is in progress
- **THEN** the response is `409`

---

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

---

### Requirement: Subprocess crash MUST be isolated from the gateway and other sessions

Each session's backend MUST run isolated from the gateway: in `process` runtime as its own OS session/process group (`start_new_session=True`); in `container` runtime as a dedicated container (the container boundary is the process group). If the backend exits unexpectedly (stdout EOF or container `die` event not initiated by our `shutdown`), the current turn MUST be marked `FAILED`, the session transitions to `COLD`, and the client is notified (`turn_error`) with the option to reconnect and rehydrate — without affecting the gateway process or any other session.

#### Scenario: unexpected subprocess exit fails only the current turn
- **WHEN** a session's subprocess crashes mid-turn
- **THEN** that turn is marked `FAILED`, the client receives `turn_error`, other sessions keep running, and the gateway stays up

#### Scenario: timeout kills the process group
- **WHEN** a turn exceeds `turn_timeout_seconds`
- **THEN** the backend's process group (or container) is terminated (`SIGTERM` then `SIGKILL`/force-remove) and the turn is failed with a timeout error

#### Scenario: killed session container is handled as a crash
- **WHEN** a session container is force-killed externally mid-turn (`docker kill -9`)
- **THEN** the gateway observes the attach-stream EOF / `die` event, fails the turn, transitions the session to `COLD`, and stays up

---

### Requirement: Interactive approval MUST be supported and gated by permission policy

Under `permission_policy=interactive`, a native `modal_request` (`kind=permission|edit_diff|question`) MUST be forwarded to the client as an `approval_request` frame carrying the `request_id`, and the client's `approval` reply MUST be translated to the native `permission_response`/`question_response`; an unanswered request MUST time out (default 300s) as a denial. Under `permission_policy=full_auto` (default), the subprocess runs with `--permission-mode full_auto` and MUST NOT block on interactive approvals.

#### Scenario: interactive permission is round-tripped
- **WHEN** the subprocess emits a `modal_request` under `interactive` policy
- **THEN** the client receives an `approval_request` with `request_id`, and its `approval` reply is forwarded as `permission_response` with the matching `request_id`

#### Scenario: full_auto does not block on approvals
- **WHEN** a session runs under `full_auto`
- **THEN** the subprocess is started with `--permission-mode full_auto` and completes turns without emitting blocking approval requests

#### Scenario: unanswered approval times out as denial
- **WHEN** an `approval_request` is not answered within the timeout
- **THEN** the service responds to the subprocess as a denial and the turn proceeds/aborts accordingly

---

### Requirement: A running turn MUST be interruptible

A client MUST be able to interrupt an in-progress turn via an `interrupt` message, which MUST be forwarded as the native `interrupt` request, causing the current turn to cancel and complete with an interruption record.

#### Scenario: interrupt cancels the active turn
- **WHEN** a client sends `{"op":"interrupt"}` during a streaming turn
- **THEN** the adapter writes `{"type":"interrupt"}`, the subprocess cancels the turn, and the client receives a `turn_complete` reflecting the interruption

---

### Requirement: Per-turn artifacts MUST be registered and downloadable with Range support

When a turn produces a video/file, the service MUST register it as a `turn_artifacts` row (via the reused `locate_output_file`/`probe_mp4`) and expose it for download. The download endpoint MUST support HTTP `Range` requests honoring both start and end bytes (reusing the `service/` download behavior), returning `206` with correct `Content-Range`/`Content-Length`.

#### Scenario: a produced video is registered as an artifact
- **WHEN** a turn completes having produced an mp4 in the session workspace
- **THEN** a `turn_artifacts` row is created with the storage key and probed metadata (size/duration/resolution/fps)

#### Scenario: artifact download honors Range end
- **WHEN** `GET /v1/sessions/{sid}/turns/{idx}/artifact` is called with `Range: bytes=10-19`
- **THEN** the response is `206` with `Content-Range: bytes 10-19/<size>` and exactly 10 bytes

---

### Requirement: Sessions MUST be affinity-routed across nodes with a single-writer lock

A stateful session's live process resides on one node; its WS connections MUST land on the node holding that process. A Redis routing table (`session:route:<sid>`) with heartbeat TTL MUST record `{node_id, pid, epoch}`. On connect, a gateway MUST serve locally if it owns the process; if another node owns it, the gateway MUST **transparently reverse-proxy the connection (including WS) to the owning node** (it MUST NOT `307`-redirect the client — clients always connect to a uniform `/v1/sessions/**` and never learn the owner node); for a `COLD` session it MUST acquire `session:lock:<sid>` before rehydrating locally. The lock MUST prevent two nodes from concurrently resuming the same `cwd`.

#### Scenario: connection is transparently proxied to the owning node
- **WHEN** a gateway receives a WS for a session whose route points to another live node
- **THEN** it transparently reverse-proxies the connection to the owning node (no redirect exposed to the client) rather than spawning a duplicate process

#### Scenario: cold rehydration is serialized by a lock
- **WHEN** two gateways simultaneously receive connections for the same `COLD` session
- **THEN** exactly one acquires `session:lock:<sid>` and rehydrates; the other waits or is routed to the winner

---

### Requirement: `extra_oh_args` MUST be allowlist- and value-validated

Forwarded `oh` CLI flags MUST be validated against the same allowlist + value-validation used by `service/security.py`: safety-critical flags (`--permission-mode`, `--cwd`, `--output-format`, `--api-key`, `--resume`, `--backend-only`) MUST be server-fixed/injected and non-overridable, and each typed value MUST be type/length/shell-metacharacter checked. Violations MUST be rejected with `422`.

#### Scenario: overriding permission-mode is rejected
- **WHEN** a create request includes `extra_oh_args: ["--permission-mode", "not_full_auto"]`
- **THEN** the request is rejected with `422`

#### Scenario: a value with shell metacharacters is rejected
- **WHEN** a create request includes an allowed flag whose value contains `;` or `|`
- **THEN** the request is rejected with `422`

---

### Requirement: Requests MUST be authenticated and scoped to a tenant

Mutating and reading endpoints (including the WS handshake) MUST require a valid `X-API-Key`, resolved by hashed lookup to a `tenant_id`; a missing/invalid/revoked/expired key MUST be rejected with `401`. All session operations MUST be scoped to the caller's `tenant_id`; cross-tenant access MUST be rejected with `403` (or `404`). Health/metrics probes (`/healthz`, `/readyz`, `/metrics`) MUST be exempt. `Settings.api_key` MUST be a `SecretStr` and responses MUST NOT leak internal storage keys/paths.

Key resolution MUST follow this order, shared by the REST middleware, the WS handshake, and the artifact-GET `?api_key=` path: (1) open mode — when no `api_key` is configured, `require_auth` is false, and the `api_keys` table is empty, the caller resolves to tenant `default`; (2) legacy single-key — a constant-time match against `settings.api_key` resolves to tenant `default`; (3) multi-key — `sha256(provided)` is looked up in the `api_keys` table (`active=true` only), resolving to the row's `tenant_id` with `actor_key_id` set to the row id for audit. Lookup results MAY be cached in-process with a bounded TTL (default 60s), so revocation takes effect within the TTL. The `api_keys` table (`key_hash` unique NOT NULL, `tenant_id` NOT NULL indexed, `active`, `label`, `created_at`) MUST be created by the session-service's own Alembic chain; raw keys MUST NOT be stored.

#### Scenario: missing API key is rejected
- **WHEN** a request to a protected endpoint has no `X-API-Key`
- **THEN** the response is `401`

#### Scenario: WS handshake enforces the key before accept
- **WHEN** a WS connects without a valid key
- **THEN** the handshake is rejected (not accepted) with an auth error

#### Scenario: cross-tenant session is invisible
- **WHEN** tenant B requests a session owned by tenant A
- **THEN** the response is `403` (or `404`) and no session data is returned

#### Scenario: multi-key resolves to its tenant
- **WHEN** a request carries a key whose `sha256` matches an active `api_keys` row with `tenant_id="acme"`
- **THEN** the request is authenticated with `request.state.tenant_id = "acme"` and `actor_key_id` set to that row's id

#### Scenario: revoked key is rejected after cache TTL
- **WHEN** an `api_keys` row is set `active=false` and the cache TTL has elapsed
- **THEN** subsequent requests with that key receive `401`

#### Scenario: legacy single-key deployment keeps working
- **WHEN** a deployment configures only `OH_API_KEY` (no `api_keys` rows) and a request carries that key
- **THEN** the request is authenticated as tenant `default`, identical to pre-change behavior

---

### Requirement: Session creation MUST be rate-limited

`POST /v1/sessions` (and per-tenant WS connection establishment) MUST enforce a Redis token-bucket rate limit (reusing `service/app/ratelimit.py`, fail-open), returning `429` when the bucket is empty.

#### Scenario: burst exceeds the bucket
- **WHEN** submissions arrive faster than the configured bucket allows
- **THEN** the excess receive `429` and no session is created for them

---

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

---

### Requirement: Creating a session from an existing one MUST resume its context

`create_session_from_existing` MUST spawn the backend with resume semantics (`--resume <oh_session_id>`) so the new live process restores the source session's conversation context. Spawning without resume (losing context) contradicts the endpoint's semantics and is a defect.

#### Scenario: continued session keeps prior context
- **WHEN** a session is created from an existing session with prior turns
- **THEN** the backend command includes `--resume <oh_session_id>` and prior context is available to the next turn

---

### Requirement: `oh_session_id` MUST be derived from `cwd` and the workspace MUST persist across turns

Each session MUST use a persistent `workspace_root/<session_id>` that is NOT deleted between turns. The native snapshot id MUST be **derived from the persistent `cwd` as the authoritative source** — computed as `{cwd.name}-{sha1(str(resolve(cwd)))[:12]}` — and persisted to `conversations.oh_session_id` **before** the `oh --backend-only` subprocess is spawned, so it is available for `--resume` without waiting for any runtime event. A `state_snapshot` event MAY be used only to validate the derived value (mismatch SHALL be logged, with the derived value taking precedence); it MUST NOT be the source for first establishing the session id.

#### Scenario: workspace survives across turns
- **WHEN** a session completes multiple turns
- **THEN** its `workspace_root/<session_id>` directory is not removed between turns

#### Scenario: session id is derived before spawn
- **WHEN** a session is created and its persistent `cwd` is known
- **THEN** `conversations.oh_session_id` is computed from `cwd` and persisted before the subprocess is spawned, so a later cold session can `--resume` even if the first turn never reached a `state_snapshot`

---

### Requirement: Session tables MUST use an independent migration chain and MUST NOT touch `video_tasks`

The service MUST define `conversations`, `conversation_turns`, and `turn_artifacts` via its own Alembic chain (independent `version_table`, e.g., `alembic_version_session`) in the shared Postgres instance, without modifying `video_tasks` or the `service/` migration head. `(conversation_id, turn_index)` MUST be unique; `(tenant_id, created_at)` MUST be indexed.

#### Scenario: session migrations do not collide with service migrations
- **WHEN** the session-service migrations run against the shared database
- **THEN** they use a separate version table and create only the three session tables, leaving `video_tasks` unchanged

---

### Requirement: The session log stream MUST be bounded

Per-session diagnostic logs stored in Redis Streams MUST be appended with `MAXLEN ~ N approximate=True` (reusing the `service/` pattern) and tail reads MUST use `XREVRANGE ... COUNT N`, so a verbose session cannot grow the stream without bound.

#### Scenario: heavy diagnostic output stays bounded
- **WHEN** a session emits a very large volume of non-protocol log lines
- **THEN** the Redis stream length stays at or below the configured `MAXLEN`

---

### Requirement: DELETE MUST clean resources while preserving terminal turn records

`DELETE /v1/sessions/{sid}` MUST kill any live process, remove the workspace, native snapshot directory, artifacts, and Redis routing/lock/log entries, and set the session `CLOSED`. It MUST preserve each completed turn's terminal record (status/metadata) for audit, rather than rewriting turn statuses. When tenant data isolation is enabled, it MUST run a final stage-out and then remove the session's traces from both the local staging directory and the MinIO tenant prefix (the `data/memory/{oh_session_id}*` and `data/sessions/{oh_session_id}*` entries and object prefixes); every local cleanup path MUST be resolved and verified to lie under `/tenants/{tenant_id}/` before deletion. When workspace archiving is enabled, a final workspace stage-out MUST complete (best-effort, awaited) **before** the local workspace directory is removed, and the session's workspace archive under `tenants/{tenant_id}/workspaces/{sid}/` MUST be **preserved** (not deleted) so the closed session's files remain readable through the workspace file APIs, per `session-workspace-archive`.

#### Scenario: delete preserves completed turn history
- **WHEN** a session with completed turns is deleted
- **THEN** resources are cleaned and the session is `CLOSED`, but the completed turns' terminal records remain queryable

#### Scenario: delete removes staging and bucket traces
- **WHEN** a session is deleted under tenant data isolation
- **THEN** after the final stage-out, the session's memory/snapshot entries are removed from both `/tenants/{tenant_id}/openharness/data/` and the tenant's MinIO prefix, and other sessions' entries are untouched

#### Scenario: delete archives then preserves the workspace archive
- **WHEN** a session with workspace files is deleted while workspace archiving is enabled
- **THEN** a final workspace stage-out runs before the local workspace is removed, the `tenants/{tenant_id}/workspaces/{sid}/` prefix is retained, and the tenant can still list and download those files via the workspace file APIs

#### Scenario: a traversal-shaped cleanup path is refused
- **WHEN** a computed cleanup path resolves outside `/tenants/{tenant_id}/`
- **THEN** the deletion of that path is refused and the violation is logged

---

### Requirement: `/healthz` is liveness; `/readyz` MUST return 503 when degraded

`/healthz` MUST stay a cheap liveness probe returning `200` while the process is up. `/readyz` MUST aggregate dependency health (DB, Redis, and process-pool headroom) and return `503` when any is unavailable. The Redis probe MUST be async (`redis.asyncio` with a timeout) so it never blocks the event loop.

#### Scenario: healthz stays 200 while up
- **WHEN** `GET /healthz` is called while the process runs (dependencies may be degraded)
- **THEN** the response is `200`

#### Scenario: readyz returns 503 when Redis is down
- **WHEN** Redis is unreachable and `GET /readyz` is called
- **THEN** the response is `503` without blocking the event loop

---

### Requirement: Reconnect MUST replay missed turn completions

On reconnect, a client MAY present `last_turn_index`; the service MUST replay the `turn_complete` records for any turns completed after that index (from the database) and then resume live streaming from the log stream tail, so a brief disconnect does not lose completed-turn results.

#### Scenario: reconnect replays completed turns
- **WHEN** a client reconnects with `last_turn_index=2` and turns 3 and 4 completed while disconnected
- **THEN** the service replays `turn_complete` for turns 3 and 4 before streaming new events

---

### Requirement: The `service/` `/v1/videos` behavior MUST remain unchanged

Introducing the session service MUST NOT change `service/`'s stateless `/v1/videos` semantics, its tests, or the `video_tasks` schema. The two backends MUST be independently deployable and share only Postgres/Redis/volumes/base image.

#### Scenario: existing video service is unaffected
- **WHEN** the session-service is added and deployed
- **THEN** `service/`'s existing test suite still passes and `/v1/videos` behavior is unchanged

---

## Spawn Lifecycle Hardening (session-credential-gateway-hardening)

> 来源：change `session-credential-gateway-hardening` —— backend spawn 生命周期硬失败 + CREATING 收敛 + FAILED 恢复语义。

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

A DB session row MUST NOT remain in `CREATING` after its spawn attempt concludes: when create-session fails after the row was committed, the gateway MUST best-effort converge the row to `FAILED` (logging but never masking the original error). At service startup, a one-shot sweep MUST mark every remaining `CREATING` row as `FAILED` — a live session is bound to a gateway process, so no legitimate `CREATING` row can survive a restart. The sweep carries single-node semantics only (multi-node ownership reconciliation is out of scope).

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

---

## Hardening Requirements (harden-session-service)

> 来源：`session-service/` 代码审查 18 项发现（SS-1 至 SS-18）。SS-R1～R8 对上述基线 Requirement 进行加固，SS-R9～R12 为新增需求。所有变更均为增量修复，不改变现有 API 契约或协议行为。

### Requirement: SS-R1 子进程产物探测 MUST NOT 阻塞事件循环

产物注册时的 `probe_mp4`（调用 `ffprobe`）和孤儿工作空间清理时的 `shutil.rmtree` MUST 通过 `run_in_executor` 或 `run_in_threadpool` 卸载到线程池执行，MUST NOT 直接在 asyncio 事件循环中同步调用。这些操作为同步阻塞操作，直接调用会阻塞事件循环，导致所有并发 WS 连接和 HTTP 请求被挂起。

*对应问题：SS-1（ffprobe 阻塞）、SS-17（rmtree 阻塞）*

#### Scenario: ffprobe 异步化
- **GIVEN** 一个轮次产生了 mp4 产物
- **WHEN** supervisor 注册产物调用 `probe_mp4`
- **THEN** 该调用通过 `run_in_executor` 在线程池中执行，不阻塞 asyncio 事件循环

#### Scenario: orphan_scan 异步化
- **GIVEN** 服务启动时存在孤儿工作空间
- **WHEN** `orphan_scan` 清理目录
- **THEN** `shutil.rmtree` 通过 `run_in_threadpool` 执行

---

### Requirement: SS-R2 Redis 连接池 MUST 复用

所有模块 MUST 使用统一的 `redis.asyncio` 客户端，并通过模块级连接池单例复用，MUST NOT 每次调用创建新连接或混用同步/异步客户端。

*对应问题：SS-2（Redis 连接泄漏）、SS-12（Redis 客户端混用）*

#### Scenario: 连接池单例
- **GIVEN** registry 和 logs 模块需要 Redis 连接
- **WHEN** 多次调用 `_client()`
- **THEN** 返回同一连接池实例，不重复创建 TCP 连接

#### Scenario: 统一异步客户端
- **GIVEN** 限流和路由表均使用 Redis
- **WHEN** 任何模块需要 Redis 访问
- **THEN** 统一使用 `redis.asyncio` 客户端，不存在同步 Redis 调用

---

### Requirement: SS-R3 租户配额 MUST 原子检查

租户并发会话配额检查（count + create）MUST 在同一个 `asyncio.Lock` 保护下执行或通过 supervisor 提供的公开方法保证原子性，MUST NOT 存在 TOCTOU 竞态窗口。

*对应问题：SS-3（租户配额 TOCTOU 竞态）*

#### Scenario: 并发创建不超配额
- **GIVEN** 租户配额为 8 且当前 7 个 live 会话
- **WHEN** 两个并发创建请求同时到达
- **THEN** 仅一个通过检查并创建，另一个被拒绝（403/503）

---

### Requirement: SS-R4 COLD 重连 MUST 单写者保证

COLD 会话重连 MUST 通过 supervisor 内部的 `register_live_session()` 方法加锁，保证仅一个客户端触发 rehydrate，MUST NOT 允许两个 WS 客户端同时触发 `oh --resume` 竞争同一个 `cwd`。

*对应问题：SS-4（双重 rehydrate 竞态）*

#### Scenario: 并发重连幂等
- **GIVEN** 一个 COLD 状态的会话
- **WHEN** 两个 WebSocket 客户端同时尝试重连
- **THEN** 仅一个触发 rehydrate，另一个等待复用已恢复的 LiveSession

---

### Requirement: SS-R5 速率限制 MUST 防绕过

`X-Forwarded-For` MUST 仅在配置了可信代理（`OH_TRUSTED_PROXY`）后读取，MUST NOT 直接信任未经验证的 XFF 头；令牌桶操作 MUST 通过 Lua 脚本原子执行，MUST NOT 存在竞态超卖窗口。

*对应问题：SS-5（XFF 伪造）、SS-9（令牌桶非原子）*

#### Scenario: XFF 仅在可信代理后生效
- **GIVEN** 部署配置了 `OH_TRUSTED_PROXY`
- **WHEN** 请求来自非可信代理且携带伪造 `X-Forwarded-For`
- **THEN** 使用 `request.client.host` 作为限流 key

#### Scenario: 令牌桶原子操作
- **GIVEN** 高并发请求
- **WHEN** 令牌桶检查执行
- **THEN** `hgetall` + 计算 + `hset` 通过 Lua 脚本原子执行，不存在竞态超卖

---

### Requirement: SS-R6 HTTP 响应头 MUST 安全 sanitize

产物下载时文件名 MUST 经过 sanitize，仅保留安全字符 `[\w\-.]`，其余替换为下划线，MUST NOT 直接拼接到 `Content-Disposition` 头中。

*对应问题：SS-6（Content-Disposition 头注入）*

#### Scenario: 文件名 sanitize
- **GIVEN** 产物文件名包含引号或特殊字符
- **WHEN** 生成 `Content-Disposition` 头
- **THEN** 文件名仅保留安全字符 `[\w\-.]`，其余替换为下划线

---

### Requirement: SS-R7 Redis 分布式锁 MUST 原子释放

Redis 分布式锁释放 MUST 通过 Lua 脚本原子执行 `GET` + 比较 + `DELETE`，MUST NOT 分三步非原子操作。

*对应问题：SS-7（锁释放 TOCTOU 竞态）*

#### Scenario: 锁释放原子性
- **GIVEN** holder 释放锁
- **WHEN** 执行 `release_lock`
- **THEN** `GET` + 比较 + `DELETE` 通过 Lua 脚本原子执行，不存在 TOCTOU 竞态

---

### Requirement: SS-R8 输入 MUST 验证加固

`BackendEvent` payload MUST 限制大小，超大 payload MUST 被截断或拒绝；`ApprovalRequest` 的 `reply` 字段 MUST 做枚举验证（仅允许 `once`/`always`/`reject`）；`ffprobe` 帧率解析 MUST 捕获 `ValueError` 并优雅降级。

*对应问题：SS-14（BackendEvent payload 过大）、SS-15（ApprovalRequest 枚举未验证）、SS-16（ffprobe ValueError 未捕获）*

#### Scenario: BackendEvent payload 限制
- **GIVEN** 上游发送超大 payload
- **WHEN** 解析 `BackendEvent`
- **THEN** 超过合理大小的 payload 被截断或拒绝

#### Scenario: ApprovalRequest reply 枚举
- **GIVEN** 客户端提交审批回复
- **WHEN** `reply` 字段不是 `once`/`always`/`reject` 之一
- **THEN** 返回 422 验证错误

#### Scenario: ffprobe ValueError 捕获
- **GIVEN** ffprobe 输出格式异常（如帧率为 `"30/abc"`）
- **WHEN** 解析帧率
- **THEN** `ValueError` 被捕获并优雅降级

---

### Requirement: SS-R9 Supervisor MUST 封装完整

Supervisor MUST 提供 `count_live_for_tenant()`、`register_live_session()`、`remove_live_session()` 等公开方法供外部调用，MUST NOT 允许路由层或 WS handler 直接访问 `_sessions` 私有属性。

*对应问题：SS-10（封装破坏）*

#### Scenario: 公开方法替代私有访问
- **GIVEN** 路由层需要查询租户 live 会话数
- **WHEN** 调用 `supervisor.count_live_for_tenant(tenant_id)`
- **THEN** 返回正确计数，无需直接访问 `_sessions` 私有属性

#### Scenario: 会话注册通过公开接口
- **GIVEN** WS handler 需要注册 rehydrated 会话
- **WHEN** 调用 `supervisor.register_live_session()`
- **THEN** 会话被安全注册，内部状态一致性由 supervisor 保证

---

### Requirement: SS-R10 WebSocket 鉴权 MUST 安全增强

WebSocket 连接的 `api_key` MUST 在日志中脱敏显示为 `"***"`，MUST NOT 完整记录明文。可选地，部署可配置 `OH_WS_AUTH_MODE=ticket` 使用一次性 ticket 替代明文 api_key。

*对应问题：SS-11（WS API Key 泄露）*

#### Scenario: API Key 日志脱敏
- **GIVEN** WebSocket 连接通过 query param 传递 `api_key`
- **WHEN** 请求被记录到日志
- **THEN** `api_key` 值被脱敏显示为 `"***"`

#### Scenario: 短期 ticket 替代方案（可选）
- **GIVEN** 部署配置了 `OH_WS_AUTH_MODE=ticket`
- **WHEN** 客户端请求 WS 连接
- **THEN** 使用一次性 ticket 替代明文 api_key

---

### Requirement: SS-R11 DB 依赖 MUST 一致关闭

所有 DB session 依赖 MUST 使用统一的 `try/finally` 模式保证显式关闭，MUST NOT 在异常退出时泄漏连接。

*对应问题：SS-8（get_db 与 get_async_session 行为不一致）*

#### Scenario: 统一 session 关闭
- **GIVEN** 路由处理中抛出异常
- **WHEN** `get_db()` 的 generator 退出
- **THEN** session 在 `finally` 块中被显式 close，与 `get_async_session()` 行为一致

---

### Requirement: SS-R12 存储客户端 MUST 缓存复用

`storage_for_kind()` MUST 缓存存储实例，MUST NOT 每次调用创建新的 boto3 client。同时，`OH_TENANT_MAX_DAILY` 每日配额 MUST 强制执行，达到上限时 MUST 返回 403 拒绝创建。

*对应问题：SS-13（S3 客户端重复创建）、SS-18（每日配额未实现）*

#### Scenario: S3 客户端复用
- **GIVEN** 多次 artifact 操作
- **WHEN** 调用 `storage_for_kind("s3")`
- **THEN** 返回缓存的存储实例，不重复创建 boto3 client

#### Scenario: 每日配额强制执行
- **GIVEN** 配置了 `OH_TENANT_MAX_DAILY`
- **WHEN** 租户当日创建会话数达到上限
- **THEN** 返回 403 拒绝创建

