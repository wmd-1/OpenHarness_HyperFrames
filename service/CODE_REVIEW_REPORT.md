# 后端代码审查报告 — `service/`（OpenHarness Video Service）

> 审查对象：`d:\WorkBuddy-Workspace\Openharness_hyperframes_Development\OpenHarness_HyperFrames\service`
> 审查日期：2026-07-20
> 范围：FastAPI 应用（`app/`）、Celery Worker（`app/workers/`）、存储抽象（`app/storage/`）、配置/安全（`config.py`/`security.py`）、Alembic 迁移、测试
> 配套文档：`plans/`、`openspec/`（Phase 3 多租户 + Temporal + 严格 Lease 设计）

---

## 1. 系统架构概览

| 层 | 技术 | 说明 |
|---|---|---|
| API | FastAPI（async）+ Uvicorn | 任务提交、状态查询、Range 下载、SSE 日志、取消/删除 |
| 任务队列 | Celery + Redis（broker & result backend） | `generate_video_task` 渲染任务、`cleanup_expired_tasks` 周期任务 |
| 持久化 | PostgreSQL（asyncpg + psycopg 双引擎） | `video_tasks` 表（见 `001_initial_video_tasks.py`） |
| 日志流 | Redis Stream（`oh:logs:<id>`） | 渲染日志实时推送、SSE 重放 |
| 存储 | 本地/共享卷 `LocalVideoStorage` | `<video_dir>/<task_id>.mp4` |
| 执行 | 子进程 `oh -p <prompt>` + chrome-headless-shell | `runner.py` 进程组管理 |

**核心流程**：`POST /v1/videos` → 幂等校验 → 写库（QUEUED）→ `generate_video_task.delay()` → worker 调 `oh` 渲染 → `ffprobe` 探测 → 落库（SUCCEEDED/FAILED）→ Redis 写 `__DONE__` 标记 → SSE/下载可消费。

**整体评价**：模块边界清晰，关键防护（幂等、CORS 非通配+凭证、flag 白名单、`oh` 用 argv 列表避免 shell 注入、进程组 kill 取消）做得扎实。但**鉴权/多租户、取消竞态、Celery 重试与重投、日志 Stream 无界增长、线程池占用**等方面存在需修复的问题。当前代码为 Phase 1 形态，Phase 3 规划的 tenant/lease/scheduler 尚未实现。

---

## 2. 发现的问题清单（按严重程度）

| 编号 | 严重度 | 类别 | 标题 | 位置 |
|---|---|---|---|---|
| S1 | 高 | 安全 | 缺鉴权与租户隔离，任意任务可被越权读/删 | `main.py:45`, `videos.py:69` |
| S2 | 中 | 安全 | API Key 非常量时间比较 + query 参数泄露 | `main.py:51-52` |
| S3 | 中 | 安全 | 无速率限制/配额 → 资源耗尽 DoS | `videos.py:79` |
| S4 | 低 | 安全 | `extra_oh_args` 仅校验 flag 名未校验取值 | `security.py:74-78` |
| L1 | 高 | 逻辑 | 取消竞态：worker 状态写覆盖 CANCELED | `tasks.py:212`, `tasks.py:73-104` |
| L2 | 中 | 逻辑 | `TransientError` 自动重试为死代码 | `tasks.py:153-164,245-249` |
| L3 | 中 | 逻辑 | `acks_late=True` 无 worker 守卫 → 崩溃重投重复执行 | `celery_app.py:19`, `tasks.py:177` |
| L4 | 低 | 逻辑 | 入队未持久化 `celery_task_id`，revoke 窗口脆弱 | `videos.py:131` |
| L5 | 低 | 逻辑 | Range 忽略 end，始终读到 EOF | `videos.py:190-208` |
| P1 | 中 | 性能 | 日志 Redis Stream 无 `MAXLEN` 上限 | `tasks.py:56,68,233` |
| P2 | 中 | 性能 | `_update_log_tail` 全量读取 Stream | `tasks.py:129-137` |
| P3 | 中 | 性能 | SSE 全量重放 + 阻塞 `xread` 占用线程池 | `videos.py:249-278` |
| P4 | 低 | 性能 | 同步引擎缺 `pool_pre_ping` | `tasks.py:45` |
| P5 | 低 | 性能 | 成功后 workspace 不即时清理，磁盘累积 | `tasks.py:226-229` |
| P6 | 低 | 性能 | `cleanup` 用 1.x 风格且一次性全量加载 | `tasks.py:259-266` |
| O1 | 低 | 其它 | 健康检查 degraded 仍返 200 | `health.py:37` |
| O2 | 低 | 其它 | 默认配置 host 不一致（localhost vs postgres） | `config.py:16,19` |
| O3 | 低 | 其它 | `probe_mp4` fps 整数截断 | `parser.py:101` |
| O4 | 低 | 其它 | `locate_output_file` 兜底选最新 mp4 易误选中间产物 | `parser.py:53` |

---

## 3. 详细分析与修复建议

### S1 [高] 缺乏鉴权与租户隔离

**现状**：
- `main.py:44-56` 的 API Key 中间件是**条件装配**——只有当 `settings.api_key` 非空时才启用。若部署时未设置 `OH_API_KEY`，整个 API 无鉴权。
- 所有按 `task_id` 访问的接口（`videos.py:69` `_get_task_or_404`）只判断任务是否存在，**不做归属/租户校验**。任意调用方只要知道 UUID，即可：
  - `GET /{id}` 读取 prompt、日志、元数据；
  - `GET /{id}/file` 下载成品视频；
  - `DELETE /{id}` 删除文件与 workspace（`videos.py:328-342`）。

**影响**：越权访问、数据泄露、任意删除他人产物；无多租户隔离，无法满足按客户隔离/计费/审计的合规要求。

**修复建议**：
1. 默认强制鉴权（至少生产环境）：未配置 key 时启动即报错或拒绝非健康端点。
2. 引入 `tenant_id`/`owner` 字段，在 `_get_task_or_404` 及所有写路径加归属过滤（采用 Phase 3 规划的 PostgreSQL RLS 或集中查询层）。
3. 越权访问返回 `404`（不泄露存在性）而非 `403`。

```python
# 示例：带归属校验的取值（伪代码）
async def _get_owned_task(task_id, db, tenant_id) -> VideoTask:
    task = await db.get(VideoTask, task_id)
    if task is None or task.tenant_id != tenant_id:
        raise HTTPException(404, "Task not found")
    return task
```

---

### S2 [中] API Key 校验时序攻击 + query 泄露

**现状**（`main.py:51-52`）：
```python
provided = request.headers.get("X-API-Key") or request.query_params.get("api_key")
if provided != settings.api_key:          # 非常量时间比较
    return JSONResponse(401, ...)
```
- `!=` 为字节序短路比较，可被时序侧信道爆破。
- 允许 `?api_key=...` query 传参，会进入网关/代理 access log、浏览器历史、Referer。

**修复建议**：
```python
from hmac import compare_digest
key = request.headers.get("X-API-Key")
if not key or not compare_digest(key, settings.api_key):
    return JSONResponse(401, {"detail": "Invalid API key"})
# 删除 query_params 兜底
```

---

### S3 [中] 无速率限制 / 配额 → 资源耗尽

**现状**：`create_video`（`videos.py:79`）直接建任务，无限流。每个任务会拉起 `oh` 子进程 + chrome-headless-shell（重 CPU/内存/磁盘）。

**影响**：单客户端无限提交即可耗尽 worker、文件描述符、DB 连接与磁盘；属于典型的资源耗尽型 DoS。

**修复建议**：
- 接入限流中间件（推荐 Redis 共享存储后端，因 Phase 2 已支持 `api×N` 副本，内存计数器会在多副本下失效——见 Phase 3 计划 D2）。
- 增加每租户并发上限（`running+pending`）、日提交上限、请求体大小限制。

---

### S4 [低] `extra_oh_args` 取值未校验

**现状**（`security.py:74-78`）：白名单只校验 flag 名称，`--model`/`--temperature`/`--max-turns` 的**值**原样透传。argv 列表传参无 shell 注入风险，但缺乏纵深防御（如 `--temperature not_a_number` 直接传给 `oh`）。

**建议**：对取值型 flag 增加基础类型/范围校验。

---

### L1 [高] 取消竞态：worker 状态写覆盖 CANCELED

**现状**：
1. `DELETE /{id}` 对 `RUNNING` 任务：`videos.py:308-320` 设置 `oh:abort:{id}`、并尝试 `revoke`，随后把 DB 状态写为 `CANCELED` 并提交。
2. 与此同时 worker 在 `tasks.py:212` 检查 abort 标志，**若此时尚未置位（或检查通过）**，继续走到 `_mark_succeeded`（`tasks.py:73-91`）。

**问题**：`_mark_succeeded/_mark_failed/_mark_canceled` 全部是**无条件状态覆盖**，没有基于当前状态的 `WHERE status='running'` 守卫。因此存在 TOCTOU 窗口：用户取消 → worker 在检查之后才写入 `SUCCEEDED`，最终状态被覆盖为成功。

**影响**：用户已取消的任务却显示成功，状态机不一致；在不可重复渲染/合规场景下风险更高。

**修复建议**：改为条件（乐观锁/CAS）更新：
```python
from sqlalchemy import update
stmt = update(VideoTask).where(
    VideoTask.id == task_id,
    VideoTask.status == TaskStatus.RUNNING,   # 仅在仍运行时落终态
).values(status=TaskStatus.SUCCEEDED, ...)
result = db.execute(stmt)
if result.rowcount == 0:
    return  # 已被取消/抢占，放弃写入
db.commit()
```
三处终态写（`_mark_succeeded/_mark_failed/_mark_canceled`）统一加此守卫，与 Phase 3 WS-C 的 fence 思路一致。

---

### L2 [中] `TransientError` 自动重试为死代码

**现状**：`tasks.py:157-164` 配置了 `autoretry_for=(TransientError,)` + `retry_backoff` + `max_retries=2`，但全代码**没有任何位置抛出 `TransientError`**。`tasks.py:245-249` 把所有异常 `except Exception` 吞掉并标记 `FAILED` 后 `return`，瞬时故障（DB/Redis 抖动）被当作永久失败。

**影响**：重试机制形同虚设，基础设施瞬时故障导致任务直接失败，浪费用户渲染额度。

**修复建议**：
```python
from sqlalchemy.exc import OperationalError
except (redis.ConnectionError, OperationalError) as exc:
    raise TransientError(...) from exc   # 触发 autoretry
```

---

### L3 [中] `acks_late=True` 无 worker 守卫 → 崩溃重投重复执行

**现状**：`celery_app.py:19` 开启 `task_acks_late=True`。worker 在 `run_oh` 执行期间崩溃时，消息在 ACK 前不会确认，会被 broker 重投。`generate_video_task`（`tasks.py:172-184`）仅在 `status == CANCELED` 时早退，**对 `RUNNING` 状态不处理**。

**影响**：重投后任务从 `RUNNING` 再次拉起 `oh`，重复消耗算力并覆盖产物。

**修复建议**：引入 worker 心跳/租约（Phase 3 WS-C 的 `lease_token` / heartbeat reclaim），重投时判断是否仍被活跃 worker 持有；或在任务开始处用行锁认领（claim）并校验是否为自己持有。

---

### L4 [低] 入队未持久化 `celery_task_id`

**现状**：`videos.py:131` `generate_video_task.delay(str(task.id))` 返回值被丢弃；task id 改由 worker 在 `tasks.py:182` 写回。

**影响**：入队到 worker 启动之间，若 `DELETE` 一个 `QUEUED` 任务，`videos.py:294` 因 `celery_task_id` 为空跳过 `revoke`，只能靠 worker 的 CANCELED 早退兜底，revoke 窗口脆弱。

**建议**：入队后立即持久化 `self.request.id` 等价物（可在 `.delay()` 后从 AsyncResult 取 id 写库）。

---

### L5 [低] Range 请求忽略 end

**现状**（`videos.py:190-208`）：仅解析 start，`bytes=100-200` 会从 100 一直返回到 EOF，且 `Content-Range` 依此计算。

**影响**：视频拖拽 seek 语义不精确，多传数据。

**建议**：解析 end（默认 EOF），按 `[start, end]` 计算 `Content-Length` 与 `Content-Range`；`/file` 端点 `storage.open` 当前返回整个文件句柄，`_iterfile` 需支持在 end 处停止。

---

### P1 [中] 日志 Redis Stream 无上限

**现状**：`tasks.py:56` 定义了 `_LOG_CAP = 10000` 但**从未使用**；`XADD`（`tasks.py:68`、`tasks.py:233`）未设 `MAXLEN`。

**影响**：长任务日志无限堆积占用 Redis 内存；cleanup 仅每日执行一次。

**修复建议**：
```python
r.xadd(f"oh:logs:{task_id}", {"line": line}, maxlen=_LOG_CAP, approximate=True)
```

---

### P2 [中] `_update_log_tail` 全量读取

**现状**（`tasks.py:129-137`）：`r.xrange(key, "-", "+")` 拉全量条目 → 全部 join 成字符串 → 仅取尾部 16KB（`log_tail_bytes`）。

**影响**：日志大时 O(n) 内存与耗时。

**修复建议**：用 `XREVRANGE key + - COUNT 200` 从尾部有界读取后反转拼接；或 `XLEN` + `XRANGE key - + COUNT` 分页取尾段。

---

### P3 [中] SSE 全量重放 + 阻塞调用占线程池

**现状**（`videos.py:249`）：每次连接全量重放历史日志；`videos.py:263` 用 `run_in_threadpool(r.xread, ..., block=5000)` 执行**阻塞** Redis 调用。文件下载 `_iterfile`（`videos.py:160`）同样占用线程池。

**影响**：anyio 默认线程池约 40。大量并发 SSE/下载会耗尽线程池，导致所有请求（含健康检查）阻塞，服务雪崩。

**修复建议**：
1. SSE 改用 `redis.asyncio.Redis`（原生异步），`xread` 不占线程池。
2. 限制历史重放条数（如最多 500 行）。
3. 下载流仍可用线程池，但确保线程池容量与并发下载数匹配（或同样异步化底层 IO）。

---

### P4 [低] 同步引擎缺 `pool_pre_ping`

**现状**：`tasks.py:45` `create_engine(settings.db_sync_url, pool_size=5, max_overflow=10)` 未设 `pool_pre_ping=True`；而异步引擎 `db.py:11` 有。

**影响**：PostgreSQL 重启/连接超时后，worker 可能拿到失效连接并报错。

**建议**：同步引擎加 `pool_pre_ping=True`。

---

### P5 [低] 成功后 workspace 不即时清理

**现状**：成功落库后（`tasks.py:226-229`）仅复制成品到 `video_dir`，原始 workspace 与源 mp4 保留至每日 `cleanup_expired_tasks` 按保留期删除。

**影响**：磁盘长期压力，尤其大批量任务。

**建议**：成功后 `shutil.rmtree(workspace)`（保留 DB 记录与 `output_path` 指向的成品）。

---

### P6 [低] `cleanup` 用 1.x 风格且全量加载

**现状**（`tasks.py:259-266`）：`db.query(VideoTask).filter(...).all()` 一次性加载全部到期任务到内存再逐条处理。

**建议**：改用 SQLAlchemy 2.0 `select`；按主键分批（如每 500 条一提交），降低内存峰值。

---

### O1 [低] 健康检查 degraded 仍返 200

**现状**（`health.py:37`）：`overall` 为 `degraded` 时 HTTP 仍为 200。

**影响**：k8s readiness/liveness 探针无法据此摘流量，故障副本继续接流。

**建议**：degraded 返回 503（或暴露独立 `/readyz`）。

---

### O2 [低] 默认配置 host 不一致

`config.py:16` `db_url` 为 `localhost`，`config.py:19` `db_migration_url` 为 `postgres`。非容器环境跑迁移会连不上。

**建议**：统一通过环境变量覆盖，避免硬编码 host 差异。

---

### O3 [低] `probe_mp4` fps 整数截断

`parser.py:101` `int(int(num)/int(den))` 使 `30000/1001≈29.97` 变成 `29`。

**建议**：保留一位小数或存 `r_frame_rate` 原始串。

---

### O4 [低] `locate_output_file` 兜底选最新 mp4

`parser.py:53` 在正则未命中时 `rglob('*.mp4')` 取 mtime 最新，可能误选 workspace 内的中间/预览产物。

**建议**：优先从 `oh` 明确输出路径；兜底时排除已知临时目录、校验文件大小/编码。

---

## 4. 与 Phase 3 规划的衔接

`plans/Phase3_Multi-Tenancy_Temporal_Lease_3217f912.md` 与 `Phase3_Review_2026-07-14.md` 已规划多租户（WS-A）、Temporal 迁移（WS-B）、严格 Lease/Fencing（WS-C）。本次审查发现的问题与规划的对应关系：

- **S1（鉴权/隔离）** → 直接对应 WS-A 的 API Key 中间件、`tenant_id` 隔离、RLS/集中查询层；是 WS-A 的**前置必须项**。
- **L1/L3（取消竞态、重投重复）** → 对应 WS-C 的 `lease_token` fence 与 heartbeat reclaim；建议在 WS-C 落地时统一加 `WHERE status='RUNNING'` 条件写守卫（见审查 F3 思路）。
- **S3（限流）** → 对应 WS-A 配额，且务必使用 **Redis 共享 limiter backend**（Phase 3 计划 D2），避免多副本下限额翻倍失效。
- **P3（SSE 线程池）** → 与 WS-B Temporal 路径无关，但属横向扩展（api×N）下的稳定性 prerequisites，应在 WS-A/WS-C 验收前修复。

> 注：Phase 3 审查报告（F1–F5/D1–D5）聚焦设计文档正确性，已自我修复一致；**但当前代码尚未实现这些设计**（无 `tenant_id`/`lease_token`/`scheduler.py`/`s3.py`）。代码层与文档层存在「规划超前于实现」的落差，落地时需以本报告发现的实际代码问题为准。

---

## 5. 修复优先级路线图

| 优先级 | 问题 | 预估工作量 | 说明 |
|---|---|---|---|
| **P0（必须）** | S1 强制鉴权 + 任务归属校验 | 中 | 安全底线，阻断越权读/删 |
| **P0（必须）** | L1 取消竞态：条件更新状态 | 小 | 状态一致性，加 `WHERE status='running'` |
| **P1（重要）** | P1/P2 日志 Stream 有界 + 尾部有界读取 | 小 | 防止 Redis 内存膨胀 |
| **P1（重要）** | S3 限流/配额 + L2 重试语义修正 | 中 | 稳定性与可用性 |
| **P2（建议）** | P3 SSE 改异步 redis 客户端 | 中 | 防止线程池耗尽雪崩 |
| **P2（建议）** | S2 常量时间校验 + 去掉 query key | 小 | 加固鉴权 |
| **P3（优化）** | L3 重投守卫、P4 pre_ping、P5 即时清理 | 小-中 | 健壮性/资源 |
| **P3（优化）** | O1–O4 健康检查/配置/fps/产物定位 | 小 | 打磨 |

---

## 6. 建议补充的测试

- **安全**：无 key / 错误 key → 401；跨 UUID 访问他人任务 → 404；`?api_key=` 被拒。
- **竞态**：并发「运行 + 取消」确定性测试，断言最终状态一致（不会覆盖成 SUCCEEDED）。
- **重试**：mock DB/Redis 抖动，断言 `TransientError` 触发重试且最终成功。
- **重投**：模拟 worker 崩溃后重投，断言不重复渲染（需 lease/claim 机制）。
- **Stream 边界**：长日志断言 `XADD` 带 `MAXLEN`；`_update_log_tail` 仅取尾部。
- **SSE 并发**：多客户端同时连接断言不耗尽线程池（异步 redis 下）。

---

*报告完。如需针对某一项（建议优先 S1 + L1）直接提交代码修复，请告知。*
