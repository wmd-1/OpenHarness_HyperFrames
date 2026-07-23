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

#### Scenario: idle session is evicted to COLD
- **WHEN** a session has no WS connections for longer than `idle_grace_seconds`
- **THEN** the subprocess is shut down gracefully and the session status becomes `COLD` with `oh_session_id` and `workspace_path` retained

#### Scenario: reconnect to a COLD session rehydrates history
- **WHEN** a client reconnects to a `COLD` session
- **THEN** the supervisor spawns `oh --resume <oh_session_id> --backend-only` in the session's `cwd`, and prior turns remain available for follow-up

---

### Requirement: Subprocess crash MUST be isolated from the gateway and other sessions

Each session's subprocess MUST run in its own OS session/process group (`start_new_session=True`). If the subprocess exits unexpectedly (stdout EOF not initiated by our `shutdown`), the current turn MUST be marked `FAILED`, the session transitions to `COLD`, and the client is notified (`turn_error`) with the option to reconnect and rehydrate — without affecting the gateway process or any other session.

#### Scenario: unexpected subprocess exit fails only the current turn
- **WHEN** a session's subprocess crashes mid-turn
- **THEN** that turn is marked `FAILED`, the client receives `turn_error`, other sessions keep running, and the gateway stays up

#### Scenario: timeout kills the process group
- **WHEN** a turn exceeds `turn_timeout_seconds`
- **THEN** the subprocess process group is terminated (`SIGTERM` then `SIGKILL`) and the turn is failed with a timeout error

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

#### Scenario: missing API key is rejected
- **WHEN** a request to a protected endpoint has no `X-API-Key`
- **THEN** the response is `401`

#### Scenario: WS handshake enforces the key before accept
- **WHEN** a WS connects without a valid key
- **THEN** the handshake is rejected (not accepted) with an auth error

#### Scenario: cross-tenant session is invisible
- **WHEN** tenant B requests a session owned by tenant A
- **THEN** the response is `403` (or `404`) and no session data is returned

---

### Requirement: Session creation MUST be rate-limited

`POST /v1/sessions` (and per-tenant WS connection establishment) MUST enforce a Redis token-bucket rate limit (reusing `service/app/ratelimit.py`, fail-open), returning `429` when the bucket is empty.

#### Scenario: burst exceeds the bucket
- **WHEN** submissions arrive faster than the configured bucket allows
- **THEN** the excess receive `429` and no session is created for them

---

### Requirement: Resource limits MUST bound sessions, turns, and lifetime

The service MUST enforce a node-level `max_live_sessions` (evicting the longest-idle `LIVE`/`IDLE` session to `COLD` when full, or returning `503` if none can be freed), a per-tenant concurrent/daily session quota (`429` on exceed), a `session_ttl_seconds` total lifetime, a `turn_timeout_seconds` per turn, and a `max_turns_per_session` cap to bound snapshot growth.

#### Scenario: capacity full evicts the longest-idle session
- **WHEN** `max_live_sessions` is reached and a new session needs a live process
- **THEN** the longest-idle session is evicted to `COLD` (its snapshot preserved) to free a slot

#### Scenario: per-tenant quota exceeded is rejected
- **WHEN** a tenant already holds its maximum concurrent sessions
- **THEN** a new session request is rejected with `429`

#### Scenario: turn cap is enforced
- **WHEN** a session reaches `max_turns_per_session`
- **THEN** further submits are rejected until the session is closed/renewed

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

`DELETE /v1/sessions/{sid}` MUST kill any live process, remove the workspace, native snapshot directory, artifacts, and Redis routing/lock/log entries, and set the session `CLOSED`. It MUST preserve each completed turn's terminal record (status/metadata) for audit, rather than rewriting turn statuses.

#### Scenario: delete preserves completed turn history
- **WHEN** a session with completed turns is deleted
- **THEN** resources are cleaned and the session is `CLOSED`, but the completed turns' terminal records remain queryable

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

