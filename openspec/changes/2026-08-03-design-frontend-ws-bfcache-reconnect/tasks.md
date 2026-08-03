# 任务清单：设计前端 WS 页面唤醒重连

> DRAFT · 未开工。与后端两个 change 无实现依赖，可独立排期。
> 单测在既有 `openharness-design-frontend:test` 镜像内执行；E2E 在既有 `openharness-design-frontend:e2e` 镜像 +
> `docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session` 真实栈内执行。禁止宿主机直跑、禁止重建基础镜像。

## 1. 探活能力
- [ ] 1.1 `WebSocketClient` 新增 `probe()`：`readyState !== OPEN` 立即重连；否则发 `ping` 并起 `PROBE_TIMEOUT` 计时。
- [ ] 1.2 收到 `pong` 清除计时；超时则本地 `close()` + 手动重连语义（重置指数退避计数）。
- [ ] 1.3 同一唤醒窗口去抖（`PROBE_DEBOUNCE`），避免 `pageshow` 与 `visibilitychange` 双触发。
- [ ] 1.4 参数定档（design.md 开放问题 1）。

## 2. 生命周期接入
- [ ] 2.1 `connect()` 注册 `pageshow` / `visibilitychange` / `online`；`close()`/`destroy()` 注销。
- [ ] 2.2 `window`/`document` 缺失时安全降级。
- [ ] 2.3 会话切换时销毁旧客户端，确保监听不残留。

## 3. 策略一致性
- [ ] 3.1 终态/不可重试类别（`4401/4403/4404` + 后端 `1011` + `error.code=RECOVERY_FAILED`/`BACKEND_START_FAILED`）唤醒后不重连，依据 `error.code` 而非 close code 识别恢复失败。
- [ ] 3.2 4429/4430/4503/4500 的专用计数与等待不被唤醒重置。
- [ ] 3.3 `useWebSocket` 暴露 `reconnecting` 状态与原因，驱动 UI 文案。

## 4. UI 一致性
- [ ] 4.1 “连接恢复中”提示；重连成功后不重复渲染 turn。
- [ ] 4.2 服务端“恢复失败”错误 ⇒ 明确文案 + “新建会话”出口，不静默清空。

## 5. 测试
- [ ] 5.1 vitest：模拟 `pageshow(persisted)` / `visibilitychange` / `online` ⇒ 触发一次探活（含去抖断言）。
- [ ] 5.2 vitest：探活超时 ⇒ 重连且退避计数归零；探活成功 ⇒ 无额外重连。
- [ ] 5.3 vitest：终态关闭码唤醒后不重连；限流计数不被重置。
- [ ] 5.4 Playwright（真实栈）：`page.goBack()/goForward()` 触发 BFCache 恢复 ⇒ 5s 内恢复可提交（当前实现最坏需约 90s）。
- [ ] 5.5 Playwright：后台切前台 + 服务端主动断连 ⇒ 快速重连且历史不重复。
- [ ] 5.6 回归既有 `e2e/run-design-frontend-real-backend-tests.sh` 全绿。
