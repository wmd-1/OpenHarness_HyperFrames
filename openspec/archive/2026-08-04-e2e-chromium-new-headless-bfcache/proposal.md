# 测试基建：E2E 浏览器升级完整 Chromium + new headless（BFCache 诊断 + 方向②验收）

> 状态：**Resolved / Ready to archive** · 日期：2026-08-05
> 本 change 是 `2026-08-03-design-frontend-ws-bfcache-reconnect`（Change3）的**前置 test-infra 项**，从 Change3 验收边界中拆出。不修改任何产品/前端逻辑，只解决 E2E 运行环境的浏览器能力与 BF3 验收口径。

## 根因已确证（2026-08-05）

> **结论**：在当前 Playwright 启动的 Chromium 下，BFCache 唤醒**本质上不可自动化驱动**——根因是 Playwright 默认注入启动参数 `--disable-back-forward-cache`（容器内 Chromium 进程 argv 实测坐实），与 Chromium 版本（133）、运行模式（headless/headed）、DevTools/CDP 附加、vite/HMR/WS 均无因果关系。即便经 `ignoreDefaultArgs` 移除该 flag，BFCache 恢复不派发 `load` 事件会使 Playwright 的 `goBack()`/`reload` 生命周期永久等待 `load` 而挂死（这正是 Playwright 默认禁用它的原因）。故 BF3 期望的 `pageshow.persisted===true` 在 Playwright E2E 中**恒不可达**，方向①（换浏览器/flag）无解。

**证据链**：
- 真实 HTTP 控制组（测试进程内 Node `http` 静态服务、`python3 -m http.server`）均 `backPersisted=false`；探针打印 Chromium argv 含 `--disable-back-forward-cache`（调查 #9）。
- headless↔headed 唯一变量对照：两者均 `backPersisted=false`，运行模式非根因（调查 #5.3）。
- `E2E_BFCACHE=1` 移除该 flag 后，`page.goBack()` **挂死**：`waiting for navigation until "load"`（调查 #10）→ BFCache 唤醒不可经 Playwright 自动化驱动。
- 默认 `notRestoredReasons: null`（调查 #11）→ BFCache 特性整项关闭，无未恢复原因可报。

**决议：方向②**——BF3 不再以 `pageshow.persisted===true` 为真值条件，改为验证用户侧真实可自动化保证：离开会话页 → 返回（整页 reload）→ 应用经 REST 重水合、WS 重连并建立可用连接、对话可继续；`pageshowEvents`/`wokeFromBFCache` 降级为信息性 annotation，不 skip、不硬断言。详见 `docs/bfcache-e2e-investigation-2026-08-04.md`「根因已确证（2026-08-05 推进）」。

**约束遵守**：未改 BF3 验收背后的业务语义、未改 `visibilitychange`、未改前端 WS 逻辑、未改 `OH_E2E_FAULT_INJECTION` 契约。诊断产物（`real-bfcache-static-http.spec.ts` + `e2e/static-ab/` + `E2E_BFCACHE=1` 开关）保留不删。

## Why

已确认事实（2026-08-05 调查闭环）：
1. 现行 e2e 镜像 `openharness-design-frontend:e2e`（FROM `oh-e2e-test:latest`）仅含 `chrome-headless-shell`（old headless），不维护 BFCache。
2. 已提供完整 chromium 镜像变体 `:e2e-chromium`（`PW_USE_NEW_HEADLESS=1`），可作 BFCache 诊断与对照基线。
3. 调查坐实 BFCache 在 Playwright 下被 `--disable-back-forward-cache` 默认禁用、且移除后亦不可自动化驱动 → BF3 的原 `pageshow.persisted===true` 验收目标不可达。
4. 因此 BF3 改为**方向②**：验证「离开/返回会话页 → REST 重水合 + WS 重连 + 对话可继续」这一用户侧真实可自动化保证（已在 `:e2e-chromium` 镜像内 `PW_USE_NEW_HEADLESS=1` 实跑通过，`1 passed`）。

BF1/BF2（后端失败 1011 + `error.code`）不依赖 BFCache，已可在现行镜像真实栈验证，与本 change 无关；其当前失败为独立 pre-existing 问题（运行栈未启用 `OH_E2E_FAULT_INJECTION=1`），不阻塞本 change。

## What Changes

- 提供完整 chromium + new headless 的 E2E 镜像变体 `openharness-design-frontend:e2e-chromium`（`PW_USE_NEW_HEADLESS=1` 选用）；默认用例仍用 `chrome-headless-shell`。
- `playwright.config.ts` 新增 `E2E_BFCACHE=1` 诊断开关（默认关闭，移除 `--disable-back-forward-cache` 供手动正向控制组，不影响其余用例）。
- BF3（`real-bfcache-reconnect.spec.ts`）由「`pageshow.persisted` 门控 + skip」改为**方向②验收**：离开/返回会话页 → REST 重水合 + WS 重连可用 + 第二轮对话可继续；`pageshowEvents`/`wokeFromBFCache` 仅作 annotation。
- 静态控制组（`real-bfcache-static-http.spec.ts`）增强为负向对照：打印 Chromium argv 与 `notRestoredReasons` 佐证根因。

## Capabilities

### New Capabilities
- `e2e-chromium-new-headless`：E2E 运行环境基线——完整 chromium + new headless 镜像变体，用于 BFCache 诊断与对照；提供 `E2E_BFCACHE=1` 诊断开关与静态控制组负向对照。BF3 验收口径为方向②（导航韧性 + WS 重连），不依赖 `pageshow.persisted`。

### Modified Capabilities（落地时需同步）
- 无产品能力变更；仅 test-infra 基线。

## Impact

- **镜像**：`openharness-design-frontend:e2e-chromium`（在 `oh-e2e-test:latest` 基础上安装完整 chromium，`SKIP_BUILD=1` 可复用既有镜像）；不重建主应用镜像。
- **配置**：`design-agent-frontend/e2e/playwright.config.ts`（`PW_USE_NEW_HEADLESS=1` 选用 `:e2e-chromium`；`E2E_BFCACHE=1` opt-in）。
- **用例**：`real-bfcache-reconnect.spec.ts` 改为方向②验收；`real-bfcache-static-http.spec.ts` 增强为负向对照。
- **风险**：完整 chromium 体积更大、启动更慢；需在 CI/本地明确镜像 tag，避免回退到 headless-shell 静默失败。
- **测试纪律**：仍在既有镜像内跑，禁宿主机直跑、禁为测试从零重建基础镜像。

## Non-goals

- 不改前端 WS 重连/唤醒逻辑（属 Change3，已归档）。
- 不追求 `pageshow.persisted===true`（Playwright 下不可达，已确证）。
- 不触碰 `OH_E2E_FAULT_INJECTION` 故障注入契约（Change3 已落地）；其导致 BF1/BF2 当前失败为独立后续 change。
