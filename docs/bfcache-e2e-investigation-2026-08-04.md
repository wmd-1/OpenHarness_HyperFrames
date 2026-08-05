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

## 根因已确证（2026-08-05 推进：本 change 内完成）

**结论：BFCache 在 Playwright 启动的 Chromium 下被禁用，根因是 Playwright 默认注入的启动参数 `--disable-back-forward-cache`，与 Chromium 版本、运行模式（headless/headed）、DevTools/远程调试附加、HMR、业务代码、应用 WebSocket 均无因果关系。且 BFCache 唤醒路径在 Playwright 自动化下根本不可驱动，故 BF3 必须走方向②（验收口径调整），而非方向①（换浏览器/flag）。**

### 证据链

| # | 实验 | 结果 | 排除的假设 |
|---|------|------|-----------|
| 9 | 在静态控制组中读取容器内 Chromium 真实进程 argv（`ps -eo pid,args`） | 浏览器与渲染进程均含 `--disable-back-forward-cache`（Playwright 默认注入）；同时含 `--enable-automation`、`--remote-debugging-pipe` | —（坐实启动参数） |
| 10 | 静态控制组经 `playwright.config.ts` 加 `ignoreDefaultArgs:['--disable-back-forward-cache']`（`E2E_BFCACHE=1`）启用 BFCache 后重跑 | `page.goBack()` **挂死**：`Error: page.goBack: Test timeout ... waiting for navigation until "load"` —— BFCache 恢复不触发 `load` 事件，Playwright 的导航生命周期永远等不到完成 | 启用 BFCache 即可让 Playwright 驱动（否） |
| 11 | 静态控制组（默认，BFCache 关闭）`notRestoredReasons` 捕获 | `notRestoredReasons: null`——因 BFCache 特性整项关闭，back 导航为普通 reload，无「未恢复原因」可报 | `notRestoredReasons` 未暴露 DevTools/WS 类阻塞（特性本就关） |

### 根因判定（已确认事实）

1. **Playwright 默认以 `--disable-back-forward-cache` 启动 Chromium**（进程 argv 实测坐实）。这是 BF3 所有先前实验（含真实 HTTP 静态控制组）`pageshow.persisted` 恒为 `false` 的唯一根因——与运行模式、Chromium 版本（133）、DevTools/CDP 附加、vite/HMR/WS 均无关。
2. **即使移除该 flag，BFCache 唤醒仍不可经 Playwright 自动化驱动**：BFCache 恢复不派发 `load` 事件，Playwright 的 `page.goBack()`/`reload` 生命周期会永久等待 `load` → 挂死。这正是 Playwright 默认禁用 BFCache 的原因（冻结页无法被 inspect/重载）。
3. 推论：BF3 期望的 `pageshow.persisted===true`（BFCache 唤醒）在 Playwright E2E 中**本质上不可达**，方向①（换浏览器/显式 flag）无解。

### 决议：采用方向②（验收口径调整，test-infra 范围内）

- BF3 不再以 `pageshow.persisted===true` 为真值条件（该条件在 Playwright 下恒假且不可达）。
- 改为验证**用户侧真实可自动化保证**：离开会话页（`goto '/'`）→ 返回（`goBack()`，此场景下为整页 reload）→ 应用经 REST 重水合会话、WS 重连并建立可用连接、对话可继续（第二轮 `submit` 收到 `Stub reply to:`）。
- `pageshowEvents` / `wokeFromBFCache` 改为**信息性记录**（打 annotation / 日志），不再 skip 或硬断言；用于人工/手动核验 BFCache 是否在某环境生效，不阻断 CI。
- 不修改业务/前端逻辑（WS 重连、`visibilitychange`、探针均不动，属已归档 Change3）；仅调整 BF3 验收手段，符合本 change 既定边界。
- 顺带保留 `playwright.config.ts` 的 `E2E_BFCACHE=1` 开关（opt-in）：供手动/正向控制组验证「移除该 flag 后静态页确实可命中 BFCache」，作为 test-infra 诊断产物，不影响其余 E2E 用例（默认关闭，避免冻结页干扰 Playwright 的 reload/inspect）。

### 2026-08-05 实测关键输出（留证）

```
# 默认（BFCache 关闭）——静态控制组负向对照
chromeProcessArgs: "...chrome ... --disable-back-forward-cache ... --enable-automation --remote-debugging-pipe ..."
backPersisted=false  notRestoredReasons=null
conclusion: REAL-HTTP-MISS: 真实静态 HTTP 页仍未命中 BFCache(persisted=false)

# E2E_BFCACHE=1（移除 --disable-back-forward-cache）——goBack 挂死
Error: page.goBack: Test timeout of 15000ms exceeded.
  - waiting for navigation until "load"
    - navigated to "http://127.0.0.1:xxxxx/a.html"


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
