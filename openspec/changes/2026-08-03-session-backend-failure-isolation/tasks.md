# 任务清单：会话后端故障隔离

> DRAFT · 未开工。实现建议在 `session-snapshot-storage-contract` 之后（恢复失败语义依赖其决策结果）。
> 所有测试在既有镜像内执行（stub 后端栈），禁止宿主机直跑、禁止重建基础镜像。

## 1. 状态一致性
- [ ] 1.1 `supervisor._spawn`（`supervisor.py:364-423`）except 分支：释放池槽位、`adapter/process` 置空、从 `self._sessions` 移除、DB 行保留 `status=FAILED`（`failure_class`/`failure_reason`）后再抛领域异常（方案 A）；**失败会话不进入自动删除/孤儿回收**。
- [ ] 1.2 明确 `LiveSession` 失败终态字段（`failure_class` / `failure_reason`）。
- [ ] 1.3 单测：spawn 失败后注册表中不存在 `adapter is None` 的会话；槽位计数归零。

## 2. 消灭运行时断言
- [ ] 2.1 `supervisor.py:759`（`stream_turn`）改显式检查 + 领域异常。
- [ ] 2.2 同步处理 `supervisor.py:442 / 932 / 1031`。
- [ ] 2.3 单测：模拟 `adapter=None` 时各入口返回领域异常而非 `AssertionError`。

## 3. 错误分类与出口
- [ ] 3.1 定义失败分类枚举 C1–C4（见 design.md §2）与错误码常量。
- [ ] 3.2 **不引入自定义 close code**：WS 失败统一以 `1011` 关闭；明确 `error` 帧 `code` 取值为**业务枚举**（`BACKEND_START_FAILED` / `RECOVERY_FAILED` / `CAPACITY_FULL` 等），**C1–C4 内部编号仅用于指标/日志，不暴露给客户端**。
- [ ] 3.3 `routers/ws.py:273-279`：扩充捕获集合，加入 `BackendProcessError` 与恢复失败异常，统一走 `error` 帧 + close。
- [ ] 3.4 REST 侧映射：C4 `RECOVERY_FAILED` → **409 Conflict**；C3 `BACKEND_START_FAILED` → 503。
- [ ] 3.5 后端 stderr 尾部采集：限长、脱敏（过滤 `*_API_KEY`、`X-API-Key`）。

## 4. 计数保护
- [ ] 4.1 恢复/启动失败路径不再创建 `conversation_turns` 行、不递增 `turn_count`。
- [ ] 4.2 单测：注入 spawn 失败 ⇒ `turn_count` 与 turn 行数均不变。

## 5. 止损与幂等
- [ ] 5.1 失败终态会话的重复连接幂等返回，不重复 spawn。
- [ ] 5.2 指标 `session_backend_failure_total{class}`；结构化日志字段补齐。
- [ ] 5.3 孤儿回收/清理策略 MUST 排除 `FAILED`（保留 DB 行、runtime 已清理，不自动回收；design.md §3 约束 4）。

## 6. 验收（既有镜像内）
- [ ] 6.1 stub 注入“启动即失败”后端 ⇒ WS 收到 `error` 帧 + 预期 close code；容器日志无 ASGI 未捕获异常 traceback。
- [ ] 6.2 复现原始故障场景（网关重启 + 无快照 + 有上下文）⇒ 得到 `RECOVERY_FAILED`，无 `AssertionError`，`turn_count` 不变。
- [ ] 6.3 连续 3 次重连 ⇒ 幂等同一错误，后端进程创建次数为 0。
- [ ] 6.4 回归 `e2e/run-session-live-acceptance.sh` 全绿。
