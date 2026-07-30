# Delta: video-service-hardening（Phase 1 / Phase 2）

> Phase 1 = worker 队列部署契约（P1，高危）；Phase 2 = Range 416 合规（P4）。

## MODIFIED Requirements

### Requirement: R13 — Worker concurrency control (queue tiering + global semaphore)

The worker MUST constrain in-instance concurrency to protect downstream
resources (Chrome / ffmpeg memory). Tasks MUST be routed to priority-tiered
Celery queues by `priority`, and a global concurrency semaphore
(`MAX_CONCURRENT_RENDERS`) MUST cap the number of simultaneously running `oh`
render processes so a single replica does not OOM under load.

**Every deployment entrypoint**（e2e 的 `oh-role` 与 oh-serve 的 supervisord
`[program:worker]`）MUST 使 worker 订阅调度器可能投递的全部优先级队列
（`queue_for_priority()` 值域）。队列集合 MUST 支持 `OH_WORKER_QUEUES` 环境变量
运行时覆盖，且在该变量缺失时 MUST 回退到与 `app/config.py::worker_queues` 一致的
默认值（shell `${VAR:-default}` 展开，禁止在 env 缺失时启动失败或静默订阅默认
`celery` 队列）。oh-serve 的 supervisord 配置 MUST 同时包含 `[program:beat]`。

部署产物 MUST 由镜像内契约测试（`service/tests/test_deployment_contract.py`）守护：
测试解析镜像内实际生效的 supervisord 配置（默认
`/etc/supervisor/conf.d/oh-service.conf`，可经 `OH_SUPERVISORD_CONF` 覆盖），断言
worker 订阅集合、beat 存在性与投递侧值域三者的契约闭环；任一漂移 MUST 使全量
pytest 失败。

#### Scenario: render concurrency stays within the semaphore cap
- GIVEN `MAX_CONCURRENT_RENDERS = K`
- WHEN more than K tasks are submitted concurrently to a single replica
- THEN at most K `oh` render processes run at once; the remainder wait in queue and start as slots free, without OOM

#### Scenario: higher-priority tasks are consumed first
- GIVEN tasks with mixed `priority` values routed to tiered queues
- WHEN workers drain the queues
- THEN higher-priority tasks are picked up before lower-priority ones

#### Scenario: oh-serve worker consumes all priority queues
- **WHEN** the single-container `api` service (oh-serve → supervisord) starts without `OH_WORKER_QUEUES` set and a task is enqueued to any of `high`/`normal`/`low`
- **THEN** the worker consumes it (task leaves `queued`), because the supervisord worker command falls back to the default queue set `high,normal,low`

#### Scenario: queue set is overridable at runtime
- **WHEN** the container is started with `OH_WORKER_QUEUES=high,normal`
- **THEN** the supervisord-managed worker subscribes exactly to `high,normal` without config file changes

#### Scenario: deployment contract test guards against drift
- **WHEN** the in-image pytest suite runs and the supervisord worker command's queue set no longer covers `settings.worker_queues` or `queue_for_priority()`'s range, or `[program:beat]` is absent
- **THEN** `test_deployment_contract.py` fails, blocking the drift from shipping

## ADDED Requirements

### Requirement: R18 — Unsatisfiable Range requests MUST return 416

`GET /v1/videos/{id}/file`（streaming 路径）对语法合法但不可满足的 `Range` 请求（first-byte-pos ≥ 文件长度，含 `bytes=-0` 推导出的空 suffix）MUST 返回 `416 Range Not Satisfiable`，并携带 `Content-Range: bytes */{size}` 头（RFC 7233 §4.4）；MUST NOT 将越界起点钳位后返回 206。语法非法的 Range 头 MUST 维持现行宽容行为（忽略 Range，返回 200 全量）。合法范围与非空 suffix 范围的现行 206 语义 MUST 保持不变。416 抛出路径 MUST NOT 泄漏已打开的文件句柄。

#### Scenario: out-of-bounds start returns 416
- **WHEN** a client requests `Range: bytes={size}-` (or any first-byte-pos ≥ file size) on a finished task's file
- **THEN** the response is `416` with header `Content-Range: bytes */{size}` and no body content from the file

#### Scenario: empty suffix returns 416
- **WHEN** a client requests `Range: bytes=-0`
- **THEN** the response is `416` with `Content-Range: bytes */{size}`

#### Scenario: valid ranges keep returning 206
- **WHEN** a client requests `Range: bytes=0-1023` or suffix `Range: bytes=-100` on a file larger than those ranges
- **THEN** the response remains `206 Partial Content` with the same `Content-Range` semantics as before

#### Scenario: malformed Range keeps lenient behavior
- **WHEN** a client sends an unparseable Range header (e.g. `Range: bytes=abc`)
- **THEN** the response is `200` with the full body (Range ignored), unchanged from current behavior
