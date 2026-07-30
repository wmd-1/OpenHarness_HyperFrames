# session-workspace-archive Specification

**Component:** `session-service/`
**Established by change:** `add-session-workspace-archive` (2026-07-29)

## Purpose
会话工作目录（`/workspaces/{sid}`）的 MinIO 归档：文件本体（`files/`）与索引清单（`manifest.json`，记录用户/租户 id、session id、每个文件的存储地址与 sync 元数据）分开存放于 `tenants/{tenant_id}/workspaces/{session_id}/` 前缀。stage-out 挂接四个生命周期钩子（turn 完成为 per-session 单 worker + debounce，绝不阻塞会话）；stage-in 在 rehydrate/重建的后端 spawn 前恢复文件；删除传播采用版本优先的 tombstone 语义；close 后归档保留，closed/expired 会话文件仍可经租户级只读文件 API 列表与下载。`OH_MINIO_ENDPOINT` 未配置时整体退化为 no-op。

## Requirements


### Requirement: Session workspaces MUST be archived under a per-session MinIO prefix with a manifest index

Workspace files of a session MUST be archived to the object prefix `tenants/{tenant_id}/workspaces/{session_id}/` in the tenant bucket, with file bodies stored under `files/` (mirroring workspace-relative paths) **separately** from the index object `manifest.json`. The manifest MUST record: `schema_version`, `tenant_id` (user id), `session_id`, `oh_session_id`, `files_prefix` (the bucket-internal storage address of the file bodies), `bucket`, sync metadata (`sync_seq` monotonically incremented per successful stage-out, `last_synced_at`, `node_id`, `sync_state`), `total_files`, `total_bytes`, a `files[]` list (`path`, `size`, `mtime`, `etag`, `last_seen_sync_seq` — the sync round in which the file was last uploaded or confirmed present), a `skipped[]` list (`path`, `reason`) and a `deleted[]` tombstone list (`path`, `deleted_seq`, `deleted_at`). The prefix MUST be generated in a single helper from a validated `tenant_id` and the server-generated session UUID; workspace-relative paths MUST be rejected if they escape the workspace root. The manifest MUST be written only **after** all file uploads of that sync round succeed and MUST always carry `sync_state="complete"` — no intermediate manifest state is ever stored, and readers MUST only trust a `complete` manifest. Each sync round MUST write a `sync.inprogress.json` marker (attempted `sync_seq`, `started_at`, `node_id`) before uploading and delete it after the manifest write, so an interrupted round is explicitly detectable and its leftover objects are reclaimable garbage.

#### Scenario: manifest indexes user, session, and file location
- **WHEN** a session of tenant `acme` completes a stage-out
- **THEN** `tenants/acme/workspaces/{sid}/manifest.json` exists, carrying `tenant_id="acme"`, the session id, `files_prefix="tenants/acme/workspaces/{sid}/files/"`, and one `files[]` entry per archived file

#### Scenario: manifest is written after the files it references
- **WHEN** a stage-out round uploads changed files and then rewrites the manifest
- **THEN** at no point does the stored manifest reference an object that has not been uploaded, and `sync_seq` increases by one with `last_synced_at` updated and `sync_state="complete"`

#### Scenario: interrupted round leaves the previous snapshot readable
- **WHEN** a stage-out round fails after uploading some files but before the manifest write
- **THEN** the stored manifest is still the previous `complete` one, the `sync.inprogress.json` marker remains as evidence, and the next successful round (or the prune script) reclaims the marker and any objects not referenced by the manifest

#### Scenario: per-tenant enumeration of session archives
- **WHEN** an operator lists objects under `tenants/{tid}/workspaces/`
- **THEN** every archived session of that tenant appears as a `{session_id}/manifest.json` entry

### Requirement: Workspace stage-out MUST run at the four lifecycle hooks without blocking the session lifecycle

Workspace archiving MUST reuse the four existing stage-out hooks. At hook (1) turn completion, the sync MUST run through a per-session background worker started only **after** the turn row is persisted and the `turn_completed` WS frame is emitted, and MUST NOT delay the turn result or the WebSocket response; at most one sync worker MAY exist per session at any time, and repeated triggers MUST only mark a dirty flag that the worker coalesces (after a configurable debounce, `OH_WORKSPACE_SYNC_DEBOUNCE_MS`) into a single latest sync round. Session close/destroy MUST follow a strict ordering: (a) set a closing flag so new dirty marks are rejected, (b) await the existing worker's exit, (c) run the final stage-out under the per-session lock — so the final manifest carries the highest `sync_seq` and can never be overwritten by a stale background round — and (d) only then remove the local workspace. At hooks (2) IDLE→COLD eviction, (3) close/DELETE (before local workspace removal) and (4) orphan reclamation, the sync MUST be awaited. Each round MUST first fetch the remote manifest and rebase its diff baseline if the remote `sync_seq` has advanced. Uploads MUST be incremental (comparing local `size`+`mtime` against the manifest baseline) and MUST NOT follow symlinks. Local deletions MUST be propagated as `deleted[]` tombstones (`path`, `deleted_seq`, `deleted_at`) alongside object removal. Tombstone resolution MUST be version-first, not clock-first: each node records the last manifest `sync_seq` it observed (its base sequence, kept in a local sidecar state file that is never archived); a locally present file whose path is tombstoned MUST be re-uploaded (with the tombstone removed) only when the node's base sequence is at least `deleted_seq` — i.e. the file reappeared after the node learned of the deletion; when the base sequence predates `deleted_seq` the copy is stale and MUST NOT be re-uploaded; the mtime-vs-`deleted_at` comparison MAY be used only as a logged fallback when no base-sequence information exists. Tombstones expire after `OH_WORKSPACE_TOMBSTONE_RETENTION_DAYS`. All stage-in/stage-out of one session MUST be serialized through a per-session lock; archiving MUST NOT take the per-tenant sync lock of `session-tenant-isolation`. Failures MUST be retried with exponential backoff, then surfaced via an `oh_workspace_sync_failures_total` metric and a warning — a failed sync MUST NOT fail the turn, eviction, close, or reclamation that triggered it. The bounded loss window is the file delta of at most one in-flight turn (SLO).

#### Scenario: slow archiving does not delay turn completion
- **WHEN** workspace stage-out is artificially slow and a turn completes
- **THEN** the `turn_completed` frame is delivered without waiting for the sync, which finishes in the background

#### Scenario: concurrent triggers coalesce into a single worker
- **WHEN** several stage-outs are triggered in quick succession for the same session
- **THEN** at most one sync worker runs, the dirty flags coalesce into a single follow-up round after the debounce, and no parallel upload starts

#### Scenario: incremental upload transfers only changes
- **WHEN** one file changed since the last successful stage-out
- **THEN** only that file is uploaded and locally deleted files are removed from the `files/` prefix with tombstones recorded in `deleted[]`

#### Scenario: a deleted file is not resurrected by a stale node
- **WHEN** a file was deleted and tombstoned by one node, and another node whose base sequence predates `deleted_seq` still holds a local copy (even one with an anomalous future mtime) and runs a stage-out
- **THEN** the stale copy is not re-uploaded; only a file present after the node has observed the deletion (base sequence ≥ `deleted_seq`) is uploaded again with its tombstone removed

#### Scenario: close ordering prevents a stale manifest overwrite
- **WHEN** a session is closed while its background sync worker is mid-round
- **THEN** new dirty marks are rejected, the worker is awaited, the final stage-out then writes the manifest with the highest `sync_seq`, and only afterwards is the local workspace removed

#### Scenario: a large same-tenant workspace does not block another session
- **WHEN** session A of a tenant is uploading a large workspace and session B of the same tenant runs a stage-out
- **THEN** B's sync proceeds without waiting for A (per-session locks, disjoint prefixes)

#### Scenario: sync failure never breaks the lifecycle
- **WHEN** MinIO is unreachable during any hook's stage-out
- **THEN** the triggering lifecycle operation completes normally and `oh_workspace_sync_failures_total` is incremented

### Requirement: Exclusion rules and size limits MUST bound the archive, with skipped files recorded

Archiving MUST honor a configurable ignore list (`OH_WORKSPACE_SYNC_IGNORE`, default covering `node_modules/`, `.venv/`, `__pycache__/`, `.git/`, `.cache/`, `tmp/`), a per-file size cap (`OH_WORKSPACE_SYNC_MAX_FILE_MB`, default 512) and a per-session total cap (`OH_WORKSPACE_SYNC_MAX_TOTAL_MB`, default 2048; newest-first when over budget). Every file excluded by rule or cap MUST be recorded in the manifest's `skipped[]` with a machine-readable reason — files MUST NOT silently disappear from the index.

#### Scenario: oversized file is skipped but the turn completes
- **WHEN** a turn produces a file exceeding the per-file cap
- **THEN** the turn completes normally, the file is not uploaded, and the manifest records it under `skipped` with reason `file_too_large`

### Requirement: Workspace stage-in MUST restore missing files before the backend starts

On rehydration or recreation of a session whose workspace may be missing locally (container switch, cross-node resume, node rebuild), the gateway MUST run workspace stage-in **after** creating the workspace directory and **before** the backend process/container is spawned, so archived files are in place before OpenHarness writes any working file. The restore rule MUST be a per-file state comparison against the `complete` manifest — the check MUST rely neither on the directory being empty nor on mere local existence: a file absent locally MUST be downloaded; a local file whose `size`+`mtime` (and `etag` when verifiable) match the manifest entry MUST be skipped; a mismatched local file MUST be resolved by mtime last-writer-wins (local newer than the manifest entry → keep local; otherwise the archived copy overwrites it), and every conflict with its resolution MUST be logged. Tombstone resolution MUST run **before** the per-file comparison and MUST use the node's **pre-stage-in** base sequence: tombstoned paths MUST NOT be downloaded and MUST NOT enter the LWW comparison; a local residual at a tombstoned path whose pre-stage-in base sequence predates `deleted_seq` MUST be deleted locally (propagating the deletion), so that advancing the base sequence at the end of stage-in cannot turn a stale residual — even one with an anomalous future mtime — into a false recreation; a residual observed with a base sequence at or above `deleted_seq` is kept as a genuine recreation. Downloaded files MUST have their local mtime aligned to the manifest value so repeated stage-ins and later incremental compares are idempotent, and a successful stage-in MUST record the manifest's `sync_seq` as the node's base sequence for later tombstone resolution. Stage-in failures are best-effort: the session MUST still resume (with a warning), in contrast to the fail-fast tenant-data stage-in.

#### Scenario: cleared workspace is restored before spawn
- **WHEN** a COLD session is rehydrated on a node where its workspace directory was wiped
- **THEN** the archived files are downloaded before the backend starts, and the resumed session sees them from its first turn

#### Scenario: initialization files do not defeat restore
- **WHEN** the workspace directory already contains freshly-created initialization files but lacks archived files
- **THEN** stage-in still downloads the missing archived files, and a same-named local file only survives if it is newer than the archived entry — otherwise the archive overwrites it, with the conflict logged

#### Scenario: restore failure does not block resume
- **WHEN** MinIO is unreachable during workspace stage-in
- **THEN** the session resumes normally without the archived files and a warning is logged

#### Scenario: a stale residual cannot bypass deletion via a future mtime
- **WHEN** stage-in runs on a node whose pre-stage-in base sequence predates `deleted_seq` while a tombstoned path exists locally with an anomalously new mtime
- **THEN** the residual is deleted locally before the base sequence is advanced, it never enters the LWW comparison, and the following stage-out does not re-upload it

### Requirement: Workspace files MUST be readable through tenant-scoped read-only APIs, including for terminal sessions

The service MUST expose `GET /v1/sessions/{sid}/workspace/files` (listing) and `GET /v1/sessions/{sid}/workspace/files/{path}` (download), scoped to the owning tenant (404 for other tenants' sessions) and available for sessions in any state including `closed`/`expired`. The listing MUST declare its `source`: `live` (session LIVE/IDLE on this node — real-time local directory), `archive` (manifest-backed, carrying `last_synced_at` and `sync_seq`), or `none` (no archive and no local directory — empty list, not 404). When a session is LIVE/IDLE but served from the archive (e.g. live on another node), the response MUST set `stale=true` to signal a snapshot that may lag by at most one turn. The listing MUST accept `limit` (default 500), an opaque `page_token` and a `prefix` filter, and return `next_page_token` (null on the last page) for both sources, so the contract survives workspace file-count growth. Downloads MUST reject path traversal (`..`, absolute paths) with 400; archive downloads SHALL use a presigned redirect when a public endpoint is configured and otherwise stream through the gateway.

#### Scenario: closed session files remain viewable
- **WHEN** a tenant lists and downloads workspace files of its own `closed` session
- **THEN** the archived file list (source `archive`) and file bodies are returned even though the local workspace was removed

#### Scenario: cross-node live session is served from the archive with stale flag
- **WHEN** the target session is LIVE on another node and the file list is requested
- **THEN** the response has `source="archive"`, `stale=true`, and carries `last_synced_at`

#### Scenario: path traversal is rejected
- **WHEN** a download is requested with a path containing `..` or an absolute path
- **THEN** the response is 400 and no file content is returned

#### Scenario: cross-tenant access is invisible
- **WHEN** tenant B requests workspace files of tenant A's session
- **THEN** the response is 404

#### Scenario: listing paginates without gaps or duplicates
- **WHEN** a workspace listing is walked page by page with `limit` and the returned `page_token`s
- **THEN** every file appears exactly once and the last page carries `next_page_token=null`

### Requirement: Archiving MUST degrade to a no-op without MinIO and archives MUST be prunable by age

With `OH_MINIO_ENDPOINT` unset, all workspace stage-in/stage-out MUST be no-ops and the file APIs MUST serve only the `live`/`none` sources — existing single-node deployments and tests are unaffected. An operations script MUST support pruning archives older than a given age (judged by manifest `last_synced_at`, optionally per tenant), deleting file objects, the manifest, and any stale `sync.inprogress.json` markers or objects not referenced by the manifest; automatic TTL deletion MUST NOT run by default. Tenant offboarding (deleting `tenants/{tid}/`) removes all workspace archives with no extra step.

#### Scenario: disabled store keeps current behavior
- **WHEN** `OH_MINIO_ENDPOINT` is unset and sessions run through their full lifecycle
- **THEN** no MinIO calls are made and the file listing of a live session still works from the local directory

#### Scenario: retention script prunes old archives
- **WHEN** the prune script runs with `--older-than-days N`
- **THEN** archives whose `last_synced_at` is older are removed (files and manifest), newer archives are untouched
