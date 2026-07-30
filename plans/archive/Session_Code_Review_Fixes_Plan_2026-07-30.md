# Session 服务审核问题修复方案（2026-07-30）

> 依据：`docs/session-code-review-2026-07-30.md`（下称「审核报告」）。
> 原则：本轮只做**低风险、可验证、不改架构语义**的修复；需要跨模块设计或产品决策的项显式列入「暂缓项」并给出理由。
> 约束：所有测试在已有 Docker 镜像内执行（项目规则），源码经 volume 挂载，无需重建镜像。

---

## 一、范围裁定

### 本轮修复（13 项）

| 报告编号 | 摘要 | 类型 | 风险 |
|---|---|---|---|
| H1 | workspace 文件下载 query-param 鉴权白名单缺失 | Bug 修复 | 低 |
| H2（部分） | WS 代理转发用错凭证（改为透传客户端原始凭证） | Bug 修复 | 低 |
| H3 | 默认部署鉴权配置缺失 + 8001 端口全网卡暴露 | 配置加固 | 低 |
| H4 | `api_workers > 1` 静默破坏单写者语义 | 启动校验 | 低 |
| M1 | WS submit 无文本长度上限 | 校验补齐 | 低 |
| M2 | 审批超时 task 未保留引用可能被 GC | 健壮性 | 低 |
| M3 | `respond_approval` 用 assert 做运行时校验 | 健壮性 | 低 |
| M6 | 路由层跨模块调用 `workspace_store` 私有函数 | 重构 | 低 |
| M7 | `next_epoch` 时间戳非严格单调 | 正确性 | 中 |
| M8 | `/healthz` 每次探测 DB/Redis（依赖负载） | 性能 | 低 |
| M9 | CORS methods/headers 通配过宽 | 加固 | 低 |
| L1–L4 | 死代码 / 弃用 API / 未用 import / 可读性 | 清理 | 低 |

### 暂缓项（不在本轮，含理由）

| 编号 | 理由 |
|---|---|
| H2（wss 加密） | 节点间链路加密属部署层（WireGuard/服务网格），代码侧仅在 README 补部署要求说明 |
| M4（`--api-key` 命令行可见） | `oh` CLI 无通用 env 等价物（env 变量按 auth source 区分：`OPENHARNESS_ANTHROPIC_API_KEY` 等），盲目映射有送错 provider 风险；且默认部署不设置 `OH_OH_API_KEY`，实际暴露面为零。留 backlog，待上游支持通用 env 后处理 |
| M5（下载直链改短时效 token） | 需要新端点 + 前端配合的设计变更，独立 change 处理；本轮 H1 先恢复功能正确性 |
| M10(stage_out 多节点删除竞态) | 需分布式锁/条件删除设计，独立 change 处理 |
| M11（镜像 tag 硬编码） | 已核实 compose 侧 `OH_SESSION_IMAGE` 默认派生自 `OH_VERSION_HYPERFRAMES_VERSION`，config.py 默认值仅为最后兜底；改动收益低 |
| M12/M13（前端 key 存储、审批帧策略） | 产品决策项（记住我交互 / full_auto 语义），需求方确认后另行处理 |
| M13 关联的前端改动 | 同上，本轮**前端零代码改动**（H1 修复在后端白名单侧完成，前端 `?api_key=` 直链行为不变） |

---

## 二、逐项修改设计

### F1（=H1）workspace 文件下载 query-param 鉴权白名单

**文件**：`session-service/app/main.py`

- 在 `_ARTIFACT_PATH_RE` 旁新增：
  ```python
  _WORKSPACE_FILE_PATH_RE = re.compile(
      r"^/v1/sessions/[0-9a-fA-F-]+/workspace/files/.+$"
  )
  ```
- 中间件放行条件由「GET + artifact 匹配」扩展为「GET + (artifact 匹配 or workspace 文件匹配)」。仅 GET、仅这两类下载路径，其余 REST 仍 header-only。
- 注释同步更新（A2 说明补充 F5.4 下载直链场景）。

**验收**：启用单 key 鉴权时，`GET /v1/sessions/{sid}/workspace/files/a.txt?api_key=<valid>` 返回 200/302；无 key 或错 key 401；`POST`/列表端点带 `?api_key=` 仍 401（不扩大面）。

### F2（=H2 部分）WS 代理透传客户端原始凭证

**文件**：`session-service/app/session/proxy.py`、`session-service/app/routers/ws.py`

- `proxy_ws()` 增加参数 `client_api_key: str | None`；转发头改为：
  - 有 `client_api_key` → `X-API-Key: <client_api_key>`（透传原始凭证，目标节点用同一 `resolve_tenant` 链自行鉴权，租户身份不丢失）；
  - 无（开放模式）→ 不带头。
  - 删除现有 `settings.api_key` 注入逻辑。
- `ws.py::session_ws` 中把 `_ws_authed` 前已提取的 `provided` 原始 key 传入 `proxy_ws`。注意：`_ws_target_url` 的 query 串可能已含 `api_key`（浏览器场景），header 与 query 并存无害（目标节点 header 优先）。
- README（session-service）部署章节补充：多节点间转发为明文 `ws://`，跨主机部署必须置于加密内网。

**验收**：单测 mock `websockets.connect`，断言转发 headers 携带的是客户端 key 而非 `settings.api_key`；开放模式不带头。

### F3（=H3）默认部署鉴权与端口暴露加固

**文件**：`.env.example`、`docker-compose.yml`

- `.env.example` 新增 session 鉴权小节（放在 MinIO 小节前）：
  ```
  # ---- Session 服务鉴权（强烈建议生产开启）----
  # 不设置 = 开放模式（无鉴权，任何可达端口者均可创建会话并执行任意 agent 任务）。
  # OH_API_KEY=<随机强密钥>
  # OH_REQUIRE_AUTH=true
  ```
- `docker-compose.yml` session 服务：
  - `environment` 增加 `OH_API_KEY=${OH_API_KEY:-}`、`OH_REQUIRE_AUTH=${OH_REQUIRE_AUTH:-false}`（默认保持开放，兼容既有 e2e）；
  - `ports` 中 `"8001:8001"` 改为 `"127.0.0.1:8001:8001"`（宿主机本地可达，外网必须经 session-frontend nginx）。3000-3003 preview 端口维持现状。
- 同步核对 `e2e/` 脚本均以 `localhost:8001` 访问（127.0.0.1 绑定不受影响）；如有容器间直连 `session:8001` 的路径，不受 ports 影响。

**验收**：`docker compose config` 校验渲染正确；e2e 冒烟脚本可正常访问。

### F4（=H4）workers 数量启动校验

**文件**：`session-service/app/main.py`（或 `config.py` validator）

- 启动期（现有 `_assert_auth_config()` 旁）新增：
  ```python
  def _assert_single_worker() -> None:
      if settings.api_workers != 1:
          raise RuntimeError(
              "api_workers must be 1: SessionSupervisor/ContainerPool are "
              "in-process singletons; scale horizontally via multi-node "
              "affinity (OH_NODE_ID + Redis route table) instead"
          )
  ```
- 说明：uvicorn `--workers N` 由 compose 控制，本校验拦截的是 `OH_API_WORKERS` 配置误用；README 补充多进程部署禁忌说明。

**验收**：`OH_API_WORKERS=2` 时应用 import/startup 即抛错；默认 1 正常。

### F5（=M1）WS submit 文本长度上限

**文件**：`session-service/app/schemas.py`（导出常量）、`session-service/app/routers/ws.py`

- `schemas.py` 定义 `MAX_TURN_TEXT_LEN = 32000`，`TurnSubmitRequest.text` 的 `max_length` 改引该常量（单一事实源）。
- `ws.py` submit 分支在取到 `text` 后：
  ```python
  if len(text) > MAX_TURN_TEXT_LEN:
      await _safe_send({"type": "error", "code": "text_too_long",
                        "message": f"text exceeds {MAX_TURN_TEXT_LEN} chars"})
      continue
  ```
- 前端 `MAX_INPUT_LENGTH=32000` 已对齐，无需改动。

**验收**：单测覆盖 32000 边界（等长通过、+1 拒绝且连接不断开）。

### F6（=M2）审批超时 task 保引用

**文件**：`session-service/app/session/supervisor.py`

- `_await_approval` 中 `asyncio.create_task(_timeout())` 的返回值保存（如 `timeout_task` 局部变量 + 在审批 future 完成路径 `cancel()`；或挂到 live 对象的 task 集合）。实现取最小改动：局部保存 + `finally` 中 cancel，防 GC 且防泄漏。

**验收**：现有审批相关单测回归通过；新增用例验证审批完成后 timeout task 被取消。

### F7（=M3）assert 改显式校验

**文件**：`session-service/app/session/supervisor.py`

- `respond_approval` 中 `assert live.adapter is not None` 改为：
  ```python
  if live.adapter is None:
      raise SessionNotFound(f"session {sid} has no active adapter")
  ```
  （异常类型与该函数现有错误路径保持一致，实施时按上下文选用既有异常。）

### F8（=M6）workspace_store 暴露公共 API

**文件**：`session-service/app/session/workspace_store.py`、`app/routers/sessions.py`

- `workspace_store` 增加公共包装：`scan_local = _scan_local`、`safe_local_path = _safe_local_path`（或改名去下划线、保留旧名别名以免破坏其它内部引用）。
- `sessions.py` L567/L647 改用公共名。

### F9（=M7）epoch 改 Redis INCR 单调生成

**文件**：`session-service/app/session/registry.py`

- `next_epoch()` 由时间戳改为 `INCR session:epoch:<sid>`（Redis 原子自增，天然单调且跨节点一致）；key 不设 TTL 或 TTL 远大于会话生命周期（随会话清理时 DEL）。
- 实施前重读 registry 中 epoch 的比较语义（`>=`/`>`）确保兼容存量数据：存量时间戳 epoch 值巨大（~1.7e9），新计数器从 1 开始会**倒退**。兼容策略：INCR 前用 `SET ... NX` 以 `max(现值, 当前时间戳)` 播种，即首次生成不低于旧方案值，之后严格 +1 递增。

**验收**：单测并发调用 `next_epoch` 断言严格递增；存量播种逻辑单测覆盖。

### F10（=M8）healthz 依赖探测加 TTL 缓存

**文件**：`session-service/app/routers/health.py`

- `_db_ok`/`_redis_ok` 结果加模块级 5s TTL 缓存（`(ts, value)` 双元组，asyncio 单线程无需锁），`/healthz` 与 `/readyz` 共享缓存。响应 schema 与语义不变（healthz 恒 200）。
- 报告中「DB 抖动导致容器被误杀」表述修正：现实现 healthz 恒 200，无误杀问题，仅存在依赖探测负载问题——本项只做减负。

### F11（=M9）CORS 收窄

**文件**：`session-service/app/main.py`

- `allow_methods=["*"]` → `["GET", "POST", "DELETE", "OPTIONS"]`；`allow_headers=["*"]` → `["X-API-Key", "Content-Type"]`。
- 核对前端实际使用（ky：GET/POST/DELETE + X-API-Key/Content-Type）后定稿；同源部署（nginx 反代）不受影响，仅影响显式配置 `OH_CORS_ORIGINS` 的跨域部署。

### F12（=L1–L4）代码清理

| 项 | 文件 | 动作 |
|---|---|---|
| L1 | `app/deps.py` | 删除 `get_current_tenant_id()`（先全局 grep 确认无引用） |
| L2 | `app/db.py` | `asyncio.get_event_loop()` → `asyncio.get_running_loop()`（确认调用点均在运行中事件循环内；若 `reconfigure` 存在同步调用场景则改 try/except 兼容） |
| L3 | `app/routers/sessions.py` | 移除未使用的 `SessionBusy` import |
| L4 | `app/session/supervisor.py` | `await live.process.kill_group() if live.process else None` 展开为 if 语句 |

---

## 三、测试计划（全部在已有镜像内执行）

1. **后端单测/回归**（主镜像容器）：
   ```bash
   docker compose run --rm --entrypoint bash session \
     -c "cd /opt/oh-session-service && python -m pytest tests/ -q"
   ```
   新增测试文件建议：
   - `tests/test_auth_query_param.py`：F1 白名单矩阵（artifact/workspace-file/其它路径 × GET/POST × header/query）
   - `tests/test_ws_submit_limit.py`：F5 边界
   - `tests/test_proxy_credential.py`：F2 凭证透传
   - `tests/test_registry_epoch.py`：F9 单调性 + 播种
   - F4 校验、F6 取消逻辑并入既有对应测试文件
2. **compose 配置校验**：`docker compose config`（宿主机允许，属 docker 命令）。
3. **e2e 冒烟**（可选，回归 F3 端口变更）：`e2e/run_e2e.sh` 或 session 相关既有脚本。
4. **前端**：本轮无前端代码改动，跳过前端流水线；若最终触碰前端则走 `e2e/run-session-frontend-docker-tests.sh`。

---

## 四、实施顺序与回滚

1. F1/F5/F7/F12（纯增量小改，先行）
2. F6/F8/F10/F11（局部行为微调）
3. F2/F4（涉及签名/启动语义）
4. F9（含存量兼容播种，最后做、独立提交）
5. F3（配置文件，随代码一并提交）

每步独立可回滚（单文件粒度）；F9 若播种策略验证不通过，可单独回退为时间戳方案不影响其余项。

---

## 五、openspec 落地

按项目流程将本方案落成 openspec change（`openspec/changes/` 下，归档目录为 `openspec/archive/`），change 命名建议：`fix-session-review-2026-07`；spec delta 主要触及 `session-auth`、`session-ws`、`session-lifecycle`（以 `openspec/specs/` 实际文件名为准），tasks 按上述 F1–F12 分组。
