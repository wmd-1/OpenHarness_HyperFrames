# session-pool-scheduling Delta Specification

## ADDED Requirements

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
