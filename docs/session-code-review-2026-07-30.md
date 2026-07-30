# Session 服务代码审核报告（2026-07-30）

- **审核范围**：`session-service/`（后端 FastAPI 服务，约 27 个源文件全部通读）与 `session-frontend/`（React SPA，核心源码 + 构建/部署配置）
- **审核方式**：人工静态审阅，覆盖架构设计、安全性、性能、代码质量、潜在缺陷、集成兼容性与最佳实践
- **交叉验证**：`docker-compose.yml`、`.env.example`、`nginx.conf.template`、Alembic 迁移链、与 `service/`（api 服务）共享的 Postgres/Redis/MinIO 配置

---

## 1. 总体评价

两个模块整体质量**明显高于项目平均水平**：后端在多租户鉴权（恒时比较、sha256 多 key 表）、租户隔离（越权一律 404）、准入控制（事件循环原子性、无 await 临界区）、路径遍历防护、Lua 原子限流/分布式锁等方面都体现了成熟的工程实践；前端在 XSS 防护（react-markdown 不开 raw HTML + 严格 CSP）、终端 ANSI 注入清理、WS 差异化重连、流式渲染节流、请求竞态防护等方面也做得系统而克制，且代码内自带对已知权衡的注释（如 C3 性能 TODO）。

但审核仍发现 **1 个功能性 Bug（前后端契约不匹配）**、若干安全加固点与健壮性隐患，按严重程度分级如下。

| 级别 | 数量 | 说明 |
|---|---|---|
| 高（H） | 4 | 功能性缺陷或启用某配置即触发的安全/正确性问题 |
| 中（M） | 13 | 特定条件下触发，或安全纵深不足 |
| 低（L） | 8 | 代码质量、可维护性、风格问题 |

---

## 2. 高优先级问题（H）

### H1.【Bug·前后端契约不匹配】工作区文件下载直链在启用鉴权时必定 401

- 前端 [sessions.ts](../session-frontend/src/api/sessions.ts) `workspaceFileUrl()` 生成 `/v1/sessions/{sid}/workspace/files/{path}?api_key=...` 直链，供 `WorkspaceFilesPanel` 的 `<a download>` 使用；
- 但后端 [main.py](../session-service/app/main.py) 的鉴权中间件**仅对 artifact 路径放行查询参数**：

  ```python
  _ARTIFACT_PATH_RE = re.compile(r"^/v1/sessions/[0-9a-fA-F-]+/turns/\d+/artifact$")
  ```

  workspace files 下载路径不匹配该正则，`?api_key=` 会被忽略，中间件只认 `X-API-Key` 头——而 `<a download>` 导航无法携带自定义头。
- **现状未暴露的原因**：默认部署为开放模式（未设 `OH_API_KEY`/`api_keys`，`resolve_tenant` 放行为 default 租户）。一旦启用鉴权（单 key 或多 key），工作区文件下载功能整体失效（401）。
- **建议**：扩展白名单正则以覆盖 `GET /v1/sessions/{sid}/workspace/files/{path}`（与 artifact 同样限定 GET），或改用短时效一次性下载 token（见 M5 的根治方案）。前端注释「复用产物直链模式（F5.4）」表明这是实现时的疏漏而非有意为之。

### H2.【安全/正确性】多节点 WS 代理在多 key 模式下用错凭证转发

- [proxy.py](../session-service/app/session/proxy.py) 跨节点转发 WS 时仅携带 `settings.api_key`（遗留单 key）。多 key 部署（`api_keys` 表）下，若目标节点未配置相同的单 key，代理连接将被目标节点 401 拒绝；即便配置了，**租户身份也在转发中丢失/被替换**，目标节点看到的是单 key 对应租户而非原请求租户。
- 同时转发使用明文 `ws://`，跨节点流量（含 api_key 与会话内容）未加密，在非可信内网部署时存在窃听风险。
- **建议**：转发时透传原始已验证租户身份（推荐节点间使用独立的内部服务凭证 + `X-Forwarded-Tenant` 类内部头，目标节点仅信任来自内网节点的该头）；节点间链路提供 `wss://` 或依赖网络层加密（如 WireGuard/服务网格）。

### H3.【安全·部署默认值】默认部署完全无鉴权，且 8001 端口直接暴露宿主机

- `docker-compose.yml` 的 session 服务未设置 `OH_API_KEY` / `OH_REQUIRE_AUTH`，`.env.example` 中也无相应条目 → 默认开放模式，任何能访问端口的人都可创建会话、执行 agent 任务（agent 可运行任意命令）。
- 同时 `ports: "8001:8001"` 将后端直接映射到宿主机，绕过了 session-frontend nginx 的 `access_log off` 等防护；若宿主机端口对外可达，等于把「远程命令执行即服务」暴露到网络。
- 容器还挂载了 `/var/run/docker.sock`（注释已自知 root 等价）并透传 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`。
- **建议**：`.env.example` 增加 `OH_API_KEY=`、`OH_REQUIRE_AUTH=true` 示例与醒目注释；compose 中 8001 至少改为 `127.0.0.1:8001:8001`；文档明确「对外必须经 nginx + 鉴权」；docker.sock 按 README 建议默认走 docker-socket-proxy。

### H4.【架构约束·易踩】`api_workers > 1` 会静默破坏单写者语义

- `SessionSupervisor`/`ContainerPool`/`SessionRegistry` 均为**进程内单例**（内存态 live 会话、准入队列、审批 future）。[config.py](../session-service/app/config.py) 却提供 `api_workers` 配置项；compose 里写死 `--workers 1` 是对的，但任何人把 workers 调大（或换 gunicorn 多 worker 部署）都会导致：同一会话被两个 worker 各自 rehydrate、审批帧路由到错误进程、准入配额翻倍。
- **建议**：启动时校验 `api_workers == 1`（>1 直接 fail-fast 并提示走多节点水平扩展路径），或移除该配置项。多实例扩展应通过既有的多节点亲和（Redis 路由表 + proxy）完成。

---

## 3. 中优先级问题（M）

### 后端

- **M1. WS 提交无文本长度限制**：REST 侧 `TurnSubmitRequest.text` 有 `max_length=32000`，但 [ws.py](../session-service/app/routers/ws.py) 的 `submit` 帧未校验长度（前端 `MAX_INPUT_LENGTH=32000` 只是君子约定）。恶意客户端可经 WS 提交超大 prompt，绕过 REST 校验直达子进程 stdin。建议 WS 侧复用同一常量做服务端校验，超限回 `error` 帧。
- **M2. 审批超时任务可能被 GC**：[supervisor.py](../session-service/app/session/supervisor.py) `_await_approval` 中 `asyncio.create_task(_timeout())` 未保留引用。CPython 事件循环仅弱引用 task，极端情况下超时任务可能在触发前被回收，导致审批永久挂起（turn 卡死直至 turn timeout 兜底）。建议保存引用（挂到 live 对象或模块级 set，done 后丢弃）。
- **M3. 用 `assert` 做运行时校验**：`respond_approval` 中 `assert live.adapter is not None`。`python -O` 下 assert 被剥离，将变成 `AttributeError`/静默错误。应改为显式检查 + 明确异常。
- **M4. `--api-key` 经命令行传给子进程**：[process.py](../session-service/app/session/process.py) 拼接 `--api-key <key>` 启动 `oh`，同容器内任何进程 `ps` 可见。建议改环境变量传递（`oh` CLI 已支持 `ANTHROPIC_API_KEY` 等环境变量）。
- **M5. api_key 出现在 URL**（WS `?api_key=`、artifact 直链）：前端 nginx 对 `/v1` 已 `access_log off`（好），但**直连 8001**（见 H3）时 uvicorn 访问日志、以及部署方自行加的任何中间层都可能记录完整 query。根治方案：为媒体/下载直链签发短时效一次性 token（`GET /...:sign` 返回 5 分钟 token），WS 改用子协议头或首帧鉴权。
- **M6. 跨模块调用私有函数**：[sessions.py](../session-service/app/routers/sessions.py) L567/L647 直接调用 `workspace_store._scan_local` / `_safe_local_path`。下划线私有函数被路由层依赖，重构时极易破坏。建议在 `workspace_store` 暴露公共 API。
- **M7. `next_epoch` 非严格单调**：[registry.py](../session-service/app/session/registry.py) 用时间戳生成 epoch，时钟回拨（NTP 校正）时可能产生重复/倒退 epoch，影响多节点 rehydrate 单写者判定。建议用 Redis `INCR` 生成全局单调 epoch。
- **M8. `/healthz` 活性探针探测 DB+Redis**：[health.py](../session-service/app/routers/health.py) 中 liveness 每次都打 DB/Redis。编排器（k8s/compose healthcheck）高频调用时给依赖增加无谓负载，且 DB 抖动会导致容器被误杀重启（活性应只答「进程活着」，依赖检查属 readiness）。建议 `/healthz` 只返回 200，依赖探测留在 `/readyz`。
- **M9. CORS 通配偏宽**：`allow_credentials=True`（当配置了 origins）+ `allow_methods=["*"]` + `allow_headers=["*"]`。虽然 origins 是显式列表（不违反规范），但凭证模式下建议按需收窄 methods/headers，减少预检放大面。
- **M10. stage_out 多节点删除竞态**：[workspace_store.py](../session-service/app/session/workspace_store.py) `_stage_out_sync` 按 manifest 清理「未引用对象」，per-session lock 仅在单节点进程内生效；跨节点并发 stage_out（理论上被 rehydrate 单写者锁抑制，但 FAILED/超时路径存在缝隙）可能删掉对端刚上传的对象。tombstone rev3 已缓解大部分场景，建议对删除操作也校验 sync_seq 后置条件。
- **M11. 镜像 tag 多处硬编码且不一致**：[config.py](../session-service/app/config.py) `session_image` 默认写死 `...v0.7.77...`，compose 默认同为 v0.7.77，但项目测试规则文档默认 `v0.7.42`。多处硬编码违反项目「tag 统一走 `.env` 的 `OH_VERSION_HYPERFRAMES_VERSION`」约定。建议 config 默认值从环境派生或留空强制显式配置。

### 前端

- **M12. API Key 存 localStorage**：[authStore.ts](../session-frontend/src/store/authStore.ts) 明文持久化。任何 XSS 即可窃取（当前 CSP 严格 + 不渲染 raw HTML，风险被显著压低，但纵深不足）。可选改进：sessionStorage / 内存 + 「记住我」显式勾选；至少在文档标注该取舍。设置面板已做 `maskApiKey` 脱敏展示（好）。
- **M13. `approval_request` 按本地 policy 忽略帧**：[useWebSocket.ts](../session-frontend/src/ws/useWebSocket.ts) 中 `full_auto` 会话直接丢弃审批帧。若后端与前端对 policy 的认知不同步（detail 懒加载失败、策略被服务端热改），用户将看不到审批弹窗而 turn 静默等到 300s 超时。建议：凡带 `modal=true` 的帧一律展示，policy 只用于 UI 提示语。

---

## 4. 低优先级问题（L）

1. **L1** `deps.py::get_current_tenant_id()` 恒返回 `"default"`，为遗留死代码，与 `request.state` 真实租户解析并存易误用，建议删除。
2. **L2** `db.py::reconfigure()` 使用已弃用的 `asyncio.get_event_loop()`，Python 3.12+ 会告警，建议 `asyncio.get_running_loop()`。
3. **L3** `sessions.py` L60 import 了 `SessionBusy` 但从未捕获（busy 用 `live.busy` 手工判断），未用 import 应清理或改为统一异常捕获风格。
4. **L4** `supervisor.py` turn 超时路径 `await live.process.kill_group() if live.process else None` 表达式式写法可读性差，建议展开为 if 语句。
5. **L5** `conversationStore.appendAssistantText` 每次 flush 全量复制消息数组 + 尾部线性扫描（代码内 TODO C3 已自知并说明当前量级可接受）——保持关注即可，超长会话前需落实其注释中的拆分方案。
6. **L6** `hydrateHistory` 以「本地为空」为前提整体替换，依赖调用方纪律（F2.1）；若未来多处触发 hydrate，建议在函数内部做防御性检查（非空即跳过或合并）。
7. **L7** `useWebSocket` 中 `turn_complete` 用 `new Date().toISOString()` 更新 `last_active_at`，客户端时钟不准会污染列表排序展示（仅展示层，影响小）。
8. **L8** `nginx.conf.template` 中 6 个安全头在 3 处重复粘贴（nginx add_header 继承语义所迫，注释已解释），可用 include 片段消重降低漂移风险。

---

## 5. 安全性专项小结

| 项 | 现状 | 评价 |
|---|---|---|
| API 鉴权 | open → 单 key 恒时比较 → sha256 多 key 表 + TTL 缓存，负查询不缓存 | ✅ 设计好；默认部署未启用（H3） |
| 租户隔离 | `_load_owned()` 越权一律 404 防枚举 | ✅ |
| 输入校验 | `vet_extra_oh_args` 白名单 + shell 元字符禁止，前端镜像同规则 | ✅ 双端一致 |
| 路径遍历 | workspace/artifact 路径 `_safe_local_path` 规范化校验 | ✅ |
| XSS | react-markdown 不启用 raw HTML + 严格 CSP + 链接 noopener | ✅ |
| 终端注入 | `sanitizeAnsi` 剥离 OSC/DCS/CSI（保留 SGR），防 OSC 52 剪贴板攻击 | ✅ 少见且到位 |
| 凭证暴露面 | URL query key（M5）、命令行参数（M4）、localStorage（M12）、代理转发（H2） | ⚠️ 主要加固方向 |
| 限流 | Redis Lua 原子限流，fail-open（Redis 挂时放行） | ✅ 设计取舍已注释 |
| WS 鉴权 | accept 前完成鉴权，4401 关闭 | ✅ |

---

## 6. 性能与可扩展性建议

1. **healthz 减负**（M8）：活性探针去依赖化。
2. **WS 连接的 DB session 生命周期**：`ws.py` 每连接持有一个 db session 直至断开，长连接多时占用连接池。建议改为「用时取、用完还」的短事务模式。
3. **stage_out 全量上传**：`tenant_store`/`workspace_store` 归档为全量 `fput_object`，无内容 hash 比对；大工作区高频 turn 时上传放大。manifest 已存 etag/size，可增量跳过未变更文件。
4. **前端流式渲染**：StreamBuffer（50ms/384 字符）+ `useDeferredValue` + memo 组合合理；虚拟滚动已隔离长列表成本。无需近期动作。
5. **会话列表刷新策略**：事件驱动 + focus 节流（无轮询），设计克制，✅。

---

## 7. 集成兼容性检查

- **与 api 服务（service/）共存**：Postgres 共库但 Alembic 使用独立 version table（`alembic_version_session`），并发启动互不干扰 ✅；Redis 用 db=1 与 api(db=0) 键空间分离 ✅；MinIO 独立 bucket（`oh-tenants`）✅。
- **compose 编排**：`depends_on` + healthcheck 齐备；entrypoint 先 `alembic upgrade head` 再启动、fail-fast ✅；`--workers 1` 与内存单例约束一致（但见 H4 的防误配建议）。
- **源码挂载**：`./session-service:/opt/oh-session-service` 运行时挂载，符合项目「改代码免重建镜像」规则 ✅。
- **前端反代**：session-frontend nginx 同源反代 REST+WS 到 `session:8001`，WS upgrade map、3600s 超时、`proxy_buffering off` 配置正确 ✅；`/v1` `access_log off` 防 key 泄露（仅在走 nginx 时有效，见 H3）。
- **协议兼容**：前端 WS 关闭码表（4400/4401/4403/4404/4429/4430/4500/4503）与后端 ws.py 一致；未知帧透传为 `event` 保证前向兼容 ✅；前端还对旧后端（无列表接口 404/405、turn_error 无 code）做了降级路径 ✅。
- **测试规范**：两模块的测试均可在既有镜像/构建流水线内运行（`e2e/run-session-frontend-docker-tests.sh` 等），符合「基于已有镜像测试」规则。

---

## 8. 修复优先级路线图

| 优先级 | 项 | 工作量估计 |
|---|---|---|
| P0 | H1 workspace 下载鉴权白名单 | 小（正则扩展 + 测试） |
| P0 | H3 默认部署鉴权与端口暴露 | 小（.env.example + compose） |
| P1 | H2 代理租户透传/加密 | 中 |
| P1 | H4 workers 校验 fail-fast | 小 |
| P1 | M1 WS 文本长度校验 / M2 timeout task 引用 / M3 assert | 小 |
| P2 | M4/M5 凭证暴露面收敛（env 传 key、下载 token） | 中 |
| P2 | M6~M11 各质量/健壮性项 | 小~中 |
| P3 | L 级与 M12/M13 | 择机 |

---

## 9. 值得肯定的实践（供其他模块参考）

- 后端：恒时 key 比较、越权 404 防枚举、准入控制无 await 临界区的原子性设计、Lua 原子限流与分布式锁、tombstone 版本化删除传播、finalize 先于终帧的崩溃一致性顺序。
- 前端：关闭码驱动的差异化重连状态机（限流/容量/配额分别有界重试）、审批倒计时以首收时刻为基准防重连重置、请求 seq 竞态防护、ANSI 终端输出消毒、CSP 禁裸 ws: 方案、对已知性能权衡的代码内文档化（C3）。
- 双端契约意识强：白名单参数、关闭码、错误 code 三张映射表前后端各持一份且注明对齐来源——建议后续抽成共享 schema 或加契约测试防漂移（H1 正是缺契约测试之处）。

---

*审核人：AI 代码审核（静态审阅）；如需对 H1/H2 做运行验证，请按项目规则在既有 Docker 镜像内进行（如 `docker compose run --rm --entrypoint bash session -c "cd /opt/oh-session-service && python -m pytest tests/"`）。*
