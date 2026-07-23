# Proposal: Harden Video Service — Implementation Fixes (V3)

**Change ID:** `harden-video-service-impl-fixes`
**Created:** 2026-07-21
**Status:** Draft
**Source documents:**
- `service/CODE_REVIEW_REPORT.md` (V1, 2026-07-20) — 19 findings
- `service/CODE_REVIEW_REPORT_V2.md` (V2, 2026-07-21) — V1 verification + 18 new findings
- `service/CODE_REVIEW_REPORT_V3.md` (V3, 2026-07-21) — re-verified against the merged `scale-multi-instance` code; ~26 V1/V2 findings still open + **9 new findings (X1–X9)**
- `plans/Backend_Hardening_Fix_Plan_V3_2026-07-21.md` — canonical TDD fix plan (supersedes the earlier `Backend_Hardening_Fix_Plan_2026-07-21.md`)

---

## Why

The `service/` backend (FastAPI + Celery video generation) has since **merged `scale-multi-instance`**, so the codebase no longer matches the V1/V2-era assumptions. Re-verification (V3) confirms that several foundations are **already in place** and MUST NOT be re-implemented:

- Terminal-state writes already use a conditional `UPDATE ... WHERE status='RUNNING' [AND worker_id=:wid]` (CAS) — `_mark_succeeded/_mark_failed/_mark_canceled` carry a `worker_id` argument and return `bool`.
- Enqueue already routes through `get_scheduler().enqueue(...)` (pluggable Celery/Temporal scheduler), not `generate_video_task.delay()`.
- The `worker_id`/`heartbeat_at`/`cancellation_requested`/`priority`/`storage_kind` columns, heartbeat/reclaim (`beat.py`), S3 storage, priority queues, and a render semaphore all exist.

Against this reality, **35 defects remain**: ~26 unresolved V1/V2 findings **plus 9 new V3 findings (X1–X9)** exposed by the multi-instance code:

- **X1 (high):** `claim()` (atomic `UPDATE ... WHERE status IN (QUEUED,RETRYING)`) is defined but **never wired into the task entry**; the entry unconditionally sets `status=RUNNING`, so `acks_late` redelivery or reclaim can **double-render** a task still owned by a live worker.
- **X4 (=N3):** `cancellation_requested` is written but never read — cancel still depends solely on Redis.
- **X2:** S3 `open`/`save` buffer the whole object in memory (OOM + breaks Range).
- **X3:** `render_semaphore` is a process-local `threading.Semaphore`, ineffective under Celery prefork (`-c 4`).
- **X5/X6:** heartbeat cadence too close to `STALE_AFTER` (false reclaim → double render); reclaim re-enqueues via `delay()`, bypassing the scheduler and losing priority.
- **X7:** worker subprocess never calls `configure_logging`; `bind_task_context` is dead code.
- **X8:** `/healthz` does a **synchronous** Redis `ping()` on the event loop.
- **X9:** `ALTER TYPE ... ADD VALUE 'RETRYING'` can fail inside a migration transaction on older PostgreSQL.

Plus the still-open V1/V2 items: unauthenticated access (S1), cancel DB fallback (N3), enqueue orphan compensation (N1), DELETE terminal-status corruption (N2), unbounded log stream (P1/P2), no rate limit (S3), blocking SSE (P3/N4), input validation (N5/N17/S4), missing index (N6), stdout cap / `preexec_fn` / timeout flag (N7/N8/N12), `SecretStr` + response sanitization (N10/N11), and assorted low-severity polish (L2/L5/P4/P5/P6/N13/N14/N15/N16/N9/O1–O4).

## What Changes

Promote the surviving findings into OpenSpec invariants (delta to `video-service-hardening.md`) and back them with TDD tasks, mirroring `plans/Backend_Hardening_Fix_Plan_V3_2026-07-21.md`. The change is **incremental hardening on top of `scale-multi-instance`** — no new infrastructure (no Temporal, no RLS, no new middleware):

**Key technical approach:**
- **Wire the existing `claim()`** at the task entry (X1/L3): exactly one worker flips `QUEUED/RETRYING → RUNNING`; losing the race skips the run. This replaces the old "add CAS" task — CAS already exists; the new work is atomic claim + a *direct* CAS test (N18).
- Cancellation adds a **DB fallback** (`status==CANCELED` or `cancellation_requested`) so it survives Redis outages (N3/X4).
- **Enqueue failure compensates** by marking the task `FAILED` + `503` (N1) — wrapping `get_scheduler().enqueue(...)`, not `delay()`.
- SSE migrates to `redis.asyncio` and validates task existence (P3/N4).
- Redis log stream gains `MAXLEN`; tail reads use `XREVRANGE`; push failures circuit-break (P1/P2/N14).
- S3 `save`/`open` **stream** (multipart upload / `StreamingBody`) instead of buffering (X2).
- Render concurrency is expressed by Celery `-c` (drop the ineffective process-local semaphore, X3).
- Heartbeat cadence widened to tolerate ≥3 missed beats; reclaim re-enqueues via the scheduler (X5/X6).
- Worker subprocess calls `configure_logging` + `bind_task_context` (X7).
- `/healthz` stays a liveness probe; dependency health moves to an async `/readyz` (X8/O1).
- Input validation, `SecretStr` API key + constant-time compare, response sanitization, `start_new_session`, stdout cap, `pool_pre_ping`, batched cleanup, transient-error retry, new `(created_at, status)` index (migration **004**), enum-migration transaction fix (X9).

## Scope

### In Scope
- New/refined spec requirements for: atomic claim at entry (X1), terminal CAS owner-fence direct test (L1/N18), cancel DB fallback (N3/X4), enqueue compensation via scheduler (N1), DELETE terminal preservation (N2), global rate-limit floor (S3), bounded log stream (P1/P2/N14), async SSE + task existence (P3/N4), input validation (N5/N17/S4), `(created_at, status)` index migration 004 (N6), stdout cap + `start_new_session` + `timed_out` (N7/N8/N12), `SecretStr` + response sanitization (N10/N11), S3 streaming (X2), render concurrency via `-c` (X3), heartbeat/reclaim tuning (X5/X6), worker logging (X7), async `/readyz` (X8/O1), enum-migration transaction fix (X9), transient retry (L2), Range end (L5), `pool_pre_ping`/immediate workspace cleanup/batched cleanup (P4/P5/P6/N13), Celery task registration hygiene (N9), and metadata polish (O2/O3/O4, N15/N16).
- TDD task breakdown (P0–P3) mirroring the V3 fix plan.

### Out of Scope (Phase 4 — separate change)
- **R14 tenant isolation** (full `tenant_id` column + query filtering) — Task for auth here stops at "enforceable auth + constant-time compare".
- **R15** per-tenant/OIDC auth, **R16** distributed hard concurrency cap, **R17** priority-queue e2e, **R18** Temporal scheduler landing, **R19** full observability metrics/alerts, **R20** shared `conftest.py` e2e refactor.

## Impact Analysis

| Component | Change Required | Details |
|---|---|---|
| API (`app/routers`) | Yes | require_auth + constant-time compare, enqueue compensation, DELETE terminal-preserve, async SSE + 404, Range end, response sanitization, async `/readyz` |
| Worker (`app/workers`) | Yes | wire `claim()` at entry, abort DB fallback, log MAXLEN + circuit-break, transient retry, `pool_pre_ping`, immediate cleanup, batched cleanup, heartbeat/reclaim tuning, `configure_logging`, drop render semaphore |
| Runner (`app/workers/runner.py`) | Yes | stdout cap, `start_new_session`, `RunResult.timed_out`, coarser watchdog poll |
| Storage (`app/storage/s3.py`) | Yes | streaming upload/download (X2) |
| Schema (`app/schemas`) | Yes | field length caps, hide `output_path`/`log_tail` |
| Config (`app/config`) | Yes | `require_auth`, `SecretStr`, unified db host, rate-limit knobs, drop plaintext default password |
| DB / Alembic | Yes | new `(created_at, status)` index **migration 004**; `ADD VALUE 'RETRYING'` transaction fix |
| Tests | Yes | new TDD tests on the **real** fixtures (`sync_db`/`_class_with`/`client`/`db_session`); enqueue tests patch `get_scheduler` |
| Docs (`openspec/specs`) | Yes | this delta |

## Architecture Considerations

- **Builds on `scale-multi-instance`:** the CAS owner-fence and `claim()` already exist; this change *activates* claim and closes the cancel/enqueue/auth/resource gaps around it. The CAS guard is still the foundation for R20 `lease_token` fencing.
- **No new middleware:** rate limiter is a thin Redis token bucket (fail-open); SSE uses `redis.asyncio` (already available via the Celery Redis broker).
- **Backward compatible:** `require_auth` defaults `False`; `max_concurrent_renders` retained as advisory; `SecretStr | None` preserves the existing "no key ⇒ open" behavior.
- **Migration safety:** new migrations start at **004** (001/002/003 are published and unchanged); the X9 enum fix is conditional and only applies to unmigrated environments.

## Success Criteria

- [ ] All surviving V1/V2 findings + X1–X9 have a corresponding spec requirement (ADDED or MODIFIED) with ≥1 GIVEN/WHEN/THEN scenario.
- [ ] `claim()` is wired at the task entry; a redelivered/reclaimed task owned by another worker does not re-render (X1/L3 test passes).
- [ ] Terminal CAS owner-fence is covered by a **direct** test (not just a pre-set abort flag) (L1/N18).
- [ ] All P0 fixes (X1, L1/N18, N3/X4, N1, S1/S2) implemented with passing TDD tests.
- [ ] Enqueue tests patch `app.routers.videos.get_scheduler` (not `delay`); enqueue failure yields `FAILED` + `503`.
- [ ] `cd service && python -m pytest -q` passes with no regression after each task.
- [ ] `/readyz` returns `503` when Redis or DB is unreachable; `/healthz` stays `200` (liveness).

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Wiring `claim()` changes the task-entry state precondition (QUEUED not RUNNING), breaking existing worker tests | High | Med | V3 plan Task 0.1 explicitly migrates the 3 existing worker cases from `RUNNING` to `QUEUED`; run full suite after |
| Migration head confusion (002 already published) | Med | High | New index migration is **004**; confirm real `003` head via `alembic heads` before setting `down_revision` |
| Async SSE rewrite changes client-visible event ordering | Low | Med | Preserve `data:`/`done`/keep-alive framing; sequential `xread` from `last_id` |
| `SecretStr` change breaks string concatenation elsewhere | Low | Med | Grep all `settings.api_key` usages; switch to `get_secret_value()` |
| Dropping render semaphore removes a perceived safeguard | Low | Low | Concurrency expressed by `-c` + `prefetch=1`; documented in config; Redis semaphore deferred to R16 |
| X9 enum fix double-applies on already-migrated PG | Low | Low | Use `ADD VALUE IF NOT EXISTS`; skip if 002 already ran successfully |
