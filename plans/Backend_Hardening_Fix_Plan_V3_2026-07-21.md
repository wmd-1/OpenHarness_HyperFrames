# Backend Hardening Fix Plan V3 — `service/`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依据 `service/CODE_REVIEW_REPORT_V3.md`，修复 V1/V2 遗留的约 26 项发现 **+** 本次新增的 9 项（X1–X9），使 `service/` 达到安全底线、状态一致性、取消可靠性与资源可控。本计划取代旧版 `plans/Backend_Hardening_Fix_Plan_2026-07-21.md`——旧版基于 **演进前的 Phase 1 代码**（`_mark_*` 无 `worker_id`/CAS、入队走 `generate_video_task.delay()`、无 `scheduler.py`/`s3.py`/`beat.py`），其许多假设已失效。

**Architecture:** 代码已合入 `scale-multi-instance`（`worker_id`/`heartbeat_at`/`cancellation_requested`/`priority`/`storage_kind` 列、终态 CAS 守卫、心跳/回收、S3、可观测、优先级队列、渲染信号量）。本计划在此基础上做**增量加固**，不引入新中间件：激活已定义但未接入的 `claim()`；给取消/入队/鉴权补齐；给日志流、S3、并发上限补上限与流式；补测试闭环。每个任务自包含、可独立测试与提交。

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2.0 (async + sync), Celery 5.x, Redis (sync + asyncio), pytest, pytest-asyncio, boto3

## Global Constraints

- Python `>=3.12`，包管理用 `service/pyproject.toml`
- 所有新 DB 字段/索引需配 Alembic 迁移（增量，**不修改已发布迁移** 001/002/003；新迁移从 004 起）
- 终态写一律走 `WHERE id AND status==RUNNING [AND worker_id]` 条件 UPDATE（CAS）——**当前已实现，勿回退**
- 新增测试用 TDD：先写失败测试 → 实现 → 通过 → 提交
- **测试基建现状（重要，勿照抄旧计划的虚构 fixture）**：
  - `service/tests/` **无 `conftest.py`**，每个测试文件各自定义 fixture
  - worker 测试用 `test_worker.py` 的 `sync_db` fixture（内存 sqlite，设置 `worker_tasks._sync_engine`）；任务体经 `generate_video_task.run(task_id=...)` 驱动；辅助 `_class_with(**attrs)` 造桩
  - API 测试用 `test_videos_api.py` 的 `client` / `db_session` / `setup_db`（autouse，`sqlite+aiosqlite`）
  - **入队已改走 `get_scheduler().enqueue(...)`**：测入队需 patch `app.routers.videos.get_scheduler`，而非 `generate_video_task.delay`
- 配置项默认值不改变现有行为（向后兼容），生产由环境变量覆盖
- 提交粒度：每个 Task 完成即提交，message 用 `fix:`/`feat:`/`refactor:`/`test:` 前缀

## 问题项索引（V1/V2 遗留 26 + 新增 9 = 35 项）

| ID | 严重度 | 来源 | 摘要 | 当前状态 |
|---|---|---|---|---|
| **X1** | 高 | V3 | `claim()` 定义未接入任务入口，R7 原子认领形同虚设 → 重复渲染 | 未做 |
| **X4** | 中 | V3 | `cancellation_requested` 只写不读（=N3 强化） | 未做 |
| **X2** | 中 | V3 | S3 `open`/`save` 全量读入内存 → OOM + 破坏 Range | 未做 |
| **X3** | 中 | V3 | `render_semaphore` 在 prefork 下失效 | 未做 |
| **X5** | 中 | V3 | 心跳滞后误回收 → 活 worker 被回收重复渲染 | 未做 |
| **X7** | 中 | V3 | worker 未 `configure_logging`，`bind_task_context` 死代码 | 未做 |
| **X6** | 低 | V3 | 回收重投走 `delay()` 绕过 scheduler 丢优先级 | 未做 |
| **X8** | 低 | V3 | `/healthz` 同步 redis `ping()` 阻塞事件循环 | 未做 |
| **X9** | 低 | V3 | `ALTER TYPE ... ADD VALUE 'RETRYING'` 事务风险 | 未做 |
| **L1** | 高 | V1 | 取消竞态（终态写覆盖） | ✅ CAS 已实现；仅缺直测 |
| **N18** | 低 | V2 | cancel-guard 测试虚假信心（未覆盖 CAS 本身） | 未闭环 |
| **N3** | 高 | V2 | 取消依赖 Redis，失败静默失效 | 未做 |
| **N1** | 高 | V2 | 入队失败无补偿 → 孤儿 QUEUED | 未做 |
| **S1** | 高 | V1 | 缺强制鉴权与任务归属隔离 | 未做 |
| **S2** | 中 | V1 | API Key 时序攻击（query key 已移除，属部分修复） | 部分 |
| **N2** | 高 | V2 | DELETE 改写终态 + 不删 DB 行 | 未做 |
| **P1** | 中 | V1 | 日志 Stream 无 MAXLEN | 未做 |
| **P2** | 中 | V1 | `_update_log_tail` 全量读 | 未做 |
| **S3** | 中 | V1 | 无速率限制 | 未做 |
| **L2** | 中 | V1 | TransientError 死代码 | 未做 |
| **P3** | 中 | V1 | SSE 阻塞线程池 | 未做 |
| **N4** | 中 | V2 | SSE 不验证 task 存在 | 未做 |
| **N5** | 中 | V2 | idempotency_key 无长度校验 | 未做 |
| **N17** | 低 | V2 | extra_oh_args list 无长度限制 | 未做 |
| **S4** | 低 | V1 | extra_oh_args 取值未校验 | 未做 |
| **N6** | 中 | V2 | created_at 无索引 | 未做 |
| **N7** | 中 | V2 | runner stdout 无上限 | 未做 |
| **N8** | 中 | V2 | preexec_fn 多线程不安全 | 未做 |
| **N12** | 低 | V2 | 超时 exit_code 混淆 | 未做 |
| **N10** | 中 | V2 | api_key 非 SecretStr | 未做 |
| **N11** | 中 | V2 | 响应暴露 output_path/log_tail | 未做 |
| **L4** | 低 | V1 | 入队未持久化 celery_task_id | 未做（worker 侧写回） |
| **L5** | 低 | V1 | Range 忽略 end | 未做 |
| **P4** | 低 | V1 | 同步引擎缺 pre_ping | 未做 |
| **P5** | 低 | V1 | workspace 不即时清理 | 未做 |
| **P6** | 低 | V1 | cleanup 1.x 风格全量加载 | 未做 |
| **N13** | 低 | V2 | cleanup 单 session 整批 | 未做 |
| **N14** | 低 | V2 | _append_log 静默吞/日志风暴 | 未做 |
| **N15** | 低 | V2 | watchdog 高频 GET（0.5s） | 未做 |
| **N16** | 低 | V2 | 默认密码明文 | 未做 |
| **N9** | 中 | V2 | autodiscover_tasks 参数（靠显式 import 兜底） | 部分 |
| **O1** | 低 | V1 | healthz degraded 200 | 未做 |
| **O2** | 低 | V1 | config host 不一致 | 未做 |
| **O3** | 低 | V1 | fps 截断 | 未做 |
| **O4** | 低 | V1 | locate_output 兜底选最新 | 未做 |

---

# Phase 0 — P0 关键修复（重复渲染 + 状态一致性 + 取消可靠性 + 安全底线）

## Task 0.1: X1 + L3 — 任务入口接入原子 `claim()`，消除重复渲染

**Files:**
- Modify: `service/app/workers/tasks.py:248-270`（`generate_video_task` 入口）
- Test: `service/tests/test_worker.py`

**Interfaces:**
- `claim(task_id, worker_id) -> bool` 已存在（`tasks.py:83-108`），本任务把它接进任务体入口，删除随后的无条件 `status=RUNNING` 赋值。

**背景**：`claim()`（原子 `UPDATE ... WHERE status IN (QUEUED,RETRYING)`）当前是死代码；任务体在 `tasks.py:260-262` 无条件把 `status=RUNNING`、`worker_id=self`，导致 `acks_late` 重投或 `recover_lost_tasks` 重投时，若原 worker 仍存活会**双重渲染**。

- [ ] **Step 1: 写失败测试（重投到已被他人认领的任务不重复执行）**

追加到 `tests/test_worker.py`（沿用 `sync_db` / `_class_with`）：
```python
def test_claim_lost_race_skips_run(sync_db):
    """X1/L3: 若任务已被其他 worker 认领（非 QUEUED/RETRYING），本次执行应直接跳过 run_oh。"""
    from sqlalchemy.orm import Session
    with Session(sync_db) as s:
        # 模拟另一 worker 已把它变成 RUNNING 且 owner 是别人
        t = VideoTask(prompt="x", status=TaskStatus.RUNNING, worker_id="other-worker")
        s.add(t); s.commit()
        tid = str(t.id)

    with patch.object(worker_tasks, "run_oh") as m_run:
        m_run.return_value = _class_with(exit_code=0, stdout="")
        worker_tasks.generate_video_task.run(task_id=tid)
        m_run.assert_not_called()  # 抢不到 claim → 不渲染

    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.worker_id == "other-worker"  # 未被本次覆盖


def test_claim_queued_task_runs(sync_db):
    """X1: QUEUED 任务应被本 worker 原子认领并执行。"""
    from sqlalchemy.orm import Session
    import tempfile
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED)
        s.add(t); s.commit()
        tid = str(t.id)

    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "out.mp4"; mp4.write_bytes(b"\x00" * 2048)
        with patch.object(worker_tasks, "run_oh") as m_run, \
             patch.object(worker_tasks, "locate_output_file", return_value=mp4), \
             patch.object(worker_tasks, "probe_mp4",
                          return_value=VideoMeta(file_size_bytes=2048, duration_seconds=1.0,
                                                 resolution="2x2", fps=1)), \
             patch.object(worker_tasks, "LocalVideoStorage",
                          return_value=LocalVideoStorage(root=Path(tmp) / "s")):
            m_run.return_value = _class_with(exit_code=0, stdout="**输出文件:** `out.mp4`")
            worker_tasks.generate_video_task.run(task_id=tid)
            m_run.assert_called_once()

    with Session(sync_db) as s:
        assert s.get(VideoTask, t.id).status == TaskStatus.SUCCEEDED
```
> 注：现存 `test_happy_path_marks_succeeded` / `test_nonzero_exit_marks_failed` / `test_cancel_guard_*` 目前用 `status=RUNNING` 建任务。接入 claim 后 RUNNING 无法被认领，这些用例需一并把初始状态改为 `TaskStatus.QUEUED`（在 Step 3 同步修改），否则会回归失败。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py::test_claim_lost_race_skips_run -v`
Expected: FAIL（当前无条件覆盖 status/worker_id，run_oh 会被调用）

- [ ] **Step 3: 实现——入口用 claim() 取代无条件赋值**

把 `tasks.py:248-270` 的入口段（`with _sync_session() as db:` 到首个 `db.commit()`）改为：
```python
    wid = get_worker_id()

    with _sync_session() as db:
        task = db.get(VideoTask, task_id)
        if task is None:
            logger.error("Task %s not found in DB", task_id)
            return
        if task.status == TaskStatus.CANCELED:
            return
        prompt = task.prompt
        timeout = task.timeout_seconds
        extra_oh_args = json.loads(task.extra_oh_args) if task.extra_oh_args else []

    # Atomic claim (scale-multi-instance R7): exactly one worker flips
    # QUEUED/RETRYING -> RUNNING for this worker_id. Losing the race means
    # another replica already owns it — skip to avoid a double render (L3).
    if not claim(task_id, wid):
        logger.warning("task %s already claimed by another worker; skip redelivery", task_id)
        return

    # Persist the Celery request id for revoke() (claim() already set
    # worker_id/status/started_at/heartbeat_at/attempt atomically).
    with _sync_session() as db:
        db.execute(
            sa_update(VideoTask)
            .where(VideoTask.id == task_id)
            .values(celery_task_id=self.request.id)
        )
        db.commit()
```
删除原 `tasks.py:256-270` 的 `wid = get_worker_id()` / `task.worker_id = wid` / `task.status = RUNNING` / `task.started_at` / `task.heartbeat_at` / `task.celery_task_id` / `db.commit()` 无条件赋值块（已被 `claim()` + 上面的 celery_task_id 写入取代）。同步把上述现存三个用例的建任务状态由 `RUNNING` 改为 `QUEUED`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS（含新增 2 用例 + 改造后的既有用例）

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(X1,L3): claim task atomically at worker entry to prevent double render"
```

---

## Task 0.2: L1 + N18 — 补齐终态 CAS 守卫的直接测试闭环

**Files:**
- Test only: `service/tests/test_worker.py`（CAS 已在 `tasks.py:111-193` 实现，无需改实现）

**背景**：`_mark_succeeded/_mark_failed/_mark_canceled` 已带 `WHERE status==RUNNING [AND worker_id]` 并返回 `rowcount==1`（L1 真修复）。但现存 `test_cancel_guard_prevents_overwrite_to_succeeded` 靠 patch `_abort_requested=True` 命中入口预检分支，**从未触达 CAS 守卫本身**（N18 虚假信心）。本任务直接对非 RUNNING 行调用 `_mark_*` 验证守卫。

- [ ] **Step 1: 写失败/断言测试**

追加到 `tests/test_worker.py`：
```python
def test_mark_succeeded_skipped_when_already_canceled(sync_db):
    """L1/N18: 已 CANCELED 的行不应被 _mark_succeeded 覆盖，返回 False。"""
    from sqlalchemy.orm import Session
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.CANCELED, worker_id="w1")
        s.add(t); s.commit()
        tid = str(t.id)

    meta = VideoMeta(file_size_bytes=1, duration_seconds=1.0, resolution="1x1", fps=1)
    updated = worker_tasks._mark_succeeded(
        tid, "x.mp4", meta, _class_with(exit_code=0), worker_id="w1"
    )
    assert updated is False
    with Session(sync_db) as s:
        assert s.get(VideoTask, t.id).status == TaskStatus.CANCELED


def test_mark_succeeded_skipped_for_stale_owner(sync_db):
    """R9: worker_id 不匹配（被 reclaim 后的旧 owner）时守卫命中 0 行。"""
    from sqlalchemy.orm import Session
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.RUNNING, worker_id="new-owner")
        s.add(t); s.commit()
        tid = str(t.id)

    meta = VideoMeta(file_size_bytes=1, duration_seconds=1.0, resolution="1x1", fps=1)
    updated = worker_tasks._mark_succeeded(
        tid, "x.mp4", meta, _class_with(exit_code=0), worker_id="stale-owner"
    )
    assert updated is False
    with Session(sync_db) as s:
        got = s.get(VideoTask, t.id)
        assert got.status == TaskStatus.RUNNING and got.worker_id == "new-owner"
```

- [ ] **Step 2: 运行测试，确认通过（守卫已实现）**

Run: `cd service && python -m pytest tests/test_worker.py::test_mark_succeeded_skipped_when_already_canceled tests/test_worker.py::test_mark_succeeded_skipped_for_stale_owner -v`
Expected: PASS（若 FAIL 说明守卫被回退，需修复实现）

- [ ] **Step 3: 提交**

```bash
git add service/tests/test_worker.py
git commit -m "test(L1,N18): directly assert terminal-state CAS guard (row + owner) semantics"
```

---

## Task 0.3: N3 + X4 — `_abort_requested` 增加 DB 二级降级

**Files:**
- Modify: `service/app/workers/tasks.py:196-202`（`_abort_requested`）
- Test: `service/tests/test_worker.py`

**Interfaces:**
- `_abort_requested(task_id) -> bool`：Redis 命中优先；Redis 读失败时降级查 DB（`status==CANCELED` 或 `cancellation_requested==True`）。

**背景**：DELETE 已写 `cancellation_requested=True`（`videos.py:332,352`）与 Redis abort key，但 worker/runner 只读 Redis（`tasks.py:200`），Redis 抖动时取消静默失效，`oh` 进程白跑到超时（X4=N3 强化证据）。

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_worker.py`：
```python
def test_abort_requested_falls_back_to_db(sync_db):
    """N3/X4: Redis 不可用时，DB 的 CANCELED / cancellation_requested 应触发中止。"""
    from sqlalchemy.orm import Session
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.CANCELED,
                      cancellation_requested=True)
        s.add(t); s.commit()
        tid = str(t.id)

    def boom():
        raise RuntimeError("redis down")
    with patch.object(worker_tasks, "_redis_client", side_effect=boom):
        assert worker_tasks._abort_requested(tid) is True


def test_abort_requested_false_when_clean(sync_db):
    from sqlalchemy.orm import Session
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.RUNNING)
        s.add(t); s.commit()
        tid = str(t.id)
    def boom():
        raise RuntimeError("down")
    with patch.object(worker_tasks, "_redis_client", side_effect=boom):
        assert worker_tasks._abort_requested(tid) is False
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py::test_abort_requested_falls_back_to_db -v`
Expected: FAIL（当前 Redis 失败直接返回 False）

- [ ] **Step 3: 实现降级逻辑**

替换 `tasks.py:196-202`：
```python
def _abort_requested(task_id: str) -> bool:
    """True if a cancellation flag was set for this task (cross-replica safe).

    Redis is the fast path; if it is unavailable we fall back to the durable
    DB signal (status==CANCELED or cancellation_requested) so a Redis blip can
    no longer silently keep a canceled render alive (N3/X4).
    """
    try:
        r = _redis_client()
        if r.get(f"oh:abort:{task_id}") is not None:
            return True
    except Exception:
        logger.warning("Redis unavailable for abort check %s; falling back to DB", task_id)
    try:
        with _sync_session() as db:
            row = db.execute(
                select(VideoTask.status, VideoTask.cancellation_requested)
                .where(VideoTask.id == uuid.UUID(str(task_id)))
            ).first()
            if row is None:
                return False
            status, cancel_flag = row
            return status == TaskStatus.CANCELED or bool(cancel_flag)
    except Exception:
        logger.exception("abort fallback DB query failed for %s", task_id)
        return False
```
顶部把 `from sqlalchemy import create_engine, func, update as sa_update` 补上 `select`（改为 `from sqlalchemy import create_engine, func, select, update as sa_update`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(N3,X4): fall back to durable DB cancellation signal when Redis is down"
```

---

## Task 0.4: N1 — 入队失败补偿（防孤儿 QUEUED）

**Files:**
- Modify: `service/app/routers/videos.py:146-155`（`create_video` 入队段）
- Test: `service/tests/test_videos_api.py`

**Interfaces:**
- `create_video`：`get_scheduler().enqueue(...)` 抛异常时把任务标记 FAILED 并返回 503。

- [ ] **Step 1: 写失败测试（patch scheduler，而非 delay）**

追加到 `tests/test_videos_api.py`：
```python
async def test_create_marks_failed_when_enqueue_down(self, client: AsyncClient, db_session):
    """N1: broker/scheduler 不可用时任务应 FAILED + 503，而非永久 QUEUED。"""
    from sqlalchemy import select
    from app.models import VideoTask, TaskStatus

    class BoomScheduler:
        def enqueue(self, *a, **k):
            raise RuntimeError("broker down")

    with patch("app.routers.videos.get_scheduler", return_value=BoomScheduler()):
        resp = await client.post("/v1/videos", json={"prompt": "hi"})
    assert resp.status_code == 503
    rows = (await db_session.execute(select(VideoTask))).scalars().all()
    assert len(rows) == 1 and rows[0].status == TaskStatus.FAILED
    assert "enqueue" in (rows[0].error_message or "").lower()
```
放入 `TestCreateVideo` 类。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_videos_api.py -k enqueue_down -v`
Expected: FAIL（当前 enqueue 无 try/except → 500 且残留 QUEUED）

- [ ] **Step 3: 实现补偿**

替换 `videos.py:146-149`（`# Enqueue render ...` 注释 + `get_scheduler().enqueue(...)`）：
```python
    # Enqueue render via the configured scheduler (Phase 6). On broker failure,
    # compensate by flipping the just-created row to FAILED so it can't linger
    # as an orphan QUEUED task, then surface 503 (N1).
    try:
        get_scheduler().enqueue(str(task.id), priority=task.priority)
    except Exception as exc:
        logger.exception("enqueue failed for task %s", task.id)
        task.status = TaskStatus.FAILED
        task.error_message = f"enqueue failed: {exc}"[:4000]
        await db.commit()
        raise HTTPException(status_code=503, detail="Task queue unavailable")
```
在 `videos.py` 顶部 import 段加 `import logging` 与模块级 `logger = logging.getLogger(__name__)`（当前文件无 logger）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_videos_api.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/videos.py service/tests/test_videos_api.py
git commit -m "fix(N1): mark task FAILED and return 503 when scheduler enqueue fails"
```

---

## Task 0.5: S1 + S2 — 强制鉴权（生产）+ 常量时间比较

**Files:**
- Modify: `service/app/config.py`（新增 `require_auth`）
- Modify: `service/app/main.py:51-62`（中间件重构 + 启动校验）
- Test: `service/tests/test_api_edge.py`

**Interfaces:**
- `settings.require_auth: bool`（默认 False，向后兼容；生产置 True）
- `main._assert_auth_config(settings)`：`require_auth=True` 且无 `api_key` 时启动 `RuntimeError`
- 中间件始终注册；比较用 `hmac.compare_digest`

> 注：完整 `tenant_id` 归属隔离属 R14（Phase 4 独立立项），本任务只做「默认可强制鉴权 + 常量时间」。

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_api_edge.py`：
```python
def test_assert_auth_config_rejects_missing_key():
    from app import main as m
    from app.config import Settings
    import pytest
    s = Settings(api_key=None, require_auth=True)
    with pytest.raises(RuntimeError, match="api_key"):
        m._assert_auth_config(s)


def test_assert_auth_config_ok_when_key_present():
    from app import main as m
    from app.config import Settings
    m._assert_auth_config(Settings(api_key="k", require_auth=True))  # no raise
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_api_edge.py -k assert_auth -v`
Expected: FAIL（`_assert_auth_config` 不存在）

- [ ] **Step 3: 实现**

`config.py` 在 `api_key` 附近加：
```python
    # When True, the app refuses to boot without an api_key and enforces the
    # key on every request. Default False keeps dev/single-tenant behavior.
    require_auth: bool = False
```

`main.py` 把 `# Optional API key middleware` 到中间件结束（`main.py:51-62`）整段替换为：
```python
from hmac import compare_digest


def _assert_auth_config(s) -> None:
    """Fail fast if auth is required but no key is configured (S1)."""
    if s.require_auth and not s.api_key:
        raise RuntimeError("api_key required when require_auth=True")


_assert_auth_config(settings)


@app.middleware("http")
async def api_key_middleware(request, call_next):
    # Health/metrics probes stay unauthenticated for orchestrators.
    if request.url.path in ("/healthz", "/readyz", "/metrics"):
        return await call_next(request)
    # No key configured and auth not required -> open (backward compatible).
    if not settings.api_key:
        return await call_next(request)
    provided = request.headers.get("X-API-Key", "")
    if not compare_digest(provided, settings.api_key):  # constant-time (S2)
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=401, content={"detail": "Invalid API key"})
    return await call_next(request)
```
（当 `api_key` 为 `SecretStr` 后——见 Task 2.5——此处改 `settings.api_key.get_secret_value()`。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_api_edge.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/config.py service/app/main.py service/tests/test_api_edge.py
git commit -m "fix(S1,S2): add require_auth boot check + constant-time API key compare"
```

---

# Phase 1 — P1 重要修复（状态机 + Redis 内存 + 限流 + 重试 + OOM）

## Task 1.1: N2 — DELETE 保留终态语义（不覆写、按需删行）

**Files:**
- Modify: `service/app/routers/videos.py:360-381`（`delete_video` 终态分支）
- Test: `service/tests/test_videos_api.py`

**背景**：当前对 SUCCEEDED/FAILED/CANCELED 一律 `task.status = TaskStatus.CANCELED`（`videos.py:373`）并只清 `output_path`，把已完成任务错误改写成 CANCELED，破坏状态机。

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_videos_api.py` 的 `TestDeleteVideo`：
```python
async def test_delete_succeeded_keeps_status(self, client: AsyncClient, db_session):
    """N2: DELETE 已完成任务不应改写成 CANCELED，仅清理资源。"""
    from app.models import VideoTask, TaskStatus
    task = VideoTask(prompt="x", status=TaskStatus.SUCCEEDED, output_path="k.mp4")
    db_session.add(task); await db_session.commit(); await db_session.refresh(task)

    resp = await client.delete(f"/v1/videos/{task.id}")
    assert resp.status_code == 200
    await db_session.refresh(task)
    assert task.status == TaskStatus.SUCCEEDED   # 终态保留
    assert task.output_path is None              # 资源已清理
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_videos_api.py -k delete_succeeded_keeps_status -v`
Expected: FAIL（当前被改成 CANCELED）

- [ ] **Step 3: 实现**

把 `videos.py:360-381`（`# For completed / failed / canceled tasks` 到函数结尾）改为：
```python
    # For completed / failed / canceled tasks: clear resources but PRESERVE the
    # terminal status (N2). Overwriting SUCCEEDED->CANCELED corrupts the state
    # machine and audit history.
    if task.output_path:
        storage.delete(task.output_path)
    if task.workspace_path:
        from pathlib import Path
        import shutil
        wp = Path(task.workspace_path)
        if wp.exists():
            shutil.rmtree(wp, ignore_errors=True)

    task.output_path = None
    task.workspace_path = None
    await db.commit()
    return VideoDeleteResponse(
        task_id=task.id,
        status=task.status,  # unchanged terminal status
        message="Task resources deleted",
    )
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_videos_api.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/videos.py service/tests/test_videos_api.py
git commit -m "fix(N2): DELETE preserves terminal status, only clears resources"
```

---

## Task 1.2: P1 + P2 + N14 — 日志 Stream MAXLEN + 尾部有界读 + 推送熔断

**Files:**
- Modify: `service/app/workers/tasks.py:69-80`（`_append_log`）、`tasks.py:205-220`（`_update_log_tail`）、`tasks.py:326`（done marker 一致加 maxlen）
- Test: `service/tests/test_worker.py`

**背景**：`xadd` 无 `maxlen`，`_LOG_CAP=10000` 定义未用（P1）；`_update_log_tail` 用 `r.xrange` 全量读（P2）；`_append_log` 每行失败逐行 warning（N14 日志风暴）。

- [ ] **Step 1: 写失败测试（用 fakeredis 或桩）**

追加到 `tests/test_worker.py`（若无 `fakeredis` 依赖则用轻量桩记录调用参数）：
```python
def test_append_log_passes_maxlen(monkeypatch):
    """P1: xadd 必须带 maxlen 上限。"""
    calls = {}
    class FakeR:
        def xadd(self, key, fields, **kw):
            calls.update(kw)
    monkeypatch.setattr(worker_tasks, "_redis_client", lambda: FakeR())
    worker_tasks._append_log("t1", "line\n")
    assert calls.get("maxlen") == worker_tasks._LOG_CAP
    assert calls.get("approximate") is True


def test_append_log_circuit_breaks(monkeypatch):
    """N14: 首次推送失败后停止重试，避免逐行日志风暴。"""
    n = {"warn": 0}
    def boom():
        raise RuntimeError("down")
    monkeypatch.setattr(worker_tasks, "_redis_client", boom)
    monkeypatch.setattr(worker_tasks.logger, "warning", lambda *a, **k: n.__setitem__("warn", n["warn"] + 1))
    worker_tasks._log_push_failed.clear()
    worker_tasks._append_log("tX", "a")
    worker_tasks._append_log("tX", "b")
    assert n["warn"] == 1  # 仅告警一次
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py -k append_log -v`
Expected: FAIL

- [ ] **Step 3: 实现 MAXLEN + 熔断**

`tasks.py` 顶部（`_LOG_CAP` 附近）加：
```python
_log_push_failed: set[str] = set()  # task ids whose Redis log push is disabled
```
替换 `_append_log`（`tasks.py:69-80`）：
```python
def _append_log(task_id: str, line: str) -> None:
    """Append a bounded log line to the task's Redis Stream (P1/N14)."""
    if str(task_id) in _log_push_failed:
        return
    try:
        r = _redis_client()
        r.xadd(f"oh:logs:{task_id}", {"line": line}, maxlen=_LOG_CAP, approximate=True)
    except Exception:
        logger.warning("Redis log push disabled for task %s after failure", task_id)
        _log_push_failed.add(str(task_id))
```
`tasks.py:326` 的 done marker 也加上限：
```python
            _redis_client().xadd(f"oh:logs:{task_id}", {"line": _DONE_MARKER}, maxlen=_LOG_CAP, approximate=True)
```

- [ ] **Step 4: 实现尾部有界读**

替换 `_update_log_tail`（`tasks.py:205-220`）用 `xrevrange` 只取尾部：
```python
def _update_log_tail(task_id: str) -> None:
    """Read only the tail of the log stream from Redis and persist it (P2)."""
    try:
        r = _redis_client()
        # Newest-first, capped; reverse to chronological before joining.
        entries = r.xrevrange(f"oh:logs:{task_id}", count=1000)
        entries.reverse()
        raw = "".join(_as_str(fields.get(b"line")) for _id, fields in entries)
        tail = raw[-settings.log_tail_bytes:]
        with _sync_session() as db:
            task = db.get(VideoTask, task_id)
            if task is not None:
                task.log_tail = tail
                db.commit()
    except Exception:
        logger.warning("Failed to update log tail for task %s", task_id)
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(P1,P2,N14): cap log stream with MAXLEN, tail via xrevrange, circuit-break push"
```

---

## Task 1.3: S3 — 限流（Redis 令牌桶，全局底线）

**Files:**
- Create: `service/app/ratelimit.py`
- Modify: `service/app/routers/videos.py`（`create_video` 前置限流）
- Modify: `service/app/config.py`（限流配置）
- Test: `service/tests/test_ratelimit.py`

**Interfaces:**
- `RateLimiter(client, capacity, refill_per_sec).check(key: str) -> bool`（异步）

- [ ] **Step 1: 写失败测试（用 fakeredis.aioredis 或内存桩）**

`tests/test_ratelimit.py`：
```python
import pytest
from app.ratelimit import RateLimiter


class _MemRedis:
    """极简内存桩，够验证桶语义。"""
    def __init__(self): self.kv = {}
    async def get(self, k): return self.kv.get(k)
    async def set(self, k, v): self.kv[k] = v


@pytest.mark.asyncio
async def test_bucket_blocks_after_burst():
    rl = RateLimiter(client=_MemRedis(), capacity=2, refill_per_sec=0.0)
    assert await rl.check("k") is True
    assert await rl.check("k") is True
    assert await rl.check("k") is False  # 桶空且不回填
```

- [ ] **Step 2: 运行测试，确认失败** — 模块不存在，FAIL

- [ ] **Step 3: 实现 RateLimiter**

`app/ratelimit.py`：
```python
from __future__ import annotations

import time


class RateLimiter:
    """Redis token bucket keyed per client/tenant (S3 baseline).

    Fail-open: if the backing store errors, requests are allowed (availability
    over strictness for a soft DoS guard).
    """

    def __init__(self, client, capacity: int, refill_per_sec: float):
        self._c = client
        self._cap = capacity
        self._refill = refill_per_sec

    async def check(self, key: str) -> bool:
        ts_key = f"rl:{key}:ts"
        tok_key = f"rl:{key}:tok"
        now = time.time()
        try:
            last = await self._c.get(ts_key)
            tokens = await self._c.get(tok_key)
            last = float(last) if last is not None else now
            tokens = float(tokens) if tokens is not None else float(self._cap)
            tokens = min(self._cap, tokens + (now - last) * self._refill)
            if tokens < 1:
                await self._c.set(ts_key, now)
                await self._c.set(tok_key, tokens)
                return False
            tokens -= 1
            await self._c.set(ts_key, now)
            await self._c.set(tok_key, tokens)
            return True
        except Exception:
            return True  # fail-open
```

`config.py` 加：
```python
    rate_limit_capacity: int = 10
    rate_limit_refill_per_sec: float = 1.0
```

`videos.py` 模块级单例 + `create_video` 起始处限流：
```python
from redis.asyncio import from_url as aredis_from_url
from app.ratelimit import RateLimiter

_limiter = RateLimiter(
    aredis_from_url(settings.broker_url),
    settings.rate_limit_capacity,
    settings.rate_limit_refill_per_sec,
)
```
`create_video` 签名加 `request: Request`，函数体最前面：
```python
    ip = request.client.host if request.client else "anon"
    if not await _limiter.check(f"create:{ip}"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
```
（`Request` 已在 `videos.py:9` 导入。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_ratelimit.py tests/test_videos_api.py -v`
Expected: PASS（默认 capacity=10 不影响既有用例；如个别用例连发 >10 次需调 fixture）

- [ ] **Step 5: 提交**

```bash
git add service/app/ratelimit.py service/app/routers/videos.py service/app/config.py service/tests/test_ratelimit.py
git commit -m "feat(S3): Redis token-bucket rate limiter on create endpoint (fail-open)"
```

---

## Task 1.4: L2 — TransientError 分类触发 autoretry

**Files:**
- Modify: `service/app/workers/tasks.py:285-342`（`generate_video_task` 异常处理）
- Test: `service/tests/test_worker.py`

**背景**：`autoretry_for=(TransientError,)` 已配置（`tasks.py:237`），但全代码无 `raise TransientError`；DB/Redis 瞬时故障走 `except Exception` 一律 `_mark_failed`（L2 死代码）。

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_worker.py`：
```python
def test_transient_db_error_raises_for_retry(sync_db):
    """L2: OperationalError 应抛 TransientError 以触发 Celery autoretry。"""
    from sqlalchemy.orm import Session
    from sqlalchemy.exc import OperationalError
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED)
        s.add(t); s.commit(); tid = str(t.id)

    def boom(*a, **k):
        raise OperationalError("SELECT 1", {}, Exception("db gone"))
    with patch.object(worker_tasks, "run_oh", side_effect=boom):
        with pytest.raises(worker_tasks.TransientError):
            worker_tasks.generate_video_task.run(task_id=tid)
```

- [ ] **Step 2: 运行测试，确认失败** — FAIL

- [ ] **Step 3: 实现异常分类**

`tasks.py` 顶部加：
```python
from sqlalchemy.exc import OperationalError
import redis.exceptions as _redis_exc
```
在 `generate_video_task` 的 `except OutputNotFoundError` **之前**插入瞬时分类分支（`tasks.py:330` 前）：
```python
    except (OperationalError, _redis_exc.ConnectionError, _redis_exc.TimeoutError) as exc:
        logger.warning("transient infra error for %s: %s", task_id, exc)
        raise TransientError(str(exc)) from exc
```
保留既有 `except TransientError: raise` 与 `except Exception` 终态失败分支不变。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(L2): classify transient DB/Redis errors to trigger Celery autoretry"
```

---

## Task 1.5: X2 — S3 流式上传/下载（防 OOM，恢复 Range）

**Files:**
- Modify: `service/app/storage/s3.py:48-58`（`save` / `open`）
- Test: `service/tests/test_streaming.py`（或新建 `test_s3_storage.py`）

**背景**：`save` 用 `fh.read()` 整文件入内存、`open` 用 `resp["Body"].read()` + `BytesIO` 整对象入内存（X2），大视频 OOM 且 Range 先全量拉取再 seek，丧失流式意义。

- [ ] **Step 1: 写失败测试（注入 fake boto3 client 记录调用）**

`tests/test_s3_storage.py`：
```python
from pathlib import Path
from app.storage.s3 import S3VideoStorage


class FakeS3:
    def __init__(self): self.uploaded = None
    def upload_fileobj(self, Fileobj, Bucket, Key):
        self.uploaded = (Bucket, Key, Fileobj.read())
    def get_object(self, Bucket, Key, **kw):
        body = b"X" * 100
        class Body:
            def __init__(self, b): self._b = b
            def read(self, n=-1): return self._b if n == -1 else self._b[:n]
        return {"Body": Body(body), "ContentLength": len(body)}


def test_save_uses_streaming_upload(tmp_path):
    src = tmp_path / "v.mp4"; src.write_bytes(b"A" * 4096)
    fake = FakeS3()
    s = S3VideoStorage(client=fake, bucket="b")
    key = s.save("tid", src)
    assert key == "tid.mp4" and fake.uploaded[0] == "b"
    # 未使用 put_object(Body=fh.read()) —— 断言走 upload_fileobj
    assert fake.uploaded[2] == b"A" * 4096


def test_open_returns_streaming_body_not_full_bytesio():
    fake = FakeS3()
    s = S3VideoStorage(client=fake, bucket="b")
    fileobj, size = s.open("tid.mp4")
    assert size == 100
    assert hasattr(fileobj, "read")  # 惰性流对象，非预读的 BytesIO
```

- [ ] **Step 2: 运行测试，确认失败** — FAIL

- [ ] **Step 3: 实现流式**

替换 `s3.py:48-58`：
```python
    def save(self, task_id: str, src: Path) -> str:
        key = f"{task_id}.mp4"
        # Multipart streaming upload — never loads the whole file into memory.
        with open(src, "rb") as fh:
            self._client.upload_fileobj(fh, self._bucket, key)
        return key

    def open(self, key: str) -> tuple[BinaryIO, int]:
        # Return boto3's StreamingBody directly so callers read lazily; the
        # download endpoint's threadpool reader pulls chunks on demand instead
        # of buffering the whole object (X2).
        resp = self._client.get_object(Bucket=self._bucket, Key=key)
        return resp["Body"], resp["ContentLength"]
```
> `StreamingBody` 支持 `.read(n)` 与 `.close()`，与下载端点 `_iterfile` 的分块 `read` 兼容。`seek`（Range>0）在 S3 场景由 Task 3.6（L5）改为向 `get_object` 传 `Range=` 参数按需拉取；本任务先消除整对象入内存。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_s3_storage.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/storage/s3.py service/tests/test_s3_storage.py
git commit -m "fix(X2): stream S3 upload/download instead of buffering whole object"
```

---

# Phase 2 — P2 中等修复（SSE 异步 + 输入校验 + 索引 + stdout 上限 + Secret + 渲染并发）

## Task 2.1: P3 + N4 — SSE 改异步 Redis + 校验 task 存在

**Files:**
- Modify: `service/app/routers/videos.py:252-314`（`video_events`）
- Test: `service/tests/test_videos_api.py`

**背景**：`video_events` 用 `run_in_threadpool` 包同步 redis 逐条读（`videos.py:283,297`），长连接占满默认线程池（40）阻塞其它请求（P3）；且从不校验 `task_id` 是否存在，对未知/伪造 id 也会挂起长轮询（N4）。

**Interfaces:**
- `video_events(task_id, request, db=Depends(get_db))`：先查 DB，任务不存在 → 404；SSE 循环改用 `redis.asyncio` 异步读取，不占线程池。

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_videos_api.py`：
```python
async def test_events_unknown_task_returns_404(self, client: AsyncClient):
    """N4: SSE 对不存在的 task 应立即 404，而非挂起长连接。"""
    import uuid
    resp = await client.get(f"/v1/videos/{uuid.uuid4()}/events")
    assert resp.status_code == 404
```
放入 `TestVideoEvents`（无则新建该类）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_videos_api.py -k events_unknown -v`
Expected: FAIL（当前无 db 校验，进入 SSE 流不返回 404）

- [ ] **Step 3: 实现——注入 db 校验 + 异步 redis**

函数签名加 `db: AsyncSession = Depends(get_db)`，进入流之前先查存在性：
```python
async def video_events(
    task_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    # Validate the task exists up-front so unknown/forged ids get a clean 404
    # instead of hanging a long-lived SSE connection (N4).
    task = await db.get(VideoTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    async def event_stream():
        # Async Redis client so the long-lived stream never parks a threadpool
        # worker (P3). One connection per subscriber, closed on disconnect.
        import redis.asyncio as aioredis
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        last_id = "0-0"
        try:
            while True:
                if await request.is_disconnected():
                    break
                resp = await r.xread({f"oh:logs:{task_id}": last_id}, block=15000, count=50)
                if resp:
                    _, entries = resp[0]
                    for entry_id, fields in entries:
                        last_id = entry_id
                        yield f"data: {json.dumps(fields)}\n\n"
                        if fields.get("event") == "done":
                            return
                else:
                    yield ": keep-alive\n\n"
        finally:
            await r.aclose()

    return StreamingResponse(event_stream(), media_type="text/event-stream")
```
> 若文件顶部未导入 `AsyncSession`/`get_db`/`json`，在 import 段补齐（`from app.db import get_db`、`from sqlalchemy.ext.asyncio import AsyncSession`、`import json`）。移除原 `run_in_threadpool` 相关 import（若无其它使用）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_videos_api.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/videos.py service/tests/test_videos_api.py
git commit -m "fix(P3,N4): async Redis SSE stream + validate task exists before streaming"
```

---

## Task 2.2: N5 + N17 + S4 — 输入长度上限 + extra_oh_args 取值校验

**Files:**
- Modify: `service/app/schemas.py:16-31`（`VideoCreateRequest`）
- Modify: `service/app/security.py:46-82`（`vet_extra_oh_args`）
- Test: `service/tests/test_security.py`（无则新建）与 `tests/test_videos_api.py`

**背景**：`idempotency_key` 无 `max_length`（N5，可被超长键放大 Redis/DB 键空间）；`extra_oh_args` list 无长度上限（N17）；`vet_extra_oh_args` 只校验 flag 名不校验取值（S4，如 `--model` 后可跟任意字符串）。

- [ ] **Step 1: 写失败测试**

`tests/test_security.py`：
```python
import pytest
from app.security import InvalidOhArgError, vet_extra_oh_args

def test_rejects_oversized_arg_value():
    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--model", "x" * 5000])

def test_rejects_value_with_shell_metachars():
    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--model", "a;rm -rf /"])
```
`tests/test_videos_api.py`：
```python
async def test_create_rejects_long_idempotency_key(self, client: AsyncClient):
    resp = await client.post("/v1/videos",
        json={"prompt": "hi", "idempotency_key": "k" * 300})
    assert resp.status_code == 422

async def test_create_rejects_too_many_extra_args(self, client: AsyncClient):
    resp = await client.post("/v1/videos",
        json={"prompt": "hi", "extra_oh_args": ["--x"] * 60})
    assert resp.status_code == 422
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_security.py tests/test_videos_api.py -k "oversized or metachars or long_idempotency or too_many" -v`
Expected: FAIL

- [ ] **Step 3: 实现**

`schemas.py` 收紧字段约束（保持既有 `vet_extra_oh_args` validator）：
```python
    idempotency_key: str | None = Field(default=None, max_length=256)
    extra_oh_args: list[str] = Field(default_factory=list, max_length=50)
```
`security.py` 在 `vet_extra_oh_args` 的取值分支加校验（flag 消费值时）：
```python
_MAX_ARG_VALUE_LEN = 2048
# 取值中禁止 shell 元字符，防止即使 flag 合法也能注入构造。
_FORBIDDEN_VALUE_CHARS = set(";|&$`\n\r")


def _vet_value(flag: str, value: str) -> None:
    if len(value) > _MAX_ARG_VALUE_LEN:
        raise InvalidOhArgError(f"value for {flag} too long ({len(value)} chars)")
    if _FORBIDDEN_VALUE_CHARS & set(value):
        raise InvalidOhArgError(f"value for {flag} contains forbidden characters")
```
在 `vet_extra_oh_args` 里消费取值处（`ALLOWED_OH_FLAGS[flag]` 为真、读取下一个 token 作为 value 后）调用 `_vet_value(flag, value)`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_security.py tests/test_videos_api.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/schemas.py service/app/security.py service/tests/test_security.py service/tests/test_videos_api.py
git commit -m "fix(N5,N17,S4): bound idempotency_key/extra_oh_args length + vet arg values"
```

---

## Task 2.3: N6 — `(created_at, status)` 复合索引（迁移 004）

**Files:**
- Modify: `service/app/models.py:51-53`（`created_at` 列声明）
- Create: `service/alembic/versions/004_task_list_index.py`
- Test: `service/tests/test_migrations.py`（无则新建轻量断言）

**背景**：列表/清理端点按 `created_at` 排序、按 `status` 过滤（`videos.py` 列表 + `cleanup_expired_tasks`），当前 `created_at` 无索引（N6），大表下全表扫描。

- [ ] **Step 1: models.py 声明索引**

把 `created_at` 列改为带 `index=True`（或用 `__table_args__` 复合索引，二选一——复合更贴合查询）：
```python
    __table_args__ = (
        Index("ix_video_tasks_created_status", "created_at", "status"),
    )
```
顶部 `from sqlalchemy import ... , Index`。

- [ ] **Step 2: 写迁移 004**

新建 `service/alembic/versions/004_task_list_index.py`：
```python
"""Add (created_at, status) composite index for list/cleanup queries (N6).

Revision ID: 004_task_list_index
Revises: 003_<existing_head>
"""
from alembic import op

revision = "004_task_list_index"
down_revision = "003_<existing_head>"  # 用 `alembic heads` 确认真实 003 revision id
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_video_tasks_created_status", "video_tasks", ["created_at", "status"]
    )


def downgrade() -> None:
    op.drop_index("ix_video_tasks_created_status", table_name="video_tasks")
```
> 执行前先 `cd service && alembic heads` 与 `alembic history` 确认 003 的真实 revision id 填入 `down_revision`，避免多头。

- [ ] **Step 3: 验证迁移可正/反向运行**

Run: `cd service && alembic upgrade head && alembic downgrade -1 && alembic upgrade head`
Expected: 无错误；`\d video_tasks` 可见新索引（Postgres）

- [ ] **Step 4: 提交**

```bash
git add service/app/models.py service/alembic/versions/004_task_list_index.py
git commit -m "perf(N6): add (created_at, status) composite index via migration 004"
```

---

## Task 2.4: N7 + N8 + N12 — runner stdout 上限 + start_new_session + timed_out 标记

**Files:**
- Modify: `service/app/workers/runner.py:15-18`（`RunResult`）、`runner.py:71`（`preexec_fn`）、`runner.py:96-106,125`（stdout 累积）
- Test: `service/tests/test_runner.py`（无则新建）

**背景**：`lines` 无限累积 → 超长日志 OOM（N7）；`preexec_fn=os.setsid` 在多线程/prefork 下 fork-after-thread 不安全（N8）；超时被 kill 后 `exit_code` 与正常非零退出无法区分（N12）。

- [ ] **Step 1: 写失败测试**

`tests/test_runner.py`（用打印大量输出 / sleep 的子命令驱动）：
```python
import sys
from app.workers.runner import run_oh

def test_stdout_is_capped(monkeypatch):
    # 让 run_oh 执行一个疯狂打印的命令，断言累积不超过上限。
    ...  # 用 monkeypatch 把命令替换为 python -c 打印 10MB
    res = run_oh(prompt="x", timeout=30, extra_oh_args=[])
    assert len(res.stdout.encode()) <= 1_100_000  # ~1MB 上限 + 截断提示

def test_timeout_sets_timed_out_flag(monkeypatch):
    res = run_oh(prompt="x", timeout=1, extra_oh_args=[])  # 命令 sleep 5
    assert res.timed_out is True
```
> 具体桩法参照仓库内既有 runner 调用方式（`run_oh` 的命令构造）；若 `run_oh` 直接拼 `oh` 可执行，用 monkeypatch 替换 argv 前缀为 `[sys.executable, "-c", ...]`。

- [ ] **Step 2: 运行测试，确认失败** — FAIL

- [ ] **Step 3: 实现**

`RunResult` 增字段：
```python
@dataclass
class RunResult:
    exit_code: int
    stdout: str
    timed_out: bool = False
```
启动进程处把 `preexec_fn=os.setsid` 替换为 `start_new_session=True`（等价语义但线程安全，N8）：
```python
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,  # N8: 安全建立进程组，取代 preexec_fn=os.setsid
    )
```
stdout 累积改为有界（N7）：
```python
    _MAX_STDOUT_BYTES = 1_000_000  # ~1MB，超过则丢弃中段仅保留提示
    collected: list[str] = []
    total = 0
    truncated = False
    for line in proc.stdout:
        _append_log(task_id, line)  # 仍逐行推 Redis（P1 已加 maxlen）
        if total < _MAX_STDOUT_BYTES:
            collected.append(line)
            total += len(line.encode())
        elif not truncated:
            collected.append("\n...[stdout truncated: exceeded 1MB]...\n")
            truncated = True
```
超时分支设置 `timed_out=True`（N12）：
```python
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        proc.wait()
        return RunResult(exit_code=-signal.SIGKILL, stdout="".join(collected), timed_out=True)
```
> 任务体（`tasks.py`）在判定失败时可据 `result.timed_out` 写更明确的 `error_message`（"render timed out after Ns"）——顺带在本任务或 Task 2 尾部补一行即可，非必须。

- [ ] **Step 4: 运行测试，确认通过** — PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/runner.py service/tests/test_runner.py
git commit -m "fix(N7,N8,N12): cap runner stdout, use start_new_session, mark timed_out"
```

---

## Task 2.5: N10 + N11 + S2(补) — api_key 用 SecretStr + 响应隐藏内部字段

**Files:**
- Modify: `service/app/config.py:74`（`api_key`）
- Modify: `service/app/main.py`（比较处取 `get_secret_value()`）
- Modify: `service/app/schemas.py:50-68`（`VideoTaskResponse` 隐藏 `output_path`/`log_tail`）
- Test: `service/tests/test_videos_api.py`、`tests/test_api_edge.py`

**背景**：`api_key: str | None`（N10）易被日志/异常回显泄漏；`VideoTaskResponse` 暴露内部 `output_path`（S3 key/本地路径）与 `log_tail`（N11），增加信息面。

- [ ] **Step 1: 写失败测试**

`tests/test_videos_api.py`：
```python
async def test_response_hides_internal_fields(self, client: AsyncClient, db_session):
    from app.models import VideoTask, TaskStatus
    t = VideoTask(prompt="x", status=TaskStatus.SUCCEEDED, output_path="secret/key.mp4")
    db_session.add(t); await db_session.commit(); await db_session.refresh(t)
    resp = await client.get(f"/v1/videos/{t.id}")
    body = resp.json()
    assert "output_path" not in body
    assert "log_tail" not in body
```

- [ ] **Step 2: 运行测试，确认失败** — FAIL

- [ ] **Step 3: 实现**

`config.py`：
```python
    from pydantic import SecretStr
    api_key: SecretStr | None = None
```
`main.py` 比较处（Task 0.5 引入的中间件）：
```python
    if not settings.api_key:
        return await call_next(request)
    expected = settings.api_key.get_secret_value()
    if not compare_digest(provided, expected):
        ...
```
同步：`_assert_auth_config` 的 `not s.api_key` 判断对 `SecretStr | None` 仍成立（None 为假）。若代码其它处直接用 `settings.api_key` 字符串拼接，一并改 `get_secret_value()`。
`schemas.py` 从 `VideoTaskResponse` 移除 `output_path` 与 `log_tail` 字段（下载走 `/download` 端点、日志走 SSE，无需在元数据响应暴露）。

- [ ] **Step 4: 运行测试，确认通过** — PASS（含既有用例回归）

- [ ] **Step 5: 提交**

```bash
git add service/app/config.py service/app/main.py service/app/schemas.py service/tests/test_videos_api.py
git commit -m "fix(N10,N11): api_key as SecretStr + hide output_path/log_tail from responses"
```

---

## Task 2.6: X3 — 渲染并发上限跨进程化（或移除失效信号量）

**Files:**
- Modify: `service/app/workers/tasks.py:29`（`render_semaphore`）与任务体获取/释放处
- Modify: `service/app/config.py`（`max_concurrent_renders` 语义说明）
- Test: `service/tests/test_worker.py`

**背景**：`render_semaphore = threading.Semaphore(max_concurrent_renders)`（`tasks.py:29`）是**进程内**信号量，但 Celery prefork（`-c 4`）下每个 worker 子进程各持一份，全局并发实际为 `进程数 × max_concurrent_renders`，上限失效（X3）。

**决策（推荐）**：删除进程内信号量，改由 **Celery 并发度 `-c` 表达单机渲染并发**（每进程串行渲染，`prefetch=1` 已设）；跨实例总并发由部署的 worker 副本数 × `-c` 控制。如需**硬性全局上限**，再用 Redis 分布式信号量。本任务采用推荐方案（最简、无新依赖），并在配置注释写明语义。

- [ ] **Step 1: 写测试（并发语义文档化 + 无信号量泄漏）**

追加到 `tests/test_worker.py`：
```python
def test_no_process_local_semaphore_gate(sync_db):
    """X3: 渲染不再依赖进程内 Semaphore（prefork 下失效）。
    happy path 在无信号量的情况下仍应成功。"""
    import tempfile
    from sqlalchemy.orm import Session
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.QUEUED); s.add(t); s.commit()
        tid = str(t.id)
    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "o.mp4"; mp4.write_bytes(b"\x00" * 16)
        with patch.object(worker_tasks, "run_oh") as m_run, \
             patch.object(worker_tasks, "locate_output_file", return_value=mp4), \
             patch.object(worker_tasks, "probe_mp4",
                          return_value=VideoMeta(file_size_bytes=16, duration_seconds=1.0,
                                                 resolution="1x1", fps=1)), \
             patch.object(worker_tasks, "LocalVideoStorage",
                          return_value=LocalVideoStorage(root=Path(tmp) / "s")):
            m_run.return_value = _class_with(exit_code=0, stdout="**输出文件:** `o.mp4`")
            worker_tasks.generate_video_task.run(task_id=tid)
    with Session(sync_db) as s:
        assert s.get(VideoTask, t.id).status == TaskStatus.SUCCEEDED
    assert not hasattr(worker_tasks, "render_semaphore")  # 已移除
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py -k no_process_local_semaphore -v`
Expected: FAIL（`render_semaphore` 仍存在）

- [ ] **Step 3: 实现**

删除 `tasks.py:29` 的 `render_semaphore = threading.Semaphore(...)` 及任务体中 `with render_semaphore:` / `acquire`/`release` 包裹（若为 `with` 块，去掉该层缩进）。`config.py` 的 `max_concurrent_renders` 保留但改注释：
```python
    # Single-worker render concurrency is expressed by Celery's -c flag and
    # prefetch=1, NOT a process-local semaphore (that was ineffective under
    # prefork, X3). This value is advisory: set worker -c to match it in
    # deployment. A hard cross-replica cap would require a Redis semaphore.
    max_concurrent_renders: int = 1
```
若 `threading` 在 `tasks.py` 无其它用途，移除其 import。

- [ ] **Step 4: 运行测试，确认通过** — PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/app/config.py service/tests/test_worker.py
git commit -m "fix(X3): drop ineffective process-local render semaphore; document -c concurrency"
```

---

# Phase 3 — P3 稳健性与低危修复（心跳/回收 + 可观测 + 健康探针 + 迁移 + 下载 + 清理 + 配置一致性）

> 本阶段以中/低危为主，任务间相互独立，可按需选做；每任务仍保持 TDD + 单独提交。L4（celery_task_id 持久化）已在 **Task 0.1** 随 `claim()` 写回解决，不再重复。

## Task 3.1: X5 + X6 — 心跳防误回收 + 回收重投走 scheduler

**Files:**
- Modify: `service/app/workers/beat.py:44`（`STALE_AFTER`）、`beat.py:114-176`（`recover_lost_tasks`）、`beat.py:181-190`（`_liveness_loop`）
- Test: `service/tests/test_beat.py`（无则新建）

**背景**：
- X5：`_liveness_loop` 心跳间隔与 `STALE_AFTER=60s` 偏近，且心跳写入与渲染同线程（若同步），重载时心跳可能滞后 → 活 worker 被误判为 stale 而回收，导致重复渲染。
- X6：`recover_lost_tasks` 用 `generate_video_task.delay()`（`beat.py:173`）重投，绕过 scheduler 丢失优先级路由。

**Interfaces:**
- 心跳间隔 `HEARTBEAT_INTERVAL`（新增，默认 15s）；`STALE_AFTER` 提到至少 `4 × HEARTBEAT_INTERVAL`（默认 90s）留三次丢失容忍。
- `recover_lost_tasks` 重投改调 `get_scheduler().enqueue(task_id, priority=...)`。

- [ ] **Step 1: 写失败测试**

`tests/test_beat.py`：
```python
def test_recover_uses_scheduler_not_delay(monkeypatch, sync_db):
    """X6: 回收重投应走 scheduler.enqueue（保留优先级），而非 delay()。"""
    from app.workers import beat
    from app.models import VideoTask, TaskStatus
    from datetime import datetime, timezone, timedelta
    from sqlalchemy.orm import Session
    # 造一个心跳超过 STALE_AFTER 的 RUNNING 任务
    with Session(sync_db) as s:
        t = VideoTask(prompt="x", status=TaskStatus.RUNNING, worker_id="dead",
                      heartbeat_at=datetime.now(timezone.utc) - timedelta(seconds=999),
                      priority=3)
        s.add(t); s.commit(); tid = str(t.id)
    calls = []
    class FakeScheduler:
        def enqueue(self, task_id, priority=None): calls.append((task_id, priority))
    monkeypatch.setattr(beat, "get_scheduler", lambda: FakeScheduler())
    beat.recover_lost_tasks()
    assert calls and calls[0][0] == tid and calls[0][1] == 3


def test_stale_after_tolerates_three_missed_beats():
    from app.workers import beat
    assert beat.STALE_AFTER >= 4 * beat.HEARTBEAT_INTERVAL
```
> `test_beat.py` 需自定义 `sync_db` fixture（同 `test_worker.py`，设 `beat` 使用的 sync engine）；若 beat 复用 `tasks._sync_engine`，直接复用那个 fixture 模式。

- [ ] **Step 2: 运行测试，确认失败** — FAIL

- [ ] **Step 3: 实现**

`beat.py`：
```python
HEARTBEAT_INTERVAL = 15   # seconds between liveness writes (X5)
STALE_AFTER = 90          # >= 4 * HEARTBEAT_INTERVAL; tolerate 3 missed beats
```
`_liveness_loop` 用 `HEARTBEAT_INTERVAL` 作为 sleep 间隔（而非硬编码）。`recover_lost_tasks` 中把 `generate_video_task.delay(task_id)`（`beat.py:173`）改为：
```python
        from app.workers.scheduler import get_scheduler
        get_scheduler().enqueue(str(task_id), priority=priority)
```
其中 `priority` 从被回收行读取（`row.priority`）。回收时先用 CAS 把 `RUNNING→RETRYING` 并 `attempt += 1`（若当前已如此则保留）。

- [ ] **Step 4: 运行测试，确认通过** — PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/beat.py service/tests/test_beat.py
git commit -m "fix(X5,X6): widen stale window to 3 missed beats; reclaim via scheduler"
```

---

## Task 3.2: X7 — worker 子进程 `configure_logging` + 启用 `bind_task_context`

**Files:**
- Modify: `service/app/workers/beat.py:214-220`（`worker_process_init` 钩子）
- Modify: `service/app/workers/tasks.py`（任务体入口调 `bind_task_context`）
- Test: `service/tests/test_observability.py`（无则新建）

**背景**：worker 子进程从未调 `configure_logging()`，结构化日志未生效；`bind_task_context`（`observability/logging.py:55-65`）从未被调用，为死代码（X7）。

- [ ] **Step 1: 写测试**

`tests/test_observability.py`：
```python
def test_worker_process_init_configures_logging(monkeypatch):
    from app.workers import beat
    called = {"n": 0}
    monkeypatch.setattr(beat, "configure_logging", lambda: called.__setitem__("n", called["n"] + 1))
    beat.worker_process_init_handler(sender=None)  # 按实际钩子名调用
    assert called["n"] == 1
```
> 按 `beat.py` 内实际的 `worker_process_init` 处理函数名调用；若为内部匿名，先提取为具名函数再测。

- [ ] **Step 2–3: 实现**

`beat.py` 在 `worker_process_init` 钩子内、启动 liveness 线程前调 `configure_logging()`（顶部 `from app.observability.logging import configure_logging`）。`tasks.py` 任务体 claim 成功后调一次 `bind_task_context(task_id=task_id, worker_id=wid)`（顶部 import），使后续日志自动携带 task/worker 字段；若确定不用结构化上下文则删除 `bind_task_context` 死代码（二选一，推荐启用）。

- [ ] **Step 4–5: 通过 + 提交**

```bash
git add service/app/workers/beat.py service/app/workers/tasks.py service/tests/test_observability.py
git commit -m "fix(X7): configure structlog in worker subprocess and bind task context"
```

---

## Task 3.3: X8 + O1 — `/healthz` 异步 redis 探针 + degraded 语义

**Files:**
- Modify: `service/app/routers/health.py:30-39`（`_redis_ok`）、`health.py:73-85`（`health_check`）
- Test: `service/tests/test_health.py`（无则新建）

**背景**：`_redis_ok` 用同步 `ping()` 阻塞事件循环（X8，`_s3_ok` 已用 `asyncio.to_thread`）；`/healthz` 在 degraded 时仍返回 200（O1），编排器无法区分。

**决策**：`/healthz` 保持 liveness 语义（进程活着就 200）；依赖健康归 `/readyz`（readiness），redis/s3 任一不可用 → `/readyz` 返回 503。`_redis_ok` 改异步。

- [ ] **Step 1: 写失败测试**

`tests/test_health.py`：
```python
async def test_readyz_503_when_redis_down(client, monkeypatch):
    from app.routers import health
    async def bad(): return False
    monkeypatch.setattr(health, "_redis_ok", bad)
    monkeypatch.setattr(health, "_s3_ok", lambda: __import__("asyncio").sleep(0, result=True))
    resp = await client.get("/readyz")
    assert resp.status_code == 503

async def test_healthz_always_200(client):
    resp = await client.get("/healthz")
    assert resp.status_code == 200
```

- [ ] **Step 2–3: 实现**

`_redis_ok` 改为 `async def`，内部用 `redis.asyncio` 的 `ping()` 包 `asyncio.wait_for(..., timeout=2)`；`health_check`（`/healthz`）固定 200 liveness；`readyz`（若已存在则修改，否则新增）汇总 `_redis_ok`/`_s3_ok`，任一为假 → `JSONResponse(status_code=503, ...)`。

- [ ] **Step 4–5: 通过 + 提交**

```bash
git add service/app/routers/health.py service/tests/test_health.py
git commit -m "fix(X8,O1): async redis probe; /readyz returns 503 on dependency failure"
```

---

## Task 3.4: X9 — `ADD VALUE 'RETRYING'` 迁移事务安全

**Files:**
- Modify: `service/alembic/versions/002_scale_multi_instance_columns.py:56-57`
- Test: 手动验证（迁移可在 Postgres 正/反向跑通）

**背景**：`ALTER TYPE taskstatus ADD VALUE 'RETRYING'`（`002:57`）在旧 PG 版本不能在事务块内执行；Alembic 默认包在事务中，可能报 `ALTER TYPE ... ADD VALUE cannot run inside a transaction block`（X9）。

> 注：002 属**已发布迁移**，原则上不改。但此为环境兼容性修正（非逻辑变更）；若目标 PG ≥ 12 且部署环境已成功跑过 002，**则不要修改**，仅在新环境/失败现场采用下述修正（二选一）。

**方案（推荐，幂等）**：新建迁移 `004b`（或并入 004），用自提交 + `IF NOT EXISTS`：
```python
def upgrade() -> None:
    if op.get_context().dialect.name == "postgresql":
        # ADD VALUE cannot run in a txn on older PG; commit the surrounding
        # migration txn first, then add idempotently (X9).
        op.execute("COMMIT")
        op.execute("ALTER TYPE taskstatus ADD VALUE IF NOT EXISTS 'RETRYING'")
```
若选择直接改 002（仅限未发布环境），把第 57 行改为 `ADD VALUE IF NOT EXISTS` 并在前面 `op.execute("COMMIT")`。

- [ ] **Step 1: 验证** — 在干净 PG 上 `alembic upgrade head` 无事务报错
- [ ] **Step 2: 提交**

```bash
git add service/alembic/versions/
git commit -m "fix(X9): add RETRYING enum value outside transaction, idempotently"
```

---

## Task 3.5: L5 — Range 请求尊重 end（完整子区间）

**Files:**
- Modify: `service/app/routers/videos.py:186-249`（`download_video` Range 解析 225-239）
- Test: `service/tests/test_videos_api.py`

**背景**：当前仅解析 `start`（`videos.py:225-232`），`Content-Length=size-start`（:239），忽略 `bytes=start-end` 的 end，不符合 HTTP Range 语义（L5）。

- [ ] **Step 1: 写失败测试**

```python
async def test_range_honors_end(self, client, db_session):
    # 造一个 SUCCEEDED + 本地存储文件（长 100 字节），请 bytes=10-19
    ...
    resp = await client.get(f"/v1/videos/{tid}/download", headers={"Range": "bytes=10-19"})
    assert resp.status_code == 206
    assert resp.headers["Content-Range"] == "bytes 10-19/100"
    assert resp.headers["Content-Length"] == "10"
    assert len(resp.content) == 10
```

- [ ] **Step 2–3: 实现**

解析 `bytes=start-end`：end 缺省为 `size-1`；`length = end - start + 1`；`Content-Range: bytes {start}-{end}/{size}`；`Content-Length=length`；`_iterfile` 传入 `length` 上限，读到足量即止（需修改 `_iterfile` 支持 `max_bytes` 参数）。边界：start>end 或 start>=size → 416。

- [ ] **Step 4–5: 通过 + 提交**

```bash
git add service/app/routers/videos.py service/tests/test_videos_api.py
git commit -m "fix(L5): honor Range end for bounded partial content responses"
```

---

## Task 3.6: P4 + P5 + P6 + N13 — 同步引擎 pre_ping + workspace 即时清理 + cleanup 2.x 分批

**Files:**
- Modify: `service/app/workers/tasks.py`（`_sync_engine` 创建处、`cleanup_expired_tasks:345-387`）
- Test: `service/tests/test_worker.py`

**背景**：
- P4：同步引擎未设 `pool_pre_ping`，worker 长命命周期下断连不自愈。
- P5：任务完成/失败后 workspace 不即时清理，靠 cleanup 周期回收 → 磁盘堆积。
- P6/N13：`cleanup_expired_tasks` 用 1.x `db.query(...)` 全量加载 + 单 session 整批（:345-387），大量过期时内存尖峰 + 长事务。

- [ ] **Step 1–3: 实现**

- P4：`create_engine(...)` 加 `pool_pre_ping=True`。
- P5：任务体 `finally` 块在终态写回后 `shutil.rmtree(workspace, ignore_errors=True)` 并清 `workspace_path`（保留 `output_path` 已存入存储）。
- P6/N13：`cleanup_expired_tasks` 改 2.x `select(...).where(expires_at < now).limit(BATCH)`，循环分批（每批 `BATCH=100`），每批独立 `_sync_session()` + commit，直到无行。

- [ ] **Step 4–5: 测试与提交**

测：`test_cleanup_batches_and_deletes`（造 >BATCH 行过期，断言全删且多次 commit）、`test_workspace_removed_after_success`。
```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(P4,P5,P6,N13): pre_ping sync engine; clean workspace eagerly; batch cleanup (2.x)"
```

---

## Task 3.7: N9 — `autodiscover_tasks` 参数修正

**Files:**
- Modify: `service/app/workers/celery_app.py:59`

**背景**：`autodiscover_tasks(["app.workers.tasks"])`（:59）参数语义错误（应为 **包名列表**，其下自动找 `tasks` 模块），当前靠末尾 `from app.workers import beat` 显式 import 兑底（N9）。

- [ ] **Step 1–3: 实现**

改为 `celery_app.autodiscover_tasks(["app.workers"])`（包名），保留显式 `from app.workers import beat` 作为双保险；或确认显式 import 已足够则移除 autodiscover 降低困惑。追加轻量测试断言 `celery_app.tasks` 包含 `app.workers.tasks.generate_video_task`。

- [ ] **Step 4–5: 提交**

```bash
git add service/app/workers/celery_app.py service/tests/
git commit -m "fix(N9): pass package name to autodiscover_tasks; assert task registration"
```

---

## Task 3.8: O2 + O3 + O4 — 配置 host 一致性 + fps 四舍五入 + locate_output 兵底

**Files:**
- Modify: `service/app/config.py:16,19`（O2）、`service/app/workers/parser.py:101`（O3）、`parser.py:53`（O4）
- Test: `service/tests/test_parser.py`（无则新建）

**背景**：
- O2：`db_url` 用 `localhost`、`db_migration_url` 用 `postgres`（:16/:19），容器内外不一致易造成连错。
- O3：`fps = int(int(num)/int(den))`（:101）截断（29.97→29），应四舍五入。
- O4：`locate_output` 兑底 `rglob` 选最新 mtime（:53），多任务共享目录时可能选错文件。

- [ ] **Step 1–3: 实现**

- O2：统一默认主机名（两者均用同一默认，如 `localhost`，并在注释说明容器部署靠环境变量覆盖为 `postgres`）；或均从同一 `db_host` 派生。
- O3：`fps = round(int(num) / int(den))`（防 den==0）。
- O4：`locate_output` 兑底限定到本任务 workspace 子目录（传入任务专属目录），避免跨任务选文件；若仅一份输出目录则保留但加注释。

- [ ] **Step 4–5: 测试与提交**

测：`test_fps_rounds_2997_to_30`。
```bash
git add service/app/config.py service/app/workers/parser.py service/tests/test_parser.py
git commit -m "fix(O2,O3,O4): consistent db host default; round fps; scope locate_output fallback"
```

---

## Task 3.9: N15 + N16 — watchdog 轮询降频 + 默认密码加固

**Files:**
- Modify: `service/app/workers/runner.py:91`（watchdog `time.sleep(0.5)`）
- Modify: `service/app/config.py`（默认密码）

**背景**：
- N15：watchdog 每 0.5s 轮询一次中断标志（:91），高频 GET Redis，压力大。
- N16：配置默认密码为明文（DB/Redis/默认 admin 等），不安全。

- [ ] **Step 1–3: 实现**

- N15：watchdog 轮询间隔提到 `2–5s`（可配置 `abort_poll_interval`，默认 2.0），兼顾取消及时性与 Redis 压力。
- N16：移除配置中硬编码默认密码，改为无默认（必须环境变量提供）或启动时告警；至少在注释/文档标明生产必改。

- [ ] **Step 4–5: 提交**

```bash
git add service/app/workers/runner.py service/app/config.py
git commit -m "fix(N15,N16): slow watchdog poll to reduce Redis load; drop plaintext default password"
```

---

# Phase 4 — 结构性升级（独立立项，本计划仅占位）

> 以下项超出“加固”范畴，需独立设计/评审，**不在本计划 Phase 0–3 内实现**。列在此处仅作跟踪，建议各自开 OpenSpec change 或独立计划。

- **R14 租户隔离（S1 完整态）**：引入 `tenant_id`（列 + 迁移 + 所有查询过滤 + 从认证上下文注入），使任务按租户归属隔离；本计划 Task 0.5 仅做到“可强制鉴权 + 常量时间比较”。
- **R15 认证升级**：从单 API Key 升到每租户/每用户 key 或 OIDC/JWT。
- **R16 分布式硬并发上限**：若业务需要跨副本硬上限（X3 进阶），引入 Redis 分布式信号量/令牌桶。
- **R17 优先级队列端到端验证**：high/normal/low 队列的路由与饱饱饰集成测试。
- **R18 Temporal 调度器落地**：`TemporalScheduler` 当前为占位，需完整实现 + 切换方案。
- **R19 可观测性完善**：关键路径埋点（渲染时长、队列深度、回收次数）Prometheus 指标 + 告警规则。
- **R20 E2E 回归套件**：将 `service/tests` 补齐 `conftest.py` 共享 fixture（统一 `client`/`sync_db`/`db_session`），降低各文件重复定义；建议在 Phase 0–3 完成后单独重构（不阻塞本计划）。

---

# 执行顺序建议

严格按 Phase 0 → 1 → 2 → 3 顺序，同一 Phase 内按 Task 编号。关键依赖：

1. **Task 0.1（claim）必须最先做**：它改变任务入口的状态机前提（QUEUED 而非 RUNNING），并连带修改现存三个 worker 用例。后续所有 worker 测试均基于“QUEUED 入口 + claim”前提。
2. **Task 0.5（鉴权）与 Task 2.5（SecretStr）联动**：Task 0.5 先用 `str` 实现比较，Task 2.5 再改 `SecretStr` + `get_secret_value()`。若先行确定用 SecretStr，可合并。
3. **Task 2.3 / 3.4（迁移）**：执行前必须 `alembic heads`/`alembic history` 确认真实 003 revision id，避免多头。
4. **P1（日志 maxlen）先于 P3.9（watchdog 降频）**：两者都涉 Redis 压力，先保证流有界。
5. 每个 Task 完成后先跑全量 `cd service && python -m pytest -q` 再提交，防止跨文件回归（尤其 Task 0.1 改了共享 fixture 语义）。

**最小可发布集（若时间有限）**：仅做 **Phase 0 全部 + Task 1.1（N2）**，即可消除重复渲染、状态错写、取消失效、孤儿 QUEUED、无鉴权五大 P0/P1 风险。

---

# Self-Review（与当前代码核对）

- ✅ **不重复已完成工作**：L1 终态 CAS、`_mark_*` 的 `worker_id` 参数、入队走 `get_scheduler().enqueue`、S3/beat/scheduler/可观测模块均已存在——本计划仅做增量（如 Task 0.2 仅补直测而非重写实现）。
- ✅ **行号与当前代码对齐**：所有“Modify”均标注了当前真实行号（tasks.py:248-270 入口、videos.py:146-155 入队、videos.py:360-381 DELETE、main.py:51-62 中间件等）。
- ✅ **测试基建真实**：全部测试代码基于真实 fixture（`sync_db`/`_class_with`/`client`/`db_session`），入队测试 patch `app.routers.videos.get_scheduler`（非 `generate_video_task.delay`）；新建测试文件已标明需自定义 fixture。
- ✅ **迁移安全**：新迁移从 004 起，不改已发布 001/002/003（X9 例外仅限未发布环境，已标条件）；提醒执行前核实 head。
- ✅ **向后兼容**：`require_auth` 默认 False、`max_concurrent_renders` 保留、SecretStr 不改现有 None 判断。
- ⚠️ **待执行时确认项**：（1）Task 3.4 需先判断部署环境是否已跑过 002；（2）Task 3.7 N9 需核实 `celery_app.tasks` 注册名；（3）Task 3.2 `worker_process_init` 钩子实际函数名需按仓库确认。

---

# 附：与旧版计划（`Backend_Hardening_Fix_Plan_2026-07-21.md`）的差异

| 旧版假设 | 当前代码实情 | 本计划处理 |
|---|---|---|
| Task 0.1 “新增终态 CAS” | CAS 已实现（`_mark_*` 带 worker_id） | 降为 Task 0.2 仅补直测 |
| 入队走 `generate_video_task.delay()` | 已改 `get_scheduler().enqueue()` | 测试/补偿 patch scheduler |
| 虚构 fixture `sample_task`/`redis_client` | 无 conftest，各文件自定义 | 全部改用真实 fixture |
| 无 `claim()` | 已定义但未接入 | Task 0.1 接入（X1） |
| 无多实例列/心跳/回收 | 已有 | 新增 X5/X6 调优 |

> 旧版计划仍可作为历史参考，但**实现以本 V3 计划为准**。
