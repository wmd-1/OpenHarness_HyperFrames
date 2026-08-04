# 设计说明：E2E 完整 Chromium + new headless

> DRAFT · 2026-08-04 · 未实现

## 1. 现状（证据）

| 项 | 现状 | 位置/来源 |
|---|---|---|
| e2e 镜像浏览器 | `chrome-headless-shell`（old headless） | `oh-e2e-test:latest` → `openharness-design-frontend:e2e` |
| BFCache 行为 | 不冻结页面，`pageshow.persisted` 恒 `false` | Change3 隔离探针 `PAGESHOW_EVENTS [false]` |
| `--headless=new` 对 headless-shell | 无效（需完整 chromium 二进制） | 探针实测 |
| BF3 状态 | `test.skip` 带原因挂起 | `design-agent-frontend/e2e/real-bfcache-reconnect.spec.ts` |

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

## 3. 验收观测点

- 隔离探针在 new-headless 下 `pageshow.persisted===true`（BFCache 生效）。
- BF3 在 new-headless 下真实跑通：进入/离开 BFCache、`ws-reconnect`→`ws-recovered` toast、对话可继续。
- BF1/BF2 在 new-headless 下无回归（1011 + `error.code` 展示）。
- 镜像 tag 固定，CI/本地不静默回退 headless-shell。

## 4. 开放问题

1. 完整 chromium 体积/启动耗时对 CI 窗口的影响——是否需分两个 e2e job（headless-shell 跑 BF1/BF2，chromium 跑 BF3）？
2. `docker-compose.stub.yml` 起的 stub 栈是否需在 new-headless 下重测（应无影响，本 change 不动前端逻辑）。
3. 是否将 `BFCACHE_SUPPORTED` 探测固化为 e2e 启动自检，缺失即 fail-fast（避免再次静默 skip）。
