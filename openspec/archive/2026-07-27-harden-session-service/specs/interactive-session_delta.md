# Delta: interactive-session — harden-session-service

**Change ID:** `harden-session-service`
**Affects:** `session-service/app/**`, `session-service/tests/**`, `openspec/specs/interactive-session.md`
**Source:** `session-service/` code review — 18 findings (SS-1 至 SS-18)

> 本 delta 对现有 `interactive-session` spec 基线（17 个 Requirement）进行加固（MODIFY）和补充（ADD）。所有变更均为增量修复，不改变现有 API 契约或协议行为。

---

## MODIFIED Requirements

### Requirement: SS-R1 子进程产物探测 MUST NOT 阻塞事件循环 [MODIFY]

产物注册时的 `probe_mp4`（调用 `ffprobe`）和孤儿工作空间清理时的 `shutil.rmtree` MUST 通过 `run_in_executor` 或 `run_in_threadpool` 卸载到线程池执行，MUST NOT 直接在 asyncio 事件循环中同步调用。这些操作为同步阻塞操作，直接调用会阻塞事件循环，导致所有并发 WS 连接和 HTTP 请求被挂起。

*对应问题：SS-1（ffprobe 阻塞）、SS-17（rmtree 阻塞）*

#### Scenario: ffprobe 异步化
- **GIVEN** 一个轮次产生了 mp4 产物
- **WHEN** supervisor 注册产物调用 `probe_mp4`
- **THEN** 该调用通过 `run_in_executor` 在线程池中执行，不阻塞 asyncio 事件循环

#### Scenario: orphan_scan 异步化
- **GIVEN** 服务启动时存在孤儿工作空间
- **WHEN** `orphan_scan` 清理目录
- **THEN** `shutil.rmtree` 通过 `run_in_threadpool` 执行

---

### Requirement: SS-R2 Redis 连接池 MUST 复用 [MODIFY]

所有模块 MUST 使用统一的 `redis.asyncio` 客户端，并通过模块级连接池单例复用，MUST NOT 每次调用创建新连接或混用同步/异步客户端。`registry.py` 和 `logs.py` 每次调用 `_client()` 时通过 `redis.from_url()` 创建新连接，导致 TCP 连接泄漏；`ratelimit.py` 使用同步 `redis.Redis` 而其他模块使用 `redis.asyncio`，混用造成事件循环阻塞。

*对应问题：SS-2（Redis 连接泄漏）、SS-12（Redis 客户端混用）*

#### Scenario: 连接池单例
- **GIVEN** registry 和 logs 模块需要 Redis 连接
- **WHEN** 多次调用 `_client()`
- **THEN** 返回同一连接池实例，不重复创建 TCP 连接

#### Scenario: 统一异步客户端
- **GIVEN** 限流和路由表均使用 Redis
- **WHEN** 任何模块需要 Redis 访问
- **THEN** 统一使用 `redis.asyncio` 客户端，不存在同步 Redis 调用

---

### Requirement: SS-R3 租户配额 MUST 原子检查 [MODIFY]

租户并发会话配额检查（count + create）MUST 在同一个 `asyncio.Lock` 保护下执行或通过 supervisor 提供的公开方法保证原子性，MUST NOT 存在 TOCTOU 竞态窗口。当前配额检查为非原子操作，并发请求可在检查和创建之间通过，导致超卖。

*对应问题：SS-3（租户配额 TOCTOU 竞态）*

#### Scenario: 并发创建不超配额
- **GIVEN** 租户配额为 8 且当前 7 个 live 会话
- **WHEN** 两个并发创建请求同时到达
- **THEN** 仅一个通过检查并创建，另一个被拒绝（403/503）

---

### Requirement: SS-R4 COLD 重连 MUST 单写者保证 [MODIFY]

COLD 会话重连 MUST 通过 supervisor 内部的 `register_live_session()` 方法加锁，保证仅一个客户端触发 rehydrate，MUST NOT 允许两个 WS 客户端同时触发 `oh --resume` 竞争同一个 `cwd`。当两个 WS 客户端同时尝试重连同一个 COLD 会话时，当前实现可能触发两次 rehydrate。

*对应问题：SS-4（双重 rehydrate 竞态）*

#### Scenario: 并发重连幂等
- **GIVEN** 一个 COLD 状态的会话
- **WHEN** 两个 WebSocket 客户端同时尝试重连
- **THEN** 仅一个触发 rehydrate，另一个等待复用已恢复的 LiveSession

---

### Requirement: SS-R5 速率限制 MUST 防绕过 [MODIFY]

`X-Forwarded-For` MUST 仅在配置了可信代理（`OH_TRUSTED_PROXY`）后读取，MUST NOT 直接信任未经验证的 XFF 头；令牌桶操作（`hgetall` + 计算 + `hset`）MUST 通过 Lua 脚本原子执行，MUST NOT 存在竞态超卖窗口。当前限流 key 直接读取 XFF 头，攻击者可伪造绕过限流；令牌桶为非原子操作，高并发下存在竞态。

*对应问题：SS-5（XFF 伪造）、SS-9（令牌桶非原子）*

#### Scenario: XFF 仅在可信代理后生效
- **GIVEN** 部署配置了 `OH_TRUSTED_PROXY`
- **WHEN** 请求来自非可信代理且携带伪造 `X-Forwarded-For`
- **THEN** 使用 `request.client.host` 作为限流 key

#### Scenario: 令牌桶原子操作
- **GIVEN** 高并发请求
- **WHEN** 令牌桶检查执行
- **THEN** `hgetall` + 计算 + `hset` 通过 Lua 脚本原子执行，不存在竞态超卖

---

### Requirement: SS-R6 HTTP 响应头 MUST 安全 sanitize [MODIFY]

产物下载时文件名 MUST 经过 sanitize，仅保留安全字符 `[\w\-.]`，其余替换为下划线，MUST NOT 直接拼接到 `Content-Disposition` 头中。若文件名包含引号或特殊字符（如 `"; rm -rf /`），可直接拼接可导致头注入。

*对应问题：SS-6（Content-Disposition 头注入）*

#### Scenario: 文件名 sanitize
- **GIVEN** 产物文件名包含引号或特殊字符
- **WHEN** 生成 `Content-Disposition` 头
- **THEN** 文件名仅保留安全字符 `[\w\-.]`，其余替换为下划线

---

### Requirement: SS-R7 Redis 分布式锁 MUST 原子释放 [MODIFY]

Redis 分布式锁释放 MUST 通过 Lua 脚本原子执行 `GET` + 比较 + `DELETE`，MUST NOT 分三步非原子操作。当前 `release_lock` 实现为 `GET` → 比较 → `DELETE` 三步操作，在 GET 和 DELETE 之间锁可能已过期并被其他客户端获取，导致误删他人的锁。

*对应问题：SS-7（锁释放 TOCTOU 竞态）*

#### Scenario: 锁释放原子性
- **GIVEN** holder 释放锁
- **WHEN** 执行 `release_lock`
- **THEN** `GET` + 比较 + `DELETE` 通过 Lua 脚本原子执行，不存在 TOCTOU 竞态

---

### Requirement: SS-R8 输入 MUST 验证加固 [MODIFY]

`BackendEvent` payload MUST 限制大小，超大 payload MUST 被截断或拒绝；`ApprovalRequest` 的 `reply` 字段 MUST 做枚举验证（仅允许 `once`/`always`/`reject`）；`ffprobe` 帧率解析 MUST 捕获 `ValueError` 并优雅降级。当前上游发送的 payload 无大小限制可导致内存耗尽，`reply` 字段未验证可穿透到子进程，ffprobe 异常输出可抛出未捕获异常。

*对应问题：SS-14（BackendEvent payload 过大）、SS-15（ApprovalRequest 枚举未验证）、SS-16（ffprobe ValueError 未捕获）*

#### Scenario: BackendEvent payload 限制
- **GIVEN** 上游发送超大 payload
- **WHEN** 解析 `BackendEvent`
- **THEN** 超过合理大小的 payload 被截断或拒绝

#### Scenario: ApprovalRequest reply 枚举
- **GIVEN** 客户端提交审批回复
- **WHEN** `reply` 字段不是 `once`/`always`/`reject` 之一
- **THEN** 返回 422 验证错误

#### Scenario: ffprobe ValueError 捕获
- **GIVEN** ffprobe 输出格式异常（如帧率为 `"30/abc"`）
- **WHEN** 解析帧率
- **THEN** `ValueError` 被捕获并优雅降级

---

## ADDED Requirements

### Requirement: SS-R9 Supervisor MUST 封装完整 [ADD]

Supervisor MUST 提供 `count_live_for_tenant()`、`register_live_session()`、`remove_live_session()` 等公开方法供外部调用，MUST NOT 允许路由层或 WS handler 直接访问 `_sessions` 私有属性。当前路由层直接访问私有属性查询租户 live 会话数，WS handler 直接操作内部状态注册 rehydrated 会话，破坏了封装。

*对应问题：SS-10（封装破坏）*

#### Scenario: 公开方法替代私有访问
- **GIVEN** 路由层需要查询租户 live 会话数
- **WHEN** 调用 `supervisor.count_live_for_tenant(tenant_id)`
- **THEN** 返回正确计数，无需直接访问 `_sessions` 私有属性

#### Scenario: 会话注册通过公开接口
- **GIVEN** WS handler 需要注册 rehydrated 会话
- **WHEN** 调用 `supervisor.register_live_session()`
- **THEN** 会话被安全注册，内部状态一致性由 supervisor 保证

---

### Requirement: SS-R10 WebSocket 鉴权 MUST 安全增强 [ADD]

WebSocket 连接的 `api_key` MUST 在日志中脱敏显示为 `"***"`，MUST NOT 完整记录明文。可选地，部署可配置 `OH_WS_AUTH_MODE=ticket` 使用一次性 ticket 替代明文 api_key。当前 WebSocket 通过 query param 传递 `api_key`，该值在请求日志中被完整记录，存在泄露风险。

*对应问题：SS-11（WS API Key 泄露）*

#### Scenario: API Key 日志脱敏
- **GIVEN** WebSocket 连接通过 query param 传递 `api_key`
- **WHEN** 请求被记录到日志
- **THEN** `api_key` 值被脱敏显示为 `"***"`

#### Scenario: 短期 ticket 替代方案（可选）
- **GIVEN** 部署配置了 `OH_WS_AUTH_MODE=ticket`
- **WHEN** 客户端请求 WS 连接
- **THEN** 使用一次性 ticket 替代明文 api_key

---

### Requirement: SS-R11 DB 依赖 MUST 一致关闭 [ADD]

所有 DB session 依赖 MUST 使用统一的 `try/finally` 模式保证显式关闭，MUST NOT 在异常退出时泄漏连接。`get_db()` 的 generator 在异常退出时未显式 close session，与 `get_async_session()` 的 `try/finally` 模式不一致。

*对应问题：SS-8（get_db 与 get_async_session 行为不一致）*

#### Scenario: 统一 session 关闭
- **GIVEN** 路由处理中抛出异常
- **WHEN** `get_db()` 的 generator 退出
- **THEN** session 在 `finally` 块中被显式 close，与 `get_async_session()` 行为一致

---

### Requirement: SS-R12 存储客户端 MUST 缓存复用 [ADD]

`storage_for_kind()` MUST 缓存存储实例，MUST NOT 每次调用创建新的 boto3 client。同时，`OH_TENANT_MAX_DAILY` 每日配额 MUST 强制执行，达到上限时 MUST 返回 403 拒绝创建。当前 `storage_for_kind("s3")` 每次创建新 client，重复初始化开销大且可能耗尽连接池；`OH_TENANT_MAX_DAILY` 配置存在但检查逻辑未实现。

*对应问题：SS-13（S3 客户端重复创建）、SS-18（每日配额未实现）*

#### Scenario: S3 客户端复用
- **GIVEN** 多次 artifact 操作
- **WHEN** 调用 `storage_for_kind("s3")`
- **THEN** 返回缓存的存储实例，不重复创建 boto3 client

#### Scenario: 每日配额强制执行
- **GIVEN** 配置了 `OH_TENANT_MAX_DAILY`
- **WHEN** 租户当日创建会话数达到上限
- **THEN** 返回 403 拒绝创建
