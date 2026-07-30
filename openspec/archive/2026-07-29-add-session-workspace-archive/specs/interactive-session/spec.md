# interactive-session Delta Specification

## MODIFIED Requirements

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
