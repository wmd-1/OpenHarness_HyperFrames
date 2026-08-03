# 会话生命周期收敛：陈旧 live 收敛 COLD 与历史只读新建（session-lifecycle-convergence）

> 状态：**DRAFT（仅提案，未实现代码）** · 日期：2026-08-03
> 独立后续 change，不并入 `session-snapshot-storage-contract` / `session-backend-failure-isolation` / `design-frontend-ws-bfcache-reconnect`。

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
