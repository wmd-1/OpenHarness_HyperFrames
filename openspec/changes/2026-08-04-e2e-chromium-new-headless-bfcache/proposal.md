# 测试基建：E2E 浏览器升级完整 Chromium + new headless 以支持 BFCache

> 状态：**DRAFT（仅提案，未实现）** · 日期：2026-08-04
> 本 change 是 `2026-08-03-design-frontend-ws-bfcache-reconnect`（Change3）的**前置 test-infra 项**，从 Change3 验收边界中拆出。不修改任何产品/前端逻辑，只解决 E2E 运行环境的浏览器能力。

## Why

已确认事实（Change3 收尾实测 + 隔离 Playwright 探针）：

1. 现行 e2e 镜像 `openharness-design-frontend:e2e`（FROM `oh-e2e-test:latest`）仅含 **`chrome-headless-shell`**（old headless 二进制）。
2. old headless 模式下浏览器**不冻结页面**、**不维护 BFCache**：实测 `page.goto('/')` → `goBack()` 后 `pageshow.persisted === false`（`PAGESHOW_EVENTS [false]`）；`--headless=new` 对该二进制**无效**（new headless 需完整 chromium）。
3. 因此 Change3 的 BF3（BFCache 唤醒：进入/离开 BFCache、`pageshow.persisted===true`、WS probe/reconnect、对话可继续）在现行镜像下**无法真实验证**，用例 `test.skip` 带原因挂起。

BF1/BF2（后端失败 1011 + `error.code`）不依赖 BFCache，已可在现行镜像真实栈验证，与本 change 无关。

## What Changes

- 将设计前端 E2E 的浏览器从 `chrome-headless-shell` 切换到**完整 chromium 运行于 new headless**，使 BFCache 生效（`pageshow.persisted===true`）。
- 在 Playwright 配置/启动参数中固定 new headless（完整 chromium 二进制），并向用例暴露能力探测 `BFCACHE_SUPPORTED`。
- 取消 BF3 的 `test.skip`，改为「能力具备才跑、否则 skip」，并在 new-headless 下补验 BFCache 唤醒全路径。
- 确保 BF1/BF2 在 new-headless 下仍全绿（无回归）。

## Capabilities

### New Capabilities
- `e2e-chromium-new-headless`：E2E 运行环境基线——完整 chromium + new headless，BFCache 可用；提供 `BFCACHE_SUPPORTED` 能力探测供用例条件跳过。

### Modified Capabilities（落地时需同步）
- 无产品能力变更；仅 test-infra 基线。

## Impact

- **镜像**：`openharness-design-frontend:e2e`（可能在 `oh-e2e-test:latest` 基础上安装完整 chromium，`Dockerfile.e2e` 改造或新增变体）；不重建主应用镜像。
- **配置**：`design-agent-frontend/e2e/playwright.config.ts` 启动参数（channel/executablePath + `headless` 形态）。
- **用例**：`real-bfcache-reconnect.spec.ts` 由 `test.skip` 改为能力门控。
- **风险**：完整 chromium 体积更大、启动更慢；需在 CI/本地明确镜像 tag，避免回退到 headless-shell 静默失败。
- **测试纪律**：仍在既有镜像内跑，禁宿主机直跑、禁为测试从零重建基础镜像。

## Non-goals

- 不改前端 WS 重连/唤醒逻辑（属 Change3，已归档）。
- 不新增产品行为；只修测试运行环境能力。
- 不触碰 `OH_E2E_FAULT_INJECTION` 故障注入契约（Change3 已落地）。
