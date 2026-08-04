# 设计说明：会话生命周期收敛

> DRAFT · 2026-08-03 · 未实现代码

## 1. 范围

本 change 收纳两段在 2026-08-03 评审中被要求「不并入当前三 change」的会话状态机工作：

- A. 网关重启后陈旧 `live` 会话对账收敛为 `COLD`；
- B. 「历史只读新建会话」——S4（`completed>0` 且无快照）恢复失败后的产品逃生舱。

## 2. Part A：陈旧 live 收敛 COLD

- 触发：网关进程启动（冷启动 / 重启）并完成内存注册表初始化之后。
- 动作：扫描 `conversations.status='live'` 且在内存注册表 `self._sessions` 中无存活实例的会话，置为 `COLD`，原因 `gateway_restart`。
- 收益：所有恢复统一走 `supervisor.rehydrate`（change 1 的唯一决策入口）；`ws.py:274` 的 re-arm 分支（`create_session_from_existing` 硬编码 `resume=True`）随之可被废弃或同样改调决策函数。
- 风险与约束：对账 MUST 幂等、可重入；判据 MUST 为「DB=live 且内存无实例」而非单纯 DB=live，否则会误伤正在运行（仅因重连而被观察）的会话。

## 3. Part B：历史只读新建会话

- 入口：`POST /v1/sessions` 带 `clone_readonly=<conversation_id>`（或等价 query/body 字段）。
- 行为：以源会话的 `conversation_turns` 投影为只读视图；新会话 `read_only=true`、`resumable=false`、不触发 oh `--resume`、不占用可恢复后端进程。
- 用途：S4 用户侧出口——展示「上下文已不可恢复，但可查看历史并新建会话继续」。
- 与 change 1/2 关系：本能力只是 S4 的一个产品出口；错误语义仍由 change 1（决策）与 change 2（错误出口）定义。

## 4. 依赖与顺序

- 依赖 change 1 的 `resolve_resume_decision` 已存在，re-arm 分支废弃时机与之对齐（建议 change 1 落地后本 change 再废弃 re-arm）。
- Part B 的只读渲染若复用前端既有 `closed/expired` 只读视图，则由 `design-agent-frontend` 配合，不属本 change 后端范围。
