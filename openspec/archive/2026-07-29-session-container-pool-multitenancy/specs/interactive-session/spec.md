# Delta: interactive-session（多租户容器池——认证解析、容量准入、清理范围、崩溃隔离扩展）

## MODIFIED Requirements

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

### Requirement: Resource limits MUST bound sessions, turns, and lifetime

The service MUST enforce a node-level `max_live_sessions` (in `container` runtime this bounds the number of live session containers), a per-tenant concurrent/daily session quota (`429` on exceed; `tenant_max_concurrent` MUST default to **1** — one active session per tenant/user at a time, which together with the per-tenant sync lock eliminates concurrent writes to the tenant's MinIO prefix; operators raising it above 1 accept last-writer-wins on tenant data), a `session_ttl_seconds` total lifetime, a `turn_timeout_seconds` per turn, and a `max_turns_per_session` cap to bound snapshot growth.

Admission for a live slot MUST proceed in order, under the supervisor's quota lock: (1) per-tenant quota check (`429` on exceed); (2) node capacity check — below `max_live_sessions` admits immediately; (3) eviction — when full, the longest-idle `IDLE` session is evicted to `COLD` (snapshot preserved) to free a slot; (4) bounded FIFO wait queue — when nothing is evictable, the request waits up to `pool_queue_timeout` in a queue bounded by `pool_queue_size`; queue-full or timeout MUST return `503` with a `Retry-After` header. A single tenant MUST NOT hold more queue slots than `tenant_max_concurrent`. A freed slot (container/process exit or session destroy) MUST wake the queue head. Setting the queue size to 0 MUST degrade to the previous fail-fast behavior (full → `503`).

#### Scenario: capacity full evicts the longest-idle session
- **WHEN** `max_live_sessions` is reached and a new session needs a live process
- **THEN** the longest-idle session is evicted to `COLD` (its snapshot preserved) to free a slot

#### Scenario: per-tenant quota exceeded is rejected
- **WHEN** a tenant already holds its maximum concurrent sessions
- **THEN** a new session request is rejected with `429`

#### Scenario: default quota allows a single active session
- **WHEN** `tenant_max_concurrent` is left at its default and a tenant with one live/idle session issues a second create request
- **THEN** the second request is rejected with `429` while the first session remains unaffected

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

### Requirement: DELETE MUST clean resources while preserving terminal turn records

`DELETE /v1/sessions/{sid}` MUST kill any live process, remove the workspace, native snapshot directory, artifacts, and Redis routing/lock/log entries, and set the session `CLOSED`. It MUST preserve each completed turn's terminal record (status/metadata) for audit, rather than rewriting turn statuses. When tenant data isolation is enabled, it MUST run a final stage-out and then remove the session's traces from both the local staging directory and the MinIO tenant prefix (the `data/memory/{oh_session_id}*` and `data/sessions/{oh_session_id}*` entries and object prefixes); every local cleanup path MUST be resolved and verified to lie under `/tenants/{tenant_id}/` before deletion.

#### Scenario: delete preserves completed turn history
- **WHEN** a session with completed turns is deleted
- **THEN** resources are cleaned and the session is `CLOSED`, but the completed turns' terminal records remain queryable

#### Scenario: delete removes staging and bucket traces
- **WHEN** a session is deleted under tenant data isolation
- **THEN** after the final stage-out, the session's memory/snapshot entries are removed from both `/tenants/{tenant_id}/openharness/data/` and the tenant's MinIO prefix, and other sessions' entries are untouched

#### Scenario: a traversal-shaped cleanup path is refused
- **WHEN** a computed cleanup path resolves outside `/tenants/{tenant_id}/`
- **THEN** the deletion of that path is refused and the violation is logged

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
