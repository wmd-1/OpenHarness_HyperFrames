# 任务清单：会话生命周期收敛

> DRAFT · 未开工。依赖 `session-snapshot-storage-contract` 决策函数落地。
> 测试在既有镜像 + stub 栈内执行，禁止宿主机直跑、禁止重建基础镜像。

## Part A：陈旧 live 收敛 COLD
- [ ] A.1 网关启动钩子：扫描 `status='live'` 且 `self._sessions` 无实例的会话 → 置 `COLD`（原因 `gateway_restart`）。
- [ ] A.2 幂等/可重入：重复启动不重复置状态、不误伤运行中 live。
- [ ] A.3 废弃 `ws.py:274` re-arm 分支（或其改调 `resolve_resume_decision`），统一入口。
- [ ] A.4 单测 + stub 栈：重启 → 陈旧 live 走 rehydrate 决策，不再硬编码 resume。

## Part B：历史只读新建会话
- [ ] B.1 `POST /v1/sessions` 新增 `clone_readonly=<conversation_id>` 入口（或等价）。
- [ ] B.2 投影 `conversation_turns` 为只读视图；新会话 `read_only=true`、`resumable=false`、不 `--resume`。
- [ ] B.3 单测：S4 会话 → 只读新建成功且 `resumable=false`。

## 验收
- [ ] 网关重启冒烟：所有陈旧 live 收敛为 COLD，无 `AssertionError`、无 re-arm 硬编码 resume。
- [ ] 回归 `e2e/run-session-live-acceptance.sh` 全绿。
