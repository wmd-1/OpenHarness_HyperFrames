# Proposal: Harden Video Service — Implementation Fixes (Phase 1)

**Change ID:** `harden-video-service-impl-fixes`
**Created:** 2026-07-21
**Status:** Draft
**Source documents:**
- `service/CODE_REVIEW_REPORT.md` (V1, 2026-07-20) — 19 findings
- `service/CODE_REVIEW_REPORT_V2.md` (V2, 2026-07-21) — V1 verification + 18 new findings
- `plans/Backend_Hardening_Fix_Plan_2026-07-21.md` — TDD fix plan covering all 37 findings

---

## Problem Statement

A two-pass code review of `service/` (FastAPI + Celery video generation backend) identified **37 concrete defects**: 4 high-severity, 11 medium, 22 low. The current implementation is **Phase 1**; `openspec/specs/video-service-hardening.md` specifies R1–R20 as the target, but only ~6 (R1–R6) are actually implemented. R7–R20 (claim/lease/tenant/observability/concurrency/temporal) are entirely absent from code.

Beyond the missing R7–R20 (owned by `phase3-multitenancy-temporal-lease`), the review found **22 invariants that the spec does not yet capture** but are essential for production safety — these are implementation-level hardening requirements that should be promoted to source-of-truth specs so they are not silently regressed later.

- **Affected:** all callers of the video service (no auth/tenant isolation today), operators (unbounded Redis/memory growth, thread-pool exhaustion), and developers (misleading test coverage, broken Celery autodiscover).
- **Pain points:** (1) unauthenticated access + cross-UUID read/delete of any task; (2) cancel race that overwrites `CANCELED` with `SUCCEEDED`; (3) orphaned `QUEUED` tasks on broker failure; (4) cancellation fully dependent on Redis availability; (5) SSE blocking the limited anyio thread pool; (6) Redis log stream unbounded growth; (7) `autodiscover_tasks` misconfigured (standalone worker may not register tasks).

## Proposed Solution

Promote the 37 review findings into OpenSpec invariants (delta to `video-service-hardening.md`) and back them with TDD tasks. The change is **purely additive and refining**: it introduces no new infrastructure (no Temporal, no S3, no RLS) and is implementable on the existing FastAPI + Celery + PostgreSQL + Redis stack. Phase 3 concerns (R7–R20) remain owned by `phase3-multitenancy-temporal-lease` and are explicitly out of scope.

**Key technical approach:**
- Terminal-state writes use conditional `UPDATE ... WHERE status='running'` (CAS) — the foundation that R9/R20 lease-fencing will build on.
- Cancellation adds a DB fallback so it stays effective when Redis is down.
- Enqueue failure compensates by marking the task `FAILED` (no orphan `QUEUED`).
- SSE migrates to `redis.asyncio` (no thread-pool occupancy) and validates task existence.
- Redis log stream gains `MAXLEN`; tail reads use `XREVRANGE`.
- Input validation (idempotency-key length, extra-arg list size, flag-value types), `SecretStr` for the API key, response sanitization.
- Worker robustness: `start_new_session`, stdout cap, `pool_pre_ping`, immediate workspace cleanup, batched per-task-resilient cleanup, `TransientError` classification, redelivery skip.

## Scope

### In Scope
- 22 new spec requirements (terminal CAS, enqueue compensation, cancel DB fallback, DELETE semantics, global rate-limit floor, input validation, log stream bounds, async SSE, stdout cap, `start_new_session`, Celery registration, `SecretStr`/response sanitization, `pool_pre_ping`/cleanup resilience, `/healthz` 503, Range end, transient retry, immediate workspace cleanup, redelivery skip, `celery_task_id` persistence, fps/output-location/default-creds polish, watchdog graceful degrade, timeout distinguish).
- 4 modifications to existing requirements (cancel race, extra-oh-args value validation, log pool→bounds, cleanup→immediate+resilient).
- TDD task breakdown (P0–P3) mirroring the fix plan.

### Out of Scope
- R7–R20 implementation (claim/lease/tenant/S3/observability/concurrency/Temporal) — owned by `phase3-multitenancy-temporal-lease`.
- Full per-tenant quota / rate-limit (R16/R18) — only a global floor is in scope here.
- `presigned_url` / S3 storage (R10).
- Prometheus/structlog/`/readyz` (R11) — only `/healthz` 503 semantics in scope.

## Impact Analysis

| Component | Change Required | Details |
|---|---|---|
| API (`app/routers`) | Yes | auth middleware, create/GET/DELETE/SSE/download rewrites, Range end |
| Worker (`app/workers`) | Yes | conditional terminal writes, abort DB fallback, `pool_pre_ping`, stdout cap, `start_new_session`, transient retry, redelivery skip, immediate cleanup |
| Storage (`app/storage`) | Yes | `start_new_session` is in runner; storage API unchanged |
| Schema (`app/schemas`) | Yes | field length caps, `SecretStr`, response sanitization |
| Config (`app/config`) | Yes | `require_auth`, `SecretStr`, unified db host, default-creds warning, rate-limit knobs |
| DB / Alembic | Yes | new `(created_at, status)` index migration |
| Tests | Yes | 22+ new TDD tests, fix misleading cancel-guard test |
| Docs (`openspec/specs`) | Yes | this delta |

## Architecture Considerations

- **Aligns with existing pattern:** conditional `UPDATE` mirrors R9's existing terminal-state guard but generalizes it beyond the lease context (covers the user-cancel race that exists even without lease). This is the intended foundation for R20's `lease_token` fence.
- **No new middleware:** rate limiter is a thin Redis token bucket; SSE uses `redis.asyncio` already a dependency via Celery's Redis broker.
- **Backward compatible:** `require_auth` defaults to `False` to preserve dev ergonomics; production flips it via env. Default DB host unified to `localhost` (was inconsistent).
- **Dependency:** Task 0.1 (CAS) is a prerequisite for R9/R20 lease fencing in `phase3-multitenancy-temporal-lease`.

## Success Criteria

- [ ] All 37 review findings have a corresponding spec requirement (ADDED or MODIFIED) with at least one GIVEN/WHEN/THEN scenario.
- [ ] All P0 fixes (S1, L1, N1, N3) implemented with passing TDD tests.
- [ ] `celery -A app.workers.celery_app.celery_app inspect registered` lists `generate_video_task` and `cleanup_expired_tasks`.
- [ ] Existing e2e suite (19/19) stays green; new tests cover the cancel TOCTOU race, enqueue failure, Redis-down cancellation, DELETE terminal preservation, SSE 404, and field validation.
- [ ] `pytest tests/ -v` passes with no regression after each task.
- [ ] `/healthz` returns 503 when Redis or DB is unreachable.

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| `autodiscover_tasks` change breaks existing worker startup | Low | High | Step 1 of Task 1.1 verifies `inspect registered` before/after; add explicit `import app.workers.tasks` as belt-and-suspenders |
| Conditional UPDATE silently drops legit success writes (e.g., status already advanced) | Low | Med | Guard checks `rowcount==0` and logs warning; the only legal pre-state is `RUNNING` |
| Async SSE rewrite changes client-visible event ordering | Low | Med | Replay last 500 entries in order; preserve `log`/`done`/`ping` event names |
| `require_auth=True` default flips break local dev | Med | Low | Default `False`; gate only via env in production |
| Immediate workspace cleanup removes debugging artifacts | Med | Low | Keep on failure (only clean on success); failed workspaces still cleared by daily cleanup |
| Spec creep into Phase 3 territory | Med | Med | Out-of-Scope section explicitly defers R7–R20; delta requirements are scoped to non-lease invariants |
