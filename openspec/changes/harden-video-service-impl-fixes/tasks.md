# Implementation Tasks: Harden Video Service — Implementation Fixes (V3)

**Change ID:** `harden-video-service-impl-fixes`
**Source plan:** `plans/Backend_Hardening_Fix_Plan_V3_2026-07-21.md` (canonical TDD steps with full code, real line numbers, and real test fixtures live there — supersedes the earlier `Backend_Hardening_Fix_Plan_2026-07-21.md`)
**Spec delta:** `openspec/changes/harden-video-service-impl-fixes/specs/video-service-hardening/spec.md`

> Each task below mirrors a Task in the V3 fix plan. The plan holds the complete TDD steps (failing test → verify fail → implement → verify pass → commit) against the **current** `scale-multi-instance` code; this file tracks OpenSpec-level completion. Run the full suite after each task: `cd service && python -m pytest -q`.
>
> **Test-infra reality (do NOT use the old plan's fictional fixtures):** `service/tests/` has **no `conftest.py`**. Worker tests use `test_worker.py`'s `sync_db` + `_class_with`, driven via `generate_video_task.run(task_id=...)`. API tests use `test_videos_api.py`'s `client`/`db_session`/`setup_db`. Enqueue tests MUST patch `app.routers.videos.get_scheduler` (enqueue routes through the scheduler, **not** `generate_video_task.delay`).

---

## Phase 0: P0 — Double-render, state consistency, cancel reliability, auth floor

- [ ] 0.1 **X1 / L3** — Wire the already-defined `claim()` at the task entry (`tasks.py:248-270`); remove the unconditional `status=RUNNING`; skip the run when the atomic `UPDATE ... WHERE status IN (QUEUED,RETRYING)` loses the race. Migrate the 3 existing worker cases from `RUNNING` to `QUEUED`.
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Task entry MUST atomically claim before rendering"

- [ ] 0.2 **L1 / N18** — Add a **direct** test of the terminal-state CAS owner-fence (row + `worker_id`). CAS is already implemented in `tasks.py:111-193`; no implementation change — only close the false-confidence gap where `test_cancel_guard` never touched the guard.
  - Files: `tests/test_worker.py` (test only)
  - Spec: refines ADDED "Terminal-state writes MUST be conditional (CAS)"

- [ ] 0.3 **N3 / X4** — `_abort_requested` falls back to the DB (`status==CANCELED` or `cancellation_requested`) when Redis is unavailable; add `select` import.
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Cancellation signal MUST have a DB fallback"

- [ ] 0.4 **N1** — `create_video` wraps `get_scheduler().enqueue(...)` in try/except; on failure marks the task `FAILED` and returns `503`; add module `logger`.
  - Files: `app/routers/videos.py`, `tests/test_videos_api.py`
  - Spec: ADDED "Enqueue failure MUST NOT orphan a QUEUED task"

- [ ] 0.5 **S1 / S2** — `require_auth` config (default `False`) + `_assert_auth_config` boot check + constant-time `compare_digest`; middleware always registered.
  - Files: `app/main.py`, `app/config.py`, `tests/test_api_edge.py`
  - Spec: ADDED "Auth MUST be enforceable and constant-time" (full R14 tenant isolation deferred to Phase 4)

**Quality Gate (Phase 0):**
- [ ] `pytest tests/test_worker.py tests/test_videos_api.py tests/test_api_edge.py -v` passes
- [ ] A redelivered/reclaimed task owned by another worker does NOT re-render (X1)
- [ ] The CAS owner-fence is verified by a direct `_mark_*` test on a non-RUNNING / stale-owner row (not a pre-set abort flag)
- [ ] Enqueue-failure test patches `get_scheduler` and asserts `FAILED` + `503`

---

## Phase 1: P1 — State machine, Redis memory, rate limit, retry, S3 OOM

- [ ] 1.1 **N2** — `delete_video` preserves terminal status (`SUCCEEDED`/`FAILED`/`CANCELED`), clears only resources (`videos.py:360-381`); does NOT rewrite to `CANCELED`.
  - Files: `app/routers/videos.py`, `tests/test_videos_api.py`
  - Spec: ADDED "DELETE on a terminal task MUST preserve its status"

- [ ] 1.2 **P1 / P2 / N14** — `XADD MAXLEN ~ _LOG_CAP approximate` in `_append_log`; tail read via bounded `XREVRANGE` in `_update_log_tail`; circuit-break log push on repeated Redis failure (`_log_push_failed`).
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: MODIFIED "Log appending MUST reuse a pool AND bound the stream" + ADDED circuit-break clause

- [ ] 1.3 **S3** — Redis token-bucket rate limiter (fail-open) on `POST /v1/videos`, keyed by client IP; module-level `_limiter`; config knobs.
  - Files: `app/ratelimit.py` (new), `app/routers/videos.py`, `app/config.py`, `tests/test_ratelimit.py` (new)
  - Spec: ADDED "Task creation MUST be rate-limited (global floor)"

- [ ] 1.4 **L2** — Classify `OperationalError` / Redis `ConnectionError`/`TimeoutError` as `TransientError` to trigger `autoretry_for`/backoff; non-transient still `FAILED`.
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Transient infrastructure errors MUST trigger Celery retry"

- [ ] 1.5 **X2** — S3 `save` uses `upload_fileobj` (multipart streaming); `open` returns boto3 `StreamingBody` instead of buffering the whole object into `BytesIO`.
  - Files: `app/storage/s3.py`, `tests/test_s3_storage.py` (new)
  - Spec: ADDED "S3 storage MUST stream uploads/downloads (no full-object buffering)"

**Quality Gate (Phase 1):**
- [ ] `pytest tests/test_ratelimit.py tests/test_worker.py tests/test_videos_api.py tests/test_s3_storage.py -v` passes
- [ ] Log stream stays bounded under heavy logging; DELETE keeps terminal status
- [ ] S3 `open`/`save` never read the full object into memory

---

## Phase 2: P2 — SSE async, input hardening, index, stdout cap, secrets, concurrency

- [ ] 2.1 **P3 / N4** — SSE (`video_events`) uses `redis.asyncio`; injects `db` and returns `404` for unknown task; no thread-pool occupancy.
  - Files: `app/routers/videos.py`, `tests/test_videos_api.py`
  - Spec: ADDED "SSE endpoint MUST use async Redis and validate task existence"

- [ ] 2.2 **N5 / N17 / S4** — `idempotency_key max_length=256`, `extra_oh_args max_length=50`; `vet_extra_oh_args` also validates flag **values** (length + shell-metachar rejection).
  - Files: `app/schemas.py`, `app/security.py`, `tests/test_security.py` (new), `tests/test_videos_api.py`
  - Spec: ADDED "Request input fields MUST be length-validated"; MODIFIED "`extra_oh_args` MUST be allowlisted AND value-validated"

- [ ] 2.3 **N6** — Alembic **migration 004** adding `(created_at, status)` composite index; declare on the model. Confirm real `003` head via `alembic heads` before setting `down_revision`.
  - Files: `alembic/versions/004_task_list_index.py` (new), `app/models.py`
  - Spec: supports "list/cleanup queries MUST be index-backed" (perf)

- [ ] 2.4 **N7 / N8 / N12** — `runner.py`: cap accumulated stdout (~1 MB, truncation marker), replace `preexec_fn=os.setsid` with `start_new_session=True`, add `RunResult.timed_out: bool`.
  - Files: `app/workers/runner.py`, `tests/test_runner.py` (new)
  - Spec: ADDED "Worker stdout MUST be capped"; ADDED "subprocess MUST use `start_new_session`"; ADDED "Timeout-kill MUST be distinguishable"

- [ ] 2.5 **N10 / N11 / S2** — `Settings.api_key: SecretStr | None`; `main.py` compares via `get_secret_value()`; remove `output_path`/`log_tail` from `VideoTaskResponse`.
  - Files: `app/config.py`, `app/main.py`, `app/schemas.py`, `tests/test_videos_api.py`, `tests/test_api_edge.py`
  - Spec: ADDED "API key MUST be a secret; responses MUST NOT leak internal paths"

- [ ] 2.6 **X3** — Drop the ineffective process-local `render_semaphore` (prefork makes it per-child); express single-worker concurrency via Celery `-c` + `prefetch=1`; document `max_concurrent_renders` as advisory.
  - Files: `app/workers/tasks.py`, `app/config.py`, `tests/test_worker.py`
  - Spec: ADDED "Render concurrency MUST NOT rely on a process-local semaphore"

**Quality Gate (Phase 2):**
- [ ] `pytest tests/ -v` passes (SSE 404, security, runner, s3 suites)
- [ ] SSE occupies no thread-pool slot; `repr(Settings)` does not leak the api key
- [ ] `output_path`/`log_tail` absent from task responses

---

## Phase 3: P3 — Robustness & polish

- [ ] 3.1 **X5 / X6** — Widen `STALE_AFTER` to ≥ `4 × HEARTBEAT_INTERVAL` (tolerate 3 missed beats); reclaim (`recover_lost_tasks`) re-enqueues via `get_scheduler().enqueue(..., priority=...)` instead of `delay()`.
  - Files: `app/workers/beat.py`, `tests/test_beat.py` (new)
  - Spec: ADDED "Reclaim MUST tolerate missed beats AND route through the scheduler"

- [ ] 3.2 **X7** — Worker subprocess calls `configure_logging()` in `worker_process_init`; task entry calls `bind_task_context(task_id, worker_id)` (removes the dead code).
  - Files: `app/workers/beat.py`, `app/workers/tasks.py`, `tests/test_observability.py` (new)
  - Spec: ADDED "Worker subprocess MUST configure structured logging"

- [ ] 3.3 **X8 / O1** — `_redis_ok` becomes async (`redis.asyncio` ping with timeout); `/healthz` stays `200` (liveness); `/readyz` returns `503` when Redis or S3/DB is down.
  - Files: `app/routers/health.py`, `tests/test_health.py` (new)
  - Spec: MODIFIED "/healthz→liveness; /readyz MUST return 503 when degraded"

- [ ] 3.4 **X9** — `ADD VALUE 'RETRYING'` runs outside a transaction and idempotently (`op.execute("COMMIT")` + `ADD VALUE IF NOT EXISTS`). Skip on environments that already ran 002.
  - Files: `alembic/versions/` (002 only if unpublished, else a new corrective migration)
  - Spec: ADDED "Enum-value migration MUST be transaction-safe"

- [ ] 3.5 **L5** — `Range: bytes=start-end` returns exactly `end-start+1` bytes (`206`, correct `Content-Range`/`Content-Length`); `_iterfile` bounded by length.
  - Files: `app/routers/videos.py`, `tests/test_videos_api.py`
  - Spec: ADDED "Range requests MUST honor the end byte"

- [ ] 3.6 **P4 / P5 / P6 / N13** — sync engine `pool_pre_ping=True`; eager workspace cleanup on terminal; batched, per-task-resilient 2.0-style `cleanup_expired_tasks`.
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Sync engine MUST pre_ping; cleanup MUST be batched + resilient + eager"

- [ ] 3.7 **N9** — `autodiscover_tasks(["app.workers"])` (package name) with the explicit `from app.workers import beat` import kept as belt-and-suspenders; assert `generate_video_task` is registered.
  - Files: `app/workers/celery_app.py`, `tests/`
  - Spec: ADDED "Celery MUST register the worker tasks"

- [ ] 3.8 **O2 / O3 / O4** — unify default DB host between `db_url`/`db_migration_url`; `fps = round(...)` (no truncation); scope `locate_output_file` fallback to the task workspace.
  - Files: `app/config.py`, `app/workers/parser.py`, `tests/test_parser.py` (new)
  - Spec: ADDED "Metadata polish — db host, fps precision, output-location fallback"

- [ ] 3.9 **N15 / N16** — coarsen watchdog abort-poll interval (2–5 s, configurable); drop the plaintext default password (require env or warn at startup).
  - Files: `app/workers/runner.py`, `app/config.py`
  - Spec: ADDED "Watchdog polling MUST be coarse; no plaintext default credentials"

> **L4** (`celery_task_id` persistence) is resolved inside Task 0.1: after `claim()` succeeds, the worker writes `celery_task_id=self.request.id`. No separate task.

**Quality Gate (Phase 3):**
- [ ] `pytest tests/ -v` passes end-to-end
- [ ] `/readyz` returns `503` when Redis/DB down; `/healthz` stays `200`
- [ ] Reclaim routes through the scheduler and preserves priority; successful task leaves no workspace on disk

---

## Phase 4: Structural upgrades — Out of Scope (separate changes)

Tracked for traceability only; NOT implemented here:

- **R14** tenant isolation (`tenant_id` column + query filtering + auth-context injection) — the auth work in Task 0.5 only reaches "enforceable auth + constant-time compare".
- **R15** per-tenant/OIDC auth, **R16** distributed hard concurrency cap (Redis semaphore, the X3 sequel), **R17** priority-queue e2e, **R18** Temporal scheduler landing, **R19** observability metrics/alerts, **R20** shared `conftest.py` e2e refactor.

> When these land, they will MODIFY the CAS guard (Task 0.2) to add `AND lease_token=:token`, and the cancel DB fallback (Task 0.3) will be subsumed by the lease/heartbeat reclaim.

---

## Completion Checklist

- [ ] All Phase 0–3 tasks complete
- [ ] Every surviving V1/V2 finding + X1–X9 maps to an ADDED/MODIFIED requirement with ≥1 passing GIVEN/WHEN/THEN test
- [ ] `claim()` wired at entry; double-render prevented (X1/L3)
- [ ] CAS owner-fence covered by a direct test (L1/N18)
- [ ] Enqueue tests patch `get_scheduler`; enqueue failure yields `FAILED` + `503`
- [ ] `cd service && python -m pytest -q` green with no regression after each task
- [ ] No `preexec_fn` in `runner.py`; `start_new_session=True` present; stdout capped
- [ ] `repr(Settings)` does not leak `api_key`; responses omit `output_path`/`log_tail`
- [ ] S3 `save`/`open` stream (no full-object buffering)
- [ ] `/readyz` 503 under degraded dependencies; `/healthz` 200 liveness
- [ ] New migrations start at **004**; X9 enum fix transaction-safe
- [ ] Documentation synced (this delta + `video-service-hardening.md` updated on archive)
- [ ] Ready for `/openspec-archive harden-video-service-impl-fixes`
