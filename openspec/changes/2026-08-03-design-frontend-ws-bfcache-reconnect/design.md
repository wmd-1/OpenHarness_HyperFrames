# 设计说明：设计前端 WS 页面唤醒重连

> DRAFT · 2026-08-03 · 未实现代码

## 1. 现状（证据）

| 能力 | 现状 | 位置 |
|---|---|---|
| 心跳 | 30s `ping`，连续 3 次无 `pong` 判死 | `WebSocketClient.ts:234-250`（`window.setInterval`） |
| 退避重连 | 1s→30s，最多 10 次 | `WebSocketClient.ts:4` |
| 关闭码策略 | 4401/4403/4404 不重连；4429 60s×2；4503 15s；4430 手动；4500 有界 | `WebSocketClient.ts:6, 164-167` |
| 页面生命周期监听 | **无**（`pageshow` / `visibilitychange` / `online` 全目录 grep 为空） | `src/ws/` |

## 2. BFCache 失效模型

```
用户后退/切后台 ──► 页面冻结：定时器暂停，socket 可能被浏览器静默断开（不一定投递 close）
        │
        ▼
pageshow(persisted=true) ──► 定时器恢复
        │
        ├─ readyState 仍显示 OPEN（假活）
        └─ 需 3 × 30s ≈ 90s 才由心跳判死 ──► 期间提交静默丢失
```

## 3. 目标行为

```
pageshow(persisted) | visibilitychange→visible | online
        │
        ▼
  probe()：readyState !== OPEN ? 立即重连
           : 发 ping 并启动 PROBE_TIMEOUT（3–5s）
                ├─ 收到 pong  → 维持连接，状态不变
                └─ 超时       → 视为死连接：close(本地) + 手动重连语义（重置退避计数）
```

参数建议（待定，见开放问题）：`PROBE_TIMEOUT = 4s`；同一唤醒事件在 `PROBE_DEBOUNCE = 1s` 内只探活一次（`pageshow` 与 `visibilitychange` 常同时触发）。

## 4. 与关闭码策略的关系

唤醒探活只是**触发器**，不改变"是否允许重连"的判定：

| 上一次关闭码 | 唤醒后行为 |
|---|---|
| 4401 / 4403 / 4404 | 不重连（维持既有终态 UI） |
| 恢复失败（`1011` + `error.code=RECOVERY_FAILED`）/ 后端启动失败（`1011` + `error.code=BACKEND_START_FAILED`） | 不重连，展示明确文案 + "新建会话"出口 |
| 4429 / 4430 / 4503 / 4500 | 沿用各自策略与计数，唤醒不重置其专用计数 |
| 正常断连 / 无关闭码（假活） | 重置指数退避计数，立即重连 |

## 5. 生命周期与资源管理

- 监听器在 `WebSocketClient.connect()` 时注册，在 `close()/destroy()` 时移除；
- 会话切换（history-switch）时旧客户端必须销毁，避免多实例重复探活；
- SSR/测试环境下 `document` / `window` 可能缺失，注册需守卫。

## 6. 验收观测点

- 重连后 UI MUST NOT 重复渲染已完成 turn（依赖既有 `turn_index` 幂等渲染）；
- 重连期间 MUST 展示 `reconnecting` 状态，且不清空会话列表（仅 401 才清 key 回 Welcome，沿用既有规则）；
- 唤醒探活不得在页面可见但连接健康时造成额外重连（假阳性率为 0）。

## 7. 开放问题

1. `PROBE_TIMEOUT` 取值（3s 更灵敏 / 5s 更稳）；弱网下的假阳性权衡。
2. 是否将唤醒探活同样应用于**非 BFCache** 的普通标签页切回（`visibilitychange`）——倾向应用，但需确认不会在频繁切屏时产生抖动。
3. 移动端 Safari 的 `pageshow(persisted)` 行为差异是否需要特判。
4. 是否需要在唤醒时顺带调用 `GET /v1/sessions/{sid}` 校验 `resumable`（可提前发现后端侧恢复失败，代价是多一次请求）。
