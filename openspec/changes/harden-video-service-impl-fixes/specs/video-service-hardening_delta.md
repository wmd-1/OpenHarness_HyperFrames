# Delta: Video Service Security & Correctness — Phase 1 Implementation Fixes

**Change ID:** `harden-video-service-impl-fixes`
**Affects:** `service/app/**`, `service/alembic/versions/**`, `service/tests/**`, `openspec/specs/video-service-hardening.md`
**Source:** V1+V2 code review (37 findings)

> This delta captures implementation-level invariants discovered by code review that are **not yet** in the source-of-truth spec, plus refinements to existing requirements. It deliberately stops short of R7–R20 (claim/lease/tenant/S3/observability/concurrency/Temporal), which remain owned by `phase3-multitenancy-temporal-lease`.

---

## ADDED

### Requirement: Terminal-state writes MUST be conditional (CAS) on `status='running'`

Every terminal-state transition (`_mark_succeeded` / `_mark_failed` / `_mark_canceled`) MUST be a single `UPDATE ... WHERE id=:id AND status='running'` and MUST verify `rowcount > 0`. A transition that affects 0 rows MUST be a no-op (no overwrite) and MUST log a warning. This guards both the user-cancel race (L1) and — when R8/R20 land — stale-owner writes; it is the foundation on which `lease_token` fencing builds.

#### Scenario: already-CANCELED task is not overwritten by a late success
- GIVEN a task was canceled (status=`CANCELED`) while `oh` was still running
- WHEN the worker later calls `_mark_succeeded`
- THEN the conditional `UPDATE` affects 0 rows, the task stays `CANCELED`, and a warning is logged

#### Scenario: already-SUCCEEDED task is not flipped by a late failure
- GIVEN a task is `SUCCEEDED`
- WHEN a late `_mark_failed` runs
- THEN the conditional `UPDATE` affects 0 rows and the task stays `SUCCEEDED`

---

### Requirement: Enqueue failure MUST NOT orphan a QUEUED task

If `generate_video_task.delay()` raises (broker/Redis unavailable), the API MUST mark the just-created task `FAILED` with an `enqueue failed` error message and return `503`, rather than leaving a `QUEUED` row that no worker will ever pick up.

#### Scenario: broker down yields FAILED, not orphan QUEUED
- GIVEN the task row was committed as `QUEUED` and `delay()` then raises `ConnectionError`
- WHEN the create endpoint handles the exception
- THEN the task is updated to `FAILED`, `error_message` contains `enqueue`, and the response is `503`

---

### Requirement: Cancellation signal MUST have a DB fallback when Redis is unavailable

`_abort_requested` MUST NOT return `False` solely because Redis is unreachable. When the Redis abort-flag read fails, the worker MUST fall back to checking the task's DB `status` (a task already `CANCELED` in DB counts as aborted). This makes cancellation effective during Redis outages.

#### Scenario: Redis down, task already CANCELED → abort detected
- GIVEN Redis is unreachable and the task row is `CANCELED`
- WHEN the worker checks `_abort_requested(task_id)`
- THEN it returns `True` (DB fallback), so the worker skips `_mark_succeeded`

#### Scenario: Redis down, task still RUNNING → not aborted
- GIVEN Redis is unreachable and the task row is `RUNNING`
- WHEN the worker checks `_abort_requested(task_id)`
- THEN it returns `False` (no spurious abort)

---

### Requirement: DELETE on a terminal task MUST preserve its status

`DELETE /v1/videos/{id}` on a `SUCCEEDED`/`FAILED`/`CANCELED` task MUST clean its artifact + workspace but MUST NOT rewrite the terminal status to `CANCELED`. The response MUST distinguish "resources deleted" from "task canceled" (e.g., a `deleted: true` flag). The original terminal status is preserved so audit/stat counts are not corrupted.

#### Scenario: DELETE a SUCCEEDED task keeps status SUCCEEDED
- GIVEN a `SUCCEEDED` task with an output artifact
- WHEN `DELETE /v1/videos/{id}` is called
- THEN the artifact + workspace are removed, `output_path`/`workspace_path` are nulled, and `status` stays `SUCCEEDED`; the response carries `deleted: true`

---

### Requirement: Task creation MUST be rate-limited (global floor)

`POST /v1/videos` MUST enforce a token-bucket rate limit (Redis-backed, capacity and refill configurable) keyed at least by client IP, returning `429` when the bucket is empty. This is a global DoS floor that complements (does not replace) the per-tenant quota of R16.

#### Scenario: burst exceeds bucket → 429
- GIVEN a bucket capacity of 2 and refill of 1/s
- WHEN 3 submissions arrive within the same second
- THEN the third receives `429` and no task is created

---

### Requirement: Request input fields MUST be length/type-validated

`idempotency_key` MUST be at most 256 characters; `extra_oh_args` MUST be a list of at most 50 entries; each `--flag value` pair whose value is meant to be numeric (`--temperature` float, `--max-turns` int) or string (`--model`) MUST be type-checked before forwarding to `oh`. Out-of-range or malformed values MUST be rejected with `422` (not reach the DB or `Popen`).

#### Scenario: overlong idempotency key rejected
- GIVEN a request with `idempotency_key` of 257 characters
- WHEN validation runs
- THEN the response is `422`

#### Scenario: extra_oh_args list too long rejected
- GIVEN a request with `extra_oh_args` containing 51 entries
- WHEN validation runs
- THEN the response is `422`

#### Scenario: non-numeric temperature rejected
- GIVEN a request with `extra_oh_args: ["--temperature", "not_a_number"]`
- WHEN validation runs
- THEN the response is `422`

---

### Requirement: Log Stream MUST be bounded and tail reads MUST be bounded

`_append_log` MUST pass `MAXLEN ~ 10000 approximate=True` to `XADD` so the per-task Redis Stream cannot grow without bound. `_update_log_tail` MUST read only the tail (e.g., `XREVRANGE ... COUNT N`) rather than the entire stream.

#### Scenario: stream stays bounded under heavy logging
- GIVEN a task emits 50 000 log lines
- WHEN logs are appended
- THEN the stream length stays at or below the configured `MAXLEN`

#### Scenario: tail read does not load full history
- GIVEN a stream with 50 000 entries
- WHEN `_update_log_tail` runs
- THEN it reads at most the configured tail-count entries (not the full stream)

---

### Requirement: SSE endpoint MUST use async Redis and MUST validate task existence

`GET /v1/videos/{id}/events` MUST NOT block an anyio thread-pool slot on `xread`; it MUST use `redis.asyncio` for the blocking read. The endpoint MUST return `404` for a non-existent `task_id` (no open connection waiting on a ghost stream). Historical replay MUST be capped (e.g., last 500 entries).

#### Scenario: SSE on unknown task returns 404 immediately
- GIVEN no task exists with the given id
- WHEN `GET /v1/videos/{id}/events` is called
- THEN the response is `404` and no SSE connection is opened

#### Scenario: SSE does not consume thread-pool slots
- GIVEN many concurrent SSE clients
- WHEN the API also serves other requests
- THEN no thread-pool slot is occupied by `xread` (async Redis)

---

### Requirement: Worker stdout accumulation MUST be capped

`run_oh` MUST bound the accumulated `stdout` string (e.g., 256 KB); excess output MUST be truncated while still being forwarded line-by-line to the log stream. This prevents OOM on verbose `oh` runs.

#### Scenario: huge stdout does not exhaust worker memory
- GIVEN an `oh` run emits 1 MB of stdout
- WHEN `run_oh` accumulates it
- THEN the returned `stdout` is at most the configured cap (excess discarded), and log streaming is unaffected

---

### Requirement: The `oh` subprocess MUST be started with `start_new_session` (no `preexec_fn`)

`Popen` MUST use `start_new_session=True` to put the child in a new session/process group (enabling process-group kill on cancel). `preexec_fn=os.setsid` MUST NOT be used, because the Python `preexec_fn` mechanism is unsafe in multi-threaded parents.

#### Scenario: child runs in a new session without preexec_fn
- GIVEN a worker starts `oh`
- WHEN `Popen` is invoked
- THEN `start_new_session=True` is passed and `preexec_fn` is absent

---

### Requirement: Celery MUST actually register the worker tasks

The Celery app's `autodiscover_tasks` argument MUST be a package name (e.g., `["app.workers"]`) so that `<package>.tasks` is importable, OR the tasks module MUST be explicitly imported at app construction. A standalone worker started with `celery -A app.workers.celery_app.celery_app worker` MUST have both `generate_video_task` and `cleanup_expired_tasks` registered.

#### Scenario: standalone worker has tasks registered
- GIVEN a worker started via `celery -A app.workers.celery_app.celery_app worker`
- WHEN `celery -A app.workers.celery_app.celery_app inspect registered` runs
- THEN the output includes `app.workers.tasks.generate_video_task` and `app.workers.tasks.cleanup_expired_tasks`

---

### Requirement: API key MUST be stored as a secret; responses MUST NOT leak internal paths

`Settings.api_key` MUST be a `SecretStr` so it is masked in `repr`/tracebacks. `VideoTaskResponse` MUST NOT expose the internal `output_path` (storage key); clients reach the file via the documented download link only.

#### Scenario: api_key is masked in repr
- GIVEN `Settings(api_key="supersecret")`
- WHEN `repr(settings)` is produced
- THEN `"supersecret"` does not appear

#### Scenario: task response has no output_path field
- GIVEN any task
- WHEN `GET /v1/videos/{id}` is called
- THEN the JSON body has no `output_path` key (only a download link)

---

### Requirement: Sync DB engine MUST enable pool_pre_ping; cleanup MUST be per-task-resilient and batched

The Celery worker's sync `create_engine` MUST set `pool_pre_ping=True` (matching the async engine). `cleanup_expired_tasks` MUST be resilient to per-task failure (one bad task does not abort the batch), MUST use SQLAlchemy 2.0 `select`/`delete` style, and MUST process in bounded batches.

#### Scenario: DB restart does not poison worker connections
- GIVEN the worker holds idle connections and PostgreSQL restarts
- WHEN the worker next uses a connection
- THEN `pool_pre_ping` discards the stale connection and reconnects (no error)

#### Scenario: one failing task does not roll back the cleanup batch
- GIVEN a cleanup batch of 50 tasks where one `storage.delete` raises
- WHEN cleanup runs
- THEN the other 49 are still deleted; the failure is logged but not fatal

---

### Requirement: `/healthz` MUST return 503 when degraded

When any dependency (Redis or DB) is unreachable, `/healthz` MUST return HTTP `503` (not `200`) so readiness probes can shed traffic. The body still reports component status for diagnostics.

#### Scenario: Redis down → 503
- GIVEN Redis is unreachable
- WHEN `GET /healthz` is called
- THEN the response status is `503` and the body marks redis as down

---

### Requirement: Range requests MUST honor the end byte

`GET /v1/videos/{id}/file` with `Range: bytes=start-end` MUST return exactly `end-start+1` bytes (clamped to file size) with a correct `Content-Range`/`Content-Length` and `206` status. It MUST NOT stream to EOF ignoring `end`.

#### Scenario: bytes=0-100 returns 101 bytes
- GIVEN a finished task with a 10 000-byte file
- WHEN `GET /v1/videos/{id}/file` is called with `Range: bytes=0-100`
- THEN the response is `206`, `Content-Length: 101`, and exactly 101 bytes are returned

---

### Requirement: Transient infrastructure errors MUST trigger Celery retry

`OperationalError` (DB) and Redis `ConnectionError`/`TimeoutError` encountered inside `generate_video_task` MUST be re-raised as `TransientError` so the configured `autoretry_for`/`retry_backoff` actually fires. Non-transient exceptions continue to mark the task `FAILED`.

#### Scenario: DB blip triggers retry
- GIVEN `generate_video_task` raises `OperationalError` mid-run
- WHEN the exception is classified
- THEN `TransientError` is raised (not swallowed) and Celery schedules a retry

---

### Requirement: A terminalized task's workspace MUST be cleaned immediately on success

On `SUCCEEDED`, the worker MUST remove the workspace directory (the artifact is already copied to the storage root). This bounds disk usage between daily cleanup runs. On `FAILED`, the workspace MAY be retained for debugging until the daily cleanup.

#### Scenario: success removes workspace
- GIVEN a task completes successfully and the artifact is saved
- WHEN `_mark_succeeded` returns
- THEN the workspace directory no longer exists on disk

---

### Requirement: A redelivered RUNNING task MUST NOT re-execute

With `acks_late=True`, a redelivered task whose DB status is already `RUNNING` MUST be skipped (no second `oh` invocation). This is a lightweight guard pending R8 strict lease.

#### Scenario: redelivery to a RUNNING task is skipped
- GIVEN a task is `RUNNING` (presumably held by another live worker) and the message is redelivered
- WHEN `generate_video_task` starts
- THEN it logs a warning and returns without invoking `oh`

---

### Requirement: `celery_task_id` MUST be persisted at enqueue time

The Celery result id returned by `delay()` MUST be written to the task row at enqueue time (before the API returns), so `revoke` is possible during the enqueue-to-worker-start window.

#### Scenario: task row carries celery id immediately after create
- GIVEN a successful `POST /v1/videos`
- WHEN the response is returned
- THEN `video_tasks.celery_task_id` is non-null and matches the `AsyncResult.id`

---

### Requirement: Metadata polish — fps precision, output-location fallback, default-credentials warning

`probe_mp4` MUST preserve sub-integer fps (e.g., `30000/1001 ≈ 29.97`), not truncate to an int. `locate_output_file`'s fallback MUST exclude temporary subdirectories so an intermediate artifact is not mistaken for the output. When default DB credentials (`oh:oh`) are in use and no API key is set, the service MUST log a warning at startup.

#### Scenario: 29.97 fps is not truncated
- GIVEN an mp4 whose `r_frame_rate` is `30000/1001`
- WHEN `probe_mp4` runs
- THEN the stored `fps` is approximately `29.97` (not `29`)

#### Scenario: temp-dir mp4 is not picked as output
- GIVEN a workspace with the real output plus a stray `tmp/intermediate.mp4`
- WHEN `locate_output_file` runs
- THEN it returns the real output, not the intermediate

---

### Requirement: Watchdog abort polling MUST degrade gracefully

The watchdog's abort-poll loop MUST NOT generate a log storm when Redis is unavailable: the first failure to read the abort flag SHOULD disable further per-line Redis attempts for that task (circuit-break), and the polling interval SHOULD be coarse enough (e.g., 2 s) to bound Redis `GET` frequency.

#### Scenario: Redis failure does not flood logs
- GIVEN Redis is unreachable and a task is running
- WHEN the watchdog polls the abort flag repeatedly
- THEN at most one error is logged per task (circuit-break), not one per poll

---

### Requirement: Timeout-kill MUST be distinguishable in the error message

When `oh` is killed because it exceeded the timeout, the failure error message MUST explicitly state `timed out after {N}s` (not just `exited with code -15`). `RunResult` MUST carry a `timed_out: bool` flag.

#### Scenario: timed-out task has a clear error message
- GIVEN a task whose `oh` was killed for exceeding the timeout
- WHEN the worker records the failure
- THEN `error_message` starts with `timed out after` and `exit_code` reflects the signal

---

## MODIFIED

### Requirement: Canceling a RUNNING task MUST terminate the `oh` process group and leave status correct

*(Refines the existing requirement: terminal writes now MUST be conditional per the new "Terminal-state writes MUST be conditional (CAS)" requirement, and cancellation MUST fall back to DB per the new "Cancellation signal MUST have a DB fallback" requirement.)*

A DELETE on a RUNNING task MUST send termination to the `oh` process group, remove the workspace and stored video, and the worker MUST NOT mark the task SUCCEEDED afterward — enforced by the conditional `WHERE status='running'` guard on `_mark_succeeded`. Cancellation effectiveness MUST NOT depend solely on Redis: the worker's abort check MUST fall back to the DB `status` when Redis is unavailable.

#### Scenario: worker does not overwrite a canceled task
- GIVEN a task was canceled while `oh` was still running
- WHEN `run_oh` eventually returns and the worker attempts `_mark_succeeded`
- THEN the conditional `UPDATE` affects 0 rows and the task stays `CANCELED`

#### Scenario: cancel remains effective during Redis outage
- GIVEN a task is RUNNING and Redis becomes unavailable
- WHEN the user cancels (DB status set to `CANCELED`) and the worker checks abort
- THEN the DB fallback returns `True` and the worker skips `_mark_succeeded`

---

### Requirement: `extra_oh_args` MUST be constrained by an allowlist AND value-validated

*(Refines the existing requirement: the allowlist now also type-checks each flag's value.)*

Forwarded `oh` CLI flags MUST be validated against a fixed allowlist of safe `--flag value` pairs; safety-critical flags MUST NOT be overridable. Additionally, the value of each typed flag (e.g., `--temperature: float`, `--max-turns: int`, `--model: str`) MUST be type-checked; a malformed value MUST be rejected with `422`.

#### Scenario: safe flag with valid value passes through
- GIVEN a request with `extra_oh_args: ["--temperature", "0.7"]`
- WHEN validation runs
- THEN the pair is forwarded to `oh` unchanged

#### Scenario: permission-mode override is rejected
- GIVEN a request with `extra_oh_args: ["--permission-mode", "not_full_auto"]`
- WHEN validation runs
- THEN the request is rejected (422)

#### Scenario: non-numeric temperature is rejected
- GIVEN a request with `extra_oh_args: ["--temperature", "hot"]`
- WHEN validation runs
- THEN the request is rejected (422)

---

### Requirement: Log appending MUST reuse a connection pool AND bound the stream

*(Refines the existing requirement: in addition to connection reuse, `XADD` MUST cap the stream with `MAXLEN` and tail reads MUST be bounded.)*

`_append_log` MUST use a shared Redis connection pool, MUST NOT call `ltrim` per line, AND MUST pass `MAXLEN ~ 10000 approximate=True` to `XADD`. `_update_log_tail` MUST read only the tail via `XREVRANGE ... COUNT N`, not the full stream.

#### Scenario: high-volume logs stay cheap and bounded
- GIVEN a task emitting thousands of stdout lines
- WHEN logs are appended
- THEN a bounded number of Redis connections is used, `ltrim` is not called per line, and the stream length stays at or below `MAXLEN`

---

### Requirement: Expired-task cleanup MUST run on a schedule AND be resilient + immediate-success-cleanup

*(Refines the existing requirement: cleanup is now per-task-resilient, batched, 2.0-style, and successful tasks have their workspace removed immediately rather than only at daily cleanup.)*

`cleanup_expired_tasks` MUST run on a Celery beat schedule, MUST be resilient to per-task failure (one bad task does not abort the batch), MUST use SQLAlchemy 2.0 `select`/`delete` in bounded batches. Additionally, a `SUCCEEDED` task's workspace MUST be removed immediately by the worker (the artifact is already copied out), so disk usage does not accumulate between daily runs.

#### Scenario: beat triggers cleanup, batch is resilient
- GIVEN the retention interval elapses
- WHEN `cleanup_expired_tasks` runs over a batch containing one failing task
- THEN the other tasks are still cleaned; the failure is logged

#### Scenario: success removes workspace immediately
- GIVEN a task completes successfully
- WHEN the worker finishes
- THEN the workspace directory is removed (not waiting for daily cleanup)

---

## REMOVED

(None)
