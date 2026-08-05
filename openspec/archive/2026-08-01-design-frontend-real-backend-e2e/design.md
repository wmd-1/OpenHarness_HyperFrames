## Context

- 既有前端 E2E：`design-agent-frontend/e2e/` 由 `playwright.config.ts` 自动启动 `node e2e/mock-backend.mjs`（:8001）与 `npm run preview`（:3001），并用 `PW_CHROMIUM_PATH` 指向 `oh-e2e-test:latest` 内置 `chrome-headless-shell`。该模式**后端为假**，已被否决。
- 真实后端栈：`docker-compose.yml` 的 `session` 服务 = `session-service`（FastAPI :8001，REST `/v1/sessions` + WS `/v1/sessions/{sid}/ws`）+ `postgres` + `redis` + `oh`（OpenHarness 运行时）。`docker-compose.stub.yml` 以 `OH_ACCEPTANCE_TEST=1` + `OH_BACKEND=stub` 把 `oh` 换成确定性 stub，无需 LLM key 即可真实返回会话/turn/产物，并**真实触发**限流与错误。
- 既有真实后端验收先例：`session-service/tests/test_real_backend_contract.py` 已用 `docker-compose.stub.yml` 对真实栈做契约与错误注入测试（env 注入 `fault` 触发 429/503），证明该栈可真实返回限流/错误码。前端可复用同一注入机制。
- 项目硬性规则：所有测试（含 E2E）必须在已有 Docker 镜像内执行；Playwright 基于 `oh-e2e-test:latest` 叠加层；禁止从零重建基础镜像、禁止宿主机直跑测试。

## Goals / Non-Goals

**Goals:**
- 用真实 `session-service` 栈（含 DB/WS/stub oh）作为 E2E 唯一后端，前端以真实浏览器（chrome-headless-shell）走真实 REST/WS 通道。
- 覆盖用户要求的 5 类真实场景：正常流程、边界情况、错误处理、性能、浏览器兼容性。
- 错误路径由真实后端真实返回（429/503/403/500/WS close code），而非 mock 伪造。
- 在既有 `oh-e2e-test:latest` 镜像内执行，产出可读报告。

**Non-Goals:**
- 不改动 `session-service` / `postgres` / `redis` / `oh` 任何代码（含 stub oh 注入点已存在，仅复用）。
- 不实现需要真实 LLM key 的内容生成断言（stub oh 返回确定性内容，断言聚焦契约/错误/恢复，而非生成质量）。
- 不重建基础镜像；不引入宿主机测试。

## Decisions

### D1 真实栈来源 = `docker-compose.yml` + `docker-compose.stub.yml`（复用既有 acceptance 模式）

`docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session` 启动真实 `session-service` + Postgres + Redis + stub `oh`。这满足"后端真起 + 真实通道 + 错误真实触发 + 无需 LLM key"。备选「自建独立 compose 仅留 session-service」被否决：与既有验收栈重复造轮子，且会偏离已验证的 stub 注入机制。

### D2 前端测试目标环境：同源反代，与运行时一致

Playwright 连接前端 `:3001`（`npm run preview`，vite 代理 `/v1` → `localhost:8001`，CORS 关）+ 或 nginx `:5175`（compose `design-frontend` 服务，envsubst `SESSION_HOST=session`）。选 `:3001` 与既有 mock 模式端口一致、改动最小；WS `Upgrade` 经 vite 代理透传。两者均在镜像内，宿主机只起栈。

### D3 错误场景 = 真实后端行为，不是 mock 返回

错误路径由真实 `session-service` 自身行为真实产生（与 `session-service/tests/test_real_backend_contract.py` / `test_harden_frontend.py` 共用同一栈与同一触发机制）：
- **429 并发配额**：stub compose 的 `OH_STUB_TURN_SECONDS`（默认 3s）制造 busy 窗口；用例并发建会话超过 `tenant_max_concurrent`（默认 1）→ 真实返回 429（含 `Retry-After`）。
- **503 / 500 不可用**：kill `session` 容器或停 Postgres/Redis → 前端真实见到连接失败 / 5xx，验证 banner + 恢复重连。
- **403 配额/越权**：真实返回 403（如非属主会话），前端展示"无权访问"banner。
- **401 错 key**：错误 `X-API-Key` → 真实 401 → 清 key 回 Welcome。
- **WS 掉线**：kill `oh` / 关闭 socket → 真实 close code（4400–4503）→ 前端退避重连。

这把"错误处理"类测试从伪造变为真实后端行为验证，断言对象即真实响应头 / close code。

**现实核查（2026-08-01 续轮，已读 `session-service/scripts/oh_backend_stub.py` + `session-service/app/*` 核实）：**
- `429` 并发配额与 `503` 容量满由 **session-service 网关**真实产生（非 stub oh），故 `429` 已可经并发建会话触发（B4）；`503` 需打满 live 池（~12 并发 busy），对共享栈有压测风险，未实现。
- `401`/`404`（未知 sid / 跨租户）已由路由层真实返回，E1/E2/E7 已覆盖。
- **stub oh 仅处理 `submit_line`/`interrupt`/`permission_response`/`question_response`/`shutdown`**：
  - **不发射 approval 帧** → A1 审批流三弹窗无法被真实触发（需 stub 扩展或真实 oh）。
  - **对 `/model` 回 `unknown request type: /model`** → 通道②仅能验证前端乐观 UI（M2），真实切模回执需真实 oh。
  - **不产生 403 真实路径**（单 key 跨租户为 404）、**不注入 503/fault**、**不产生 WS close code 4400–4503**（close code 由 session-service WS 层产生，单浏览器 UI 难构造，kill-oh 协调因 e2e 镜像无 docker.sock 不可行）→ E3/E5/E9/6.4 标记为后端阻断。
- 结论：续轮仅落地 stub 可确定触发的能力（T1/M1/M2/M3/I1/W4），其余按非目标（不改动后端）留作阻断项，待 stub/编排扩展。

### D4 Playwright 配置改造：移除 mock-backend 自动启动

`playwright.config.ts` 的 `webServer` 去掉 `node e2e/mock-backend.mjs`，改为假定真实栈由编排脚本先起；新增 `baseURL` 指向 `:3001`。用例 `beforeAll` 经真实 `POST /v1/sessions`（带 `X-API-Key: test-key` 已由 stub 栈接受）建会话，断言真实返回 `session_id`。

### D5 5 类场景映射真实能力域（并复用 session-live-acceptance 范式）

本 change 的 E2E 编排**直接复用既有 `session-live-acceptance` 范式**（`e2e/run-session-live-acceptance.sh` + `e2e/session-acceptance/{lib,rest,ws,frontend}.sh`）：
- 同一套 stub 组合 `docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session`；起栈后校验 `healthz` 含 `oh_backend_stub`（防配置漂移）；
- 签发双临时租户 key（A/B，随机后缀）用于跨租户隔离断言；trap 清理 revoke key + DELETE 会话；
- 其 `rest.sh`/`ws.sh` 已覆盖的**后端级断言**（401/201/list/artifact 200+206/路径穿越 400/404/422/跨租户 404/并发 429、`assistant_text` 不重复、WS live→cold→resume→closed）作为设计前端真实后端的"后端契约基线"，设计前端 E2E 在其之上叠加**前端交互层**断言（所见渲染、横幅、重连策略、模型切换、审批流、Terminal、演示标识）。

映射：
- 正常流程：Welcome 输入 key → 进入 `/video` → 真实建会话（POST）→ WS 真实流式（stub 确定性 delta）→ `turn_complete` 真实产物（`has_artifact=true` 自动展开预览，`?mode=stream` 加载，`Range 206`）→ `assistant_text` 恰出现一次 → 历史切换（resumable 续聊 / read_only 只读徽标）→ 个人空间聚合真实 sessions/turns（含已关闭、按 `finished_at` 倒序、骨架屏、分页 6/页）→ 退出清 key。
- 边界：空 prompt（真实 422/不建 turn）、超大文本（真实成功）、特殊字符、并发建会话（真实多 sid）、刷新重放（localStorage `da.currentSessionId` 真实 resume WS）、工作区路径穿越（真实 400）。
- 错误（真实后端产生）：429（并发配额 `OH_STUB_TURN_SECONDS≥3` 制造 busy 窗口 + `Retry-After` banner）、503（fatal banner）、403（配额拒绝）、401（错 key → 清 key 回 Welcome）、404（未知 sid / 跨租户隔离）、WS 掉线（close code 分支策略：4430 不重连+手动重试、4404 不重连等）、kill 容器（不可用恢复重连）。
- 功能域专项（design-frontend 独有）：模型双通道切换（建会话 `extra_oh_args --model` + 空闲态 `/model` WS 命令 + busy 禁用）、审批流三弹窗、Terminal 模式切保会话、中断/REST 兜底。
- 性能：Playwright 并发 ≤8 浏览器上下文连真实后端；采集 TTFB、API p95、容器 `docker stats` CPU/内存；大数据量（100 turns）空间分页滚动。
- 兼容：新标签打开会话直链、前进/后退、刷新保留、清 localStorage 重访回 Welcome。
- 平台一致性：AgentRegistry 派生主页/路由/空间 tab（video/ui/drawio 三域）；demo 数据带「演示数据」标识、ga 视频不带。

### D6 执行约束：编排脚本 + 镜像

新增 `e2e/run-design-frontend-real-backend-tests.sh`：
1. `docker compose ... up -d session`（宿主机，起真实栈）。
2. `docker run --rm -v $(pwd)/design-agent-frontend/e2e:/app/e2e -v $(pwd)/design-agent-frontend:/app/src ... openharness-design-frontend:e2e npx playwright test`（既有镜像，真实浏览器）。
3. 跑完 `docker compose ... down`（保留可选 `--keep`）。
报告写入 `design-agent-frontend/e2e/real_backend_report_<date>.txt`。

### D7 既有假后端文件处置

`e2e/mock-backend.mjs` 仅用于前端单元/开发的本地桩；E2E 不再引用。标记废弃，待真实栈稳定后可删除（不阻塞本 change）。

## Risks / Trade-offs

- [stub oh 内容确定性，无法验证真实生成质量] → 断言聚焦契约/错误/恢复而非内容，符合"真实使用场景"的健壮性目标。
- [真实栈启动耗时（Postgres/Redis 健康等待）] → 编排脚本加 `healthcheck` 等待 `session:8001/healthz` 就绪再跑测试。
- [WS 经 vite 代理在 headless 下偶尔握手慢] → 前端已有 30s 心跳 + 退避重连，测试给足超时。
- [并发性能测试会压真实 Postgres] → 限制并发上下文数（≤8）、单测数据隔离（独立 key 前缀），跑完 `down` 清库。
- [Playwright 版本与镜像浏览器不一致] → 锁定 1.50.1，与 `design-agent-frontend` package.json 及 session-frontend 一致。

## Migration Plan

1. 落本 change 四件套 → 改造 `playwright.config.ts`（去 mock 启动，加 baseURL）。
2. 重写/新增真实栈 scenario 用例（5 类）。
3. 新增编排脚本 `e2e/run-design-frontend-real-backend-tests.sh`。
4. 本地：`docker compose ... up -d session` → `docker run ... playwright test` → 验证全绿 → `down`。
5. 回滚：保留 mock-backend，必要时 `git revert` 配置改动即可恢复旧 E2E。
6. 验收红线：报告中每条用例标注"真实后端 URL / 真实 WS close code / 真实错误响应头"，杜绝假后端痕迹。

## Open Questions

- `mock-backend.mjs` 是否在真实栈稳定后删除？建议本 change 落地并跑绿后下个 change 清理。
- 性能测试是否纳入 CI 或仅本地？建议本地为主，CI 仅跑功能/错误/兼容三类（避免压真实栈影响共享环境）。
