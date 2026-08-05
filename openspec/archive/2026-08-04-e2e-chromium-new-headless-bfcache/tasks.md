# 任务清单：E2E 完整 Chromium + new headless

## 1. 镜像与运行模式
- [x] 1.1 已有完整 chromium 镜像变体 `openharness-design-frontend:e2e-chromium`（FROM `oh-e2e-test:latest`，含完整 chromium 支持 `--headless=new`）。
- [x] 1.2 `PW_USE_NEW_HEADLESS=1` 选用 `:e2e-chromium`，其余用例默认仍用 `chrome-headless-shell`（镜像 tag 固定，不静默回退 headless-shell）。
- [x] 1.3 `E2E_BFCACHE=1` 诊断开关：移除 Playwright 默认注入的 `--disable-back-forward-cache`（默认关闭，不影响其余用例）。

## 2. 隔离探针（静态 HTTP 控制组）
- [x] 2.1 静态 HTTP 控制组（`real-bfcache-static-http.spec.ts`）默认 `backPersisted=false`，排除 vite/HMR/WS/缓存头干扰。
- [x] 2.2 探针打印 Chromium 真实进程 argv，坐实 `--disable-back-forward-cache` 为根因（调查 #9）。
- [x] 2.3 探针捕获 `notRestoredReasons`（调查 #11）：默认 `null`，佐证 BFCache 特性整项关闭。
- [x] 2.4 实测 `E2E_BFCACHE=1` 后 `page.goBack()` 因 BFCache 恢复不派发 `load` 事件而挂死（调查 #10）→ BFCache 唤醒在 Playwright 下不可自动化驱动。

## 3. BF3 补验
- [x] 3.1 BF3 原 `test.skip(pageshow.persisted)` 门控已移除（该条件在 Playwright 下恒假且不可达）。
- [x] 3.2 new-headless 下 BF3 实跑通过：`PW_USE_NEW_HEADLESS=1 bash e2e/run-design-frontend-real-backend-tests.sh real-bfcache-reconnect` → `1 passed`，验证「离开/返回 → REST 重水合 + WS 重连 + 对话可继续」。
- [ ] 3.3 **BF1/BF2 回归：与本次 change 无关，独立 pre-existing 问题**——`real-backend-failure.spec.ts` 在 headless-shell 与 new-headless 下均失败（default 与 new-headless 同样 ✘），根因为运行栈未启用 `OH_E2E_FAULT_INJECTION=1`（受控注入 `?fault=403|503` 不生效 → 无 error.code toast）。属独立后续 change，本 change 的 `playwright.config.ts` 改动为 additive/default-off，未触碰 BF1/BF2 用例与前/后端逻辑，故不构成回归。
- [x] 3.4 方向②落地：BF3 断言改为「返回后 WS 重连可用 + 第二轮 `Stub reply to:` 可见」；`pageshowEvents`/`wokeFromBFCache` 降级为 annotation，不 skip、不硬断言。

## 4. 验收
- [x] 4.1 静态控制组作为负向对照保留并增强（Chromium argv + `notRestoredReasons`）；`E2E_BFCACHE=1` 开关保留供手动正向控制组。
- [x] 4.2 BF3 在 `:e2e-chromium` 镜像内（`PW_USE_NEW_HEADLESS=1`）跑通，无回退 headless-shell。

## 5. 调查状态（2026-08-05 根因已确证）
- [x] 5.1 升级完整 chromium + new headless 后 BF3 真实栈仍 `pageshow.persisted===false`，`goBack()` 为整页 reload。
- [x] 5.2 真实 HTTP 控制组（Node `http` / `python3 -m http.server`）均 `backPersisted=false`，排除实验方法干扰。
- [x] 5.3 headless↔headed 唯一变量对照：两者均 `backPersisted=false`，运行模式非根因。
- [x] 5.4 根因确证：容器内 Chromium 进程 argv 实测含 Playwright 默认注入的 `--disable-back-forward-cache`；移除后 `page.goBack()` 因 BFCache 恢复不派发 `load` 事件而挂死。结论：BFCache 唤醒在 Playwright E2E 下本质上不可达，方向①无解，决议**方向②**。
- [x] 5.5 静态控制组增强 `notRestoredReasons`（调查 #11）：默认 `null`，佐证「BFCache 特性整项关闭 → 无未恢复原因可报」。

## 6. 方向② 实施（test-infra，不碰业务/前端逻辑）
- [x] 6.1 改写 `real-bfcache-reconnect.spec.ts`：去掉 `pageshow.persisted` 硬门控，断言「返回后 WS 重连可用 + 第二轮对话可继续」；`pageshowEvents` 仅作 annotation。
- [x] 6.2 `playwright.config.ts` 保留 `E2E_BFCACHE=1` opt-in（默认关闭，不影响其余用例）。
- [x] 6.3 `:e2e-chromium` 镜像内 `PW_USE_NEW_HEADLESS=1` 实跑 BF3 通过（1 passed）；BF1/BF2 失败为独立 pre-existing（见 3.3），非本 change 回归。
- [x] 6.4 归档本 change（`openspec archive`）——已落地 `openspec/archive/2026-08-04-e2e-chromium-new-headless-bfcache`，主 spec 已合入 `openspec/specs/e2e-chromium-new-headless/spec.md`。

## 备注
- 不动前端 WS 逻辑（Change3 已归档）与 `OH_E2E_FAULT_INJECTION` 契约。
- BF1/BF2 失败另立 change（启用 `OH_E2E_FAULT_INJECTION=1` 或修正受控注入契约），不阻塞本 change 归档。
- startup-failure hook、stub 429 为独立后续 change。
