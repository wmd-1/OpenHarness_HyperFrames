# Implementation Tasks: Harden Video Service — Phase 1 Implementation Fixes

**Change ID:** `harden-video-service-impl-fixes`
**Source plan:** `plans/Backend_Hardening_Fix_Plan_2026-07-21.md` (canonical TDD steps with full code live there)
**Spec delta:** `openspec/changes/harden-video-service-impl-fixes/specs/video-service-hardening_delta.md`

> Each task below is the OpenSpec task-list mirror of the fix plan. The fix plan holds the complete TDD steps (failing test → verify fail → implement → verify pass → commit); this file tracks OpenSpec-level completion. Run the full suite after each task: `cd service && python -m pytest tests/ -v`.

---

## Phase 0: P0 — Safety Floor (auth, state consistency, cancel reliability)

- [ ] 0.1 **L1 / N18** — Guard terminal-state writes with conditional `UPDATE ... WHERE status='running'` (CAS) in `_mark_succeeded`/`_mark_failed`/`_mark_canceled`; return `bool`; fix misleading `test_cancel_guard` to cover the real TOCTOU race
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Terminal-state writes MUST be conditional (CAS)"

- [ ] 0.2 **N3** — `_abort_requested` falls back to DB `status='CANCELED'` when Redis is unavailable
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Cancellation signal MUST have a DB fallback"

- [ ] 0.3 **N1** — `create_video` wraps `delay()` in try/except; on failure marks task `FAILED` and returns `503` (no orphan `QUEUED`)
  - Files: `app/routers/videos.py`, `tests/test_videos_api.py`
  - Spec: ADDED "Enqueue failure MUST NOT orphan a QUEUED task"

- [ ] 0.4 **S1 / S2** — `require_auth` config + constant-time `compare_digest` + drop `?api_key=` query fallback
  - Files: `app/main.py`, `app/config.py`, `tests/test_api_edge.py`
  - Spec: supports R15 foundation (full R15 in `phase3-multitenancy-temporal-lease`)

**Quality Gate (Phase 0):**
- [ ] `pytest tests/test_worker.py tests/test_videos_api.py tests/test_api_edge.py -v` passes
- [ ] No regression in existing e2e (19/19)
- [ ] Conditional-UPDATE guard verified by a real TOCTOU test (not a pre-set abort flag)

---

## Phase 1: P1 — Startup, semantics, resource caps, retry

- [ ] 1.1 **N9** — Fix `autodiscover_tasks(["app.workers.tasks"])` → `["app.workers"]` (+ explicit import belt-and-suspenders); verify via `celery ... inspect registered`
  - Files: `app/workers/celery_app.py`
  - Spec: ADDED "Celery MUST actually register the worker tasks"

- [ ] 1.2 **N2** — `delete_video` preserves terminal status, clears only resources; `VideoDeleteResponse.deleted: bool`
  - Files: `app/routers/videos.py`, `app/schemas.py`, `tests/test_videos_api.py`
  - Spec: ADDED "DELETE on a terminal task MUST preserve its status"

- [ ] 1.3 **P1 / P2** — `XADD MAXLEN ~10000 approximate` + tail read via `XREVRANGE COUNT`
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: MODIFIED "Log appending MUST reuse a connection pool AND bound the stream"

- [ ] 1.4 **S3** — Redis token-bucket rate limiter on `POST /v1/videos` (global floor, keyed by IP)
  - Files: `app/ratelimit.py` (new), `app/routers/videos.py`, `app/config.py`, `tests/test_ratelimit.py` (new)
  - Spec: ADDED "Task creation MUST be rate-limited (global floor)"

- [ ] 1.5 **L2** — Classify `OperationalError`/Redis `ConnectionError`/`TimeoutError` as `TransientError` to trigger autoretry
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Transient infrastructure errors MUST trigger Celery retry"

**Quality Gate (Phase 1):**
- [ ] `celery -A app.workers.celery_app.celery_app inspect registered` lists both tasks
- [ ] `pytest tests/test_ratelimit.py tests/test_worker.py tests/test_videos_api.py -v` passes
- [ ] Log stream stays bounded under heavy logging test

---

## Phase 2: P2 — Concurrency stability & input hardening

- [ ] 2.1 **P3 / N4** — SSE uses `redis.asyncio`; `video_events` returns `404` for unknown task; capped historical replay
  - Files: `app/routers/videos.py`, `app/db.py`, `tests/test_sse.py`
  - Spec: ADDED "SSE endpoint MUST use async Redis and MUST validate task existence"

- [ ] 2.2 **N5 / N17 / S4** — `idempotency_key max_length=256`, `extra_oh_args max_length=50`, flag-value type validation
  - Files: `app/schemas.py`, `app/security.py`, `tests/test_security.py`
  - Spec: ADDED "Request input fields MUST be length/type-validated"; MODIFIED "`extra_oh_args` MUST be constrained by an allowlist AND value-validated"

- [ ] 2.3 **N6** — Alembic migration adding `(created_at, status)` composite index; declare on model
  - Files: `alembic/versions/002_*.py` (new), `app/models.py`
  - Spec: supports "cleanup MUST be batched" (perf)

- [ ] 2.4 **N7 / N8 / N12** — `runner.py`: cap stdout (256 KB), `start_new_session=True` (drop `preexec_fn`), `RunResult.timed_out: bool`
  - Files: `app/workers/runner.py`, `tests/test_runner.py`
  - Spec: ADDED "Worker stdout accumulation MUST be capped"; ADDED "subprocess MUST use `start_new_session`"; supports ADDED "Timeout-kill MUST be distinguishable"

- [ ] 2.5 **N10 / N11** — `Settings.api_key: SecretStr`; hide `output_path` in `VideoTaskResponse`
  - Files: `app/config.py`, `app/main.py`, `app/schemas.py`, `tests/test_api_edge.py`
  - Spec: ADDED "API key MUST be stored as a secret; responses MUST NOT leak internal paths"

**Quality Gate (Phase 2):**
- [ ] `pytest tests/ -v` passes (including SSE, security, runner suites)
- [ ] No thread-pool occupancy by SSE `xread` (async Redis)
- [ ] `repr(Settings)` does not leak the api key

---

## Phase 3: P3 — Robustness & polish

- [ ] 3.1 **L3** — Skip redelivery of already-`RUNNING` tasks (lightweight guard pending R8 lease)
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "A redelivered RUNNING task MUST NOT re-execute"

- [ ] 3.2 **L4** — Persist `celery_task_id` at enqueue time
  - Files: `app/routers/videos.py`, `tests/test_videos_api.py`
  - Spec: ADDED "`celery_task_id` MUST be persisted at enqueue time"

- [ ] 3.3 **L5** — `Range` request honors end byte (`206`, correct `Content-Length`/`Content-Range`)
  - Files: `app/routers/videos.py`, `tests/test_videos_api.py`
  - Spec: ADDED "Range requests MUST honor the end byte"

- [ ] 3.4 **P4 / P5 / P6 / N13** — sync `pool_pre_ping=True`; immediate workspace cleanup on success; batched per-task-resilient cleanup in SQLAlchemy 2.0 style
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`, `tests/test_cleanup.py`
  - Spec: ADDED "Sync DB engine MUST enable pool_pre_ping; cleanup MUST be per-task-resilient and batched"; MODIFIED "Expired-task cleanup MUST run on a schedule AND be resilient + immediate-success-cleanup"

- [ ] 3.5 **O1 / O2 / O3 / O4** — `/healthz` 503 on degraded; unify db host; preserve fps decimals; exclude temp dirs in output-location fallback
  - Files: `app/routers/health.py`, `app/config.py`, `app/workers/parser.py`, `tests/`
  - Spec: ADDED "/healthz MUST return 503 when degraded"; ADDED "Metadata polish — fps precision, output-location fallback, default-credentials warning"

- [ ] 3.6 **N12 / N14 / N15 / N16** — timeout error message; `_append_log` circuit-break on Redis failure; watchdog poll interval 2 s + coarse; default-creds startup warning
  - Files: `app/workers/tasks.py`, `app/workers/runner.py`, `app/config.py`, `tests/`
  - Spec: ADDED "Watchdog abort polling MUST degrade gracefully"; ADDED "Timeout-kill MUST be distinguishable"; supports "Metadata polish"

**Quality Gate (Phase 3):**
- [ ] `pytest tests/ -v` passes end-to-end
- [ ] `/healthz` returns 503 when Redis/DB down (manual or integration test)
- [ ] Successful task leaves no workspace on disk

---

## Phase 4: R7–R20 — Out of Scope (owned by `phase3-multitenancy-temporal-lease`)

These requirements are NOT in this change. Tracked here for traceability only:

- R7 atomic claim, R8 strict lease, R9 idempotent reclaim (the CAS guard in Task 0.1 is the foundation), R10 S3 storage + `presigned_url`, R11 Prometheus/structlog/`/readyz`, R12 horizontal scaling, R13 concurrency control, R14 tenant isolation, R15 hashed API-key auth, R16 per-tenant quota, R17 audit logging, R18 per-tenant rate limit, R19 pluggable Temporal scheduler, R20 strict lease with fencing token.

> When `phase3-multitenancy-temporal-lease` lands, it will MODIFY the CAS guard (Task 0.1) to add `AND lease_token=:token` per R20, and the cancel DB fallback (Task 0.2) will be subsumed by the lease/heartbeat reclaim.

---

## Completion Checklist

- [ ] All Phase 0–3 tasks complete
- [ ] All 22 ADDED requirements have at least one passing GIVEN/WHEN/THEN test
- [ ] All 4 MODIFIED requirements' new scenarios pass
- [ ] Existing e2e suite green (19/19)
- [ ] `celery ... inspect registered` lists both tasks
- [ ] `/healthz` returns 503 under degraded dependencies
- [ ] No `preexec_fn` in `runner.py`; `start_new_session=True` present
- [ ] `repr(Settings)` does not leak api_key
- [ ] Documentation synced (this delta + `video-service-hardening.md` updated on archive)
- [ ] Ready for `/openspec-archive harden-video-service-impl-fixes`
