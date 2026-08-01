# 设计智能体前端：真实后端 E2E 测试计划

## Why

当前 `design-agent-frontend/e2e/` 下的 E2E 用例全部依赖 `e2e/mock-backend.mjs` 在 `:8001` 启动一个**脚本假后端**：它只返回写死的 fixture，从不连接真实 `session-service`。这带来三个根本性问题，与"真实浏览器测真实场景"的目标相悖：

1. **后端从未启动**：测试运行时 `session-service` / Postgres / Redis / WebSocket 全部不在线，所谓"全链路"只测了前端 + 假 HTTP 桩，后端契约、限流、错误恢复、WS 重连等真实行为完全未被覆盖。
2. **错误路径是伪造的**：429/503/403/500 由 mock 手动返回，无法验证真实后端的限流头、配额拒绝、DB 异常恢复、WS close code 策略。
3. **用户已明确否决该方式**：要求"按真实浏览器去测试，模拟真实使用场景"，即测试必须连接真实运行的后端服务栈。

仓库已有完整、可复用的真实栈：`docker-compose.yml` 的 `session` 服务（FastAPI + Postgres + Redis + WS，acceptance 模式走 stub `oh` 后端）+ `docker-compose.stub.yml` override。该栈无需真实 LLM API key，且 stub `oh` 后端能**确定性地真实触发** 429/503/403/WS 关闭码等错误路径。本 change 重做 E2E 基建，使前端用真实浏览器连接这真实栈。

## What Changes

- **废弃 mock 假后端驱动**：E2E 不再依赖 `e2e/mock-backend.mjs` 启动的假后端；改用 `docker compose -f docker-compose.yml -f docker-compose.stub.yml up session` 拉起真实 `session-service` 服务栈（含 Postgres + Redis + WS + stub `oh` 后端）。
- **真实浏览器连接真实后端**：Playwright 仍运行于既有 `oh-e2e-test:latest` 镜像（`PW_CHROMIUM_PATH` 指向镜像内置 `chrome-headless-shell`），但测试目标环境为真实栈：`session-service` 暴露 `:8001` REST + `/v1/sessions/{sid}/ws`，经由前端 `:3001`（`npm run preview`）或 nginx `:5175` 同源反代（无 CORS，与运行时一致）。
- **重写/新增 5 类真实场景用例**（覆盖用户要求的 5 类）：正常流程、边界情况、错误处理（后端真实返回）、性能（多并发连接真实后端）、浏览器兼容性（标签页/前进后退/刷新/清缓存）。
- **错误场景改造为真实触发**：利用 stub `oh` 后端的确定性错误注入（如特定 prompt 触发 429/503/403、kill 后端进程模拟 500/不可用、断 WS 验证 close code 重连），而非 mock 手动返回。
- **测试编排脚本**：新增 `e2e/run-design-frontend-real-backend-tests.sh`，负责（在真实栈已起的前提下）在镜像内跑 Playwright，并产出报告。

## Capabilities

### New Capabilities

- `design-frontend-real-backend-e2e`：真实后端 E2E 测试基建——以 `docker-compose.{yml,stub.yml}` 真实 `session` 栈为唯一后端来源、Playwright 真实浏览器、5 类真实场景用例集、真实错误注入与恢复断言、镜像内执行约束。

### Modified Capabilities

（无既有 spec 被修改；本 change 在 `design-agent-video` / `design-agent-platform` 既有契约之上追加测试覆盖，不改动其声明。）

## Impact

- **后端/API**：零改动（复用既有 `session` 服务栈与 stub `oh` 后端）。
- **前端代码**：仅测试相关改动；之前为修复真实缺陷而抬高的 `SettingsPanel` z-index（`z-50`→`z-[200]`）保留——该修复正是由真实栈测试中暴露的遮挡问题驱动，属有效修复。
- **新增文件**：`openspec/changes/2026-08-01-design-frontend-real-backend-e2e/`（proposal/design/specs/tasks）、`e2e/run-design-frontend-real-backend-tests.sh`、`design-agent-frontend/e2e/real-*.spec.ts`（或重构既有 scenario 文件指向真实栈）。
- **废弃/移除**：`e2e/mock-backend.mjs` 作为 E2E 唯一后端来源的角色；保留文件但若真实栈就绪可删除（见 Open Questions）。
- **测试**：全部在真实栈 + 既有 `oh-e2e-test:latest` 镜像内执行，宿主机只跑 `docker compose up` / 编排脚本，严禁宿主机直跑测试、严禁从零重建基础镜像。
