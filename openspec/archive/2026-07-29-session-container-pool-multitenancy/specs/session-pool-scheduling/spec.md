# session-pool-scheduling Specification

## Purpose
池化调度：以 `ContainerPool.acquire/release` 收敛「取得一个可用后端」的全部准入逻辑（租户配额 → 节点容量 → LRU 驱逐 → 有界公平队列），并暴露池状态指标。接口为变体 A（预热池）预留唯一替换点。准入次序与队列语义的规范性要求定义在 `interactive-session` 的「Resource limits」需求（本变更 MODIFIED）；本 capability 约束调度器自身的结构与可观测性。

## ADDED Requirements

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
