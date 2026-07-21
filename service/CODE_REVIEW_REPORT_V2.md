# 后端代码审查报告 V2（核验 + 扩展版）

> 审查对象：`service/`（OpenHarness Video Service — FastAPI + Celery）
> 核验基线：`service/CODE_REVIEW_REPORT.md`（V1，2026-07-20）
> 核验日期：2026-07-21
> 范围：全部 `service/app/**/*.py` + `alembic/` + `tests/` + 历史规格 `openspec/specs/video-service-hardening.md`（R1–R20）+ `plans/`
> 方法：逐文件实读源码，逐条比对 V1 报告的行号与结论；对照规格基线核对实现差距；扫描测试覆盖缺口

---

## 0. 核验结论摘要

### V1 报告的 19 项发现 — 核验结果

| V1 编号 | 标题 | 核验 | 备注 |
|---|---|---|---|
| S1 | 缺鉴权与租户隔离 | ✅ 已确认 | `main.py:45` 条件装配；`videos.py:69` 无归属校验 |
| S2 | API Key 时序攻击 + query 泄露 | ✅ 已确认 | `main.py:51-52` `!=` 比较 + `query_params.get` |
| S3 | 无速率限制 | ✅ 已确认 | 全代码无限流 |
| S4 | extra_oh_args 取值未校验 | ✅ 已确认 | `security.py:78` 透传原值 |
| L1 | 取消竞态 | ✅ 已确认 + **强化** | 见 §3.1，测试覆盖有虚假信心 |
| L2 | TransientError 死代码 | ✅ 已确认 | 全代码无 `raise TransientError` |
| L3 | acks_late 重投重复 | ✅ 已确认 | `tasks.py:177` 仅 CANCELED 守卫 |
| L4 | 入队未持久化 celery_task_id | ✅ 已确认 | `videos.py:131` 丢弃返回值 |
| L5 | Range 忽略 end | ✅ 已确认 | `videos.py:195` 仅解析 start |
| P1 | Stream 无 MAXLEN | ✅ 已确认 | `_LOG_CAP` 定义未用 |
| P2 | _update_log_tail 全量读 | ✅ 已确认 | `tasks.py:133` xrange 全量 |
| P3 | SSE 阻塞线程池 | ✅ 已确认 | `videos.py:249,263` run_in_threadpool |
| P4 | 同步引擎缺 pre_ping | ✅ 已确认 | `tasks.py:45` |
| P5 | workspace 不即时清理 | ✅ 已确认 | `tasks.py:226-229` 仅复制 |
| P6 | cleanup 1.x 风格全量加载 | ✅ 已确认 | `tasks.py:259` db.query |
| O1 | healthz degraded 200 | ✅ 已确认 | `health.py:37` |
| O2 | config host 不一致 | ✅ 已确认 | `config.py:16,19` |
| O3 | fps 截断 | ✅ 已确认 | `parser.py:101` |
| O4 | locate_output 兜底选最新 | ✅ 已确认 | `parser.py:53` |

**V1 全部 19 项结论属实，行号准确。**

### 本次核验新增 18 项发现（V1 未覆盖）

详见 §2。其中 **3 项高严重度**（N1/N2/N3）、**7 项中严重度**、**8 项低严重度**。

---

## 1. 系统架构与现状

| 层 | 实现 | 规格基线要求 | 差距 |
|---|---|---|---|
| API | FastAPI + 单可选 API Key | R15 每 tenant 哈希 key | 无 tenant/哈希/吊销 |
| 鉴权 | `main.py:45` 条件装配 | R15 强制 | 可选 = 默认无鉴权 |
| 任务队列 | Celery + Redis | R19 可插拔（Celery/Temporal） | `TemporalScheduler` 未实现 |
| DB | PostgreSQL，单表 `video_tasks` | R7/R8/R14/R20 需 `worker_id`/`heartbeat_at`/`lease_token`/`tenant_id` | **均无** |
| claim/reclaim | 无 | R7/R8/R9 原子条件 UPDATE + heartbeat | **完全缺失** |
| 存储 | `LocalVideoStorage` | R10 需 `S3VideoStorage` + `presigned_url` | 无 S3 实现 |
| 可观测 | 仅 `/healthz` + 基础 logging | R11 Prometheus/structlog/`/readyz` | **完全缺失** |
| 并发控制 | Celery `-c 4` | R13 优先级队列 + `MAX_CONCURRENT_RENDERS` 信号量 | 无优先级队列/信号量 |
| 审计 | 无 | R17 audit_log | **完全缺失** |
| 限流 | 无 | R18 per-tenant rate limit | **完全缺失** |

**核心结论**：当前代码为 **Phase 1 形态**；`openspec/specs/video-service-hardening.md` 的 R7–R20 在代码中**均未实现**。规格文档（Phase 2/3 规划）远超当前实现，存在「文档超前于代码」的显著落差。

---

## 2. 新增问题清单（V1 未覆盖）

| 编号 | 严重度 | 类别 | 标题 | 位置 |
|---|---|---|---|---|
| N1 | 高 | 逻辑 | 入队失败无补偿 → 孤儿 QUEUED 任务永久卡死 | `videos.py:131` |
| N2 | 高 | 逻辑 | DELETE 把 SUCCEEDED/FAILED 改成 CANCELED，且不删 DB 行 | `videos.py:340-342` |
| N3 | 高 | 逻辑 | 取消机制完全依赖 Redis，Redis 不可用时取消失效 | `tasks.py:120-126` |
| N4 | 中 | 逻辑 | SSE 端点不验证 task 存在 → 幽灵任务连接泄漏 | `videos.py:218-219` |
| N5 | 中 | 逻辑 | `idempotency_key` 无长度校验 → DB DataError 500 | `schemas.py:20` |
| N6 | 中 | 性能 | `created_at` 无索引 → cleanup 全表扫描 | `models.py:50` |
| N7 | 中 | 性能 | `runner.py` stdout 无上限累积 → OOM 风险 | `runner.py:96-101` |
| N8 | 中 | 安全 | `preexec_fn=os.setsid` 多线程不安全（应 `start_new_session=True`） | `runner.py:71` |
| N9 | 中 | 逻辑 | `autodiscover_tasks(["app.workers.tasks"])` 疑似错误，独立 worker 可能不注册任务 | `celery_app.py:36` |
| N10 | 中 | 安全 | `config.api_key` 用 `str` 而非 `SecretStr`，traceback/日志泄露 | `config.py:50` |
| N11 | 中 | 安全 | `VideoTaskResponse` 暴露 `output_path`/`log_tail` 内部信息 | `schemas.py:56,63` |
| N12 | 低 | 逻辑 | 超时被杀的 exit_code 与普通失败混淆 | `tasks.py:218-224` |
| N13 | 低 | 逻辑 | cleanup 单 session 跨全部删除，一处失败回滚整批 | `tasks.py:258-292` |
| N14 | 低 | 逻辑 | `_append_log` Redis 失败静默吞，SSE 客户端看不到任何日志 | `tasks.py:69-70` |
| N15 | 低 | 性能 | watchdog 每 0.5s 一次 Redis GET，4 并发 = 8 GET/s | `runner.py:91` |
| N16 | 低 | 安全 | 默认 DB 密码 `oh:oh` 明文硬编码 | `config.py:16-17` |
| N17 | 低 | 逻辑 | `extra_oh_args` list 无长度限制 → ARG_MAX 超限 Popen 失败 | `schemas.py:19` |
| N18 | 低 | 测试 | `test_cancel_guard` 给予虚假信心，未覆盖 L1 真实 TOCTOU 竞态 | `test_worker.py:93-114` |

---

## 3. 详细分析（新增 + V1 强化项）

### 3.1 L1 强化：取消竞态的测试覆盖有虚假信心 [高]

**V1 结论属实**：`tasks.py:73-91` `_mark_succeeded` 无条件覆盖；`tasks.py:212` 检查 abort 后仍有 TOCTOU 窗口。

**本次核验新增发现（N18）**：现有测试 `test_cancel_guard_prevents_overwrite_to_succeeded`（`test_worker.py:93-114`）**全程 patch `_abort_requested` 返回 True**：

```python
# test_worker.py:102-104
with patch.object(worker_tasks, "run_oh") as m_run, patch.object(
    worker_tasks, "_abort_requested", return_value=True
):
```

这测试的是「abort 标志在 `run_oh` 返回前已置位」的路径（`tasks.py:212` 命中 → 走 `_mark_canceled`）。它**没有测试 L1 真实竞态**：abort 标志在 `tasks.py:212` 检查通过之后才置位，此时 worker 已走过检查、即将调用 `_mark_succeeded` 覆盖 CANCELED。

**影响**：测试全绿但 L1 竞态未被覆盖，给人虚假安全感。

**修复建议**：
1. `_mark_succeeded/_mark_failed/_mark_canceled` 改条件 UPDATE（V1 已给代码示例）。
2. 补一个真正测竞态的用例：mock `_abort_requested` 第一次返回 False（通过 212 行检查）、第二次返回 True（在 `_mark_succeeded` 内部重检时），断言状态不被覆盖。

---

### 3.2 N1 [高] 入队失败无补偿 → 孤儿 QUEUED 任务

**现状**（`videos.py:130-131`）：
```python
# Enqueue Celery task
generate_video_task.delay(str(task.id))
```
无 try/except。若 Redis/broker 不可用，`delay()` 抛 `redis.ConnectionError`：
- FastAPI 返回 500 给客户端；
- 但 `task` 已在 `videos.py:107` `await db.commit()` 提交，状态为 `QUEUED`；
- 无 worker 会接收（消息从未入队）；
- **无任何补偿机制扫描孤儿 QUEUED 任务**（R8 的 reclaim 只针对 RUNNING）。

**影响**：broker 抖动期间提交的任务永久卡在 QUEUED，用户看不到失败也等不到结果。

**修复建议**：
```python
try:
    generate_video_task.delay(str(task.id))
except Exception:
    # 回滚或标记失败，避免孤儿
    task.status = TaskStatus.FAILED
    task.error_message = "Enqueue failed: broker unavailable"
    await db.commit()
    raise HTTPException(503, "Task queue unavailable")
```
或加一个 beat 周期任务扫描 `QUEUED` 超过 N 分钟的任务重新入队/标记失败。

---

### 3.3 N2 [高] DELETE 把终态任务改成 CANCELED，且不删 DB 行

**现状**（`videos.py:327-348`）：对 `SUCCEEDED/FAILED/CANCELED` 任务执行 DELETE 时：
```python
# videos.py:328-342
if task.output_path:
    storage.delete(task.output_path)
if task.workspace_path:
    ...shutil.rmtree(wp, ignore_errors=True)
task.status = TaskStatus.CANCELED   # ← 把 SUCCEEDED 改成 CANCELED
task.output_path = None
await db.commit()
```

**问题**：
1. 把一个已 `SUCCEEDED` 的任务改写成 `CANCELED` —— 状态机语义混乱。用户删除已完成的任务后，状态变成 CANCELED，与"用户主动取消运行中任务"无法区分。
2. **不删除 DB 行** —— 任务记录永久保留（直到 `cleanup_expired_tasks` 按保留期清理）。用户无法真正"删除"任务，只能清理文件。
3. 返回的 `VideoDeleteResponse.status = CANCELED` 误导用户以为任务被取消而非删除。

**影响**：状态语义不一致；DB 行堆积；审计/统计失真（CANCELED 计数虚高）。

**修复建议**：
- 引入 `DELETED` 状态，或直接删除 DB 行（保留审计日志即可）。
- 或保持原终态不变，仅清理文件并把 `output_path` 置空，返回中明确区分"resources deleted"。

---

### 3.4 N3 [高] 取消机制完全依赖 Redis

**现状**（`tasks.py:120-126`）：
```python
def _abort_requested(task_id: str) -> bool:
    try:
        r = _redis_client()
        return r.get(f"oh:abort:{task_id}") is not None
    except Exception:
        return False   # ← Redis 不可用时返回"未取消"
```

**问题**：当 Redis 临时不可用（网络抖动/重启）时：
- `_abort_requested` 捕获异常返回 `False`；
- worker 的 `tasks.py:212` 检查通过 → 继续执行并 `_mark_succeeded`；
- `runner.py:88` watchdog 的 `is_aborted()` 也调用同一函数 → 同样失效；
- **用户已发起的取消被静默忽略**，任务继续运行至完成。

**影响**：Redis 不可用窗口内的取消请求全部失效，与 L1 竞态叠加放大。

**修复建议**：
- 增加基于 DB 的二级取消信号（如 `cancellation_requested` 布尔列，Phase 2 规划已提及但未实现）；
- 或在 `_abort_requested` Redis 失败时降级查 DB `status == CANCELED`；
- watchdog 同时检查 DB 状态，不单依赖 Redis。

---

### 3.5 N4 [中] SSE 端点不验证 task 存在

**现状**（`videos.py:218-219`）：
```python
@router.get("/{task_id}/events")
async def video_events(task_id: uuid.UUID):
    # 直接进入 SSE 生成器，不查 DB
```

**问题**：任意 UUID（甚至不存在的任务）都会建立 SSE 连接，阻塞在 `xread`（`videos.py:263`，block=5000ms）等待一个永不存在的日志流。客户端断开前连接一直挂着，占线程池槽。

**影响**：恶意/误操作可对大量不存在的 task_id 建立 SSE，耗尽线程池（与 P3 叠加）。

**修复建议**：进入生成器前先 `_get_task_or_404(task_id, db)`（需注入 `db` 依赖）。

---

### 3.6 N5 [中] `idempotency_key` 无长度校验

**现状**（`schemas.py:20`）：
```python
idempotency_key: str | None = None   # 无 Field(max_length=...)
```
DB 列为 `String(256)`（`models.py:45`，`001:45`）。

**问题**：客户端传 >256 字符的 key → Pydantic 不拦截 → INSERT 时 PG 抛 `DataError: value too long` → 500（非 422）。

**修复建议**：`idempotency_key: str | None = Field(default=None, max_length=256)`。

---

### 3.7 N6 [中] `created_at` 无索引 → cleanup 全表扫描

**现状**：`models.py:50` `created_at` 无 `index=True`；`001:48` 无索引。

`cleanup_expired_tasks`（`tasks.py:259-266`）查询：
```python
db.query(VideoTask).filter(
    VideoTask.created_at < cutoff,                          # ← 无索引
    VideoTask.status.in_([SUCCEEDED, FAILED, CANCELED]),    # status 有索引
)
```

**影响**：任务量大时 cleanup 每日全表扫描，慢查询。

**修复建议**：加复合索引 `(created_at, status)`：
```python
Index("ix_video_tasks_created_status", "created_at", "status")
```

---

### 3.8 N7 [中] `runner.py` stdout 无上限累积

**现状**（`runner.py:96-103`）：
```python
lines: list[str] = []
def _reader() -> None:
    for line in proc.stdout:
        lines.append(line)          # ← 全量累积
        if on_log_line is not None:
            on_log_line(line)
...
return RunResult(..., stdout="".join(lines))   # ← 全量返回
```

**问题**：`oh` 输出冗长时（hyperframes 渲染日志可达数 MB），`lines` 列表与最终 `stdout` 字符串无上限，worker 内存可能膨胀。4 并发任务 × 数 MB = 显著内存压力。

**修复建议**：
- `stdout` 只保留尾部 N KB（如 64KB）用于 `locate_output_file` 正则匹配；
- 或流式处理，仅 `on_log_line` 推 Redis，`stdout` 截断；
- 加 `max_stdout_bytes` 上限，超出后停止累积。

---

### 3.9 N8 [中] `preexec_fn=os.setsid` 多线程不安全

**现状**（`runner.py:63-72`）：
```python
proc = Popen(
    cmd, ...,
    preexec_fn=os.setsid,   # ← Python 文档明确警告：多线程中不安全
)
```

**问题**：Python `subprocess` 文档明确警告 `preexec_fn` 在多线程应用中**不安全**——fork 后、exec 前子进程只应调用 async-safe 函数，而 Python 的 `preexec_fn` 机制会在子进程内获取解释器锁，若父进程其他线程（`_watchdog`/`_reader`）在 fork 时持有该锁，子进程会死锁。

虽然 Celery prefork worker 默认单线程，但 `runner.py` 内部启动了 `watchdog_thread` 和 `reader_thread`（`runner.py:93,105`），fork 发生在 `Popen()` 调用时（两线程尚未 start，理论上安全），但这是脆弱的隐式假设。

**修复建议**：改用 `start_new_session=True`（Python 3.2+，等价于 `setsid` 但在 C 层执行，无 GIL 风险）：
```python
proc = Popen(cmd, ..., start_new_session=True)
```
功能等价，消除 `preexec_fn` 的安全警告。

---

### 3.10 N9 [中] `autodiscover_tasks` 参数疑似错误

**现状**（`celery_app.py:36`）：
```python
celery_app.autodiscover_tasks(["app.workers.tasks"])
```

**问题**：Celery `autodiscover_tasks(packages)` 对每个 `pkg` 尝试导入 `<pkg>.tasks`（`related_name` 默认 `"tasks"`）。传入 `"app.workers.tasks"`（一个**模块**而非包）→ 尝试导入 `app.workers.tasks.tasks` → 该模块不存在 → 静默失败。

标准用法应为 `autodiscover_tasks(["app.workers"])` → 导入 `app.workers.tasks` ✓。

**核验**：
- worker 启动命令（`docker/supervisord.conf:18`）：`celery -A app.workers.celery_app.celery_app worker -l info -c 4`
- 导入 `app.workers.celery_app` 时**不导入** `app.workers.tasks`（`celery_app.py` 无此 import）
- API 进程因 `videos.py:28` `from app.workers.tasks import generate_video_task` 触发注册，但**独立 worker 进程无此 import**
- 若 autodiscover 未命中，worker 启动后**无注册任务**，收到 `generate_video` 消息会 `NotRegistered`

> ⚠️ 历史档案 `openspec/archive/harden-hyperframes-video-service/tasks.md:189` 提到曾修复 `autodiscover_modules → autodiscover_tasks`，但当前代码的参数仍是模块名而非包名。**需实际启动 worker 并执行 `celery -A app.workers.celery_app.celery_app inspect registered` 验证**。若返回为空，则此为确认 bug。

**修复建议**：改为 `autodiscover_tasks(["app.workers"])`，或在 `celery_app.py` 显式 `import app.workers.tasks  # noqa: F401` 确保注册。

---

### 3.11 N10 [中] `api_key` 用 `str` 而非 `SecretStr`

**现状**（`config.py:50`）：`api_key: str | None = None`

**问题**：明文 `str`，会在异常 traceback、日志、`repr(settings)` 中泄露。Pydantic v2 推荐 `SecretStr`。

**修复建议**：
```python
from pydantic import SecretStr
api_key: SecretStr | None = None
# 使用时: settings.api_key.get_secret_value()
```

---

### 3.12 N11 [中] `VideoTaskResponse` 暴露内部信息

**现状**（`schemas.py:50-68`）：返回 `output_path`（存储 key，如 `<task_id>.mp4`）与 `log_tail`（完整日志尾部）。

**问题**：
- `output_path` 泄露内部存储结构；
- `log_tail` 可能含 oh 输出的文件路径、环境变量、调试信息等敏感内容。

**修复建议**：对外响应隐藏 `output_path`（仅返回 `_task_links.file` 链接），`log_tail` 脱敏或仅 debug 端点暴露。

---

### 3.13 N12 [低] 超时被杀的 exit_code 与普通失败混淆

**现状**：`runner.py:109-118` 超时后 kill 进程组，`proc.returncode` 为负（`-SIGTERM` 或 `-SIGKILL`）。`tasks.py:218` `if result.exit_code != 0` 一律走 `_mark_failed`，错误信息仅 `"oh exited with code -15"`。

**问题**：无法区分"超时被杀"与"oh 自身退出非 0"，运维排障困难。

**修复建议**：`runner.py` 返回 `timed_out: bool` 标志，`tasks.py` 据此写不同的 `error_message`（如 `"timed out after {timeout}s"`）。

---

### 3.14 N13 [低] cleanup 单 session 跨全部删除

**现状**（`tasks.py:258-292`）：单个 `with _sync_session() as db:` 包裹整个循环，最后 `db.commit()`。

**问题**：若某条任务的 `storage.delete()` 或 `shutil.rmtree` 抛异常，整个 batch 在 `commit` 前异常 → 全部回滚或部分脏数据。

**修复建议**：每条任务单独 try/except + 单独 commit，失败记录日志但不中断整批。

---

### 3.15 N14 [低] `_append_log` Redis 失败静默吞

**现状**（`tasks.py:65-70`）：
```python
try:
    r = _redis_client()
    r.xadd(f"oh:logs:{task_id}", {"line": line})
except Exception:
    logger.warning("Failed to push log line to Redis for task %s", task_id)
```

**问题**：Redis 不可用时，每行日志都打一条 warning（日志风暴），且日志内容丢失，SSE 客户端看不到任何输出。

**修复建议**：降级到本地文件兜底；或首次失败后停止重试并打一条汇总 warning。

---

### 3.16 N15 [低] watchdog 高频 Redis GET

**现状**：`runner.py:85-91` watchdog 每 0.5s 调 `is_aborted()` → `_abort_requested` → Redis GET。4 并发任务 = 8 GET/s。

**影响**：可接受但可优化。

**修复建议**：本地缓存 abort 标志 + 降低 Redis 轮询频率（如每 2s），或用 Redis SUBSCRIBE 推送取消信号。

---

### 3.17 N16 [低] 默认 DB 密码明文硬编码

**现状**（`config.py:16-17`）：`postgresql+asyncpg://oh:oh@localhost` —— 弱密码 `oh:oh` 明文。

**修复建议**：生产强制覆盖，或默认值用占位符 `<set-via-env>` 启动校验。

---

### 3.18 N17 [低] `extra_oh_args` list 无长度限制

**现状**（`schemas.py:19`）：`extra_oh_args: list[str] = Field(default_factory=list)` 无 `max_length`。

**问题**：客户端传超大 list → `json.dumps` 后 DB Text 可存，但 `Popen(cmd=[..., *大量 args])` 受系统 `ARG_MAX` 限制（Linux 约 2MB）→ `OSError: Argument list too long`。

**修复建议**：`Field(default_factory=list, max_length=50)`。

---

### 3.19 N18 [低→配合 L1] 测试覆盖缺口

见 §3.1。`test_worker.py:93` 的 cancel-guard 测试 patch `_abort_requested=True` 全程，未覆盖 L1 真实 TOCTOU。

---

## 4. V1 发现的强化补充

### 4.1 L1 竞态的完整时序

V1 已识别竞态，这里补充完整时序以便理解修复必要性：

```
T0  worker: run_oh() 返回
T1  worker: tasks.py:212  _abort_requested() → False（abort 尚未设）
T2  user:   DELETE /v1/{id} → videos.py:312 SET oh:abort:{id}=1
T3  user:   videos.py:319-320 task.status=CANCELED; commit
T4  worker: tasks.py:229 _mark_succeeded → UPDATE status=SUCCEEDED（无条件覆盖）
T5  最终:   status=SUCCEEDED（用户取消被覆盖）
```

`_mark_succeeded` 的条件 UPDATE 守卫（V1 建议的 `WHERE status='running'`）会在 T4 命中 0 行（因 T3 已改 CANCELED），从而阻止覆盖。

---

### 4.2 L3 重投与 N9 的叠加风险

若 N9（`autodiscover_tasks` 错误）属实，独立 worker 可能根本无法注册任务。即使修复 N9，L3 的重投守卫仍需 `worker_id`/`lease_token`（R8/R20）才能真正防重复。

---

### 4.3 P3 线程池与 N4 叠加

P3（SSE 阻塞线程池）+ N4（SSE 不验证 task 存在）→ 攻击者可对大量幽灵 task_id 建立 SSE，快速耗尽 anyio 默认 ~40 线程池，导致全服务雪崩。

---

## 5. 与规格基线（R1–R20）的实现差距

| 需求 | 状态 | 证据 |
|---|---|---|
| R1 extra_oh_args 白名单 | ✅ 已实现 | `security.py` |
| R2 取消杀进程组 | ✅ 已实现 | `runner.py:79-91` |
| R3 下载不阻塞事件循环 | ✅ 已实现 | `videos.py:160` run_in_threadpool |
| R4 cleanup 周期调度 | ✅ 已实现 | `celery_app.py:29-34` beat_schedule |
| R5 日志连接池复用 | ✅ 已实现 | `tasks.py:27-35` |
| R6 CORS 非通配+凭证 | ✅ 已实现 | `main.py:31-42` |
| R7 原子 claim | ❌ 未实现 | 无 `claim()`、无 `worker_id` 列 |
| R8 严格 lease+heartbeat | ❌ 未实现 | 无 `worker_id`/`heartbeat_at`/`lease_token` |
| R9 终态守卫 | ❌ 未实现 | `_mark_*` 无 WHERE 守卫（= L1） |
| R10 对象存储+presigned | ❌ 未实现 | 仅 `LocalVideoStorage`，无 S3 |
| R11 可观测性 | ❌ 未实现 | 无 Prometheus/structlog/`/readyz` |
| R12 水平扩展 | ⚠️ 部分 | docker-compose 支持 scale，但无 claim/reclaim |
| R13 并发控制 | ❌ 未实现 | 无优先级队列、无 `MAX_CONCURRENT_RENDERS` |
| R14 租户隔离 | ❌ 未实现 | 无 `tenant_id` |
| R15 API Key 鉴权 | ⚠️ 部分 | 单全局可选 key，无哈希/tenant/吊销 |
| R16 配额 | ❌ 未实现 | 无 quotas 表 |
| R17 审计 | ❌ 未实现 | 无 audit_log |
| R18 限流 | ❌ 未实现 | 无 rate limit |
| R19 可插拔调度器 | ❌ 未实现 | 无 `scheduler.py`/Temporal |
| R20 严格 lease fencing | ❌ 未实现 | 无 `lease_token` |

**实现率**：R1–R20 中 6/20 已实现，14/20 未实现。当前代码远未达到规格基线。

---

## 6. 测试覆盖缺口

| 缺口 | 相关问题 | 建议 |
|---|---|---|
| L1 真实 TOCTOU 竞态未测 | L1/N18 | mock `_abort_requested` 顺序返回 [False, True]，断言不被覆盖 |
| 入队失败补偿未测 | N1 | mock `delay()` 抛异常，断言任务被标记 FAILED 而非孤儿 QUEUED |
| Redis 不可用时取消失效未测 | N3 | mock `_redis_client` 抛异常，断言 worker 行为 |
| DELETE 终态任务的状态转换未测 | N2 | DELETE 一个 SUCCEEDED 任务，断言状态语义正确 |
| SSE 对不存在 task 未测 | N4 | 对随机 UUID 建 SSE，断言 404 而非挂起 |
| `idempotency_key` 超长未测 | N5 | 传 300 字符 key，断言 422 而非 500 |
| `created_at` 索引无验证 | N6 | 大数据量 cleanup 性能测试（可选） |
| stdout 上限未测 | N7 | oh 输出超大时断言无 OOM |
| `autodiscover_tasks` 注册未验证 | N9 | 启动 worker 后 `inspect registered` 断言含 `generate_video` |
| 无鉴权测试 | S1/S2 | 无 key / 错误 key / query key 全场景 |
| 无限流测试 | S3 | 超频提交断言 429（待限流实现后） |

---

## 7. 完整修复优先级路线图（V1 + V2 合并）

| 优先级 | 问题 | 工作量 | 说明 |
|---|---|---|---|
| **P0** | S1 强制鉴权 + 任务归属校验 | 中 | 安全底线 |
| **P0** | L1 取消竞态：条件 UPDATE 守卫 | 小 | 状态一致性 |
| **P0** | N1 入队失败补偿 | 小 | 防孤儿任务 |
| **P0** | N3 取消机制 Redis 降级（DB 二级信号） | 中 | 取消可靠性 |
| **P1** | N2 DELETE 语义修正 | 小 | 状态机正确性 |
| **P1** | N9 `autodiscover_tasks` 参数修正 | 小 | worker 可启动性（需先验证） |
| **P1** | P1/P2 日志 Stream MAXLEN + 尾部有界读 | 小 | Redis 内存 |
| **P1** | S3 限流 + L2 重试语义修正 | 中 | 稳定性 |
| **P2** | P3 SSE 改 `redis.asyncio` + N4 task 存在校验 | 中 | 防线程池耗尽 |
| **P2** | S2 常量时间校验 + 去 query key + N10 SecretStr | 小 | 鉴权加固 |
| **P2** | N6 `created_at` 复合索引 + N7 stdout 上限 + N8 `start_new_session` | 小 | 性能/安全 |
| **P2** | N5/N17 字段长度校验 | 小 | 输入校验 |
| **P3** | L3 重投守卫（需 lease/claim，依赖 R8） | 中 | 依赖规格实现 |
| **P3** | L4/L5/P4/P5/P6 + N12–N16 | 小 | 打磨/健壮性 |
| **P3** | R7–R20 规格实现 | 大 | 多租户/lease/Temporal/可观测 |

---

## 8. 关键修复代码示例

### 8.1 L1 — 终态条件 UPDATE 守卫（`tasks.py`）

```python
from sqlalchemy import update

def _mark_succeeded(task_id, storage_key, meta, result) -> None:
    with _sync_session() as db:
        stmt = (
            update(VideoTask)
            .where(
                VideoTask.id == task_id,
                VideoTask.status == TaskStatus.RUNNING,  # 仅运行中可落终态
            )
            .values(
                status=TaskStatus.SUCCEEDED,
                output_path=storage_key,
                file_size_bytes=meta.file_size_bytes,
                duration_seconds=meta.duration_seconds,
                resolution=meta.resolution,
                fps=meta.fps,
                exit_code=result.exit_code,
                finished_at=datetime.now(timezone.utc),
            )
        )
        result_rowcount = db.execute(stmt).rowcount
        if result_rowcount == 0:
            logger.warning("task %s not RUNNING, skip SUCCEEDED", task_id)
            return
        db.commit()
```

`_mark_failed` / `_mark_canceled` 同理加 `WHERE status == RUNNING`。

### 8.2 N1 — 入队失败补偿（`videos.py:130`）

```python
try:
    generate_video_task.delay(str(task.id))
except Exception:
    logger.exception("enqueue failed for task %s", task.id)
    await db.rollback() if not db.in_transaction() else None
    task.status = TaskStatus.FAILED
    task.error_message = "enqueue failed: broker unavailable"
    await db.commit()
    raise HTTPException(503, "Task queue unavailable")
```

### 8.3 N8 — `start_new_session`（`runner.py:63`）

```python
proc = Popen(
    cmd,
    cwd=str(cwd),
    stdout=PIPE,
    stderr=STDOUT,
    text=True,
    bufsize=1,
    env=env,
    start_new_session=True,   # 替代 preexec_fn=os.setsid
)
```

### 8.4 S2 — 常量时间校验（`main.py:51`）

```python
from hmac import compare_digest
key = request.headers.get("X-API-Key")
if not key or not compare_digest(key, settings.api_key.get_secret_value()):
    return JSONResponse(401, {"detail": "Invalid API key"})
```

### 8.5 P1 — Stream MAXLEN（`tasks.py:68`）

```python
r.xadd(f"oh:logs:{task_id}", {"line": line}, maxlen=_LOG_CAP, approximate=True)
```

---

## 9. 总结

1. **V1 报告 19 项结论全部属实**，行号准确，可作为修复依据。
2. **本次核验新增 18 项**，其中 N1（孤儿任务）、N2（DELETE 语义）、N3（取消依赖 Redis）为高优先级，需与 L1/S1 一并优先修复。
3. **测试覆盖存在虚假信心**：`test_cancel_guard` 未覆盖 L1 真实竞态（N18）。
4. **代码与规格基线落差巨大**：R1–R20 仅 6 项已实现，14 项未实现。Phase 2/3 规划的 claim/reclaim/lease/tenant/observability/concurrency 全部缺失。
5. **最危险的叠加**：P3（线程池）+ N4（SSE 不验证存在）+ S1（无鉴权）= 未鉴权攻击者可耗尽线程池使服务雪崩。

**建议立即执行 P0 修复**（S1 + L1 + N1 + N3），其余按路线图推进。规格 R7–R20 的实现需作为独立项目规划。

---

*报告完。如需对某 P0 项直接提交代码修复，请告知。*
