# session-pool-scheduling Specification

**Component:** `session-service/`
**Established by change:** `session-container-pool-multitenancy` (2026-07-29)

## Purpose
池化调度：以 `ContainerPool.acquire/release` 收敛「取得一个可用后端」的全部准入逻辑（租户配额 → 节点容量 → LRU 驱逐 → 有界公平队列），并暴露池状态指标。接口为变体 A（预热池）预留唯一替换点。准入次序与队列语义的规范性要求定义在 `interactive-session` 的「Resource limits」需求（本变更 MODIFIED）；本 capability 约束调度器自身的结构与可观测性。

## Requirements

### Requirement: Slot acquisition MUST be encapsulated behind a pool interface

All paths that need a live backend (session creation and COLD → LIVE rehydration) MUST acquire it through a single pool interface (`acquire(tenant_id, sid) -> BackendRuntime` / `release(sid)`); routers and the supervisor MUST NOT implement admission logic inline. The admission sequence and queue behavior follow the `interactive-session` resource-limits requirement. The pool MUST be the single point where a future warm-pool (Variant A) implementation can be substituted without touching admission, lifecycle, or protocol layers.

#### Scenario: create and resume share one admission path
- **WHEN** a new session is created and a cold session is rehydrated concurrently under capacity pressure
- **THEN** both go through the same acquire path and are subject to the same quota/capacity/eviction/queue rules

### Requirement: Queue waiting MUST be observable and bounded end-to-end

The pool MUST expose Prometheus metrics: live backend count, current queue depth, queue wait time histogram, evictions total, and admission rejections total labeled by reason (`tenant_quota`, `queue_full`, `queue_timeout`). Session creation duration MUST be observable (histogram) so cold-start latency can be evaluated against the Variant A trigger threshold.

#### Scenario: pool state is visible on /metrics
- **WHEN** sessions are queued, evicted, and rejected under load
- **THEN** `/metrics` reports queue depth, wait-time histogram, eviction and per-reason rejection counters consistent with the observed behavior

#### Scenario: cold-start latency is measurable
- **WHEN** sessions are created in `container` runtime
- **THEN** a creation-duration histogram is recorded, allowing P95 evaluation without extra instrumentation

### Requirement: Tenant-quota eviction MUST be a supervisor-injected hook with truthful results

The pool MUST NOT implement tenant-eviction policy inline: on a tenant-quota miss, `acquire` MUST invoke a supervisor-injected `evict_tenant_idle(tenant_id) -> bool` hook and retry the claim only when the hook reports `True`, bounded by the same eviction-attempt limit as capacity eviction. A `False` result (no candidate, re-entrant skip, or an internal eviction failure caught and logged by the hook) MUST route the request to the existing rejection/queue path without leaking internal exceptions. Check-and-claim critical sections MUST remain free of awaits (hook invocation happens outside them), preserving event-loop atomicity.

#### Scenario: hook success leads to claim retry
- **WHEN** a claim fails on tenant quota and the hook evicts an idle same-tenant session
- **THEN** the claim is retried and succeeds within the eviction-attempt bound

#### Scenario: hook failure falls back to the existing rejection path
- **WHEN** the hook returns `False` because eviction raised internally
- **THEN** `acquire` raises `TenantQuotaExceeded` (or queues) exactly as if no candidate existed, and the internal error is only logged

#### Scenario: eviction retry cannot loop unbounded
- **WHEN** the hook keeps reporting `True` but the freed slot is claimed by competing requests
- **THEN** the acquire gives up after the shared eviction-attempt limit instead of retrying indefinitely

### Requirement: 进程内单例调度 MUST 由单 worker 承载
由于 `SessionSupervisor`、`ContainerPool`、`SessionRegistry` 为进程内单例（内存态 live 会话、准入队列、审批 future），系统 SHALL 在启动期强制 `api_workers == 1`，配置为其它值时 SHALL fail-fast 并提示应通过多节点亲和（`OH_NODE_ID` + Redis 路由表）水平扩展，而非多 worker。（Established by change: `fix-session-review-2026-07`）

#### Scenario: 单 worker 正常启动
- **WHEN** `api_workers == 1`（默认）
- **THEN** 应用正常启动

#### Scenario: 多 worker 配置被拒
- **WHEN** 配置 `api_workers > 1`（如 `OH_API_WORKERS=2`）
- **THEN** 应用启动期抛出错误并终止，错误信息指向多节点水平扩展路径
