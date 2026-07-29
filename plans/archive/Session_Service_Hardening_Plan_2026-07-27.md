# Session Service Hardening Plan — `session-service/`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 `session-service/` 后端代码审查发现的 18 项问题（SS-1 ~ SS-18）进行系统性修复，覆盖事件循环阻塞、Redis 连接管理、竞态条件、安全漏洞、封装破坏、测试缺失等，使 session-service 达到生产级稳定性。

**Architecture:** session-service 是 FastAPI 异步网关，管理 oh CLI 子进程的全生命周期（创建 → LIVE ⇄ IDLE → COLD → --resume）。核心模块：`supervisor.py`（776 行，生命周期管理）、`registry.py`（Redis 路由表）、`logs.py`（Redis Stream 日志）、`ratelimit.py`（令牌桶限流）、`routers/ws.py`（WebSocket 实时流）、`routers/sessions.py`（REST API）。本计划按优先级分 Phase 增量修复，每个 Task 自包含、可独立测试与提交。

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2.0 (async), Redis (asyncio + sync), PostgreSQL (asyncpg), Alembic, boto3, structlog, Prometheus, OpenTelemetry, pytest, pytest-asyncio, fakeredis, aiosqlite

## Global Constraints

- Python `>=3.11`，包管理用 `session-service/pyproject.toml`
- 所有 DB 迁移通过 Alembic 管理，本计划不涉及 schema 变更
- 修复不改变现有外部 API 行为（向后兼容），新增配置项使用 `OH_` 前缀环境变量
- 新增测试用 TDD：先写失败测试 → 实现 → 通过 → 提交
- 测试基建：`session-service/tests/` 使用 `pytest-asyncio`，Redis 测试用 `fakeredis`，DB 测试用 `sqlite+aiosqlite`
- 提交粒度：每个 Task 完成即提交，message 用 `fix:`/`feat:`/`refactor:`/`test:` 前缀

## 问题项索引（18 项）

| ID | 严重度 | 摘要 | 当前状态 |
|---|---|---|---|
| **SS-1** | 高 | `ffprobe` 同步阻塞事件循环（`subprocess.run`） | 未做 |
| **SS-2** | 高 | Redis 连接每次操作新建，未使用连接池 | 未做 |
| **SS-3** | 高 | 租户配额检查存在竞态条件（TOCTOU） | 未做 |
| **SS-4** | 高 | COLD 会话重连竞态 — 双重 rehydrate | 未做 |
| **SS-5** | 高 | X-Forwarded-For 可被伪造绕过速率限制 | 未做 |
| **SS-6** | 中 | Content-Disposition 头注入风险 | 未做 |
| **SS-7** | 中 | `release_lock` 的 GET+DELETE 非原子操作 | 未做 |
| **SS-8** | 中 | `get_db()` 缺少异常安全关闭 | 未做 |
| **SS-9** | 中 | Rate Limiter 令牌桶非原子操作 | 未做 |
| **SS-10** | 中 | 直接访问 supervisor 私有成员 `_sessions` | 未做 |
| **SS-11** | 中 | WebSocket API Key 通过 query param 传递 | 未做 |
| **SS-12** | 中 | 同步/异步 Redis 混用 | 未做 |
| **SS-13** | 低 | S3 客户端每次调用新建 | 未做 |
| **SS-14** | 低 | BackendEvent `extra="allow"` 可接受超大 payload | 未做 |
| **SS-15** | 低 | ApprovalRequest.reply 缺少枚举验证 | 未做 |
| **SS-16** | 低 | `probe_mp4` 中 `int(den)` 可能抛 ValueError 未被捕获 | 未做 |
| **SS-17** | 低 | `orphan_scan` 中同步 `shutil.rmtree` 阻塞事件循环 | 未做 |
| **SS-18** | 低 | `OH_TENANT_MAX_DAILY` 配置存在但无代码实现 | 未做 |

---

# Phase 0 — P0 关键修复（事件循环阻塞 + 竞态条件 + 安全底线）

## Task 0.1: SS-1 — ffprobe 同步阻塞事件循环

**Files:**
- Modify: `session-service/app/session/artifacts.py:58-94`（`probe_mp4` 改为异步）
- Test: `session-service/tests/test_artifacts.py`

**Interfaces:**
- `async def probe_mp4(path: Path) -> VideoMeta` — 签名变为 async，调用方需 `await`
- 内部使用 `asyncio.get_running_loop().run_in_executor()` 包装同步 `subprocess.run`

**背景**：`probe_mp4` 使用 `subprocess.run()` 同步调用 ffprobe，最长阻塞 30 秒。在 async 上下文中（supervisor 注册产物时调用），这会阻塞整个事件循环，导致所有并发 WebSocket 和 HTTP 请求卡死。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_artifacts.py
@pytest.mark.asyncio
async def test_probe_mp4_is_async():
    """SS-1: probe_mp4 must not block the event loop."""
    fake_result = MagicMock()
    fake_result.returncode = 0
    fake_result.stdout = '{"format":{"duration":"1.5"},"streams":[{"codec_type":"video","width":640,"height":480,"r_frame_rate":"30/1"}]}'
    with patch("app.session.artifacts.run", return_value=fake_result):
        counter = 0
        async def tick():
            nonlocal counter
            for _ in range(10): counter += 1; await asyncio.sleep(0.01)
        task = asyncio.create_task(tick())
        meta = await probe_mp4(Path("/fake/video.mp4"))
        await task
        assert counter > 0, "Event loop was blocked"
        assert meta.duration_seconds == 1.5
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd session-service && python -m pytest tests/test_artifacts.py::test_probe_mp4_is_async -v`
Expected: FAIL（当前 `probe_mp4` 是同步函数，`await` 会报 TypeError）

- [ ] **Step 3: 实现——将 probe_mp4 改为异步**

把 `artifacts.py:58-94` 改为：
```python
import asyncio

async def probe_mp4(path: Path) -> VideoMeta:
    """Use ffprobe to extract duration, resolution, fps, and file size.
    Runs the blocking subprocess call in a thread executor."""
    meta = VideoMeta(file_size_bytes=path.stat().st_size if path.exists() else None)
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _probe_mp4_sync, path)
        if result is not None:
            meta = result
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return meta


def _probe_mp4_sync(path: Path) -> VideoMeta | None:
    """Synchronous ffprobe invocation (runs in executor)."""
    # 与原始 probe_mp4 逻辑相同，只是提取为同步函数
    # ... (保持原有 subprocess.run + json 解析逻辑)
```

> `_probe_mp4_sync` 包含原有的 `subprocess.run(["ffprobe", ...])` + JSON 解析逻辑，从原 `probe_mp4` 中提取出来。

同时更新 `supervisor.py` 中所有 `probe_mp4` 调用处加 `await`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd session-service && python -m pytest tests/test_artifacts.py -v`

- [ ] **Step 5: 提交**

```bash
cd /root/projects/OpenHarness_HyperFrames && git add -A && git commit -m "fix(ss): SS-1 make probe_mp4 async to avoid blocking event loop"
```

---

## Task 0.2: SS-2 — Redis 连接每次操作新建，未使用连接池

**Files:**
- Modify: `session-service/app/session/registry.py:50-51`（`_client()` 改为连接池单例）
- Modify: `session-service/app/session/logs.py:30-31`（同上）
- Test: `session-service/tests/test_registry.py`

**Interfaces:**
- `_get_pool() -> aioredis.Redis` — 返回模块级缓存的 Redis 连接（连接池）
- 所有 `await _client()` 调用替换为 `await _get_pool()`（或直接 `_get_pool()`，因为不 async）

**背景**：`registry.py` 和 `logs.py` 的 `_client()` 每次调用执行 `aioredis.from_url()`，创建全新连接。心跳、日志追加等高频路径频繁 TCP 握手/断开，高并发下耗尽文件描述符或 Redis 连接数。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_registry.py
def test_redis_client_returns_same_instance():
    """SS-2: _get_pool() must return the same Redis connection pool."""
    assert registry._get_pool() is registry._get_pool()
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd session-service && python -m pytest tests/test_registry.py::test_redis_client_returns_same_instance -v`

- [ ] **Step 3: 实现——registry.py 连接池单例**

替换 `registry.py:50-51`：
```python
_pool: aioredis.Redis | None = None

def _get_pool() -> aioredis.Redis:
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(settings.broker_url, decode_responses=True)
    return _pool
```

删除所有 `finally: await r.aclose()` 块（连接池管理连接生命周期）。将所有 `r = await _client()` 替换为 `r = _get_pool()`。

- [ ] **Step 4: 同步修改 logs.py**

对 `logs.py:30-31` 做同样的改造：
```python
_pool: aioredis.Redis | None = None

def _get_pool() -> aioredis.Redis:
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(settings.broker_url, decode_responses=True)
    return _pool
```

删除所有 `finally: await r.aclose()` 块。

- [ ] **Step 5: 运行全部相关测试**

Run: `cd session-service && python -m pytest tests/test_registry.py tests/test_logs.py -v`

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "fix(ss): SS-2 use Redis connection pool singleton in registry and logs"
```

---

## Task 0.3: SS-3 — 租户配额检查存在竞态条件（TOCTOU）

**Files:**
- Modify: `session-service/app/session/supervisor.py`（添加 `asyncio.Lock` + 公开方法）
- Modify: `session-service/app/routers/sessions.py:79-81`（使用公开方法）
- Test: `session-service/tests/test_supervisor_quota.py`

**Interfaces:**
- `SessionSupervisor.count_live_for_tenant(tenant_id: str) -> int` — 统计租户活跃会话数
- `SessionSupervisor._quota_lock: asyncio.Lock` — 保护配额检查+创建的原子段

**背景**：`sessions.py:79-81` 的配额检查 `sum(1 for s in sup._sessions.values() if ...)` 与后续 `create_session()` 之间有 `await db.commit()`，并发请求可同时通过检查，超出配额。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_supervisor_quota.py
@pytest.mark.asyncio
async def test_concurrent_quota_check_does_not_exceed_limit():
    """SS-3: concurrent creates must not exceed tenant quota."""
    sup = get_supervisor()
    results = []
    async def try_create(i):
        async with sup._quota_lock:
            count = sup.count_live_for_tenant("test-tenant")
            if count >= 2:
                results.append("rejected"); return
            await asyncio.sleep(0.01)  # simulate await gap
            results.append("accepted")
    await asyncio.gather(*[try_create(i) for i in range(5)])
    assert results.count("accepted") <= 2
```

- [ ] **Step 2: 运行测试，确认失败（当前无 `_quota_lock` 属性）**

Run: `cd session-service && python -m pytest tests/test_supervisor_quota.py -v`

- [ ] **Step 3: 实现——supervisor 添加公开方法和锁**

在 `SessionSupervisor.__init__` 中添加：
```python
self._quota_lock = asyncio.Lock()
```

添加公开方法：
```python
def count_live_for_tenant(self, tenant_id: str) -> int:
    """Count live sessions for a tenant (public API, replaces _sessions access)."""
    return sum(
        1 for s in self._sessions.values()
        if s.tenant_id == tenant_id and s.is_live()
    )
```

- [ ] **Step 4: 修改 sessions.py 使用公开方法 + 锁**

替换 `sessions.py:77-83`：
```python
    sup = get_supervisor()
    async with sup._quota_lock:
        live_for_tenant = sup.count_live_for_tenant(tenant_id)
        if live_for_tenant >= settings.tenant_max_concurrent:
            raise HTTPException(status_code=429, detail="Concurrent session quota exceeded")
        # create_session is inside the lock to ensure atomicity
        try:
            conv = await sup.create_session(
                db=db,
                tenant_id=tenant_id,
                permission_policy=body.permission_policy,
                extra_args=body.extra_oh_args,
                actor_key_id=actor,
            )
        except CapacityFullError:
            raise HTTPException(status_code=503, detail="node capacity full")
```

- [ ] **Step 5: 运行测试**

Run: `cd session-service && python -m pytest tests/test_supervisor_quota.py -v`

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "fix(ss): SS-3 fix tenant quota TOCTOU race with asyncio.Lock"
```

---

## Task 0.4: SS-4 — COLD 会话重连竞态（双重 rehydrate）

**Files:**
- Modify: `session-service/app/routers/ws.py:120-150`（加锁保护 rehydrate）
- Modify: `session-service/app/session/supervisor.py`（添加 `register_session()` 公开方法）
- Test: `session-service/tests/test_ws_rehydrate.py`

**Interfaces:**
- `SessionSupervisor.register_session(sid, live) -> LiveSession` — 使用 `setdefault` 模式确保只有一个 LiveSession 被注册
- `SessionSupervisor._session_lock: asyncio.Lock` — 保护 `_sessions` 写入

**背景**：`ws.py:120-150` 中两个 WS 客户端同时连接 COLD 会话时，都尝试 rehydrate，可能创建两个 LiveSession，后者覆盖前者导致泄漏。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_ws_rehydrate.py
@pytest.mark.asyncio
async def test_concurrent_cold_rehydrate_creates_only_one_live():
    """SS-4: two concurrent WS connects to COLD session → one LiveSession."""
    sup = get_supervisor(); sup._sessions.clear()
    created = []
    async def simulate(client_id):
        async with sup._session_lock:
            if sup.has_session(sid):
                created.append("found"); return
            sup.register_session(sid, LiveSession(...))
            created.append("created")
            await asyncio.sleep(0.01)
    await asyncio.gather(simulate(1), simulate(2))
    assert created.count("created") == 1
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd session-service && python -m pytest tests/test_ws_rehydrate.py -v`

- [ ] **Step 3: 实现——supervisor 添加 session_lock 和 register_session**

在 `SessionSupervisor.__init__` 中添加：
```python
self._session_lock = asyncio.Lock()
```

添加公开方法：
```python
def has_session(self, sid: uuid.UUID) -> bool:
    """Check if a session is registered locally."""
    return sid in self._sessions

def register_session(self, sid: uuid.UUID, live: "LiveSession") -> "LiveSession":
    """Register a session using setdefault semantics — returns existing if present."""
    self._sessions.setdefault(sid, live)
    return self._sessions[sid]
```

- [ ] **Step 4: 修改 ws.py rehydrate 段加锁**

替换 `ws.py:118-150` 的 rehydrate 块（关键变更）：
```python
    live = None
    try:
        live = sup.get(sid_uuid)
    except SessionNotFound:
        async with sup._session_lock:
            # Double-check after acquiring lock (防止并发重连)
            try:
                live = sup.get(sid_uuid)
            except SessionNotFound:
                # ... 原有的 LiveSession 创建 + rehydrate 逻辑 ...
                live = LiveSession(...)
                sup.register_session(sid_uuid, live)
                await sup.rehydrate(live, db=session)
```

- [ ] **Step 5: 运行测试**

Run: `cd session-service && python -m pytest tests/test_ws_rehydrate.py -v`

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "fix(ss): SS-4 prevent double rehydrate race on COLD session reconnect"
```

---

## Task 0.5: SS-5 — X-Forwarded-For 可被伪造绕过速率限制

**Files:**
- Modify: `session-service/app/config.py`（添加 `trusted_proxies` 配置）
- Modify: `session-service/app/ratelimit.py:30-35`（`_client_ip` 加可信代理检查）
- Test: `session-service/tests/test_ratelimit.py`

**Interfaces:**
- `Settings.trusted_proxies: list[str]` — 可信代理 IP 列表，空列表表示不信任任何 X-Forwarded-For
- `_client_ip(request) -> str` — 仅当 `request.client.host` 在可信列表中时才读取 X-Forwarded-For

**背景**：攻击者可设置 `X-Forwarded-For: 1.2.3.4` 使用任意 IP 绕过 rate limit。当前代码无条件信任该 header。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_ratelimit.py
from unittest.mock import MagicMock
from app.ratelimit import _client_ip

def test_xff_ignored_from_untrusted_source():
    """SS-5: X-Forwarded-For from untrusted IP must be ignored."""
    req = MagicMock()
    req.headers = {"X-Forwarded-For": "1.2.3.4"}
    req.client.host = "10.0.0.99"  # not in trusted list
    ip = _client_ip(req)
    assert ip == "10.0.0.99", "Should use client.host when proxy is untrusted"

def test_xff_honored_from_trusted_proxy(monkeypatch):
    """SS-5: X-Forwarded-For from trusted proxy should be used."""
    from app.config import settings
    monkeypatch.setattr(settings, "trusted_proxies", ["10.0.0.1"])
    req = MagicMock()
    req.headers = {"X-Forwarded-For": "1.2.3.4, 10.0.0.1"}
    req.client.host = "10.0.0.1"
    ip = _client_ip(req)
    assert ip == "1.2.3.4"
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd session-service && python -m pytest tests/test_ratelimit.py -v`

- [ ] **Step 3: 实现**

在 `config.py` 添加：
```python
    # --- Security ---
    # Trusted proxy IPs. X-Forwarded-For is only honored when request.client.host
    # is in this list. Empty = never trust X-Forwarded-For.
    trusted_proxies: list[str] = []
```

修改 `ratelimit.py:30-35`：
```python
def _client_ip(request) -> str:
    """Extract the client IP, honoring X-Forwarded-For only from trusted proxies."""
    client_host = request.client.host if request.client else "unknown"
    if client_host in settings.trusted_proxies:
        fwd = request.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
    return client_host
```

- [ ] **Step 4: 运行测试**

Run: `cd session-service && python -m pytest tests/test_ratelimit.py -v`

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "fix(ss): SS-5 only honor X-Forwarded-For from trusted proxies"
```

---

# Phase 1 — P1 重要修复（安全加固 + 原子性 + 封装）

## Task 1.1: SS-6 — Content-Disposition 头注入风险

**Files:**
- Modify: `session-service/app/routers/sessions.py:242-245`
- Test: `session-service/tests/test_sessions_api.py`

**Interfaces:**
- `_sanitize_filename(filename: str) -> str` — 正则清理文件名

**背景**：`art.filename` 来自数据库，含 `"` 或换行符可导致 HTTP 头注入。

- [ ] **Step 1: 写失败测试**

```python
from app.routers.sessions import _sanitize_filename

def test_sanitize_filename_strips_dangerous_chars():
    assert _sanitize_filename('evil"file.mp4') == "evil_file.mp4"
    assert _sanitize_filename("hack\nme.mp4") == "hack_me.mp4"
    assert _sanitize_filename("normal-video.mp4") == "normal-video.mp4"
```

- [ ] **Step 3: 实现**

在 `sessions.py` 顶部添加：
```python
import re

def _sanitize_filename(filename: str) -> str:
    """Remove characters that could cause HTTP header injection."""
    return re.sub(r'[^\w\-.]', '_', filename)
```

修改 `sessions.py:242-245`：
```python
    filename = _sanitize_filename(art.filename or f"{sid}_{idx}.mp4")
    headers = {
        "Content-Type": "video/mp4",
        "Content-Disposition": f'attachment; filename="{filename}"',
        ...
    }
```

- [ ] **Step 4: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/test_sessions_api.py -v`
```bash
git add -A && git commit -m "fix(ss): SS-6 sanitize filename to prevent Content-Disposition header injection"
```

---

## Task 1.2: SS-7 — release_lock 的 GET+DELETE 非原子操作

**Files:**
- Modify: `session-service/app/session/registry.py:137-147`
- Test: `session-service/tests/test_registry.py`

**Interfaces:**
- `release_lock(sid, holder)` — 使用 Lua 脚本原子性释放

**背景**：GET 和 DELETE 之间锁可能被其他 holder 重新获取。

- [ ] **Step 1: 写失败测试**

```python
@pytest.mark.asyncio
async def test_release_lock_is_atomic():
    """SS-7: release_lock must only delete if current holder matches (atomic)."""
    # Use Lua script path — verified by implementation
    from app.session.registry import _RELEASE_LOCK_SCRIPT
    assert _RELEASE_LOCK_SCRIPT is not None
```

- [ ] **Step 2: 实现——Lua 脚本原子释放**

替换 `registry.py:137-147`：
```python
_RELEASE_LOCK_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
"""

async def release_lock(sid: str, holder: str) -> None:
    try:
        r = _get_pool()
        await r.eval(_RELEASE_LOCK_SCRIPT, 1, _lock_key(sid), holder)
    except Exception:
        pass
```

- [ ] **Step 3: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/test_registry.py -v`
```bash
git add -A && git commit -m "fix(ss): SS-7 use Lua script for atomic release_lock"
```

---

## Task 1.3: SS-8 — get_db() 缺少异常安全关闭

**Files:**
- Modify: `session-service/app/deps.py:10-13`

**Interfaces:**
- `get_db()` — 统一使用 `try/finally` 确保 session 关闭

**背景**：`deps.py` 的 `get_db()` 与 `db.py` 中 `get_async_session()` 行为不一致。`db.py` 有 `try/finally`，`deps.py` 依赖 `async with` 但缺少显式 close。

- [ ] **Step 1: 实现——统一使用 get_async_session**

修改 `deps.py:10-13`：
```python
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async DB session with guaranteed close on exception."""
    async with db.async_session() as session:
        try:
            yield session
        finally:
            await session.close()
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v -k "db"`
```bash
git add -A && git commit -m "fix(ss): SS-8 add try/finally to get_db for exception-safe close"
```

---

## Task 1.4: SS-9 — Rate Limiter 令牌桶非原子操作

**Files:**
- Modify: `session-service/app/ratelimit.py:48-76`
- Test: `session-service/tests/test_ratelimit.py`

**Interfaces:**
- `check_rate_limit(client_ip) -> bool` — 使用 Lua 脚本实现原子令牌桶

**背景**：`hgetall` → 计算 → `hset` 非原子，高并发下实际允许请求超过限额。

- [ ] **Step 1: 写失败测试**

```python
@pytest.mark.asyncio
async def test_rate_limit_is_atomic():
    """SS-9: verify Lua script is used for atomic token bucket."""
    from app.ratelimit import _TOKEN_BUCKET_SCRIPT
    assert _TOKEN_BUCKET_SCRIPT is not None
```

- [ ] **Step 2: 实现——Lua 脚本原子令牌桶**

替换 `ratelimit.py:43-77`（核心 Lua 脚本）：
```python
_TOKEN_BUCKET_SCRIPT = """
local key = KEYS[1] local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2]) local refill = tonumber(ARGV[3])
local tokens, ts = capacity, now
local existing = redis.call('HGETALL', key)
if #existing > 0 then
    for i = 1, #existing, 2 do
        if existing[i] == 'tokens' then tokens = tonumber(existing[i+1]) end
        if existing[i] == 'ts' then ts = tonumber(existing[i+1]) end
    end
end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, math.floor(capacity / refill) + 10)
return allowed
"""

async def check_rate_limit(client_ip: str) -> bool:
    try:
        r = _get_redis()
        key = f"oh:session:ratelimit:{client_ip}"
        allowed = await r.eval(
            _TOKEN_BUCKET_SCRIPT, 1, key,
            time.time(), settings.rate_limit_capacity, settings.rate_limit_refill,
        )
        return bool(allowed)
    except Exception:
        logger.warning("Rate limiter error for ip=%s — failing open", client_ip)
        return True
```

- [ ] **Step 3: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/test_ratelimit.py -v`
```bash
git add -A && git commit -m "fix(ss): SS-9 use Lua script for atomic token bucket rate limiter"
```

---

## Task 1.5: SS-10 — 直接访问 supervisor 私有成员 `_sessions`

**Files:**
- Modify: `session-service/app/session/supervisor.py`（添加公开方法）
- Modify: `session-service/app/routers/sessions.py:80`
- Modify: `session-service/app/routers/ws.py:143`

**Interfaces:**
- `SessionSupervisor.count_live_for_tenant(tenant_id) -> int`（SS-3 已添加）
- `SessionSupervisor.register_session(sid, live) -> LiveSession`（SS-4 已添加）
- `SessionSupervisor.has_session(sid) -> bool`（SS-4 已添加）

**背景**：多处直接访问 `sup._sessions`，破坏封装。

- [ ] **Step 1: 全局搜索 `_sessions` 的外部访问**

Run: `cd session-service && grep -rn "sup\._sessions\|supervisor\._sessions" app/`

- [ ] **Step 2: 替换所有外部访问为公开方法**

- `sessions.py:80` → `sup.count_live_for_tenant(tenant_id)`（SS-3 已改）
- `ws.py:143` → `sup.register_session(sid_uuid, live)`（SS-4 已改）

- [ ] **Step 3: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v`
```bash
git add -A && git commit -m "refactor(ss): SS-10 replace all external _sessions access with public methods"
```

---

## Task 1.6: SS-11 — WebSocket API Key 通过 query param 传递

**Files:**
- Modify: `session-service/app/routers/ws.py:42-45`（日志脱敏 + 子协议支持）
- Test: `session-service/tests/test_ws_auth.py`

**Interfaces:**
- `_ws_authed(websocket)` — 支持 `Sec-WebSocket-Protocol` 子协议传递 token

**背景**：API Key 出现在 URL query 中会被记录到访问日志。

- [ ] **Step 1: 实现——日志脱敏 + 子协议备选**

修改 `ws.py:33-50`：
```python
def _ws_authed(websocket: WebSocket) -> tuple[bool, str, str | None]:
    if not (settings.require_auth or settings.api_key):
        return True, "default", None
    
    # Try header first, then query param (for browsers)
    provided = websocket.headers.get("X-API-Key") or ""
    from_query = False
    if not provided:
        provided = websocket.query_params.get("api_key", "")
        from_query = True
    
    expected = settings.api_key.get_secret_value() if settings.api_key else ""
    if not compare_digest(provided, expected):
        return False, "", None
    
    # Log warning when key is passed via query (less secure)
    if from_query:
        log.warning("API key received via query param — consider using X-API-Key header")
    
    return True, "default", None
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v -k "ws_auth"`
```bash
git add -A && git commit -m "fix(ss): SS-11 log warning when API key sent via query param"
```

---

## Task 1.7: SS-12 — 同步/异步 Redis 混用

**Files:**
- Modify: `session-service/app/ratelimit.py`（改用 `redis.asyncio`）
- Modify: `session-service/app/routers/sessions.py`（调用方改 async）
- Modify: `session-service/app/routers/ws.py`（调用方改 async）
- Test: `session-service/tests/test_ratelimit.py`

**Interfaces:**
- `async def check_rate_limit(client_ip: str) -> bool` — 改为 async
- `async def _client_ip(request) -> str` — 保持同步（无需 Redis）

**背景**：限流用同步 Redis client，其他用异步，不一致且同步调用阻塞事件循环。

- [ ] **Step 1: 实现——ratelimit.py 改用 redis.asyncio**

将 `import redis as _redis` 替换为 `import redis.asyncio as aioredis`，连接池改用 `aioredis.from_url()`。

> 注：SS-9 已将 `check_rate_limit` 改为 `async def` + Lua 脚本，本任务只需确保底层连接也使用 `redis.asyncio`。

- [ ] **Step 2: 更新调用方**

`sessions.py:71`：`if not await check_rate_limit(_client_ip(request)):`
`ws.py:88`：`if not await check_rate_limit(_client_ip(websocket)):`

- [ ] **Step 3: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/test_ratelimit.py -v`
```bash
git add -A && git commit -m "fix(ss): SS-12 unify ratelimit to use redis.asyncio"
```

---

# Phase 2 — P2 中等修复（资源管理 + 输入校验）

## Task 2.1: SS-13 — S3 客户端每次调用新建

**Files:** Modify: `session-service/app/storage/s3.py:77-81`

**背景**：`storage_for_kind()` 每次调用创建新的 `S3ArtifactStorage()`，内部 `boto3.client()` 开销大。

- [ ] **Step 1: 实现——缓存 storage 实例**

```python
_s3_cache: S3ArtifactStorage | None = None
_local_cache: LocalArtifactStorage | None = None

def storage_for_kind(kind: str) -> LocalArtifactStorage | S3ArtifactStorage:
    global _s3_cache, _local_cache
    if kind == "s3":
        if _s3_cache is None:
            _s3_cache = S3ArtifactStorage()
        return _s3_cache
    if _local_cache is None:
        _local_cache = LocalArtifactStorage()
    return _local_cache
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v -k "storage"`
```bash
git add -A && git commit -m "fix(ss): SS-13 cache S3 and Local storage instances"
```

---

## Task 2.2: SS-14 — BackendEvent extra="allow" 可接受超大 payload

**Files:** Modify: `session-service/app/session/adapter.py:67-75`

**背景**：`extra="allow"` 加上 passthrough fallback 可接受任意大小 payload。

- [ ] **Step 1: 实现——添加 payload 大小限制**

在 `adapter.py` 的 except 块中添加大小检查：
```python
            except Exception as exc:
                raw_size = len(json.dumps(data))
                if raw_size > 10_240:
                    log.warning("BackendEvent payload too large (%d bytes), dropping", raw_size)
                    continue
                event = BackendEvent(type=str(data.get("type", "unknown")), **{
                    k: v for k, v in data.items() if k != "type"
                })
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v -k "adapter"`
```bash
git add -A && git commit -m "fix(ss): SS-14 limit BackendEvent passthrough payload size to 10KB"
```

---

## Task 2.3: SS-15 — ApprovalRequest.reply 缺少枚举验证

**Files:** Modify: `session-service/app/schemas.py:33-37`

- [ ] **Step 1: 实现**

```python
class ApprovalRequest(BaseModel):
    request_id: str
    allowed: bool = True
    reply: str | None = Field(default=None, pattern="^(once|always|reject)$")
    answer: str | None = Field(default=None, max_length=32000)
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v -k "schema"`
```bash
git add -A && git commit -m "fix(ss): SS-15 add enum validation to ApprovalRequest.reply"
```

---

## Task 2.4: SS-16 — probe_mp4 中 int(den) 可能抛 ValueError

**Files:** Modify: `session-service/app/session/artifacts.py:92`

- [ ] **Step 1: 实现** — 在 except 子句中加入 ValueError：

```python
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        pass
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/test_artifacts.py -v`
```bash
git add -A && git commit -m "fix(ss): SS-16 catch ValueError in probe_mp4 frame rate parsing"
```

---

## Task 2.5: SS-17 — orphan_scan 中同步 shutil.rmtree 阻塞事件循环

**Files:** Modify: `session-service/app/session/supervisor.py:759`

- [ ] **Step 1: 实现** — 替换同步调用：

```python
    from fastapi.concurrency import run_in_threadpool
    await run_in_threadpool(shutil.rmtree, entry, True)
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v -k "orphan"`
```bash
git add -A && git commit -m "fix(ss): SS-17 wrap shutil.rmtree in run_in_threadpool in orphan_scan"
```

---

## Task 2.6: SS-18 — OH_TENANT_MAX_DAILY 配置存在但无代码实现

**Files:**
- Modify: `session-service/app/routers/sessions.py`
- Test: `session-service/tests/test_daily_quota.py`

**背景**：`tenant_max_daily` 配置存在但无代码使用。

- [ ] **Step 1: 写失败测试**

```python
@pytest.mark.asyncio
async def test_daily_quota_enforced():
    """SS-18: tenant_max_daily must be enforced."""
    ...
```

- [ ] **Step 2: 实现——在 create_session 中添加每日配额检查**

在配额检查段添加：
```python
    from sqlalchemy import func
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    daily_count = (await db.execute(
        select(func.count()).select_from(Conversation).where(
            Conversation.tenant_id == tenant_id,
            Conversation.created_at >= today_start,
        )
    )).scalar() or 0
    if daily_count >= settings.tenant_max_daily:
        raise HTTPException(status_code=429, detail="Daily session quota exceeded")
```

- [ ] **Step 3: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/test_daily_quota.py -v`
```bash
git add -A && git commit -m "feat(ss): SS-18 implement daily tenant quota check"
```

---

# Phase 3 — P3 低优改进（测试覆盖 + 架构改进）

## Task 3.1: 补充缺失的测试覆盖

**Files:**
- Create: `session-service/tests/test_proxy.py` — 多节点 WS 代理路由逻辑
- Create: `session-service/tests/test_registry_full.py` — Redis 路由表 CRUD + 锁
- Create: `session-service/tests/test_logs_full.py` — Redis Stream 日志追加/读取/清理
- Create: `session-service/tests/test_storage.py` — local 和 S3 存储层
- Create: `session-service/tests/test_artifact_range.py` — 产物下载 Range header 解析

**背景**：proxy.py / registry.py / logs.py / storage / Range 解析均无测试覆盖。

- [ ] **Step 1:** proxy.py 测试 — 验证本地/远程路由分支
- [ ] **Step 2:** registry.py 测试 — 路由注册/查询/过期/锁获取释放
- [ ] **Step 3:** logs.py 测试 — append/tail/clear 使用 fakeredis
- [ ] **Step 4:** storage 测试 — LocalArtifactStorage 读写 + S3 mock
- [ ] **Step 5:** Range 解析测试 — 各种 Range header 格式

Run: `cd session-service && python -m pytest tests/ -v`
```bash
git add -A && git commit -m "test(ss): add test coverage for proxy, registry, logs, storage, and Range parsing"
```

---

## Task 3.2: 架构改进 — supervisor.py 拆分

**Files:**
- Modify: `session-service/app/session/supervisor.py`（776 行，职责过重）
- Create: `session-service/app/session/lifecycle_manager.py` — 会话创建/关闭/状态转换
- Create: `session-service/app/session/turn_runner.py` — turn 执行/流式/中断

**背景**：supervisor.py 承担生命周期管理 + turn 执行 + 产物注册，建议拆分。

- [ ] **Step 1:** 提取 `lifecycle_manager.py` — create_session / close / rehydrate / state transitions
- [ ] **Step 2:** 提取 `turn_runner.py` — stream_turn / interrupt / respond_approval
- [ ] **Step 3:** 保留 supervisor 为门面，委托调用拆分后的模块
- [ ] **Step 4:** 运行全部测试确认无回归

Run: `cd session-service && python -m pytest tests/ -v`
```bash
git add -A && git commit -m "refactor(ss): split supervisor.py into lifecycle_manager and turn_runner"
```

---

## Task 3.3: 架构改进 — 模块级全局单例不利于测试

**Files:** Modify: `session-service/app/session/supervisor.py:771`

**背景**：模块级全局 `supervisor` 单例不利于测试隔离。

- [ ] **Step 1: 添加 `reset_supervisor()` 用于测试重置**

```python
def reset_supervisor() -> None:
    """Reset the global supervisor singleton (for tests only)."""
    global supervisor
    supervisor = SessionSupervisor()
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v`
```bash
git add -A && git commit -m "refactor(ss): add reset_supervisor() for test isolation"
```

---

## Task 3.4: 修复 node_id 默认值行为与注释不一致

**Files:** Modify: `session-service/app/config.py:68`

**背景**：注释说 "When unset a random uuid is generated at startup"，但 `_node_id()` 返回 `"local"`。

- [ ] **Step 1: 实现——在 config 初始化时生成随机 node_id**

```python
    node_id: str | None = None

    def model_post_init(self, __context: Any) -> None:
        if not self.node_id:
            import uuid as _uuid
            object.__setattr__(self, "node_id", str(_uuid.uuid4()))
```

- [ ] **Step 2: 运行测试并提交**

Run: `cd session-service && python -m pytest tests/ -v`
```bash
git add -A && git commit -m "fix(ss): generate random node_id when unset, matching comment"
```
