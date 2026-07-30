# session-tenant-isolation Delta Specification

## MODIFIED Requirements

### Requirement: A per-tenant MinIO prefix MUST be the sole authoritative store for tenant data

All OpenHarness persistent state for a tenant MUST be authoritatively stored under the object prefix `tenants/{tenant_id}/` in a configurable MinIO (S3-compatible) bucket (`OH_MINIO_ENDPOINT` / `OH_MINIO_ACCESS_KEY` / `OH_MINIO_SECRET_KEY` / `OH_MINIO_BUCKET`, bucket default `oh-tenants`), with the layout: `openharness/` (the tenant's full `~/.openharness` — `settings.json` plus `data/{memory,agent-memory,sessions,...}`), `rules/` (tenant-supplied rule/document files) and `workspaces/` (per-session workspace archives — `{session_id}/manifest.json` plus `{session_id}/files/**`, governed by `session-workspace-archive`). The node-local staging directory `{tenants_root}/{tenant_id}/` (`OH_TENANTS_ROOT`, default `/tenants`) MUST be a disposable cache: deleting it while the tenant has no live session MUST NOT lose any data that has been staged out.

#### Scenario: staging is disposable and rebuilt from MinIO
- **WHEN** a tenant's local staging directory is wiped while the tenant has no live session, and a new session is then created
- **THEN** the session observes the tenant's settings, agent memory, and snapshots exactly as last staged out to MinIO

#### Scenario: tenant offboarding is a single-prefix removal
- **WHEN** an operator deletes the `tenants/{tenant_id}/` object prefix from the bucket
- **THEN** no authoritative trace of that tenant's memory, settings, or snapshots remains (local staging is a cache and is reclaimed by normal cleanup), and all of the tenant's workspace archives are removed with no extra step
