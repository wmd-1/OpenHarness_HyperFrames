## session-service 后端代码审查报告

### 项目概况

`session-service` 是一个基于 **FastAPI + SQLAlchemy(async) + Redis** 的交互式会话网关服务，负责管理 `oh` CLI 子进程的生命周期、WebSocket 实时流式交互、多节点路由代理，以及产物存储。整体架构设计成熟，包含完整的状态机管理、可观测性三件套（structlog/Prometheus/OpenTelemetry）和安全纵深。

---

### 🔴 高严重度问题（5 项）

| # | 问题                                               | 位置                                                                                                                                                                                                           | 影响                                                                                          |
| - | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1 | **`ffprobe` 同步阻塞事件循环**             | [artifacts.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/session/artifacts.py) L58-73                                                                                                   | `subprocess.run()` 在 async 上下文中最长阻塞 30 秒，导致所有并发 WebSocket 和 HTTP 请求卡死 |
| 2 | **Redis 连接每次操作新建，未使用连接池**     | [registry.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/session/registry.py) L50-51, [logs.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/session/logs.py) L30-31 | 心跳、日志追加等高频路径频繁 TCP 握手/断开，高并发下可耗尽文件描述符或 Redis 连接数           |
| 3 | **租户配额检查存在竞态条件 (TOCTOU)**        | [sessions.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/routers/sessions.py) L79-81                                                                                                     | 并发请求可同时通过配额检查，创建超出限额的会话                                                |
| 4 | **COLD 会话重连竞态 — 双重 rehydrate**      | [ws.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/routers/ws.py) L120-150                                                                                                               | 两个 WS 客户端同时连接 COLD 会话时，可能创建两个 LiveSession 对象，后者覆盖前者导致会话泄漏   |
| 5 | **`X-Forwarded-For` 可被伪造绕过速率限制** | [ratelimit.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/ratelimit.py) L30-35                                                                                                           | 攻击者可设置任意 IP 绕过 rate limit                                                           |

---

### 🟡 中严重度问题（7 项）

| #  | 问题                                                 | 位置                                                                                                                                                                                                  | 影响                                                                        |
| -- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 6  | **`Content-Disposition` 头注入风险**         | [sessions.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/routers/sessions.py) L242-245                                                                                          | filename 含`"` 或换行符可导致 HTTP 头注入                                 |
| 7  | **`release_lock` 的 GET+DELETE 非原子操作**  | [registry.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/session/registry.py) L137-147                                                                                          | 锁释放瞬间可能被其他 holder 抢占，应使用 Lua 脚本                           |
| 8  | **`get_db()` 缺少异常安全关闭**              | [deps.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/deps.py) L10-13                                                                                                            | 与`db.py` 中的 `get_async_session()` 行为不一致，异常时可能未显式 close |
| 9  | **Rate Limiter 令牌桶非原子操作**              | [ratelimit.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/ratelimit.py) L48-76                                                                                                  | `hgetall`→计算→`hset` 非原子，高并发下实际允许请求超过限额            |
| 10 | **直接访问 supervisor 私有成员 `_sessions`** | [sessions.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/routers/sessions.py) L80, [ws.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/routers/ws.py) L143 | 破坏封装，内部结构变更会导致外部代码悄悄出错                                |
| 11 | **WebSocket API Key 通过 query param 传递**    | [ws.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/routers/ws.py) L42-45                                                                                                        | API Key 会出现在访问日志、代理日志、浏览器历史中                            |
| 12 | **同步/异步 Redis 混用**                       | [ratelimit.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/ratelimit.py) vs [registry.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/session/registry.py)  | 限流用同步 Redis，其他用异步，不一致且同步调用阻塞事件循环                  |

---

### 🟢 低严重度问题（6 项）

| #  | 问题                                                                | 位置                                                                                                         |
| -- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 13 | S3 客户端每次调用新建，未缓存                                       | [s3.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/storage/s3.py) L77-81               |
| 14 | `BackendEvent` fallback 构造 `extra="allow"` 可接受超大 payload | [adapter.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/session/adapter.py) L73-75     |
| 15 | `ApprovalRequest.reply` 缺少枚举验证                              | [schemas.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/schemas.py) L33-37             |
| 16 | `probe_mp4` 中 `int(den)` 可能抛 `ValueError` 未被捕获        | [artifacts.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/session/artifacts.py) L88-90 |
| 17 | `orphan_scan` 中同步 `shutil.rmtree` 阻塞事件循环               | [supervisor.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/session/supervisor.py) L759 |
| 18 | `OH_TENANT_MAX_DAILY` 配置存在但无代码强制实现                    | [config.py](file:///root/projects/OpenHarness_HyperFrames/session-service/app/config.py) L94                  |

---

### 测试覆盖薄弱区域

以下模块**无任何测试覆盖**：

- 多节点代理 `proxy.py` 和路由表 `registry.py`
- Redis 日志流 `logs.py`
- 存储层 `local.py` / `s3.py`
- 可观测性模块（logging/metrics/tracing）
- 产物下载的 Range 解析逻辑

---

### 架构层面观察

- **supervisor.py 职责过重**（776 行）：同时承担会话注册、生命周期管理、turn 执行、产物注册、空闲管理、容量管理、孤儿扫描，建议拆分
- **模块级全局单例**（supervisor/settings/engine）：测试需 monkeypatch 替换，难以做多实例隔离
- **`node_id` 默认值问题**：未配置时实际为 `"local"` 而非随机 UUID，多实例部署不显式配置会冲突

---

### 修复优先级建议

1. **最优先**：#1 ffprobe 异步化 + #2 Redis 连接池化 — 生产负载下直接导致服务不可用
2. **高优先**：#5 速率限制绕过修复 + #3/#4 竞态条件加锁
3. **中优先**：#6 文件名 sanitize + #7 Lua 脚本原子释放锁 + #9 令牌桶原子化
4. **后续迭代**：封装改进、测试补充、supervisor 拆分

如需针对任何问题进行修复，请告知，我会先给出具体方案供您确认后再实施。
