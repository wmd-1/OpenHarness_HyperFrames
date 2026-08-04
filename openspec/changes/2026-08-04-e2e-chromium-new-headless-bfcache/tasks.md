# 任务清单：E2E 浏览器升级完整 Chromium + new headless

> 状态：**DRAFT（未实现）** · 依赖 Change3 已归档（`2026-08-03-design-frontend-ws-bfcache-reconnect`）。
> 测试纪律：仍在既有镜像内跑，禁宿主机直跑、禁为测试从零重建基础镜像。

## 1. 镜像能力
- [ ] 1.1 在 `oh-e2e-test:latest` 基础上安装完整 chromium（`npx playwright install chromium` + 依赖），保留 headless-shell 作回退。
- [ ] 1.2 重建并固定 `openharness-design-frontend:e2e` 镜像 tag，记录所用 chromium 版本与 headless 形态。

## 2. Playwright 启动
- [ ] 2.1 `playwright.config.ts` 显式使用完整 chromium 通道/new headless（排除 headless-shell）。
- [ ] 2.2 启动自检：注入 `window.__BFCACHE_SUPPORTED` 能力探测；缺失即 fail-fast（避免再次静默 skip）。

## 3. BF3 补验
- [ ] 3.1 `real-bfcache-reconnect.spec.ts` 由 `test.skip` 改为能力门控（`test.skip(!BFCACHE_SUPPORTED, ...)`）。
- [ ] 3.2 在 new-headless 下验证：`pageshow.persisted===true`、WS probe/reconnect toast、对话可继续。
- [ ] 3.3 BF1/BF2 在 new-headless 下回归全绿（1011 + `error.code`）。

## 4. 验收
- [ ] 4.1 隔离探针确认 new-headless 下 BFCache 生效。
- [ ] 4.2 完整 E2E 套件（BF1/BF2/BF3）在 new-headless 镜像内跑通，无回退 headless-shell。

## 备注
- 本 change 不动前端 WS 逻辑（属 Change3，已归档）与 `OH_E2E_FAULT_INJECTION` 契约。
- starup-failure hook、stub 429 为独立后续 change，不并入本轮。
