# 设计说明：E2E 完整 Chromium + new headless

> 2026-08-05 · 调查完成 · 采用**方向②**（验收口径调整，test-infra 内）
> 根因与证据见 `docs/bfcache-e2e-investigation-2026-08-04.md`「根因已确证（2026-08-05 推进）」。

## 1. 现状（证据）

| 项 | 现状 | 位置/来源 |
|---|---|---|
| e2e 镜像浏览器 | 默认 `chrome-headless-shell`（old headless）；另建 `:e2e-chromium` 变体含完整 chromium（支持 `PW_USE_NEW_HEADLESS=1`） | `oh-e2e-test:latest` → `openharness-design-frontend:e2e(-chromium)` |
| BFCache 行为 | Playwright 默认以 `--disable-back-forward-cache` 启动 Chromium → BFCache 整项关闭，`pageshow.persisted` 恒 `false` | 容器内 Chromium 进程 argv 实测（调查 #9） |
| 移除该 flag 后 | BFCache 恢复不派发 `load` 事件 → Playwright `page.goBack()` 挂死（调查 #10）；这正是 Playwright 默认禁用它的原因 | `page.goBack: waiting for navigation until "load"` |
| BF3 状态 | 原 `test.skip` 挂起；现改为方向②验收（见 §2.4） | `design-agent-frontend/e2e/real-bfcache-reconnect.spec.ts` |

## 2. 方案

### 2.1 镜像：安装完整 chromium
- 在 `oh-e2e-test:latest` 基础上新增完整 chromium 安装（与 Playwright 版本匹配），保留 `chrome-headless-shell` 仅作回退。
- 可选：通过 `npx playwright install chromium` 拉取完整 chromium；确保 `libnss3`/`libatk` 等依赖齐全。

### 2.2 启动：固定 new headless
- Playwright 配置中显式使用完整 chromium 通道：
  - `chromium.launch({ headless: true, channel: 'chromium' })`（Playwright 近期版本 new headless 为默认；显式 channel 排除 headless-shell）。
  - 或在 `playwright.config.ts` 设置 `launchOptions` 排除 headless-shell。
- 提供能力探测：启动后注入 `window.__BFCACHE_SUPPORTED`（隔离探针验证 `pageshow.persisted` 能力），供用例读取。

### 2.3 能力门控
- `real-bfcache-reconnect.spec.ts` 改为：
  ```ts
  const bfcacheSupported = await probeBfcacheSupport(page);
  test.skip(!bfcacheSupported, 'BFCache 不可用：需 new-headless 完整 chromium（见 2026-08-04-e2e-chromium-new-headless-bfcache）');
  ```
- BF1/BF2 不依赖此能力，保持无条件运行。

## 2.4 调查结论（2026-08-05）：BFCache 在 Playwright E2E 下本质上不可达

- **根因**：Playwright 默认注入 `--disable-back-forward-cache`（Chromium 进程 argv 实测坐实），与 Chromium 版本（133）、运行模式、DevTools/CDP、vite/HMR/WS 无关。
- **即使移除该 flag**：BFCache 恢复不派发 `load` 事件，Playwright 的 `goBack()`/`reload` 生命周期永久等待 `load` → 挂死。故 BFCache **唤醒路径无法经 Playwright 自动化驱动**，方向①（换浏览器/显式 flag）无解。
- **决议：方向②**——BF3 验收口径调整（不修改业务/前端逻辑）：验证用户侧真实可自动化保证——离开会话页 → 返回（整页 reload）→ 应用经 REST 重水合、WS 重连并建立可用连接、对话可继续；`pageshow.persisted` 降级为**信息性记录**（annotation/日志），不再 skip 或硬断言。

## 3. 验收观测点

- 静态控制组（`real-bfcache-static-http.spec.ts`）作为**负向对照**保留：默认（BFCache 关闭）`backPersisted=false`，并打印 Chromium argv 与 `notRestoredReasons` 佐证；`E2E_BFCACHE=1` 可作为手动正向控制组（移除 `--disable-back-forward-cache` 后静态页可命中 BFCache，但 `goBack` 自动化会挂死，仅人工/短链路使用）。
- BF3 在 `PW_USE_NEW_HEADLESS=1` 下真实跑通（方向②）：离开/返回会话页、WS 重连可用、第二轮对话可继续。
- BF1/BF2 在 new-headless 下无回归（1011 + `error.code` 展示）。
- 镜像 tag 固定，CI/本地不静默回退 headless-shell。

## 4. 开放问题（已收敛）

1. 完整 chromium 体积/启动耗时对 CI 窗口的影响——是否需分两个 e2e job（headless-shell 跑 BF1/BF2，chromium 跑 BF3）？（**保留**，可在归档后优化）
2. `docker-compose.stub.yml` 起的 stub 栈是否需在 new-headless 下重测（应无影响，本 change 不动前端逻辑）。
3. 是否将 `BFCACHE_SUPPORTED` 探测固化为 e2e 启动自检（**已不需**：方向②不再以 `pageshow.persisted` 为门控，无静默 skip 风险）。
