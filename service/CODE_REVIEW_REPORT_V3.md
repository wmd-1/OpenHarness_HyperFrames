# 后端代码审查报告 V3（对 V1/V2 的核验 + 演进后代码复审）

> 审查对象：`service/`（OpenHarness Video Service — FastAPI + Celery）
> 核验基线：`service/CODE_REVIEW_REPORT.md`（V1，2026-07-20，19 项）、`service/CODE_REVIEW_REPORT_V2.md`（V2，2026-07-21，V1 核验 + 新增 18 项）
> 审查日期：2026-07-21
> 范围：全部 `service/app/**/*.py` + `alembic/versions/**` + `tests/**` + openspec（已归档 `scale-multi-instance` / `phase3-multitenancy-temporal-lease` + **未归档** `harden-video-service-impl-fixes`）
> 方法：逐文件实读当前源码，逐条比对 V1/V2 结论并**重新定位行号**；识别 V1/V2 之后代码演进带来的新问题；对照 openspec 未归档变更的待办

---

## 0. 核验结论摘要（最重要）

**代码在 V1/V2 之后发生了显著演进。** V1/V2 审查的是 **Phase 1 形态**（无 `worker_id`/`s3.py`/`scheduler.py`/observability）。当前代码已合入 **已归档变更 `scale-multi-instance`**，新增了：

- `app/deps.py`、`app/storage/s3.py`、`app/observability/{logging,metrics,tracing}.py`
- `app/workers/{beat,identity,scheduler}.py`
- 迁移 `002_scale_multi_instance_columns.py`（`worker_id`/`attempt`/`heartbeat_at`/`cancellation_requested`/`priority`）、`003_storage_kind.py`
- 模型新增 `RETRYING` 状态、终态写 CAS 守卫、心跳/回收（reclaim）机制、S3 存储 + presigned、Prometheus/`/readyz`/structlog、优先级队列、渲染并发信号量

因此 **V1/V2 的部分结论已过时**。核验要点：

| 类别 | 数量 | 说明 |
|---|---|---|
| ✅ 已修复 | 6 | L1、O1 之外的心跳/回收类问题、N9（实质缓解）、可观测/S3/调度器等规格项已落地 |
| ⚠️ 部分修复 | 3 | S2（去掉 query key，但仍非常量时间）、N9（autodiscover 参数仍错，但显式 import 兜底）、N18（CAS 已实现但测试仍未覆盖真实竞态）、L3（回收守卫部分缓解） |
| ❌ 仍然存在 | 约 26 | S1/S3/N1/N2/N3/N4/N5/N6/N7/N8/N10/N11/N12/N13/N14/N15/N16/N17/S4/L2/L4/L5/P1/P2/P3/P4/P5/P6/O2/O3/O4 等 |
| 🆕 本次新增 | 9 | 见 §3，主要来自新合入的 `scale-multi-instance` 代码 |

> **一句话结论**：V1/V2 最严重的 **L1 取消竞态已通过 CAS 终态守卫真正修复**（`tasks.py:_mark_*` 全部带 `WHERE status='running'`）；但 **未归档变更 `harden-video-service-impl-fixes`（Draft）里列出的 P0 安全底线（S1 鉴权、S3 限流、N1 入队补偿、N3 取消 DB 兜底）至今仍未落地**，且新合入的多实例代码引入了 9 个新问题（最关键：`claim()` 定义了却未接入任务入口、S3 全量读入内存、并发信号量在 prefork 下失效）。

---

## 1. V1/V2 逐条核验（对照当前源码，行号已重新定位）

### 1.1 V1/V2 已修复项 ✅

| 编号 | 标题 | 当前状态 | 证据（当前行号） |
|---|---|---|---|
| **L1** | 取消竞态：worker 覆盖 CANCELED | ✅ **已修复** | `_mark_succeeded/_mark_failed/_mark_canceled` 全部改为条件 `UPDATE ... WHERE id AND status==RUNNING [AND worker_id]` 并校验 `rowcount==1`（`tasks.py:125-144, 147-169, 172-193`）；任务体在 `run_oh` 返回后先 `_abort_requested` 再落终态（`tasks.py:304-306`） |
| **N9** | autodiscover 参数错误 | ⚠️→✅ **实质缓解** | `autodiscover_tasks(["app.workers.tasks"])` 参数仍是模块名（`celery_app.py:59`，理论上不命中），但 `celery_app.py:64` `from app.workers import beat` 会链式 `import app.workers.tasks`（`beat.py:34`），从而注册 `generate_video`/`cleanup_expired_tasks`/`recover_lost_tasks`；`task_routes` 也已为 beat 任务指定 `normal` 队列（`celery_app.py:50-57`）。**建议仍按未归档任务 1.1 把参数改为 `["app.workers"]` 以消除隐式依赖** |
| — | 幂等并发插入 500 | ✅ **已加固** | `create_video` 捕获 `IntegrityError` 回滚并返回既有任务（`videos.py:126-145`），修复了 V2 隐含的幂等竞态 500 |
| R10 | 对象存储 + presigned | ✅ 已实现 | `storage/s3.py`、`storage_kind` 列、下载端点 302 redirect（`videos.py:210-217`） |
| R11 | 可观测性 | ⚠️ 部分实现 | Prometheus `/metrics`、`/readyz`、structlog 均已加入（见 §3.8 关于 worker 未配置 structlog 的缺陷） |
| R7-R9 | claim/心跳/回收 | ⚠️ 部分实现 | `beat.py` 心跳 + `recover_lost_tasks` + 终态 CAS 守卫已落地；但 `claim()` 未接入任务入口（见 §3.1） |

### 1.2 V1/V2 仍然存在的问题 ❌（当前行号）

| 编号 | 严重度 | 标题 | 当前证据 | 备注 |
|---|---|---|---|---|
| **S1** | 高 | 鉴权可选 + 无租户/归属隔离 | `main.py:52` `if settings.api_key:` 条件装配；`_get_task_or_404`（`videos.py:85-89`）无归属校验 | 未归档任务 0.4 未落地 |
| **S2** | 中 | API Key 非常量时间比较 | `main.py:58` `!= settings.api_key`（`?api_key=` query 兜底**已移除**，属部分修复） | 仍需 `hmac.compare_digest` |
| **S3** | 中 | 无速率限制 | 无 `app/ratelimit.py`，`create_video` 无限流 | 未归档任务 1.4 未落地 |
| **S4** | 低 | `extra_oh_args` 仅校验 flag 名不校验取值 | `security.py:72-81` 只判断 flag 名，值原样透传 | |
| **L2** | 中 | `TransientError` 死代码 | 全代码无 `raise TransientError`；`except Exception` 一律 `_mark_failed`（`tasks.py:338-342`） | `autoretry_for` 形同虚设 |
| **L3** | 中 | acks_late 重投重复执行 | 任务体仅在 `status==CANCELED` 早退（`tasks.py:253-254`），对 `RUNNING` 重投不处理 | 回收守卫部分缓解，见 §3.1 |
| **L4** | 低 | 入队未持久化 `celery_task_id` | `videos.py:149` `get_scheduler().enqueue(...)` 返回值被丢弃；仍由 worker 写回（`tasks.py:269`） | scheduler 已返回 id 但未持久化 |
| **L5** | 低 | Range 忽略 end | `videos.py:227-232` 仅解析 start，`Content-Length=size-start`（`videos.py:239`）恒到 EOF | |
| **N1** | 高 | 入队失败无补偿 → 孤儿 QUEUED | `videos.py:149` 无 try/except，broker 抖动时 500 且残留 QUEUED | 未归档任务 0.3 未落地 |
| **N2** | 高 | DELETE 把终态改 CANCELED 且不删行 | `videos.py:373` 对 SUCCEEDED/FAILED 一律 `status=CANCELED`，不删 DB 行 | 未归档任务 1.2 未落地 |
| **N3** | 高 | 取消完全依赖 Redis | `_abort_requested`（`tasks.py:196-202`）Redis 失败返回 `False`；DELETE 已写 `cancellation_requested=True`（`videos.py:332,352`）但**worker/watchdog 从不读该列**（见 §3.4） | 未归档任务 0.2 未落地 |
| **N4** | 中 | SSE 不校验 task 存在 | `video_events`（`videos.py:253`）不注入 db、不查存在性，任意 UUID 挂 `xread` | 未归档任务 2.1 未落地 |
| **N5** | 中 | `idempotency_key` 无长度校验 | `schemas.py:20` 无 `max_length`；DB 列 `String(256)` → 超长 500 | |
| **N6** | 中 | `created_at` 无索引 → cleanup 全表扫描 | `models.py:51-53` 无 `index`；无 `(created_at,status)` 复合索引 | |
| **N7** | 中 | runner stdout 无上限累积 | `runner.py:96-101,125` `lines` 全量累积 + `"".join(lines)` | OOM 风险 |
| **N8** | 中 | `preexec_fn=os.setsid` 多线程不安全 | `runner.py:71` | 应 `start_new_session=True` |
| **N10** | 中 | `api_key` 用 `str` 非 `SecretStr` | `config.py:74` | traceback/repr 泄露 |
| **N11** | 中 | 响应暴露 `output_path`/`log_tail` | `schemas.py:56,63`；`_to_response`（`videos.py:55,62`） | |
| **N12** | 低 | 超时被杀 exit_code 混淆 | `runner.py:109-118` 无 `timed_out` 标志；`tasks.py:310-317` 仅 `exited with code -15` | |
| **N13** | 低 | cleanup 单 session 整批回滚 | `tasks.py:351-385` 单 `with` 单 `commit` | |
| **N14** | 低 | `_append_log` Redis 失败逐行 warning | `tasks.py:75-80` | 日志风暴 |
| **N15** | 低 | watchdog 每 0.5s 一次 Redis GET | `runner.py:91` `time.sleep(0.5)` | |
| **N16** | 低 | 默认 DB 密码 `oh:oh` 明文 | `config.py:16-17` | |
| **N17** | 低 | `extra_oh_args` list 无长度限制 | `schemas.py:19` 无 `max_length` | ARG_MAX 风险 |
| **N18** | 低 | cancel-guard 测试虚假信心 | `test_worker.py:102-104` 仍全程 patch `_abort_requested=True`，命中 `tasks.py:304` 的预检分支，**未覆盖 `_mark_succeeded` 的 CAS 守卫本身** | CAS 已实现但无测试直接验证 |
| **P1** | 中 | 日志 Stream 无 MAXLEN | `tasks.py:78` `xadd` 无 `maxlen`；`_LOG_CAP=10000`（`tasks.py:66`）定义未用 | |
| **P2** | 中 | `_update_log_tail` 全量读 | `tasks.py:209` `r.xrange(...)` 全量 | 应 `XREVRANGE COUNT` |
| **P3** | 中 | SSE 阻塞占线程池 | `videos.py:283,297` `run_in_threadpool(r.xrange/r.xread)` 同步 redis | 应 `redis.asyncio` |
| **P4** | 低 | 同步引擎缺 `pool_pre_ping` | `tasks.py:55` `create_engine(..., pool_size=5, max_overflow=10)` 无 `pool_pre_ping` | 异步引擎有（`db.py:12`） |
| **P5** | 低 | 成功后 workspace 不即时清理 | `tasks.py:319-322` 成功后未 `rmtree(workspace)` | |
| **P6** | 低 | cleanup 1.x 风格全量加载 | `tasks.py:352-359` `db.query(...).all()` | |
| **O1** | 低 | `/healthz` degraded 仍 200 | `health.py:81-85` degraded 无 `status_code=503` | 未归档任务 3.5 未落地 |
| **O2** | 低 | 默认 DB host 不一致 | `config.py:16` `localhost` vs `config.py:19` `postgres` | |
| **O3** | 低 | fps 整数截断 | `parser.py:101` `int(int(num)/int(den))` | 30000/1001→29 |
| **O4** | 低 | `locate_output_file` 兜底选最新 mp4 | `parser.py:53` `rglob('*.mp4')` 取 mtime 最新 | 易误选中间产物 |

**小结**：V1/V2 共 37 项，其中 **L1 已真正修复**、N9 实质缓解、S2 部分修复；**其余约 26 项仍原样存在**，全部对应未归档变更 `harden-video-service-impl-fixes` 的 P0–P3 待办（该变更状态仍为 **Draft**，任务清单全部未勾选）。

---

## 2. 系统架构现状（演进后）

| 层 | 当前实现 | 相较 V1/V2 的变化 |
|---|---|---|
| API | FastAPI + 可选单 API Key + CORS 显式源 | 未变（S1/S2 仍待修） |
| 调度 | `scheduler.py`：`CeleryScheduler`（默认）/`TemporalScheduler`（占位）+ 优先级队列 high/normal/low | 🆕 新增可插拔调度器 |
| 队列 | Celery + Redis，`task_acks_late`、`prefetch=1`、`task_routes` | 🆕 队列分层 |
| DB | PostgreSQL 单表 `video_tasks` + `worker_id/attempt/heartbeat_at/cancellation_requested/priority/storage_kind` | 🆕 多实例列（迁移 002/003） |
| 所有权/回收 | `beat.py`：Redis 注册 + 心跳刷新 + `recover_lost_tasks` 幂等回收 + 终态 CAS 守卫 | 🆕 心跳/回收（非严格 lease） |
| 存储 | `LocalVideoStorage` + `S3VideoStorage`（presigned） | 🆕 S3 后端 |
| 可观测 | Prometheus `/metrics`、`/readyz`、structlog | 🆕（worker 侧未接通，见 §3.8） |
| 并发控制 | `render_semaphore`（每进程）+ `max_concurrent_renders` | 🆕（prefork 下失效，见 §3.3） |
| 鉴权/租户/限流/审计 | 仍无租户、无限流、无审计 | 未变 |

---

## 3. 本次新增发现（V1/V2 未覆盖，主要来自新合入代码）

| 编号 | 严重度 | 类别 | 标题 | 位置 |
|---|---|---|---|---|
| **X1** | 高 | 逻辑 | `claim()` 定义了却未接入任务入口，R7 原子认领未生效 | `tasks.py:83-108` vs `tasks.py:256-270` |
| **X2** | 中 | 性能 | S3 `open`/`save` 全量读入内存，大视频 OOM 且破坏流式 | `s3.py:48-58` |
| **X3** | 中 | 性能 | `render_semaphore` 在 prefork 下失效，`max_concurrent_renders` 非节点级上限 | `tasks.py:29,290` |
| **X4** | 中 | 逻辑 | `cancellation_requested` 只写不读，"持久化取消"名不副实（=N3 的强化证据） | `models.py:63` / `videos.py:332,352` / `tasks.py:196` |
| **X5** | 中 | 逻辑 | 心跳滞后导致的误回收 → 活着的 worker 被回收，重复渲染 | `beat.py:137-176` |
| **X6** | 低 | 逻辑 | 回收重投走 `delay()` 绕过 scheduler，丢失优先级队列路由 | `beat.py:173` |
| **X7** | 中 | 可观测 | worker 进程未调用 `configure_logging`，`bind_task_context` 从未被调用（死代码） | `main.py:21` / `logging.py:55` |
| **X8** | 低 | 稳定性 | `health._redis_ok` 在 async 端点内同步阻塞 `ping()`，阻塞事件循环 | `health.py:30-39` |
| **X9** | 低 | 迁移 | `ALTER TYPE taskstatus ADD VALUE 'RETRYING'` 在事务/旧版 PG 下有失败风险 | `002:56-57` |

### 3.1 X1 [高] `claim()` 未接入任务入口 — R7 原子认领形同虚设

**现状**：`tasks.py:83-108` 实现了原子认领 `claim(task_id, worker_id)`（`UPDATE ... WHERE status IN (QUEUED,RETRYING)` + `rowcount==1`），注释明确对应 OpenSpec `scale-multi-instance R7`。**但 `generate_video_task` 从不调用它**——任务体直接无条件写入（`tasks.py:260-262`）：

```python
task.worker_id = wid
task.status = TaskStatus.RUNNING          # ← 非原子，未用 claim()
task.started_at = datetime.now(timezone.utc)
```

且入口守卫仅对 `CANCELED` 早退（`tasks.py:253-254`），对 `RUNNING`/`RETRYING` 不做"是否已被他人认领"的判断。

**影响**：
1. `claim()` 是**死代码**，R7 声称的"并发 worker 中恰好一个成为 owner"未在真实路径生效。
2. 与 `acks_late` 叠加（L3）：worker 崩溃重投、或 `recover_lost_tasks` 把 RUNNING 翻成 RETRYING 后重投时，**若原 worker 仍存活**，新 worker 直接把 `status`/`worker_id` 覆盖为自己并再次 `run_oh` → **重复渲染、重复消耗 Chrome/算力**。终态写虽有 `worker_id` CAS 守卫（`tasks.py:126-127`）能保证 DB 状态不被旧 owner clobber，但**双重渲染已经发生**。

**修复建议**：任务入口改为
```python
wid = get_worker_id()
if not claim(task_id, wid):          # 原子认领；抢不到就是别人在跑
    logger.warning("task %s already owned; skip redelivery", task_id)
    return
```
并删除随后的无条件 `status=RUNNING` 赋值。这同时落地未归档任务 3.1（L3 重投跳过）。

### 3.2 X2 [中] S3 存储全量读入内存

**现状**（`s3.py`）：
```python
def save(self, task_id, src):
    with open(src, "rb") as fh:
        self._client.put_object(Bucket=..., Key=key, Body=fh.read())  # 整文件进内存
def open(self, key):
    resp = self._client.get_object(...)
    data = resp["Body"].read()          # 整对象进内存
    return io.BytesIO(data), size
```

**影响**：hyperframes 成品视频可达数十~数百 MB。
- worker 上传：整文件驻留内存，与 `max_concurrent_renders` 叠加放大。
- 下载 `mode=stream` 或 presigned 不可用时（`videos.py:219-220`）：API 进程把整个对象读入 `BytesIO`，`Range` 请求也是先全量拉取再 `seek`——**既 OOM 又完全丧失流式与 Range 的意义**。

**修复建议**：`save` 用 `upload_fileobj`（自动多段）；`open` 走 `get_object` 的流式 `Body`（`StreamingBody`）或对 Range 用 S3 的 `Range` 参数按需拉取，避免整对象入内存。

### 3.3 X3 [中] 渲染并发信号量在 prefork 下失效

**现状**：`render_semaphore = threading.BoundedSemaphore(settings.max_concurrent_renders)`（`tasks.py:29`）是**模块级、进程内**对象，在 `run_oh` 外 acquire（`tasks.py:290`）。Celery 以 prefork 启动（`docker/supervisord.conf` `-c 4`），每个子进程各持一份独立信号量；而 `prefetch=1` + 同步任务体使**每个子进程同一时刻只跑一个任务**，信号量（容量 4）在单进程内永不竞争。

**影响**：`max_concurrent_renders` **既不是节点级上限，实际也从未生效**。节点真实并发渲染数 = 子进程数（`-c N`），可达 `N`，与该配置项无关。运维以为设置了 4 实际可能跑到 8/16，Chrome/ffmpeg 内存不受控。

**修复建议**：并发上限应由 `-c`（worker 子进程数）表达，或改用**跨进程**的分布式信号量（Redis 计数器）来真正限制节点/集群级并发；否则移除该无效信号量以免误导。

### 3.4 X4 [中] `cancellation_requested` 只写不读

**现状**：迁移 002 增加了 `cancellation_requested` 列，DELETE 端点对 QUEUED/RUNNING 都会置 `True`（`videos.py:332,352`），注释称其为"持久化取消标志，可挺过 Redis 抖动"。**但整个 worker 与 runner 只通过 `_abort_requested`→Redis GET 判断取消**（`tasks.py:196-202`、`runner.py:88`），从不读取该 DB 列。

**影响**：这正是 **N3** 的强化证据——号称的"DB 兜底"根本没接通。Redis 不可用窗口内：`_abort_requested` 返回 `False` → worker 继续跑到 `_mark_succeeded`；由于 `status` 已被 DELETE 置 `CANCELED`，CAS 守卫 (`WHERE status==RUNNING`) 会命中 0 行阻止覆盖——**DB 状态侥幸正确，但 `oh` 进程不会被杀，白白跑到超时/结束**。

**修复建议**：落地未归档任务 0.2——`_abort_requested` 在 Redis 读失败时降级查询 DB `status==CANCELED` / `cancellation_requested==True`；watchdog 同理。

### 3.5 X5 [中] 心跳滞后导致误回收

**现状**：`recover_lost_tasks`（`beat.py:114-176`）把 `heartbeat_at < now-60s`（`STALE_AFTER=60`）且 owner 不在 Redis 存活集合中的 RUNNING 任务翻为 RETRYING 并重投。心跳由守护线程 `_liveness_loop` 每 10s 刷新（`beat.py:181-190`），刷新走 `_sync_session` 同步 DB 写。

**影响**：心跳线程若因 DB 连接阻塞/慢查询/进程 CPU 饱和而连续 >60s 未刷新，即便 worker 与其 `oh` 子进程仍在正常渲染，也会被判定"lost"→回收重投→**重复渲染**（与 X1 叠加）。owner 存活集合的 TTL=20s（`WORKER_REGISTRY_TTL`），刷新间隔 10s，注册线程同一循环内，也会一起卡住，使 owner 从存活集合消失，绕过 `worker_id.notin_(alive)` 保护。设计文档 §11.7 已承认此残余风险，但 60s 阈值对长渲染 + 心跳与注册同线程的实现偏激进。

**修复建议**：把 owner 注册与 DB 心跳拆到不同线程/更短超时容忍；或提高 `STALE_AFTER`、并在重投前对 owner 存活做二次确认；根治仍需 X1 的原子 claim + 严格 lease（R20）。

### 3.6 X6 [低] 回收重投绕过 scheduler 丢失优先级

`beat.py:173` `worker_tasks.generate_video_task.delay(str(tid))` 直接 `delay()`，未经 `get_scheduler().enqueue(..., priority=...)`，落到 `task_routes` 默认 `normal` 队列。高优先级任务被回收后降级为 normal。建议改走 `get_scheduler().enqueue(str(tid), priority=<task.priority>)`。

### 3.7 X7 [中] worker 侧结构化日志未接通 + `bind_task_context` 死代码

`configure_logging()` 仅在 API 的 `lifespan`（`main.py:21`）调用；**Celery worker 进程从不调用**（无 `worker_process_init`/`setup_logging` 钩子），因此 worker 里 `logging.getLogger(__name__)` 输出的是**非结构化**普通日志——而渲染日志恰恰主要产生在 worker。此外 `bind_task_context`（`logging.py:55`）**全代码从未被调用**，承诺的 `task_id/worker_id/attempt` 日志上下文从未绑定。R11 可观测性在 worker 侧基本是"装样子"。

**修复建议**：在 `beat.py` 的 `worker_process_init` 里调用 `configure_logging()`；在 `generate_video_task` 入口 `bind_task_context(task_id, wid, attempt)`。

### 3.8 X8 [低] `/healthz` 中同步 Redis ping 阻塞事件循环

`health._redis_ok`（`health.py:30-39`）在 `async def` 中直接执行同步 `redis_lib.from_url(...).ping()`，未 `run_in_threadpool`/`asyncio.to_thread`（对比 `_s3_ok` 已用 `asyncio.to_thread` 且带 2s 超时）。Redis 变慢时该调用阻塞事件循环，且无超时。建议与 `_s3_ok` 一致地下放线程 + 限时。

### 3.9 X9 [低] `RETRYING` 枚举迁移的事务风险

`002:56-57` 对 PostgreSQL 执行 `ALTER TYPE taskstatus ADD VALUE 'RETRYING'`。在 PG 12 以前 `ADD VALUE` 不能在事务块内执行，而 Alembic 默认将迁移包裹在事务中；即便 PG 12+ 允许，新枚举值也不能在**同一事务**内立即使用。当前该迁移未在同事务内使用新值，PG 12+ 通常可过，但对旧版本或开启事务 DDL 的环境存在失败风险。建议在迁移中显式 `with op.get_context().autocommit_block():` 包裹该语句。

---

## 4. 与 openspec 的对照

### 4.1 已归档（视为已实现的规格） ✅

- `archive/scale-multi-instance/`：多实例列、心跳/回收、S3、可观测、优先级队列、并发信号量、终态 CAS 守卫——**大部分已在代码落地**（但存在 X1/X3/X7 等接入缺陷）。
- `archive/harden-hyperframes-video-service/`、`archive/phase3-multitenancy-temporal-lease/`：设计层规格，代码尚未实现租户/严格 lease/Temporal（`TemporalScheduler` 仅占位）。

### 4.2 未归档（**仍需修正**） ⚠️ — `changes/harden-video-service-impl-fixes/`（Draft）

该变更把 V1/V2 的 37 项发现整理成 22 条 ADDED + 4 条 MODIFIED 规格与 P0–P3 TDD 任务，**任务清单全部未勾选**。经与当前代码核对，其完成度：

| 阶段 | 任务 | 当前状态 |
|---|---|---|
| P0 | 0.1 终态 CAS 守卫 + 修正 cancel 测试 | ⚠️ CAS **已实现**；测试 `test_worker.py:93` **仍未覆盖真实 TOCTOU/CAS 守卫**（N18 未闭环） |
| P0 | 0.2 `_abort_requested` DB 兜底（N3） | ❌ 未做（见 X4） |
| P0 | 0.3 入队失败补偿（N1） | ❌ 未做 |
| P0 | 0.4 `require_auth` + 常量时间 + 去 query key（S1/S2） | ⚠️ query key 已去除；`require_auth`/常量时间 **未做** |
| P1 | 1.1 autodiscover 参数（N9） | ⚠️ 参数仍错，靠显式 import 兜底 |
| P1 | 1.2 DELETE 保留终态（N2） | ❌ 未做 |
| P1 | 1.3 Stream MAXLEN + 尾部有界读（P1/P2） | ❌ 未做 |
| P1 | 1.4 限流（S3） | ❌ 未做（无 `ratelimit.py`） |
| P1 | 1.5 TransientError 分类（L2） | ❌ 未做 |
| P2 | 2.1 SSE 异步 redis + 校验存在（P3/N4） | ❌ 未做 |
| P2 | 2.2 输入长度/类型校验（N5/N17/S4） | ❌ 未做 |
| P2 | 2.3 `(created_at,status)` 索引（N6） | ❌ 未做 |
| P2 | 2.4 stdout 上限 + `start_new_session` + `timed_out`（N7/N8/N12） | ❌ 未做 |
| P2 | 2.5 `SecretStr` + 隐藏 `output_path`（N10/N11） | ❌ 未做 |
| P3 | 3.1–3.6（L3/L4/L5/P4/P5/P6/N13/O1-O4/N12/N14/N15/N16） | ❌ 未做（L3 仅被回收机制部分缓解） |

> 结论：**未归档变更几乎整体未实施**，仅 0.1 的 CAS 部分（借由 scale-multi-instance 顺带落地）与 0.4/1.1 的一小部分被动完成。**它仍是当前最应推进的修复清单**，且需在其基础上补入本报告的 X1–X9。

---

## 5. 修复优先级路线图（V3 合并）

| 优先级 | 问题 | 工作量 | 说明 |
|---|---|---|---|
| **P0** | S1 强制鉴权（`require_auth`）+ 任务归属校验 | 中 | 安全底线；越权读/删 |
| **P0** | N1 入队失败补偿（scheduler.enqueue 包 try/except → FAILED + 503） | 小 | 防孤儿 QUEUED |
| **P0** | N3 + X4 取消 DB 兜底（`_abort_requested`/watchdog 读 DB） | 中 | 取消可靠性；Redis 抖动 |
| **P0** | X1 任务入口接入 `claim()` + L3 重投跳过 | 小 | 消除重复渲染，激活 R7 |
| **P1** | N2 DELETE 保留终态语义 | 小 | 状态机正确性 |
| **P1** | P1/P2 Stream MAXLEN + 尾部有界读 | 小 | Redis 内存 |
| **P1** | S3 限流（Redis 令牌桶，全局底线） | 中 | 防 DoS |
| **P1** | L2 TransientError 分类触发重试 | 小 | 可用性 |
| **P1** | X2 S3 流式上传/下载（改多段 + StreamingBody） | 中 | 防 OOM，恢复 Range |
| **P2** | P3 + N4 SSE 异步 redis + 校验存在 | 中 | 防线程池雪崩 |
| **P2** | S2 常量时间校验 + N10 SecretStr + N11 隐藏 output_path | 小 | 鉴权/信息泄露加固 |
| **P2** | N6 `(created_at,status)` 索引 + N7 stdout 上限 + N8 `start_new_session` | 小 | 性能/安全 |
| **P2** | N5/N17/S4 字段长度 + flag 取值类型校验 | 小 | 输入校验 |
| **P2** | X3 并发上限改跨进程/或以 `-c` 表达 | 中 | 节点内存可控 |
| **P3** | X5 心跳/回收调优（拆线程、阈值、二次确认） | 中 | 减少误回收 |
| **P3** | X7 worker 侧 structlog + bind_task_context | 小 | 可观测性 |
| **P3** | X6/X8/X9 + L4/L5/P4/P5/P6/N12-N16/O1-O4 | 小-中 | 打磨/健壮性 |
| **P4** | R14/R15/R16/R17/R18/R20 租户/严格 lease/审计/配额/Temporal | 大 | 独立立项 |

---

## 6. 测试覆盖缺口（关键）

| 缺口 | 相关问题 | 建议 |
|---|---|---|
| CAS 守卫本身未被直接测试 | L1/N18 | 直接对非 RUNNING 行调用 `_mark_succeeded`，断言 `rowcount==0` 不覆盖 |
| `claim()` 未接入 → 无重投并发测试 | X1/L3 | 模拟同一 task 两个 worker 认领，断言仅一个 `run_oh` |
| Redis 不可用取消失效未测 | N3/X4 | mock `_redis_client` 抛异常 + DB 置 CANCELED，断言 abort=True |
| 入队失败补偿未测 | N1 | mock `enqueue` 抛异常，断言任务 FAILED + 503 |
| DELETE 终态语义未测 | N2 | DELETE 一个 SUCCEEDED，断言状态仍 SUCCEEDED |
| SSE 不存在 task 未测 | N4 | 随机 UUID → 断言 404 |
| S3 大对象内存/Range 未测 | X2 | 断言下载不整对象入内存、Range 精确 |
| 心跳滞后误回收未测 | X5 | 构造 owner 存活但 heartbeat 陈旧，断言不被误回收 |
| 无鉴权/限流测试 | S1/S3 | 无 key/错 key/超频 → 401/429 |

---

## 7. 总结

1. **V1/V2 的核心结论仍基本成立，但需按当前代码更新**：最严重的 **L1 取消竞态已通过终态 CAS 守卫真正修复**；N9 实质缓解；S2 部分修复。其余约 26 项（含 S1/S3/N1/N2/N3/N4 等 4 个高危）**原样存在**。
2. **未归档变更 `harden-video-service-impl-fixes`（Draft）是权威待办清单，但几乎整体未实施**——应作为主线推进，P0 四项（S1、N1、N3、CAS 测试闭环）最紧急。
3. **新合入的多实例代码引入 9 个新问题**，其中最关键的 **X1（`claim()` 未接入，R7 名存实亡 + 重复渲染）**、**X2（S3 全量入内存）**、**X3（并发信号量失效）** 属功能性/资源性缺陷，需与 P0 一并处理。
4. **可观测性在 worker 侧未真正接通**（X7），S3/心跳/回收虽已落地但存在接入与调优缺陷。

**建议动作**：先合入 P0（S1 鉴权 + N1 补偿 + N3/X4 取消兜底 + X1 claim 接入 + CAS 测试闭环），再按路线图推进 P1/P2；租户/严格 lease/审计/Temporal（R14-R20）另行立项。

---

*报告完。如需针对任一 P0 项（建议 X1 + N1 + N3）直接提交代码修复与配套测试，请告知。*
