# 任务清单：设计前端 WS BFCache 唤醒重连

> 状态：**已验收通过，归档（2026-08-04）**。单元全绿（ws 模块 47 passed；全仓 vitest **318 passed**，无回归）；真实栈 E2E 按业务边界验收——BF1/BF2（后端失败 1011 + `error.code`）已落地并经真实栈范式覆盖；**BF3（BFCache 唤醒）不并入本 change**，拆出独立 test-infra change `2026-08-04-e2e-chromium-new-headless-bfcache` 处理 new-headless/chromium 能力后补验。
> 验证：`design-agent-frontend:test` 镜像内 `npx vitest run`（挂载 `src`+配置，保留镜像内 `node_modules`，不在宿主机直跑）；E2E 范式见 `e2e/run-design-frontend-real-backend-tests.sh`（既有 `openharness-design-frontend:e2e` 镜像）。
> 关键决策（原 design 标注「待定」已定）：`PROBE_TIMEOUT_MS=4000`、`PROBE_DEBOUNCE_MS=1000`；唤醒后**重置有界/指数重试计数**但**保留恢复策略**；页面隐藏时网络断开（1006）**推迟**到唤醒后再探测。
> **错误边界契约（最终）**：WS 后端/恢复失败 → 服务端发 `error` 帧（业务 `code`）+ `close(1011)`，客户端经 `error` 帧 `code` 区分 `BACKEND_START_FAILED`/`RECOVERY_FAILED`；UI 经两条通道展示——(a) 系统消息 + (b) 瞬时 toast。本回合新增后端 `force_backend_failure=start|recovery` 注入（受 `OH_E2E_FAULT_INJECTION` 门控）用于 E2E 复现 1011+error.code，生产默认关闭。

## 1. 唤醒探测钩子
- [x] 1.1 `WebSocketClient.probe()`：未 OPEN 立即 `forceReconnect`；OPEN 则发 ping 等 pong，`PROBE_TIMEOUT_MS` 内无 pong 强制重连。
- [x] 1.2 `visibilitychange`（仅 `!document.hidden` 时）注册监听 → `scheduleProbe`。
- [x] 1.3 `pageshow` + `online` 注册监听 → `scheduleProbe`；三者经 `PROBE_DEBOUNCE_MS` 去抖后单次探测；SSR 安全；`dispose()` 注销监听。

## 2. 恢复策略一致性（不被刷新/唤醒清除）
- [x] 2.1 `forceReconnect` 不清除恢复策略：`getApiKey` / `getLastTurnIndex` 为 getter，每次 `openSocket` 现取。
- [x] 2.2 恢复策略一致性验证（`WebSocketClient.test.ts` 5 例）。
- [x] 2.3 唤醒后 `session_ready` 本地状态补：沿用既有 `useWebSocket` 逻辑。

## 3. 参数
- [x] 3.1 `PROBE_TIMEOUT_MS = 4000`（constants.ts）。
- [x] 3.2 `PROBE_DEBOUNCE_MS = 1000`（constants.ts）。

## 4. UI/UX
- [x] 4.2 `useWebSocket` 暴露 `reconnecting`；组件可据此隐藏「手动重试」按钮避免误触。
- [x] 4.1 自动重连 / 恢复 / 后端错误 → 瞬时 toast 接线：
  - `reconnecting` 状态 → `info` toast（spinner，sticky，`id=ws-reconnect`）。
  - 由 `reconnecting→ready` 恢复 → `success` toast「连接已恢复」（`id=ws-recovered`）。
  - `error` 服务器帧（带业务 `code`）→ `error` toast「后端错误：<code>」+ 系统消息展示 `code+message`。
  - 新增 `uiStore` toast 切片 + `Toaster` 组件（`z-[var(--z-toast)]`=300，`data-testid="toast"`/`toaster`，`__toastLog` 测试钩子）+ `App.tsx` 挂载。

## 5/6. Playwright E2E（真实后端）
- [~] 5.1 BFCache 唤醒 e2e：`e2e/real-bfcache-reconnect.spec.ts` 已编写，但现行 e2e 镜像仅含 `chrome-headless-shell`（old headless，不冻结页面 → `pageshow.persisted` 恒 false），**无法真实验证**，用例 `test.skip` 带原因挂起；**不并入 Change3 验收**，转交 `2026-08-04-e2e-chromium-new-headless-bfcache`。
- [x] 6.1 失败注入 e2e：`e2e/real-backend-failure.spec.ts` — `force_backend_failure=start` → 1011 关闭 + `BACKEND_START_FAILED` 展示 + 非空错误。
- [x] 6.2 恢复失败 e2e：同上 `=recovery` → `RECOVERY_FAILED` 展示 + 1011 关闭。

## 备注
- `WebSocketClient.test.ts` 5 例覆盖 probe，全部通过（ws 模块 47 passed；全仓 318 passed）。
- 后端故障注入 `force_backend_failure` 仅在 `OH_E2E_FAULT_INJECTION=1` 时生效（`docker-compose.stub.yml` 已置），生产环境无影响；触发点位于 `session-service/app/routers/ws.py` 的 `create_session_from_existing` 之前，复用 `_close_backend_failure`（与 Change2 错误分类路径一致）。
- E2E 复跑命令：`bash e2e/run-design-frontend-real-backend-tests.sh`（会先起 stub 栈再跑 Playwright）。`chrome-headless-shell` 下 BFCache 是否参与见验收记录；如 headless-shell 不冻结页面，需改用 new headless 以拿到 `pageshow.persisted===true`。
- **归档边界（2026-08-04）**：BF3 不并入本 change 验收，独立 test-infra change `2026-08-04-e2e-chromium-new-headless-bfcache` 负责启用 new-headless（完整 chromium）后补验 BFCache 唤醒路径；startup-failure hook 与 stub 429 调整不扩展本轮范围，分别作为后续 change 登记（`2026-08-04-test-infra-startup-failure-hook`、`2026-08-04-e2e-stub-429-concurrency-adjust`）。
