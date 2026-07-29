# session-history-switch Specification

**Component:** `session-service/`
**Established by change:** `add-session-history-switch` (2026-07-29)

## Purpose
历史会话切换：租户列出自己的历史会话、读取历史轮次，并通过 WS 单一准入路径把 COLD 历史会话切回 LIVE。定义面向前端的 `resumable`/`read_only` 业务字段契约与机器可解析的 WS 准入失败语义。让位驱逐的池准入次序变更定义在 `interactive-session`，驱逐 hook 结构定义在 `session-pool-scheduling`，快照存在性查询定义在 `session-tenant-isolation`。

## Requirements

### Requirement: Tenant sessions MUST be listable with pagination and business fields

The service MUST expose `GET /v1/sessions` returning only the authenticated tenant's sessions, ordered by `created_at` descending, with `limit` (default 20, max 100) / `offset` pagination, an optional `status` filter, and a `total` count. Each item MUST include `session_id`, `status`, `created_at`, `turn_count`, a `title` derived from the first turn's prompt truncated to 80 characters (fetched with a single batched query per page, no N+1), and the business fields `resumable` and `read_only`. Sessions of other tenants MUST NOT be visible.

#### Scenario: list returns paginated tenant sessions
- **WHEN** a tenant with 37 sessions requests `GET /v1/sessions?limit=20&offset=0`
- **THEN** 20 items are returned newest-first with `total=37`, each carrying `title`, `turn_count`, `resumable`, and `read_only`

#### Scenario: cross-tenant sessions are invisible
- **WHEN** tenant A lists sessions while tenant B has sessions on the same node
- **THEN** the response contains only tenant A's sessions

#### Scenario: status filter narrows the list
- **WHEN** a tenant requests `GET /v1/sessions?status=cold`
- **THEN** only sessions whose persisted status is `cold` are returned

### Requirement: Historical turns MUST be readable, including for read-only sessions

The service MUST expose `GET /v1/sessions/{sid}/turns` returning the session's persisted turns ordered by `turn_index` ascending, with cursor pagination via `after_index` (default -1) and `limit` (default 50, max 200). Each item MUST include the persisted prompt, assistant text, status, and a batched `has_artifact` flag. Turns of `closed`/`expired` sessions MUST remain readable. Access MUST be scoped to the owning tenant (404 for other tenants' sessions).

#### Scenario: turns are paged by cursor
- **WHEN** a client requests `GET /v1/sessions/{sid}/turns?after_index=49&limit=50`
- **THEN** turns 50 onward are returned in ascending `turn_index` order

#### Scenario: closed session history is still readable
- **WHEN** a client requests turns of a `closed` session it owns
- **THEN** the persisted turn records are returned even though the session cannot be resumed

### Requirement: Switching MUST reuse the single WS admission path

Switching to a historical session MUST NOT introduce a dedicated activation endpoint. Connecting the target session's WebSocket MUST be the sole trigger: admission goes through the same pool `acquire` path as creation, and a COLD target is rehydrated (stage-in + `oh --resume`) before `session_ready` is emitted. The previously active same-tenant session, if idle and unattached, yields its slot per the admission rules in `interactive-session` and remains resumable from COLD.

#### Scenario: switch to a cold session under default quota
- **WHEN** a tenant with `tenant_max_concurrent=1` has session A in `IDLE` with no WS attached and connects the WS of cold session B
- **THEN** A is evicted to `COLD` (snapshot preserved), B rehydrates via `--resume`, and the client receives `session_ready`

#### Scenario: switching back restores the yielded session
- **WHEN** the tenant later connects the WS of session A (now `COLD`)
- **THEN** A rehydrates with its prior context and B yields per the same rules

### Requirement: Frontend contract MUST use business fields decoupled from the internal status enum

Clients MUST be able to decide "can switch back" / "view only" solely from `resumable` and `read_only`, without interpreting the internal status enum. The mapping MUST be centralized in one backend helper: `read_only = status in (closed, expired)`; `resumable = not read_only` AND, for `cold`/`failed` sessions, the snapshot presence check (`session-tenant-isolation`) passes. A `cold` session with `turn_count == 0` and no snapshot MUST report `resumable=true` (rehydrate falls back to a fresh spawn since there is no context to lose). Adding internal states in the future MUST NOT break this contract.

#### Scenario: cold session without a recoverable snapshot is not resumable
- **WHEN** a `cold` session with `turn_count > 0` has no snapshot in local staging nor in the tenant bucket
- **THEN** the list reports `resumable=false` and `read_only=false` for it

#### Scenario: failed session with a snapshot is resumable
- **WHEN** a `failed` session has a recoverable snapshot
- **THEN** the list reports `resumable=true`

### Requirement: WS admission failures MUST be machine-parseable

Admission failures on WebSocket connect MUST close with a distinct code and a machine-parseable reason constant, preceded by a structured error frame `{"type": "error", "code": "<constant>", "message": "<human readable>"}`: `4430` / `TENANT_QUOTA_EXCEEDED` when the tenant quota is still exceeded after the same-tenant eviction attempt; `4503` / `CAPACITY_FULL` on node capacity, queue-full, or queue-timeout; `4500` / `SESSION_UNAVAILABLE` for other admission or rehydration failures. Exception handling MUST match the quota subclass before the generic pool admission base class. Internal eviction errors MUST NOT leak to the client.

#### Scenario: quota still exceeded after eviction attempt
- **WHEN** a tenant at quota connects a cold session's WS and no same-tenant candidate can yield (all busy or attached)
- **THEN** the client receives an error frame with `code="TENANT_QUOTA_EXCEEDED"` and the socket closes with `4430` and reason `TENANT_QUOTA_EXCEEDED`

#### Scenario: node capacity exhaustion is distinguishable
- **WHEN** admission fails because the node is full or the queue times out
- **THEN** the socket closes with `4503` / `CAPACITY_FULL`, not `4500`
