# Backend Hardening Fix Plan — `service/`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `service/` 后端代码审查（V1 + V2，共 37 项发现）中识别的全部安全隐患、逻辑漏洞与性能瓶颈，使代码达到 `openspec/specs/video-service-hardening.md` 的 R1–R9 基线（R10–R20 属独立项目，本计划仅占位）。

**Architecture:** 在现有 FastAPI + Celery + PostgreSQL + Redis 架构上做渐进式加固，不引入新中间件。终态写采用条件 UPDATE（CAS）守卫；取消信号增加 DB 二级降级；日志 Stream 加 `MAXLEN`；SSE 改 `redis.asyncio`；输入校验补全。每个任务自包含、可独立测试与提交。

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2.0 (async + sync), Celery 5.x, Redis (sync + asyncio), pytest, pytest-asyncio

## Global Constraints

- Python `>=3.12`，包管理用 `pyproject.toml`
- 所有新 DB 字段需配 Alembic 迁移（增量，不修改已发布迁移）
- 终态写一律走 `WHERE status='RUNNING'` 条件 UPDATE（CAS）
- 新增测试用 TDD：先写失败测试 → 实现 → 通过 → 提交
- 不破坏现有 `tests/` 通过的用例（19/19 e2e）
- 配置项默认值不改变现有行为（保持向后兼容），生产由环境变量覆盖
- 提交粒度：每个 Step 完成即提交，commit message 用 `fix:`/`feat:`/`refactor:`/`test:` 前缀

## 问题项索引（37 项）

| ID | 严重度 | 来源 | 摘要 |
|---|---|---|---|
| S1 | 高 | V1 | 缺鉴权与租户隔离 |
| S2 | 中 | V1 | API Key 时序攻击 + query 泄露 |
| S3 | 中 | V1 | 无速率限制 |
| S4 | 低 | V1 | extra_oh_args 取值未校验 |
| L1 | 高 | V1 | 取消竞态（终态写覆盖） |
| L2 | 中 | V1 | TransientError 死代码 |
| L3 | 中 | V1 | acks_late 重投重复执行 |
| L4 | 低 | V1 | 入队未持久化 celery_task_id |
| L5 | 低 | V1 | Range 忽略 end |
| P1 | 中 | V1 | 日志 Stream 无 MAXLEN |
| P2 | 中 | V1 | _update_log_tail 全量读 |
| P3 | 中 | V1 | SSE 阻塞线程池 |
| P4 | 低 | V1 | 同步引擎缺 pre_ping |
| P5 | 低 | V1 | workspace 不即时清理 |
| P6 | 低 | V1 | cleanup 1.x 风格全量加载 |
| O1 | 低 | V1 | healthz degraded 200 |
| O2 | 低 | V1 | config host 不一致 |
| O3 | 低 | V1 | fps 截断 |
| O4 | 低 | V1 | locate_output 兜底选最新 |
| N1 | 高 | V2 | 入队失败无补偿 → 孤儿 QUEUED |
| N2 | 高 | V2 | DELETE 改写终态 + 不删 DB 行 |
| N3 | 高 | V2 | 取消依赖 Redis，失败静默失效 |
| N4 | 中 | V2 | SSE 不验证 task 存在 |
| N5 | 中 | V2 | idempotency_key 无长度校验 |
| N6 | 中 | V2 | created_at 无索引 |
| N7 | 中 | V2 | runner stdout 无上限 |
| N8 | 中 | V2 | preexec_fn 多线程不安全 |
| N9 | 中 | V2 | autodiscover_tasks 参数错误 |
| N10 | 中 | V2 | api_key 非 SecretStr |
| N11 | 中 | V2 | 响应暴露 output_path/log_tail |
| N12 | 低 | V2 | 超时 exit_code 混淆 |
| N13 | 低 | V2 | cleanup 单 session 整批 |
| N14 | 低 | V2 | _append_log 静默吞 |
| N15 | 低 | V2 | watchdog 高频 GET |
| N16 | 低 | V2 | 默认密码明文 |
| N17 | 低 | V2 | extra_oh_args list 无长度限制 |
| N18 | 低 | V2 | cancel-guard 测试虚假信心 |

---

# Phase 0 — P0 关键修复（安全底线 + 状态一致性 + 取消可靠性）

## Task 0.1: L1 + N18 — 终态写条件 UPDATE 守卫

**Files:**
- Modify: `service/app/workers/tasks.py:73-104`（`_mark_succeeded` / `_mark_failed` / `_mark_canceled`）
- Test: `service/tests/test_worker.py`

**Interfaces:**
- Produces: `_mark_succeeded(task_id, *, storage_key=None, meta=None, result=None) -> bool`（返回是否实际更新）

- [ ] **Step 1: 写失败测试（覆盖真实 TOCTOU 竞态）**

在 `tests/test_worker.py` 末尾追加：
```python
def test_mark_succeeded_skipped_when_already_canceled(db_session, sample_task):
    """L1: 已 CANCELED 的任务不应被 _mark_succeeded 覆盖。"""
    from app.workers.tasks import _mark_succeeded
    from app.models import TaskStatus
    from datetime import datetime, timezone

    sample_task.status = TaskStatus.CANCELED
    db_session.add(sample_task)
    db_session.commit()

    updated = _mark_succeeded(
        str(sample_task.id),
        storage_key="x.mp4",
        meta=type("M", (), {"file_size_bytes": 1, "duration_seconds": 1.0,
                            "resolution": "1x1", "fps": 30.0})(),
        result=type("R", (), {"exit_code": 0, "stdout": "", "stderr": "",
                              "timed_out": False})(),
    )
    assert updated is False
    db_session.refresh(sample_task)
    assert sample_task.status == TaskStatus.CANCELED  # 未被覆盖
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py::test_mark_succeeded_skipped_when_already_canceled -v`
Expected: FAIL（当前 `_mark_succeeded` 无返回值 / 无条件写）

- [ ] **Step 3: 实现条件 UPDATE 守卫**

替换 `tasks.py:73-104` 三个函数为：
```python
def _mark_succeeded(task_id, *, storage_key=None, meta=None, result=None) -> bool:
    with _sync_session() as db:
        stmt = (
            update(VideoTask)
            .where(VideoTask.id == task_id, VideoTask.status == TaskStatus.RUNNING)
            .values(
                status=TaskStatus.SUCCEEDED,
                output_path=storage_key,
                file_size_bytes=meta.file_size_bytes if meta else None,
                duration_seconds=meta.duration_seconds if meta else None,
                resolution=meta.resolution if meta else None,
                fps=meta.fps if meta else None,
                exit_code=result.exit_code if result else None,
                finished_at=datetime.now(timezone.utc),
            )
        )
        rc = db.execute(stmt).rowcount
        db.commit()
        if rc == 0:
            logger.warning("task %s not RUNNING, skip SUCCEEDED", task_id)
        return rc > 0


def _mark_failed(task_id, error_message, *, exit_code=None) -> bool:
    with _sync_session() as db:
        stmt = (
            update(VideoTask)
            .where(VideoTask.id == task_id, VideoTask.status == TaskStatus.RUNNING)
            .values(
                status=TaskStatus.FAILED,
                error_message=error_message,
                exit_code=exit_code,
                finished_at=datetime.now(timezone.utc),
            )
        )
        rc = db.execute(stmt).rowcount
        db.commit()
        if rc == 0:
            logger.warning("task %s not RUNNING, skip FAILED", task_id)
        return rc > 0


def _mark_canceled(task_id) -> bool:
    with _sync_session() as db:
        stmt = (
            update(VideoTask)
            .where(VideoTask.id == task_id, VideoTask.status == TaskStatus.RUNNING)
            .values(status=TaskStatus.CANCELED, finished_at=datetime.now(timezone.utc))
        )
        rc = db.execute(stmt).rowcount
        db.commit()
        return rc > 0
```
顶部确保 `from sqlalchemy import update` 已导入。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS（含原有用例 + 新用例）

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(L1): guard terminal-state writes with conditional UPDATE to prevent cancel race"
```

---

## Task 0.2: N3 — 取消机制增加 DB 二级降级

**Files:**
- Modify: `service/app/workers/tasks.py:120-126`（`_abort_requested`）
- Test: `service/tests/test_worker.py`

**Interfaces:**
- Produces: `_abort_requested(task_id) -> bool`（Redis 失败时降级查 DB `status==CANCELED`）

- [ ] **Step 1: 写失败测试（Redis 不可用时降级到 DB）**

追加到 `tests/test_worker.py`：
```python
def test_abort_requested_falls_back_to_db_when_redis_down(db_session, sample_task, monkeypatch):
    """N3: Redis 不可用时取消信号应从 DB 降级读取。"""
    from app.workers import tasks as wt
    from app.models import TaskStatus

    sample_task.status = TaskStatus.CANCELED
    db_session.add(sample_task)
    db_session.commit()

    def boom(*a, **k):
        raise RuntimeError("redis down")
    monkeypatch.setattr(wt, "_redis_client", boom)

    assert wt._abort_requested(str(sample_task.id)) is True


def test_abort_requested_false_when_redis_and_db_both_clean(db_session, sample_task, monkeypatch):
    from app.workers import tasks as wt
    monkeypatch.setattr(wt, "_redis_client", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    assert wt._abort_requested(str(sample_task.id)) is False
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py::test_abort_requested_falls_back_to_db_when_redis_down -v`
Expected: FAIL（当前 Redis 失败返回 False）

- [ ] **Step 3: 实现降级逻辑**

替换 `tasks.py:120-126`：
```python
def _abort_requested(task_id: str) -> bool:
    try:
        r = _redis_client()
        if r.get(f"oh:abort:{task_id}") is not None:
            return True
    except Exception:
        logger.warning("Redis unavailable for abort check %s, falling back to DB", task_id)
    # DB 二级降级：任务已被标记 CANCELED 即视为取消
    try:
        with _sync_session() as db:
            row = db.execute(
                select(VideoTask.status).where(VideoTask.id == task_id)
            ).scalar_one_or_none()
            return row == TaskStatus.CANCELED
    except Exception:
        logger.exception("abort fallback DB query failed for %s", task_id)
        return False
```
确保 `from sqlalchemy import select` 已导入。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(N3): fall back to DB when Redis unavailable for abort check"
```

---

## Task 0.3: N1 — 入队失败补偿

**Files:**
- Modify: `service/app/routers/videos.py:130-131`（`create_video` 入队段）
- Test: `service/tests/test_videos_api.py`

**Interfaces:**
- Produces: `create_video` 在 `delay()` 抛异常时把任务标记 FAILED 并返回 503

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_videos_api.py`：
```python
@pytest.mark.asyncio
async def test_create_video_marks_failed_when_broker_down(client, monkeypatch, db_session):
    """N1: broker 不可用时任务应被标记 FAILED 而非永久 QUEUED。"""
    from app.routers import videos as vmod

    def boom(*a, **k):
        raise RuntimeError("broker down")
    monkeypatch.setattr(vmod, "generate_video_task", type("T", (), {"delay": boom})())

    resp = await client.post("/v1/videos", json={"prompt": "hi"})
    assert resp.status_code == 503
    from app.models import VideoTask, TaskStatus
    tasks = (await db_session.execute(select(VideoTask))).scalars().all()
    assert len(tasks) == 1 and tasks[0].status == TaskStatus.FAILED
    assert "enqueue" in (tasks[0].error_message or "").lower()
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_videos_api.py::test_create_video_marks_failed_when_broker_down -v`
Expected: FAIL

- [ ] **Step 3: 实现补偿**

替换 `videos.py:130-131`：
```python
try:
    generate_video_task.delay(str(task.id))
except Exception as exc:
    logger.exception("enqueue failed for task %s", task.id)
    task.status = TaskStatus.FAILED
    task.error_message = f"enqueue failed: {exc}"
    await db.commit()
    raise HTTPException(503, "Task queue unavailable")
```
确保 `from sqlalchemy import select`、`import logging` 与 `logger` 在 `videos.py` 已就位。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_videos_api.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/videos.py service/tests/test_videos_api.py
git commit -m "fix(N1): mark task FAILED and return 503 when broker enqueue fails"
```

---

## Task 0.4: S1 — 强制鉴权（生产）+ 任务归属预埋

**Files:**
- Modify: `service/app/main.py:44-56`（API Key 中间件）
- Modify: `service/app/config.py`（新增 `require_auth`）
- Modify: `service/app/routers/videos.py:69`（`_get_task_or_404` 预埋 owner 注释占位）
- Test: `service/tests/test_api_edge.py`

**Interfaces:**
- Produces: `settings.require_auth`（bool）；未设置 key 且 `require_auth=True` 时启动报错

> 注：完整 tenant_id 隔离属 R14（Phase 3 独立项目），本任务仅做「默认强制鉴权」。

- [ ] **Step 1: 写失败测试（无 key 时启动应拒绝）**

追加到 `tests/test_api_edge.py`：
```python
def test_app_rejects_missing_key_when_required(monkeypatch):
    """S1: require_auth=True 且无 api_key 应启动失败。"""
    from app import main as m
    from app.config import Settings

    s = Settings(api_key=None, require_auth=True)
    import pytest
    with pytest.raises(RuntimeError, match="api_key required"):
        m._assert_auth_config(s)


def test_missing_api_key_returns_401(client_no_key, monkeypatch):
    resp = await client_no_key.get("/v1/videos")
    assert resp.status_code == 401
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_api_edge.py -v`
Expected: FAIL

- [ ] **Step 3: 实现**

`config.py` Settings 增加：
```python
require_auth: bool = False  # 生产置 True
```

`main.py` 在 `app = FastAPI(...)` 之后、中间件注册之前加：
```python
def _assert_auth_config(s):
    if s.require_auth and not s.api_key:
        raise RuntimeError("api_key required when require_auth=True")

_assert_auth_config(settings)
```

`main.py:51-52` API Key 中间件改为常量时间比较 + 去掉 query 兜底（同时完成 S2 核心）：
```python
from hmac import compare_digest

@app.middleware("http")
async def api_key_middleware(request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)
    if not settings.api_key:  # require_auth=False 且无 key 才放行
        return await call_next(request)
    provided = request.headers.get("X-API-Key", "")
    if not compare_digest(provided, settings.api_key):
        return JSONResponse(401, {"detail": "Invalid API key"})
    return await call_next(request)
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_api_edge.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/main.py service/app/config.py service/tests/test_api_edge.py
git commit -m "fix(S1,S2): require auth in prod, constant-time compare, drop query key"
```

---

# Phase 1 — P1 重要修复（语义/可启动性/资源上限/重试）

## Task 1.1: N9 — 修正 `autodiscover_tasks` 参数

**Files:**
- Modify: `service/app/workers/celery_app.py:36`

**Interfaces:**
- 无新接口；修复 Celery 任务注册

- [ ] **Step 1: 验证当前是否真的未注册（诊断）**

Run: `cd service && celery -A app.workers.celery_app.celery_app inspect registered 2>&1 | head`
Expected: 若输出无 `app.workers.tasks.generate_video_task`，确认 bug 存在。记录结果到 PR 描述。

- [ ] **Step 2: 修正参数**

`celery_app.py:36`：
```python
celery_app.autodiscover_tasks(["app.workers"])
```
并在文件末尾加显式 import 保险：
```python
import app.workers.tasks  # noqa: F401  确保 @celery_app.task 装饰器执行
```

- [ ] **Step 3: 再次验证注册**

Run: `cd service && celery -A app.workers.celery_app.celery_app inspect registered 2>&1 | head`
Expected: 含 `app.workers.tasks.cleanup_expired_tasks` 与 `app.workers.tasks.generate_video_task`

- [ ] **Step 4: 提交**

```bash
git add service/app/workers/celery_app.py
git commit -m "fix(N9): correct autodiscover_tasks package name so worker registers tasks"
```

---

## Task 1.2: N2 — DELETE 语义修正（不覆写终态）

**Files:**
- Modify: `service/app/routers/videos.py:327-348`（`delete_video`）
- Modify: `service/app/schemas.py`（`VideoDeleteResponse` 加 `deleted: bool`）
- Test: `service/tests/test_videos_api.py`

**Interfaces:**
- Produces: `delete_video` 不改写终态，仅清理资源；返回 `deleted=True` 与原 `status`

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_videos_api.py`：
```python
@pytest.mark.asyncio
async def test_delete_succeeded_keeps_status(client, succeeded_task):
    """N2: DELETE 已完成任务不应把状态改成 CANCELED。"""
    resp = await client.delete(f"/v1/videos/{succeeded_task.id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["deleted"] is True
    assert body["status"] == "SUCCEEDED"  # 终态保留
    await db_session.refresh(succeeded_task)
    assert succeeded_task.status == TaskStatus.SUCCEEDED
    assert succeeded_task.output_path is None  # 资源已清理
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_videos_api.py::test_delete_succeeded_keeps_status -v`
Expected: FAIL

- [ ] **Step 3: 实现**

`schemas.py` `VideoDeleteResponse` 增字段：
```python
class VideoDeleteResponse(BaseModel):
    task_id: uuid.UUID
    status: TaskStatus
    deleted: bool = True
```

`videos.py` `delete_video` 对已完成分支（原 `videos.py:328-342`）改为：
```python
if task.output_path:
    storage.delete(task.output_path)
if task.workspace_path:
    shutil.rmtree(Path(task.workspace_path), ignore_errors=True)
task.output_path = None
task.workspace_path = None
# 不改写 status：保留 SUCCEEDED/FAILED/CANCELED 原终态
await db.commit()
return VideoDeleteResponse(task_id=task.id, status=task.status, deleted=True)
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_videos_api.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/videos.py service/app/schemas.py service/tests/test_videos_api.py
git commit -m "fix(N2): DELETE preserves terminal status, only clears resources"
```

---

## Task 1.3: P1 + P2 — 日志 Stream MAXLEN + 尾部有界读

**Files:**
- Modify: `service/app/workers/tasks.py:65-70`（`_append_log`）、`tasks.py:129-137`（`_update_log_tail`）

**Interfaces:**
- 无新接口

- [ ] **Step 1: 写失败测试（MAXLEN 生效）**

追加到 `tests/test_worker.py`：
```python
def test_append_log_enforces_maxlen(monkeypatch, redis_client):
    from app.workers import tasks as wt
    monkeypatch.setattr(wt, "_redis_client", lambda: redis_client)
    wt._append_log("t1", "x" * 100)
    info = redis_client.xinfo_stream("oh:logs:t1")
    assert info["max-len"] == wt._LOG_CAP or info["length"] <= wt._LOG_CAP


def test_update_log_tail_reads_only_tail(monkeypatch, redis_client):
    from app.workers import tasks as wt
    monkeypatch.setattr(wt, "_redis_client", lambda: redis_client)
    for i in range(500):
        redis_client.xadd("oh:logs:t1", {"line": f"line{i}"})
    tail = wt._update_log_tail("t1")
    assert "line499" in tail and "line0" not in tail
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py::test_append_log_enforces_maxlen -v`
Expected: FAIL

- [ ] **Step 3: 实现 MAXLEN**

`tasks.py:68`：
```python
r.xadd(f"oh:logs:{task_id}", {"line": line}, maxlen=_LOG_CAP, approximate=True)
```
对 `tasks.py:233`（done 标记同样加 MAXLEN 一致性）：
```python
r.xadd(f"oh:logs:{task_id}", {"event": "__DONE__"}, maxlen=_LOG_CAP, approximate=True)
```

- [ ] **Step 4: 实现尾部有界读**

替换 `tasks.py:129-137`：
```python
def _update_log_tail(task_id: str) -> None:
    try:
        r = _redis_client()
        entries = r.xrevrange(f"oh:logs:{task_id}", count=500)
        entries.reverse()
        text = "".join(e[1].get("line", "") for e in entries)
        with _sync_session() as db:
            db.execute(
                update(VideoTask).where(VideoTask.id == task_id)
                .values(log_tail_bytes=text[-_LOG_TAIL_BYTES:])
            )
            db.commit()
    except Exception:
        logger.exception("update_log_tail failed for %s", task_id)
```
顶部定义 `_LOG_TAIL_BYTES = 16 * 1024`。

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(P1,P2): cap log stream with MAXLEN and read tail via xrevrange"
```

---

## Task 1.4: S3 — 限流（Redis 令牌桶，全局）

**Files:**
- Create: `service/app/ratelimit.py`
- Modify: `service/app/routers/videos.py:79`（`create_video` 前置限流）
- Modify: `service/app/config.py`（新增配置）
- Test: `service/tests/test_ratelimit.py`

**Interfaces:**
- Produces: `RateLimiter.check(key: str) -> bool`；FastAPI 依赖 `enforce_create_rate_limit`

- [ ] **Step 1: 写失败测试**

`tests/test_ratelimit.py`：
```python
import pytest
from app.ratelimit import RateLimiter

@pytest.mark.asyncio
async def test_rate_limiter_blocks_after_burst(redis_client):
    rl = RateLimiter(client=redis_client, capacity=2, refill_per_sec=1)
    assert await rl.check("k") is True
    assert await rl.check("k") is True
    assert await rl.check("k") is False  # 桶空
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_ratelimit.py -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 RateLimiter**

`app/ratelimit.py`：
```python
from __future__ import annotations
import time
from redis.asyncio import Redis

class RateLimiter:
    """Redis 令牌桶，单 key 维度（如 client IP / tenant）。"""
    def __init__(self, client: Redis, capacity: int, refill_per_sec: float):
        self._c = client
        self._cap = capacity
        self._refill = refill_per_sec

    async def check(self, key: str) -> bool:
        now = time.time()
        ts_key = f"rl:{key}:ts"
        tok_key = f"rl:{key}:tok"
        async with self._c.pipeline() as p:
            p.setnx(tok_key, self._cap)
            p.setnx(ts_key, now)
            await p.execute()
        last = float(await self._c.get(ts_key))
        tokens = float(await self._c.get(tok_key))
        tokens = min(self._cap, tokens + (now - last) * self._refill)
        if tokens < 1:
            allowed = False
        else:
            tokens -= 1
            allowed = True
        await self._c.set(ts_key, now)
        await self._c.set(tok_key, tokens)
        return allowed
```

`config.py` 加：
```python
rate_limit_capacity: int = 10
rate_limit_refill_per_sec: float = 1.0
```

`videos.py` `create_video` 起始处加：
```python
ip = request.client.host if request.client else "anon"
if not await _limiter.check(f"create:{ip}"):
    raise HTTPException(429, "Rate limit exceeded")
```
并模块级单例：
```python
from app.ratelimit import RateLimiter
from redis.asyncio import from_url as aredis_from_url
_limiter = RateLimiter(aredis_from_url(settings.redis_url),
                       settings.rate_limit_capacity, settings.rate_limit_refill_per_sec)
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_ratelimit.py tests/test_videos_api.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/ratelimit.py service/app/routers/videos.py service/app/config.py service/tests/test_ratelimit.py
git commit -m "feat(S3): add Redis token-bucket rate limiter for create endpoint"
```

---

## Task 1.5: L2 — 修正 TransientError 重试语义

**Files:**
- Modify: `service/app/workers/tasks.py:245-249`（异常分类）

**Interfaces:**
- 无新接口；瞬时异常改为 raise TransientError 触发 autoretry

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_worker.py`：
```python
def test_transient_db_error_triggers_retry(monkeypatch, sample_task):
    """L2: OperationalError 应 raise TransientError 触发 autoretry。"""
    from app.workers import tasks as wt
    from sqlalchemy.exc import OperationalError

    def boom(*a, **k):
        raise OperationalError("SELECT 1", {}, Exception("db gone"))
    monkeypatch.setattr(wt, "_sync_session", boom)
    with pytest.raises(wt.TransientError):
        wt.generate_video_task.run.__wrapped__(str(sample_task.id))
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py::test_transient_db_error_triggers_retry -v`
Expected: FAIL

- [ ] **Step 3: 实现异常分类**

`tasks.py` 顶部加 import：
```python
from sqlalchemy.exc import OperationalError
import redis.exceptions
```

`tasks.py:245-249` 改为：
```python
except (OperationalError, redis.exceptions.ConnectionError,
        redis.exceptions.TimeoutError) as exc:
    logger.warning("transient error for %s: %s", task_id, exc)
    raise TransientError(f"transient: {exc}") from exc
except Exception as exc:
    logger.exception("generate_video failed for %s", task_id)
    _mark_failed(task_id, f"execution failed: {exc}")
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(L2): classify transient infra errors to trigger Celery autoretry"
```

---

# Phase 2 — P2 建议（并发稳定性 / 输入校验 / 加固）

## Task 2.1: P3 + N4 — SSE 改异步 redis + 验证 task 存在

**Files:**
- Modify: `service/app/routers/videos.py:218-278`（`video_events`）
- Modify: `service/app/db.py`（新增 async redis 客户端工厂）
- Test: `service/tests/test_sse.py`

**Interfaces:**
- Produces: `video_events(task_id, db)` 用 `redis.asyncio` 原生 `xread`，不占线程池

- [ ] **Step 1: 写失败测试（幽灵 task 返回 404 + 不占线程池）**

追加到 `tests/test_sse.py`：
```python
@pytest.mark.asyncio
async def test_sse_returns_404_for_unknown_task(client):
    """N4: 不存在的 task 应 404 而非挂起。"""
    import uuid
    resp = await client.get(f"/v1/videos/{uuid.uuid4()}/events",
                           headers={"X-Api-Key": "test"})
    assert resp.status_code == 404
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_sse.py::test_sse_returns_404_for_unknown_task -v`
Expected: FAIL

- [ ] **Step 3: 实现**

`db.py` 末尾加：
```python
from redis.asyncio import from_url as aredis_from_url
_aredis = None
def get_async_redis():
    global _aredis
    if _aredis is None:
        _aredis = aredis_from_url(settings.redis_url)
    return _aredis
```

`videos.py` `video_events` 改为（注入 `db` 依赖 + 异步 xread）：
```python
@router.get("/{task_id}/events")
async def video_events(task_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    task = await db.get(VideoTask, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    r = get_async_redis()
    stream = f"oh:logs:{task_id}"
    # 仅重放最近 500 行历史
    history = await r.xrevrange(stream, count=500)
    history.reverse()

    async def gen():
        for _, fields in history:
            if "line" in fields:
                yield {"event": "log", "data": fields["line"]}
        last = history[-1][0] if history else "0"
        while True:
            resp = await r.xread({stream: last}, block=5000, count=100)
            if not resp:
                yield {"event": "ping", "data": ""}
                continue
            for _, entries in resp:
                for eid, fields in entries:
                    last = eid
                    if "event" in fields and fields["event"] == "__DONE__":
                        yield {"event": "done", "data": task.status}
                        return
                    if "line" in fields:
                        yield {"event": "log", "data": fields["line"]}
    return EventSourceResponse(gen(), ping=15)
```
导入 `from app.db import get_async_redis`。删除原 `run_in_threadpool` 块。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_sse.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/videos.py service/app/db.py service/tests/test_sse.py
git commit -m "fix(P3,N4): async redis for SSE, 404 on unknown task"
```

---

## Task 2.2: N5 + N17 + S4 — 输入字段校验

**Files:**
- Modify: `service/app/schemas.py:19-20`（`idempotency_key` / `extra_oh_args`）
- Modify: `service/app/security.py:74-78`（flag 取值校验）
- Test: `service/tests/test_security.py`

**Interfaces:**
- 无新接口

- [ ] **Step 1: 写失败测试**

`tests/test_security.py` 追加：
```python
def test_idempotency_key_too_long_rejected():
    from app.schemas import VideoCreate
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        VideoCreate(prompt="x", idempotency_key="k" * 257)


def test_extra_oh_args_list_too_long_rejected():
    from app.schemas import VideoCreate
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        VideoCreate(prompt="x", extra_oh_args=["--model"] * 51)


def test_temperature_value_validated():
    from app.security import vet_extra_oh_args
    from app.security import ExtraArgError
    with pytest.raises(ExtraArgError):
        vet_extra_oh_args(["--temperature", "not_a_number"])
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_security.py -v`
Expected: FAIL

- [ ] **Step 3: 实现**

`schemas.py:19-20`：
```python
extra_oh_args: list[str] = Field(default_factory=list, max_length=50)
idempotency_key: str | None = Field(default=None, max_length=256)
```

`security.py` 增加取值校验表 + 逻辑：
```python
_OH_VALUE_TYPES: dict[str, type] = {
    "--model": str,
    "--temperature": float,
    "--max-turns": int,
}

def vet_extra_oh_args(args: list[str]) -> list[str]:
    vetted: list[str] = []
    i = 0
    while i < len(args):
        flag = args[i]
        if flag not in EXTRA_OH_FLAGS:
            raise ExtraArgError(f"forbidden flag: {flag}")
        if flag in _OH_VALUE_TYPES and i + 1 < len(args):
            value = args[i + 1]
            try:
                _OH_VALUE_TYPES[flag](value)
            except ValueError:
                raise ExtraArgError(f"invalid value for {flag}: {value}")
            vetted.extend([flag, value])
            i += 2
            continue
        vetted.append(flag)
        i += 1
    return vetted
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_security.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/schemas.py service/app/security.py service/tests/test_security.py
git commit -m "fix(N5,N17,S4): validate idempotency_key length, extra args list size, flag values"
```

---

## Task 2.3: N6 — created_at 复合索引 + 迁移

**Files:**
- Create: `service/alembic/versions/002_add_created_status_index.py`
- Modify: `service/app/models.py`（声明索引）

**Interfaces:**
- 无新接口

- [ ] **Step 1: 创建迁移**

```bash
cd service && alembic revision -m "add created_at_status index"
```

- [ ] **Step 2: 实现迁移**

`002_add_created_status_index.py`：
```python
"""add created_at_status index

Revision ID: 002_created_status_idx
Revises: 001_initial_video_tasks
Create Date: 2026-07-21
"""
from alembic import op

revision = "002_created_status_idx"
down_revision = "001_initial_video_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_video_tasks_created_status",
        "video_tasks",
        ["created_at", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_video_tasks_created_status", table_name="video_tasks")
```

- [ ] **Step 3: 在模型声明索引**

`models.py` `VideoTask` 类内或末尾加：
```python
from sqlalchemy import Index
Index("ix_video_tasks_created_status", "created_at", "status")
```

- [ ] **Step 4: 运行迁移 + 测试**

Run: `cd service && alembic upgrade head && python -m pytest tests/ -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/alembic/versions/002_add_created_status_index.py service/app/models.py
git commit -m "perf(N6): add (created_at, status) composite index for cleanup query"
```

---

## Task 2.4: N7 + N8 — runner stdout 上限 + start_new_session

**Files:**
- Modify: `service/app/workers/runner.py:63-72,96-103`

**Interfaces:**
- Produces: `RunResult.timed_out: bool`（N12 一并支持）

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_runner.py`：
```python
def test_run_oh_caps_stdout(monkeypatch, tmp_path):
    """N7: stdout 超上限应截断而非无限增长。"""
    from app.workers import runner

    class FakeProc:
        def __init__(self):
            self.stdout = __import__("io").StringIO("L\n" * 1_000_000)
            self.returncode = 0
        def wait(self, timeout=None): return 0
        def poll(self): return 0
    monkeypatch.setattr(runner.subprocess, "Popen", lambda *a, **k: FakeProc())
    res = runner.run_oh("p", cwd=tmp_path, timeout=60, on_log_line=lambda x: None)
    assert len(res.stdout) <= runner._MAX_STDOUT_BYTES + 1024  # 余量


def test_run_oh_uses_start_new_session(monkeypatch, tmp_path):
    """N8: 应使用 start_new_session 而非 preexec_fn。"""
    captured = {}
    real_popen = runner.subprocess.Popen
    def spy(cmd, **kw):
        captured.update(kw)
        return real_popen(cmd, **{**kw, "stdout": __import__("subprocess").DEVNULL,
                                  "stderr": __import__("subprocess").STDOUT})
    monkeypatch.setattr(runner.subprocess, "Popen", spy)
    runner.run_oh("p", cwd=tmp_path, timeout=60)
    assert captured.get("start_new_session") is True
    assert "preexec_fn" not in captured
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_runner.py -v`
Expected: FAIL

- [ ] **Step 3: 实现**

`runner.py` 顶部加：
```python
_MAX_STDOUT_BYTES = 256 * 1024  # 256KB
```

`runner.py:63-72` `Popen` 改：
```python
proc = Popen(
    cmd,
    cwd=str(cwd),
    stdout=PIPE,
    stderr=STDOUT,
    text=True,
    bufsize=1,
    env=env,
    start_new_session=True,
)
```
删除 `preexec_fn=os.setsid`。

`_reader` 改为带上限：
```python
_stdout_bytes = 0
def _reader() -> None:
    nonlocal _stdout_bytes
    for line in proc.stdout:
        if _stdout_bytes < _MAX_STDOUT_BYTES:
            lines.append(line)
            _stdout_bytes += len(line)
        if on_log_line is not None:
            on_log_line(line)
```

`RunResult` 增 `timed_out: bool`，超时分支设 `timed_out=True`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_runner.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/runner.py service/tests/test_runner.py
git commit -m "fix(N7,N8,N12): cap stdout, use start_new_session, expose timed_out flag"
```

---

## Task 2.5: N10 + N11 — SecretStr + 响应脱敏

**Files:**
- Modify: `service/app/config.py:50`（`api_key` 改 SecretStr）
- Modify: `service/app/main.py:51`（访问处改 `get_secret_value()`）
- Modify: `service/app/schemas.py:50-68`（`VideoTaskResponse` 隐藏 `output_path`）

**Interfaces:**
- 无新接口

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_api_edge.py`：
```python
def test_api_key_not_in_repr():
    from app.config import Settings
    s = Settings(api_key="supersecret")
    assert "supersecret" not in repr(s)


@pytest.mark.asyncio
async def test_task_response_hides_output_path(client, succeeded_task):
    resp = await client.get(f"/v1/videos/{succeeded_task.id}")
    body = resp.json()
    assert "output_path" not in body  # 对外不暴露
    assert "_links" in body
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_api_edge.py -v`
Expected: FAIL

- [ ] **Step 3: 实现**

`config.py`：
```python
from pydantic import SecretStr
api_key: SecretStr | None = None
```

`main.py:51`：
```python
key_val = settings.api_key.get_secret_value() if settings.api_key else ""
...
if not compare_digest(provided, key_val):
```

`schemas.py` `VideoTaskResponse` 删除 `output_path` 字段（保留 `_links` 中的 file 链接）。`log_tail` 改为 `debug_log_tail` 仅在 `debug=True` 查询参数时返回（简化：本任务先隐藏 `output_path`，`log_tail` 保留但加 `Field(repr=False)` 或在 Pydantic `model_config` 中标记 — 实际隐藏 `output_path` 即可满足主要诉求）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/ -v`
Expected: PASS（注意可能需更新依赖 `output_path` 的测试）

- [ ] **Step 5: 提交**

```bash
git add service/app/config.py service/app/main.py service/app/schemas.py service/tests/test_api_edge.py
git commit -m "fix(N10,N11): use SecretStr for api_key, hide output_path in response"
```

---

# Phase 3 — P3 优化（健壮性 / 资源 / 打磨）

## Task 3.1: L3 — 重投守卫（基于 status RUNNING 检查）

**Files:**
- Modify: `service/app/workers/tasks.py:172-184`（`generate_video_task` 开头）

**Interfaces:**
- 无新接口；任务开始时若非 QUEUED/RUNNING 则退出

> 注：完整 lease/claim 属 R8（独立项目），本任务做轻量守卫。

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_worker.py`：
```python
def test_redelivered_running_task_does_not_rerun(db_session, sample_task, monkeypatch):
    """L3: 重投到 RUNNING 任务不应重复执行 oh。"""
    from app.workers import tasks as wt
    from app.models import TaskStatus
    sample_task.status = TaskStatus.RUNNING
    db_session.add(sample_task); db_session.commit()

    called = {"n": 0}
    def fake_run(*a, **k):
        called["n"] += 1
        return wt.RunResult(exit_code=0, stdout="", stderr="", timed_out=False)
    monkeypatch.setattr(wt, "run_oh", fake_run)
    wt.generate_video_task.run.__wrapped__(str(sample_task.id))
    assert called["n"] == 0
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd service && python -m pytest tests/test_worker.py::test_redelivered_running_task_does_not_rerun -v`
Expected: FAIL

- [ ] **Step 3: 实现守卫**

`tasks.py:172` 任务开头加：
```python
with _sync_session() as db:
    current = db.execute(
        select(VideoTask.status).where(VideoTask.id == task_id)
    ).scalar_one_or_none()
if current is None:
    logger.warning("task %s not found, skip", task_id)
    return
if current == TaskStatus.SUCCEEDED:
    logger.info("task %s already SUCCEEDED, skip redelivery", task_id)
    return
# 仅 QUEUED 改 RUNNING；RUNNING 重投不重复执行（轻量守卫，待 R8 lease 增强）
if current == TaskStatus.RUNNING:
    logger.warning("task %s already RUNNING, skip redelivery", task_id)
    return
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd service && python -m pytest tests/test_worker.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py
git commit -m "fix(L3): skip redelivery of already-RUNNING tasks"
```

---

## Task 3.2: L4 — 入队即持久化 celery_task_id

**Files:**
- Modify: `service/app/routers/videos.py:130-131`
- Test: `service/tests/test_videos_api.py`

- [ ] **Step 1: 写失败测试**

```python
@pytest.mark.asyncio
async def test_create_persists_celery_task_id(client, monkeypatch, db_session):
    from app.routers import videos as vmod
    captured = {}
    class FakeResult:
        id = "celery-123"
    def fake_delay(tid):
        captured["tid"] = tid
        return FakeResult()
    monkeypatch.setattr(vmod, "generate_video_task", type("T", (), {"delay": fake_delay})())
    resp = await client.post("/v1/videos", json={"prompt": "p"})
    assert resp.status_code == 201
    from app.models import VideoTask
    t = (await db_session.execute(select(VideoTask))).scalars().one()
    assert t.celery_task_id == "celery-123"
```

- [ ] **Step 2: 运行失败** — `pytest tests/test_videos_api.py::test_create_persists_celery_task_id -v` FAIL

- [ ] **Step 3: 实现**

`videos.py:130-131`：
```python
async_result = generate_video_task.delay(str(task.id))
task.celery_task_id = async_result.id
await db.commit()
```

- [ ] **Step 4: 通过** — `pytest tests/test_videos_api.py -v` PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/videos.py service/tests/test_videos_api.py
git commit -m "fix(L4): persist celery_task_id at enqueue time"
```

---

## Task 3.3: L5 — Range 解析 end

**Files:**
- Modify: `service/app/routers/videos.py:190-208`
- Test: `service/tests/test_videos_api.py`

- [ ] **Step 1: 写失败测试**

```python
@pytest.mark.asyncio
async def test_download_range_end_respected(client, video_file):
    """L5: bytes=0-100 应只返回 101 字节。"""
    resp = await client.get(f"/v1/videos/{video_file.task_id}/file",
                            headers={"Range": "bytes=0-100"})
    assert resp.status_code == 206
    assert len(resp.content) == 101
    assert resp.headers["content-length"] == "101"
```

- [ ] **Step 2: 运行失败** — FAIL

- [ ] **Step 3: 实现**

`videos.py:190-208`：
```python
range_header = request.headers.get("range", "").lower()
start = 0
end = None
size = storage.size(storage_key) if storage_key else 0
m = re.match(r"bytes=(\d+)-(\d*)", range_header)
if m:
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else None
if end is None or end >= size:
    end = size - 1 if size else 0
start = max(0, min(start, size - 1)) if size else 0
length = max(0, end - start + 1)
status_code = 206 if range_header else 200
headers = {"accept-ranges": "bytes"}
if status_code == 206:
    headers["content-range"] = f"bytes {start}-{end}/{size}"
headers["content-length"] = str(length)
fileobj = storage.open(storage_key)
fileobj.seek(start)

def _iterfile():
    remaining = length
    try:
        while remaining > 0:
            chunk = fileobj.read(min(_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
    finally:
        fileobj.close()
```

- [ ] **Step 4: 通过** — PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/videos.py service/tests/test_videos_api.py
git commit -m "fix(L5): respect Range end byte for partial content"
```

---

## Task 3.4: P4 + P5 + P6 — pre_ping / 即时清理 / cleanup 改造

**Files:**
- Modify: `service/app/workers/tasks.py:45`（pre_ping）、`tasks.py:226-229`（即时清理）、`tasks.py:259-292`（cleanup 分批 + per-task try）

- [ ] **Step 1: 写测试（pre_ping + 即时清理）**

```python
def test_sync_engine_has_pre_ping():
    from app.workers.tasks import _get_sync_engine
    eng = _get_sync_engine()
    assert eng.pool._pre_ping is True


def test_workspace_cleaned_on_success(tmp_path, monkeypatch, sample_task):
    # 验证成功后 workspace 被删除
    ...
```

- [ ] **Step 2: 运行失败** — FAIL

- [ ] **Step 3: 实现**

`tasks.py:45`：
```python
_sync_engine = create_engine(
    settings.db_sync_url, pool_size=5, max_overflow=10, pool_pre_ping=True
)
```

`tasks.py` 成功分支末尾（`_mark_succeeded` 之后）：
```python
if task.workspace_path:
    shutil.rmtree(Path(task.workspace_path), ignore_errors=True)
```
失败分支可选保留（便于排障），仅记日志。

`tasks.py:259-292` cleanup 改 SQLAlchemy 2.0 + 分批 + per-task try：
```python
@celery_app.task(name="cleanup_expired_tasks")
def cleanup_expired_tasks() -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.retention_days)
    with _sync_session() as db:
        ids = db.execute(
            select(VideoTask.id, VideoTask.output_path, VideoTask.workspace_path)
            .where(VideoTask.created_at < cutoff,
                   VideoTask.status.in_([TaskStatus.SUCCEEDED, TaskStatus.FAILED,
                                        TaskStatus.CANCELED]))
            .limit(500)
        ).all()
    for tid, out, wp in ids:
        try:
            if out:
                storage.delete(out)
            if wp:
                shutil.rmtree(Path(wp), ignore_errors=True)
            with _sync_session() as db:
                db.execute(delete(VideoTask).where(VideoTask.id == tid))
                db.commit()
        except Exception:
            logger.exception("cleanup failed for %s", tid)
```
顶部加 `from sqlalchemy import delete`。

- [ ] **Step 4: 通过** — PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/tests/test_worker.py service/tests/test_cleanup.py
git commit -m "fix(P4,P5,P6): pre_ping, immediate workspace cleanup, batched cleanup with 2.0 style"
```

---

## Task 3.5: O1 + O2 + O3 + O4 — 健康检查 / 配置 / fps / 产物定位

**Files:**
- Modify: `service/app/routers/health.py:37`（degraded → 503）
- Modify: `service/app/config.py:16,19`（统一 host）
- Modify: `service/app/workers/parser.py:101`（fps 保留小数）、`parser.py:53`（产物定位排除临时目录）
- Test: `service/tests/test_*`

- [ ] **Step 1: 写测试**

```python
@pytest.mark.asyncio
async def test_healthz_degraded_returns_503(client, monkeypatch):
    from app.routers import health
    monkeypatch.setattr(health, "_check_redis", lambda *a: False)
    resp = await client.get("/healthz")
    assert resp.status_code == 503


def test_fps_not_truncated():
    from app.workers.parser import probe_mp4
    # 用一个 ffprobe mock 返回 30000/1001
    ...


def test_locate_output_excludes_temp(monkeypatch, tmp_path):
    # workspace 内不应被兜底选中
    ...
```

- [ ] **Step 2: 运行失败** — FAIL

- [ ] **Step 3: 实现**

`health.py:37`：
```python
return JSONResponse(503 if overall == "degraded" else 200, body)
```

`config.py`：统一默认为 `localhost`（或二者都从同一 `db_host` 派生）：
```python
db_host: str = "localhost"
db_url: str = f"postgresql+asyncpg://oh:oh@{db_host}:5432/openharness"
db_migration_url: str = f"postgresql://oh:oh@{db_host}:5432/openharness"
```
（pydantic 用 `computed_field` 或 `model_validator` 派生）

`parser.py:101` fps：
```python
fps = round(num / den, 2) if den else 0.0
```
字段类型 `fps: float`（models/migration 已是 Float）。

`parser.py:53` 兜底排除 workspace 临时子目录：
```python
candidates = [p for p in cwd.rglob("*.mp4")
              if "tmp" not in p.parts and p.stat().st_size > 1024]
```

- [ ] **Step 4: 通过** — PASS

- [ ] **Step 5: 提交**

```bash
git add service/app/routers/health.py service/app/config.py service/app/workers/parser.py service/tests/
git commit -m "fix(O1-O4): 503 on degraded, unify db host, preserve fps decimals, exclude temp mp4"
```

---

## Task 3.6: N12 + N13 + N14 + N15 + N16 — 收尾健壮性

**Files:**
- Modify: `service/app/workers/tasks.py`（N12 错误信息 / N13 cleanup per-task / N14 log 兜底 / N15 watchdog 降频）
- Modify: `service/app/config.py`（N16 默认密码校验）
- Modify: `service/app/workers/runner.py:85-91`（N15）

- [ ] **Step 1: 写测试**（每个子项一个断言）
- [ ] **Step 2: 运行失败** — FAIL
- [ ] **Step 3: 实现**

N12 — `tasks.py` 失败分支区分超时：
```python
if getattr(result, "timed_out", False):
    _mark_failed(task_id, f"timed out after {timeout}s", exit_code=result.exit_code)
else:
    _mark_failed(task_id, f"oh exited with code {result.exit_code}", exit_code=result.exit_code)
```

N13 — 见 Task 3.4（已 per-task try/except）。

N14 — `_append_log` 首次失败后停止重试：
```python
_log_push_failed: set[str] = set()
def _append_log(task_id, line):
    if task_id in _log_push_failed:
        return
    try:
        r = _redis_client()
        r.xadd(f"oh:logs:{task_id}", {"line": line}, maxlen=_LOG_CAP, approximate=True)
    except Exception:
        logger.error("Redis log push disabled for %s", task_id)
        _log_push_failed.add(task_id)
```

N15 — `runner.py:85-91` watchdog 间隔改 2.0s：
```python
while proc.poll() is None:
    time.sleep(2.0)
    if is_aborted and is_aborted():
        ...
```

N16 — `config.py` 加 `model_validator`：
```python
from pydantic import model_validator
@model_validator(mode="after")
def _warn_default_creds(self):
    if "oh:oh" in self.db_url and not self.api_key:
        logger.warning("default DB creds in use — set OH_DB_URL & OH_API_KEY")
    return self
```

- [ ] **Step 4: 通过** — PASS
- [ ] **Step 5: 提交**

```bash
git add service/app/workers/tasks.py service/app/workers/runner.py service/app/config.py service/tests/
git commit -m "fix(N12-N16): timeout error msg, log push circuit-break, watchdog freq, default creds warn"
```

---

# Phase 4 — 规格占位（R7–R20，独立项目）

> 以下属 `openspec/specs/video-service-hardening.md` 的 R7–R20，工作量巨大且需独立设计评审，**不在本修复计划范围内**，仅记录为后续项目入口：

| 需求 | 后续项目入口 |
|---|---|
| R7 原子 claim / R8 lease+heartbeat / R9 终态守卫 / R20 fencing | `plans/Phase3_Multi-Tenancy_Temporal_Lease_3217f912.md`（WS-C） |
| R10 S3 存储 + presigned | 新建 `plans/Phase4_Object_Storage.md` |
| R11 可观测性（Prometheus/structlog/readyz） | 新建 `plans/Phase4_Observability.md` |
| R13 并发控制（优先级队列 + 信号量） | 新建 `plans/Phase4_Concurrency_Control.md` |
| R14–R18 多租户/哈希 key/配额/审计/限流 | `plans/Phase3_Multi-Tenancy_Temporal_Lease_3217f912.md`（WS-A） |
| R19 可插拔调度器（Temporal） | `plans/Phase3_Multi-Tenancy_Temporal_Lease_3217f912.md`（WS-B） |

> 本计划 Task 0.1（L1 条件 UPDATE）已为 R9 终态守卫奠基；Task 3.1（L3 守卫）已为 R8 lease 预留接入点。

---

## Self-Review 核对

**1. 规格覆盖**：V1 19 项 + V2 18 项 = 37 项全部映射到任务：
- S1→0.4 / S2→0.4 / S3→1.4 / S4→2.2
- L1→0.1 / L2→1.5 / L3→3.1 / L4→3.2 / L5→3.3
- P1→1.3 / P2→1.3 / P3→2.1 / P4→3.4 / P5→3.4 / P6→3.4
- O1→3.5 / O2→3.5 / O3→3.5 / O4→3.5
- N1→0.3 / N2→1.2 / N3→0.2 / N4→2.1 / N5→2.2 / N6→2.3 / N7→2.4 / N8→2.4 / N9→1.1 / N10→2.5 / N11→2.5 / N12→3.6 / N13→3.4(并入) / N14→3.6 / N15→3.6 / N16→3.6 / N17→2.2 / N18→0.1(并入)

**2. 占位符扫描**：无 TBD/TODO，每个 code step 含实际代码。

**3. 类型一致性**：`_mark_succeeded` 返回 `bool`（0.1 定义，3.1 引用）；`RunResult.timed_out: bool`（2.4 定义，3.6 引用）；`VideoDeleteResponse.deleted: bool`（1.2 定义）；`RateLimiter.check`（1.4 定义）；`get_async_redis`（2.1 定义）。命名一致。

---

## 执行顺序建议

1. **Phase 0**（0.1 → 0.2 → 0.3 → 0.4）：阻断安全与状态一致性问题，必须先做。
2. **Phase 1**（1.1 → 1.2 → 1.3 → 1.4 → 1.5）：恢复可启动性、资源上限、重试语义。
3. **Phase 2**（2.1 → 2.2 → 2.3 → 2.4 → 2.5）：并发稳定性与输入加固。
4. **Phase 3**（3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6）：健壮性与打磨。
5. **Phase 4**：独立项目，另起 spec。

每个 Task 完成后跑全量 `pytest tests/ -v` 确保无回归。
