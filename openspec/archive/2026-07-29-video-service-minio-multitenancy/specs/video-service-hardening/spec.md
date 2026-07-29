# Delta: video-service-hardening（多租户条文按 rev1 裁决落实/修订 R10/R14/R15/R16/R18）

## MODIFIED Requirements

### Requirement: R10 — Object storage abstraction with presigned URLs

`VideoStorage` MUST support `presigned_url(key, expires) -> str | None`. A new
`S3VideoStorage` MUST implement `save`/`open`/`delete`/`exists`/`presigned_url`;
`LocalVideoStorage.presigned_url` MUST return `None` (caller falls back to streaming).

存储接口 MUST 按完整对象 key 操作：`save` 的签名 MUST 为 `save(key, src)`（key 由调用方经单点函数生成，产物 key MUST 带租户前缀 `tenants/{tenant_id}/videos/`，见 `video-tenant-storage` 能力）。下载与删除路径 MUST 按任务行记录的 `storage_kind` 解析后端（行自描述），MUST NOT 硬编码具体后端实现。

#### Scenario: S3 storage implements all methods
- GIVEN `S3VideoStorage`
- WHEN `delete` / `exists` / `presigned_url` are called
- THEN all are implemented (no `AttributeError` from `cleanup_expired_tasks`)

#### Scenario: local storage returns None for presigned
- GIVEN `LocalVideoStorage`
- WHEN `presigned_url` is called
- THEN it returns `None` and the API falls back to streaming

#### Scenario: 保存与删除按 key/行后端解析
- **WHEN** worker 以 `save(key, src)` 保存产物、清理任务对 `storage_kind='s3'` 的行执行删除
- **THEN** 保存后端由 `settings.storage_kind` 决定、删除后端由任务行 `storage_kind` 决定，均不出现硬编码 `LocalVideoStorage()`

### Requirement: R14 — Tenant isolation

All video-task operations on the existing five endpoints (create / get / download /
events / delete) MUST be scoped to the caller's `tenant_id`. `video_tasks` MUST carry a
`tenant_id` column (`NOT NULL DEFAULT 'default'`, indexed by `(tenant_id, created_at)`,
existing rows backfilled to `'default'`). A request MUST NOT be able to read or mutate a
task owned by a different tenant; cross-tenant access MUST be rejected with a uniform
**`404`** (never `403`, to avoid revealing existence). `idempotency_key` uniqueness MUST
be per-tenant: `UNIQUE (tenant_id, idempotency_key)`; idempotent-create lookup MUST filter
by the caller's `tenant_id`. Isolation MUST be implemented via query-level scoping
(`WHERE tenant_id = :caller_tenant` through a single shared helper); RLS is explicitly NOT
used. A future list endpoint, when added, MUST apply the same tenant scoping.

#### Scenario: cross-tenant task is invisible
- GIVEN tenant A owns task `t1` and tenant B presents a valid API key
- WHEN tenant B calls `GET /v1/videos/t1`
- THEN the response is `404` and no task data is returned

#### Scenario: cross-tenant delete is rejected
- GIVEN tenant A owns task `t1`
- WHEN tenant B calls `DELETE /v1/videos/t1`
- THEN the response is `404` and the task is unchanged

#### Scenario: cross-tenant list is scoped
- GIVEN tenant A owns `t1` and tenant B owns `t2`
- WHEN tenant B calls `GET /v1/videos` (list, once such an endpoint exists)
- THEN the response contains only tenant B's tasks (no `t1`) and no task data from other tenants

#### Scenario: 幂等键租户内唯一
- **WHEN** 租户 A 与租户 B 先后以同一 `idempotency_key` 各自创建任务
- **THEN** 两个任务均创建成功互不影响；同一租户内重复提交同键则返回既有任务

### Requirement: R15 — API Key authentication

The API key (via the `X-API-Key` header) MUST be resolved to a `tenant_id` in three
ordered steps sharing a single resolution function: (1) open mode — no
`settings.api_key` configured and the `api_keys` table is empty → `tenant_id='default'`
(backward compatible); (2) the key matches `settings.api_key` (constant-time compare) →
`tenant_id='default'`; (3) `sha256(key)` hashed lookup in the `api_keys` table
(`active=true` only) → that row's `tenant_id`. A missing, invalid, or deactivated key
(when auth is in effect) MUST be rejected with `401`. The `api_keys` table
(`id/key_hash/tenant_id/label/active/created_at`) is shared with session-service in the
same database; its migration MUST be idempotent (skip creation when the table already
exists). Lookup results MAY be cached in-process with a TTL (`OH_APIKEY_CACHE_TTL`,
default 60s). `GET /v1/videos/{id}/file` and `GET /v1/videos/{id}/events` MUST
additionally accept the key via the `?api_key=` query parameter (browser
EventSource/download cannot set custom headers); all other endpoints remain header-only.
The resolved `tenant_id` MUST be derived solely from the credential; a self-reported
header (e.g. `X-User-Id`) MUST NOT be trusted as tenant identity.

#### Scenario: missing key is rejected
- GIVEN a request with no `X-API-Key` while auth is in effect
- WHEN any protected endpoint is called
- THEN the response is `401`

#### Scenario: revoked key is rejected
- GIVEN an API key with `active=false` in the `api_keys` table
- WHEN a request presents it
- THEN the response is `401`

#### Scenario: 多 key 解析到各自租户
- **WHEN** 两个 `api_keys` 行分别属于租户 A/B，各自持 key 调用 API
- **THEN** 请求分别以 `tenant_id=A`/`tenant_id=B` 执行，换 key 即切换租户

#### Scenario: 单 key/开放模式兼容
- **WHEN** 部署仅配置 `OH_API_KEY`（或完全未配置且表空）
- **THEN** 请求解析为 `tenant_id='default'`，现有行为与存量测试不变

#### Scenario: file/events 支持查询参数回退
- **WHEN** 浏览器以 `GET /v1/videos/{id}/events?api_key=<key>` 建立 SSE 连接
- **THEN** 该 key 按与请求头相同的三段式规则解析并通过鉴权

### Requirement: R16 — Per-tenant quota

Each tenant MUST have an active-task quota: `tenant_max_active` (default 4), counting
tasks in QUEUED + RUNNING states. A submission that would exceed the limit MUST be
rejected with `429` and no task created. The count check MAY be non-strongly-consistent
(a transient overshoot of one or two tasks under concurrent submission is acceptable; no
locking is introduced). The former `daily_submit_limit` is removed from this requirement
(never implemented; to be re-proposed separately if needed).

#### Scenario: concurrent quota exceeded
- GIVEN tenant T already has `tenant_max_active` tasks in QUEUED/RUNNING
- WHEN T submits a new task
- THEN the response is `429` and no task is created

#### Scenario: 配额随任务终结释放
- **WHEN** 租户 T 的一个 RUNNING 任务进入终态后 T 再次提交
- **THEN** 提交成功（活跃计数已低于 `tenant_max_active`）

### Requirement: R18 — Per-tenant rate limiting

The `POST /v1/videos` token-bucket rate limiter MUST key on the caller's `tenant_id`
(resolved per R15) instead of the client IP. For the `default` tenant (open mode /
single-key mode) the limiter MUST fall back to the client-IP key, preserving current
behavior for existing deployments. A tenant exceeding its rate MUST receive `429`.
Redis unavailability keeps the existing fail-open behavior.

#### Scenario: rate limit tripped
- GIVEN tenant T's token bucket is exhausted
- WHEN T issues further `POST /v1/videos` requests within the window
- THEN the excess requests receive `429`

#### Scenario: 租户间限流互不影响
- **WHEN** 租户 A 打满自身令牌桶后，租户 B 提交任务
- **THEN** 租户 B 不受影响正常创建（各租户独立桶）

#### Scenario: default 租户回退 IP 键
- **WHEN** 开放/单 key 部署（tenant_id='default'）下不同 IP 的客户端提交任务
- **THEN** 限流按客户端 IP 分桶，与改造前语义一致
