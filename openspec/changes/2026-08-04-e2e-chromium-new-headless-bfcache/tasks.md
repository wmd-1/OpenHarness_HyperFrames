# 任务清单：E2E 浏览器升级完整 Chromium + new headless

> 状态：**DRAFT / In Progress（BF3 受阻，暂未归档）** · 依赖 Change3 已归档（`2026-08-03-design-frontend-ws-bfcache-reconnect`）。
> 测试纪律：仍在既有镜像内跑，禁宿主机直跑、禁为测试从零重建基础镜像。

## 1. 镜像能力
- [x] 1.1 e2e 镜像支持完整 chromium：`design-agent-frontend/Dockerfile` e2e 阶段新增 `ARG INSTALL_FULL_CHROMIUM=0`，`=1` 时 `npx playwright install chromium`（+`install-deps`）于既有基础镜像之上；默认 0 不影响 headless-shell 路径。
- [ ] 1.2 构建并固定 chromium e2e 镜像变体 `openharness-design-frontend:e2e-chromium`（`docker build --target e2e --build-arg INSTALL_FULL_CHROMIUM=1 design-agent-frontend`）。

## 2. Playwright 启动
- [x] 2.1 `playwright.config.ts` 支持 `PW_USE_NEW_HEADLESS=1`：用 `channel: 'chromium'` + `headless: true`（new headless，支持 BFCache），不再强制 headless-shell `executablePath`。
- [x] 2.2 运行脚本 `run-design-frontend-real-backend-tests.sh` 支持 `PW_USE_NEW_HEADLESS=1`：构建 chromium 镜像变体并在容器内传 `PW_USE_NEW_HEADLESS=1`；默认仍走 headless-shell。

## 3. BF3 补验
- [x] 3.1 BF3（`real-bfcache-reconnect.spec.ts`）已运行时能力门控（pageshow.persisted 检测），new-headless 下自动真跑，无需改用例。
- [ ] 3.2 new-headless 下验证 BF3：`PW_USE_NEW_HEADLESS=1 bash e2e/run-design-frontend-real-backend-tests.sh real-bfcache-reconnect`。
- [ ] 3.3 BF1/BF2 在 new-headless 下回归全绿（1011 + error.code）。

## 4. 验收
- [ ] 4.1 隔离探针确认 new-headless 下 `pageshow.persisted===true`。
- [ ] 4.2 完整 E2E 套件在 chromium 镜像内跑通，无回退 headless-shell。

## 5. 调查状态（2026-08-04，BF3 受阻）
- [x] 5.1 升级完整 chromium + new headless 后 BF3 真实栈仍 `pageshow.persisted===false`，隔离探针 `goBack()` 为整页 reload；`PW_USE_NEW_HEADLESS=1 bash e2e/run-design-frontend-real-backend-tests.sh real-bfcache-reconnect` 结论：BFCache 未命中。
- [x] 5.2 真实 HTTP 控制组（Node `http` 静态服务、`python3 -m http.server`）均 `backPersisted=false`，排除实验方法干扰。
- [x] 5.3 headless↔headed 唯一变量对照：两者均 `backPersisted=false`，运行模式非根因。
- [ ] 5.4 BF3 验收（4.1/4.2）**阻塞**：当前 Playwright 启动的 Chromium 配置下 BFCache 无法命中，本 change 暂不归档。后续方向（换浏览器/flag 或调整 BF3 验收策略）另立新 change，以 `INVESTIGATION.md` 为输入。

## 备注
- 不动前端 WS 逻辑（Change3 已归档）与 `OH_E2E_FAULT_INJECTION` 契约。
- startup-failure hook、stub 429 为独立后续 change。
