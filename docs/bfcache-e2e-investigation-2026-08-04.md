# BFCache E2E 调查文档（2026-08-04）

> 本文档为 `e2e-chromium-new-headless-bfcache` change 的**调查依据**与**后续新 change 的输入**。
> 调查范围限定 test-infra，**未修改业务/前端逻辑、未扩展已归档 Change3**。

## 调查目标

确定在「真实后端 + 真实浏览器」的 E2E harness 下，BF3 用例（`real-bfcache-reconnect.spec.ts`）期望的 BFCache 唤醒（`pageshow.persisted===true`）为何无法命中，以便判断应调整测试基建（浏览器/启动参数）还是调整验收策略。

## 实验与排除的假设

| # | 实验 | 结果 | 排除的假设 |
|---|------|------|-----------|
| 1 | 隔离探针：现行 e2e 镜像仅含 `chrome-headless-shell`（old headless）→ `pageshow.persisted===false` | old headless 不维护 BFCache | 现行 headless-shell 二进制可做 BFCache 验证 |
| 2 | 升级完整 Chromium + new headless（`PW_USE_NEW_HEADLESS=1`，Chromium 133.0.6943.16）跑 BF3 真实栈 | 仍 `persisted===false`，`goBack()` 为整页 reload（`marker:"LOST(reloaded)"`） | new headless 二进制本身即可启用 BFCache |
| 3 | 关 vite HMR（`vite.config.ts` 加 `hmr:false`）复验 | 仍 false | HMR 是 blocker |
| 4 | 浏览器侧拦截 vite HMR WebSocket（`?token=` ws 被 block） | 仍 false | HMR WebSocket 常驻使页面失去 BFCache 资格 |
| 5 | 同源静态控制组：`page.route` fulfill 纯静态 HTML（无 vite/无 WS/无 beforeunload）；`data:` URL 控制组 | 均 false | vite/dev server/业务代码/应用 WS/beforeunload/cache 头是 blocker |
| 6 | 真实 HTTP 控制组①：测试进程内 Node `http` 静态服务读 `e2e/static-ab/{a,b}.html`，`A→B→Back` | `backPersisted=false`，`nav type=back_forward` 但整页 reload | 实验方法（`route.fulfill`/`data:`）不等价于真实 HTTP |
| 7 | 真实 HTTP 控制组②：独立进程 `python3 -m http.server --directory e2e/static-ab`（与测试进程解耦），`BFCACHE_STATIC_PORT=8099` | 同样 `backPersisted=false` | vite 残留 / 测试进程同址干扰 |
| 8 | headless↔headed 对照：同 Chromium、同 `--no-sandbox`、同 Node `http` 控制组，仅翻转运行模式。new headless `chromeDelta=0`，headed `PW_HEADED=1` `chromeDelta=85`（确为真实有头窗口） | 两者均 `backPersisted=false` | 运行模式（headless vs headed）是根因 |

## 最终保留的结论

- 在**当前 Playwright 启动的 Chromium 配置**下（`PW_USE_NEW_HEADLESS=1` new headless 与 `PW_HEADED=1` 有头模式均奏效为同一完整 Chromium 133.0.6943.16 + `--no-sandbox`），**真实 HTTP 控制组的 BFCache 无法命中**：`goBack()` 表现为整页 reload（`pageshow.persisted===false`，`navigationEntries[].type==="back_forward"` 但无恢复事件）。
- 该结论**已排除** vite / HMR / 业务代码 / 应用 WebSocket / `route.fulfill` / `data:` / 静态服务方式 / 运行模式（headless↔headed）等全部 harness 与实验方法因素，**唯一可严格成立**的事实是上述浏览器配置下 BFCache 未命中。
- **表述纪律**：不得扩大为「Chromium/浏览器本身不支持 BFCache」；仅限定于「当前 Playwright 启动的 Chromium 配置下」。

## 尚未解决的问题

- 是 **Chromium 版本**（133.0.6943.16）还是**启动参数**（Playwright 默认自动化 flags、`--no-sandbox`、DevTools/远程调试附加）导致 BFCache 被禁用？本调查未深入版本/参数排查（用户裁定本轮止步）。
- 后续若需让 BF3 真正验证，两条方向待**新 change** 拍板（不扩展本 change）：
  - 方向①：换支持 BFCache 的浏览器/启动参数，或显式 flag（如启用 `BackForwardCache`、`--disable-features` 调整）。
  - 方向②：调整 BF3 验收策略，改验 `visibilitychange` 唤醒后的 WS 重连（不依赖 BFCache 唤醒）。

## 保留的诊断产物（test-infra，未删）

- `design-agent-frontend/e2e/real-bfcache-static-http.spec.ts` + `e2e/static-ab/{a,b}.html`（支持 `BFCACHE_STATIC_PORT` 外部服务模式）。
- `playwright.config.ts` `PW_HEADED=1` 分支（`channel:'chromium'` + `headless:false`，二进制与 `--no-sandbox` 同 `PW_USE_NEW_HEADLESS=1`）。

## 后续 change 的建议范围（不修改业务、不改 BF3 验收目标）

若后续决定继续让 BF3 在 E2E 中真实验证，应**新开独立 change**（test-infra 类），输入即本文档。建议调查范围：

- **Chromium 版本**：核对 Playwright 捆绑的 Chromium（当前 133.0.6943.16）是否存在 BFCache 回归或该版本已知禁用项；必要时通过 `PLAYWRIGHT_CHROMIUM_VERSION` 或自定义 `executablePath` 指定其他版本。
- **启动参数**：系统排查 Playwright 默认自动化 flags、`--no-sandbox`、DevTools/远程调试附加，以及 `--disable-features`/`--enable-features` 中影响 `BackForwardCache` 的开关；显式启用 BFCache（如 `BackForwardCache` 相关开关调整）。
- **运行模式**：虽 headless↔headed 对照已排除运行模式本身为根因，但新 change 仍可复核是否有「自动化/无头」相关 flag 隐式禁用 BFCache。
- **验收策略（备选）**：若浏览器侧始终无法命中，可将 BF3 验收改为验证 `visibilitychange` 唤醒后的 WS 重连（不依赖 BFCache 唤醒），属 test-infra 验收口径调整。

**硬约束（沿用本 change 既定边界）**：
- **不改业务 / 前端逻辑**（WS 重连、唤醒、`visibilitychange` 均不动，属已归档 Change3）。
- **不改 BF3 验收目标语义**：BF3 仍应验证「离开后返回能恢复对话 + WS 重连」，仅在「如何触发恢复」层面调整手段。
- **不扩展已归档 Change3**、不触碰 `OH_E2E_FAULT_INJECTION` 契约；仍在既有 Docker 镜像内跑，禁宿主机直跑。
