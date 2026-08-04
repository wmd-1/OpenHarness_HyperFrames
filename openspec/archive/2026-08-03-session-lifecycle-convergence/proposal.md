# 会话生命周期收敛：陈旧 live 收敛 COLD 与历史只读新建（session-lifecycle-convergence）

> 状态：**Archived（已归档）** · 日期：2026-08-03
> 独立后续 change，不并入 `session-snapshot-storage-contract` / `session-backend-failure-isolation` / `design-frontend-ws-bfcache-reconnect`。
> **归档范围说明：本 change 包含既有 WS close code 契约修复**（`session_ws` 拒绝分支 `accept()` 前 `close()` 导致 Starlette 返回 HTTP 403 的根因修复，同时校正了 `4401/4400/4403/4404/4429` 全部拒绝码的交付；详见下方「Scope」。）。

## Why

来源：2026-08-03 评审决策——「网关重启后 live session 收敛 COLD、历史只读新建会话」先不并入当前三 change，单独立项。

两块都与“会话状态机正确性”相关：

1. **陈旧 `live` 收敛 COLD**：网关重启后 DB 残留 `status='live'` 的会话（内存态已清空）。当前三 change 已保证决策函数对陈旧 `live` 也能给出正确 `FRESH/RESUME/RECOVERY_FAILED`，但 `ws.py:274` 的 re-arm 分支（`create_session_from_existing`）仍硬编码 `resume=True` 路径。把陈旧 `live` 在启动时批量收敛为 `COLD`，使其统一走 `rehydrate` 决策入口，可从根上消除 re-arm 分支、收紧入口唯一性。
2. **历史只读新建会话**：change 1 的 S4（`completed>0` 且无快照）当前为“恢复失败终态、不降级”。但产品上应提供出口，让用户从已有历史（`conversation_turns`）以**只读**方式新建一个会话查看上下文；新会话不继承 oh 侧可恢复上下文。这是 S4 恢复失败后的“逃生舱”。

## What Changes

- 网关启动时对 `status='live'` 且内存无存活实例的会话执行**对账（reconcile）**，收敛为 `COLD`（带原因 `gateway_restart`）；`COLD` 经 `rehydrate` 唯一决策入口。
- 在 change 1 决策函数落定后，废弃 `ws.py` 的 re-arm 分支（或令其同样调用决策函数）；re-arm 不再硬编码 `resume=True`。
- 新增「从历史只读新建会话」能力：`POST /v1/sessions` 带 `clone_readonly=<conversation_id>`（或等价入口），复制 `conversation_turns` 历史为只读视图、新会话 `read_only=true` 且 `resumable=false`、不触发 oh `--resume`。

## Capabilities

### New Capabilities
- `session-lifecycle-convergence`：陈旧 live 对账 + 历史只读新建。

## Impact

- **代码**：`session-service/app/session/{supervisor,tenant_store}.py`、`app/routers/{sessions,ws}.py`；（历史只读）新增克隆/投影逻辑。
- **依赖**：依赖 change 1 的 `resolve_resume_decision` 已存在；re-arm 分支废弃时机需与 change 1/2 实现排期对齐。
- **测试**：既有镜像 + stub 栈（`docker-compose.yml + docker-compose.stub.yml`）内执行；禁止宿主机直跑、禁止重建基础镜像。

## Non-goals

- 不重新定义快照判据/恢复语义（属 change 1）。
- 不定义失败隔离出口（属 change 2），本 change 的“历史只读新建”只是 S4 的一个产品出口，错误语义仍由 change 1（决策）与 change 2（错误出口）定义。
- 不改前端 BFCache 重连行为（属 change 3）。

## Scope：WS close code 交付修复为何归属本 change

验收 readonly clone 真实栈链路时（clone 的 `CLOSED → 4403`），发现 `session_ws` 各拒绝分支（4401/4400/4403/4404/4429）在 `accept()` **之前**调用 `websocket.close(code=...)`，Starlette 对此返回 **HTTP 403** 而非 WebSocket 关闭码。该修复**保留在本 change 内**，理由：

1. **单一根因**：这是 `session_ws` 拒绝分支的一处共享缺陷（同一函数、同一模式），并非 4 个独立修复。要修正本 change 引入的 clone `4403` 交付，必然要改动与 `4401/4400/4404/4429` 相同的代码路径——无法只修 clone 而不顺带修其余拒绝码。
2. **本 change 新契约的必要前置**：本 change 引入的「历史只读新建会话」的 WS 契约是 `CLOSED → 4403`。前端重连策略将 4403 视为「不重连」（见 `design-frontend-ws-bfcache-reconnect` 与前端 WS 重连矩阵）。若不修该缺陷，4403 会被当作 HTTP 403 交付，前端会把它误判为服务器/网络错误而重试，**直接破坏本 change 新增的只读 clone 契约**。因此该修复是「让新契约真正生效」的必要修复，而非附带的无关改动。
3. **附带校正既有拒绝码**：同一修复也一并校正了 `4401/4400/4404/4429` 这些**既有**拒绝码的交付（auth 失败 / 非法 sid / 会话不存在 / 限流）。这些是被同一根因波及的既有 bug，并非本 change 新增的行为。

**结论**：保留在本 change。但为避免后续追踪困难，已在归档说明中显式注明「包含既有 WS close code 契约修复」，并明确该修复同时影响 `4401/4400/4404/4429` 既有拒绝码。若未来希望把「既有 WS close code 交付」单独立项做契约回归覆盖，可基于此归档说明提取独立 `websocket-contract-fix` change，本归档已记录根因与范围边界，提取时无需重新排查。
