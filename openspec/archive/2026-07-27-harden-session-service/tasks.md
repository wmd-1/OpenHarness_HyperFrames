# Tasks: harden-session-service

**Change ID:** `harden-session-service`
**Source plan:** session-service code review — 18 findings (SS-1 至 SS-18)
**Spec delta:** `openspec/changes/harden-session-service/specs/interactive-session_delta.md`

> 基于 session-service 代码审查的 18 项发现，按优先级分阶段修复。每个任务配套 TDD 测试，完成后运行 `cd session-service && python -m pytest -q` 验证无回归。

---

## Phase 0 — P0 关键修复（服务可用性 + 安全底线）

- [x] **Task 0.1 (SS-1)**: ffprobe 异步化 — `session-service/app/session/artifacts.py` — 用 `run_in_executor` 包装 `probe_mp4`，新增 `probe_mp4_async`
  - Spec: SS-R1 [MODIFY]

- [x] **Task 0.2 (SS-2)**: Redis 连接池 — `session-service/app/session/registry.py` + `logs.py` — 模块级连接池单例替代每次 `from_url()`
  - Spec: SS-R2 [MODIFY]

- [x] **Task 0.3 (SS-3)**: 租户配额原子化 — `session-service/app/routers/sessions.py` + `supervisor.py` — `asyncio.Lock` 保护 check+create，新增 `count_live_for_tenant()` 公开方法
  - Spec: SS-R3 [MODIFY]

- [x] **Task 0.4 (SS-4)**: COLD 重连单写者 — `session-service/app/routers/ws.py` + `supervisor.py` — 新增 `register_live_session()` 方法，内部加锁防双重 rehydrate
  - Spec: SS-R4 [MODIFY]

- [x] **Task 0.5 (SS-5)**: XFF 防伪造 — `session-service/app/ratelimit.py` + `config.py` — 新增 `OH_TRUSTED_PROXY` 配置，仅可信代理后读取 XFF
  - Spec: SS-R5 [MODIFY]

**Quality Gate (Phase 0):**
- [x] `pytest tests/ -v` 通过
- [x] ffprobe 通过 `run_in_executor` 异步执行
- [x] Redis 连接池单例验证（多次调用返回同一实例）
- [x] 并发创建不超配额
- [x] 并发 COLD 重连仅触发一次 rehydrate
- [x] 非可信代理后 XFF 被忽略

---

## Phase 1 — P1 重要修复（安全 + 原子性 + 封装）

- [x] **Task 1.1 (SS-6)**: Content-Disposition sanitize — `session-service/app/routers/sessions.py` — 正则过滤文件名特殊字符
  - Spec: SS-R6 [MODIFY]

- [x] **Task 1.2 (SS-7)**: 锁释放 Lua 脚本 — `session-service/app/session/registry.py` — `release_lock` 改用 `EVAL` 原子操作
  - Spec: SS-R7 [MODIFY]

- [x] **Task 1.3 (SS-8)**: get_db 安全关闭 — `session-service/app/deps.py` — 统一 `try/finally` 模式
  - Spec: SS-R11 [ADD]

- [x] **Task 1.4 (SS-9)**: 令牌桶 Lua 原子化 — `session-service/app/ratelimit.py` — `hgetall+calc+hset` 改为 Lua `EVAL`
  - Spec: SS-R5 [MODIFY]

- [x] **Task 1.5 (SS-10)**: Supervisor 封装 — `session-service/app/session/supervisor.py` — 新增 `count_live_for_tenant()`、`register_live_session()`、`remove_live_session()` 公开方法
  - Spec: SS-R9 [ADD]

- [x] **Task 1.6 (SS-11)**: WS API Key 脱敏 — `session-service/app/routers/ws.py` + `observability/logging.py` — 日志中 mask api_key
  - Spec: SS-R10 [ADD]

- [x] **Task 1.7 (SS-12)**: Redis 客户端统一 — `session-service/app/ratelimit.py` — 同步 redis 改为 `redis.asyncio`
  - Spec: SS-R2 [MODIFY]

**Quality Gate (Phase 1):**
- [x] `pytest tests/ -v` 通过
- [x] Content-Disposition 文件名已 sanitize
- [x] 锁释放通过 Lua 脚本原子执行
- [x] get_db 异常退出时 session 被显式 close
- [x] 令牌桶通过 Lua 脚本原子执行
- [x] supervisor 无外部直接访问 `_sessions`
- [x] API Key 在日志中脱敏
- [x] 无同步 Redis 调用残留

---

## Phase 2 — P2 中等修复（输入验证 + 资源管理 + 异常处理）

- [x] **Task 2.1 (SS-13)**: S3 客户端缓存 — `session-service/app/storage/s3.py` — `storage_for_kind()` 缓存实例
  - Spec: SS-R12 [ADD]

- [x] **Task 2.2 (SS-14)**: BackendEvent payload 限制 — `session-service/app/session/adapter.py` — 限制解析字段数量/大小
  - Spec: SS-R8 [MODIFY]

- [x] **Task 2.3 (SS-15)**: ApprovalRequest 枚举验证 — `session-service/app/schemas.py` — `reply` 字段加 `pattern` 约束
  - Spec: SS-R8 [MODIFY]

- [x] **Task 2.4 (SS-16)**: ffprobe ValueError — `session-service/app/session/artifacts.py` — except 子句加入 `ValueError`
  - Spec: SS-R8 [MODIFY]

- [x] **Task 2.5 (SS-17)**: rmtree 异步化 — `session-service/app/session/supervisor.py` — `orphan_scan` 中 `shutil.rmtree` 用 `run_in_threadpool` 包装
  - Spec: SS-R1 [MODIFY]

- [x] **Task 2.6 (SS-18)**: 每日配额实现 — `session-service/app/routers/sessions.py` + `config.py` — 实现 `tenant_max_daily` 检查逻辑
  - Spec: SS-R12 [ADD]

**Quality Gate (Phase 2):**
- [x] `pytest tests/ -v` 通过
- [x] S3 客户端缓存验证
- [x] 超大 payload 被截断或拒绝
- [x] 非法 reply 枚举返回 422
- [x] ffprobe 异常输出优雅降级
- [x] rmtree 通过 `run_in_threadpool` 异步执行
- [x] 每日配额达到上限返回 403

---

## Phase 3 — 测试补充 + 架构改进

- [x] **Task 3.1**: 补充 proxy.py 测试 — `session-service/tests/test_proxy.py` — 多节点 WS 代理路由/转发/错误处理
  - 覆盖：本地/远程路由判断、透明代理转发、WS 数据双向透传、目标节点不可达时的错误处理

- [x] **Task 3.2**: 补充 registry.py 测试 — `session-service/tests/test_registry.py` — 路由注册/心跳/锁获取释放
  - 覆盖：路由注册写入、心跳 TTL 续期、锁获取成功/失败、锁释放（含 Lua 脚本原子性测试）

- [x] **Task 3.3**: 补充 logs.py 测试 — `session-service/tests/test_logs.py` — Redis Stream 有界追加/读取
  - 覆盖：`XADD MAXLEN ~` 有界追加、`XREVRANGE COUNT` 尾部读取、连接池复用验证

- [x] **Task 3.4**: 补充 storage 测试 — `session-service/tests/test_storage.py` — local + S3 存储 CRUD
  - 覆盖：local 存储读写/删除、S3 客户端缓存验证、Range 请求支持

- [x] **Task 3.5**: 产物下载 Range 测试 — `session-service/tests/test_sessions_api.py` — Range header 解析 + 206 响应
  - 覆盖：完整 Range header 解析、206 Partial Content 响应、Content-Range/Content-Length 正确性

**Quality Gate (Phase 3):**
- [x] `pytest tests/ -v` 全部通过，覆盖率不降
- [x] proxy/registry/logs/storage 模块均有独立测试文件
- [x] 所有新增测试在隔离环境可运行

---

## 问题 → 任务 → Spec 映射

| 问题 | 任务 | Delta Spec |
|------|------|-----------|
| SS-1 ffprobe 阻塞 | Task 0.1 | SS-R1 |
| SS-2 Redis 连接泄漏 | Task 0.2 | SS-R2 |
| SS-3 配额竞态 | Task 0.3 | SS-R3 |
| SS-4 双重 rehydrate | Task 0.4 | SS-R4 |
| SS-5 XFF 伪造 | Task 0.5 | SS-R5 |
| SS-6 头注入 | Task 1.1 | SS-R6 |
| SS-7 锁释放竞态 | Task 1.2 | SS-R7 |
| SS-8 DB 依赖不一致 | Task 1.3 | SS-R11 |
| SS-9 令牌桶非原子 | Task 1.4 | SS-R5 |
| SS-10 封装破坏 | Task 1.5 | SS-R9 |
| SS-11 WS Key 泄露 | Task 1.6 | SS-R10 |
| SS-12 Redis 混用 | Task 1.7 | SS-R2 |
| SS-13 S3 客户端 | Task 2.1 | SS-R12 |
| SS-14 payload 过大 | Task 2.2 | SS-R8 |
| SS-15 枚举验证 | Task 2.3 | SS-R8 |
| SS-16 ValueError | Task 2.4 | SS-R8 |
| SS-17 rmtree 阻塞 | Task 2.5 | SS-R1 |
| SS-18 每日配额未实现 | Task 2.6 | SS-R12 |
