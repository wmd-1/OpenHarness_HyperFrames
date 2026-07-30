# session-tenant-isolation Specification

**Component:** `session-service/`
**Established by change:** `session-container-pool-multitenancy` (2026-07-29)

## Purpose
租户级数据隔离（rev2：MinIO 权威源）：租户数据的唯一权威源是 MinIO 对象存储中的按租户前缀（`tenants/{tenant_id}/`，`tenant_id` = 用户 id）；节点本地 `/tenants/{tenant_id}/` 降级为**可丢弃的暂存缓存**，由网关在会话生命周期内 stage-in/stage-out 同步，节点因此无状态。user-scope agent 记忆、settings、会话快照在**租户内共享、租户间不可见**；`rules/` 前缀内容注入会话工作区；会话删除时清理暂存与 bucket 痕迹；租户注销即删 bucket 前缀。process 与 container 两种运行时共用同一暂存布局（分别经环境变量注入 / 卷挂载生效）。

## Requirements

### Requirement: A per-tenant MinIO prefix MUST be the sole authoritative store for tenant data

All OpenHarness persistent state for a tenant MUST be authoritatively stored under the object prefix `tenants/{tenant_id}/` in a configurable MinIO (S3-compatible) bucket (`OH_MINIO_ENDPOINT` / `OH_MINIO_ACCESS_KEY` / `OH_MINIO_SECRET_KEY` / `OH_MINIO_BUCKET`, bucket default `oh-tenants`), with the layout: `openharness/` (the tenant's full `~/.openharness` — `settings.json` plus `data/{memory,agent-memory,sessions,...}`), `rules/` (tenant-supplied rule/document files) and `workspaces/` (per-session workspace archives — `{session_id}/manifest.json` plus `{session_id}/files/**`, governed by `session-workspace-archive`). The node-local staging directory `{tenants_root}/{tenant_id}/` (`OH_TENANTS_ROOT`, default `/tenants`) MUST be a disposable cache: deleting it while the tenant has no live session MUST NOT lose any data that has been staged out.

#### Scenario: staging is disposable and rebuilt from MinIO
- **WHEN** a tenant's local staging directory is wiped while the tenant has no live session, and a new session is then created
- **THEN** the session observes the tenant's settings, agent memory, and snapshots exactly as last staged out to MinIO

#### Scenario: tenant offboarding is a single-prefix removal
- **WHEN** an operator deletes the `tenants/{tenant_id}/` object prefix from the bucket
- **THEN** no authoritative trace of that tenant's memory, settings, or snapshots remains (local staging is a cache and is reclaimed by normal cleanup), and all of the tenant's workspace archives are removed with no extra step

### Requirement: Stage-in MUST populate the staging directory before a backend starts

On session creation and on COLD → LIVE rehydration, the gateway MUST mirror the `tenants/{tenant_id}/` prefix into the local staging directory (deleting local entries absent from the bucket) **before** the backend process/container starts, holding the per-tenant sync lock. If MinIO is unreachable, the request MUST fail fast with `503` and no session may start against a stale or empty cache.

#### Scenario: MinIO outage fails session creation fast
- **WHEN** MinIO is unreachable and a create-session request arrives
- **THEN** the response is `503` and no backend is started

#### Scenario: resume re-stages tenant data
- **WHEN** a `COLD` session is rehydrated on a node whose staging directory was cleared
- **THEN** stage-in restores the tenant prefix locally before `--resume` starts, and the session continues with its prior memory and snapshot

### Requirement: Stage-out MUST mirror staging back to MinIO at defined hooks

The gateway MUST mirror the tenant's staging directory back to the `tenants/{tenant_id}/` prefix (including deletion propagation) at four hooks: (1) turn completion, (2) IDLE → COLD eviction, (3) session close/DELETE, and (4) orphan reclamation. A failed stage-out MUST be retried with exponential backoff and surfaced via a `tenant_sync_failures_total` metric. The maximum loss window MUST be bounded by the memory delta of at most one in-flight turn (SLO).

#### Scenario: a completed turn's memory survives node loss
- **WHEN** a turn completes (triggering stage-out) and the node's staging volume is subsequently destroyed
- **THEN** a later session for the same tenant observes the memory written by that turn

#### Scenario: deletions propagate to the bucket
- **WHEN** the backend deletes a memory file locally and a stage-out hook runs
- **THEN** the corresponding object is removed from the tenant prefix, not resurrected by the next stage-in

### Requirement: A first-seen tenant MUST be seeded idempotently in the bucket

When a session is created for a `tenant_id` whose prefix does not exist in the bucket, the gateway MUST seed `tenants/{tenant_id}/openharness/settings.json` from a server-owned template, inside the per-tenant sync lock. Seeding MUST be idempotent (retries and races cannot corrupt or duplicate the seed). Tenants MUST NOT be able to influence the template content in this change.

#### Scenario: repeated first-create seeds exactly once
- **WHEN** the first create-session for a brand-new tenant is retried after a transient failure
- **THEN** the tenant prefix ends up with exactly one server-seeded `settings.json` and the session proceeds against it

### Requirement: The backend MUST be pointed at the staged tenant directory in both runtimes

In `process` runtime the gateway MUST inject `OPENHARNESS_CONFIG_DIR`/`OPENHARNESS_DATA_DIR` (resolving into `{tenants_root}/{tenant_id}/openharness/`) into the spawned `oh --backend-only` environment. In `container` runtime the gateway MUST bind-mount `{tenants_root}/{tenant_id}/openharness/` to `/root/.openharness` at container create time. Credentials (upstream LLM API keys) MUST NOT be stored in the bucket or the staging directory; they remain server-injected via environment.

#### Scenario: user-scope agent memory is isolated between tenants
- **WHEN** a session of tenant A writes user-scope agent memory (`data/agent-memory/{agent_type}/`) and tenant B then runs a session with the same agent type
- **THEN** tenant B's session cannot read tenant A's entries

#### Scenario: user-scope agent memory is shared within a tenant
- **WHEN** one session of tenant A writes user-scope agent memory, the session ends, and a later session of tenant A starts (possibly on another node)
- **THEN** the later session reads the memory written by the first, round-tripped through MinIO

#### Scenario: no credential material in bucket or staging
- **WHEN** inspecting the `tenants/{tenant_id}/` prefix and the local staging directory after sessions have run
- **THEN** no upstream API-key/credential material is present in any object or file

### Requirement: Per-tenant sync operations MUST be serialized

All stage-in and stage-out operations for one tenant MUST be serialized through a per-tenant lock, covering the session-handover window: a new session's stage-in MUST NOT begin until the previous session's final stage-out has completed. Combined with the tenant concurrency quota defaulting to one active session (see `interactive-session` resource limits), concurrent-write conflicts on the tenant prefix are eliminated by construction — no last-writer-wins or merge policy is required.

#### Scenario: back-to-back sessions hand over without loss
- **WHEN** a tenant closes a session and immediately creates a new one
- **THEN** the new session's stage-in waits for the old session's final stage-out and observes all data it wrote

### Requirement: Tenant rules MUST be injected into the session workspace

Objects under the `tenants/{tenant_id}/rules/` prefix, staged in locally, MUST be copied into the session workspace at session creation, at the location where OpenHarness discovers local rules, so the spawned agent loads them automatically. The copy MUST be per-session snapshot semantics (mutating the `rules/` prefix afterwards MUST NOT affect already-created sessions).

#### Scenario: a tenant rule file reaches the agent
- **WHEN** `tenants/{tid}/rules/style.md` exists in the bucket and a session is created
- **THEN** the file is present in the session workspace at the rules-discovery location before the first turn runs

### Requirement: Snapshot presence MUST be queryable for resumability decisions

The tenant store MUST expose `has_session_snapshot(tenant_id, oh_session_id) -> bool` to check whether a recoverable native snapshot exists for a session. The check MUST consult the node-local staging directory first (filesystem stat on `sessions/{oh_session_id}/` snapshot files — cheap), and only fall back to a tenant-bucket prefix query when the local staging copy is absent; when tenant staging is disabled the bucket query MUST be skipped. The result feeds the `resumable` business field (see `session-history-switch`) so the session list never advertises a session as resumable when no snapshot can be restored. A stage-out failure after eviction remains acceptable: the session still transitions to `COLD` because the local staging snapshot remains usable for a same-node resume.

#### Scenario: local staging snapshot short-circuits the check
- **WHEN** the snapshot exists in the node-local staging directory
- **THEN** the check returns `True` without querying the bucket

#### Scenario: bucket fallback covers cross-node resumes
- **WHEN** the local staging copy is absent but the tenant bucket holds the snapshot prefix
- **THEN** the check returns `True`

#### Scenario: missing snapshot marks the session not resumable
- **WHEN** neither local staging nor the bucket holds a snapshot for a `cold` session with prior turns
- **THEN** the check returns `False` and the session list reports `resumable=false`
