# session-tenant-isolation Delta Specification

## ADDED Requirements

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
