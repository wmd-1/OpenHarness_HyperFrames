# 测试基建：后端启动失败 hook（startup-failure hook）

> 状态：**DRAFT（仅提案，未实现）** · 日期：2026-08-04
> 本 change 由 Change3 收尾时列为「不阻塞的 test-infra 增强」；不扩展 Change3 验收范围，作为后续 change 登记。不影响任何产品/前端逻辑。

## Why

已确认事实（test-infra 观察）：

1. E2E/集成验收依赖真实起的后端（stub 栈 + 真实 `openharness-session`）。
2. 当后端进程**启动失败**（镜像缺失/端口冲突/OOM/依赖未就绪）时，当前 test-infra 仅表现为**通用超时**，缺乏早失败与可操作诊断，排障耗时长、易与真实业务失败混淆。

## What Changes

- 在 test-infra 中新增 **startup-failure hook**：在后端依赖就绪检查/起栈后、跑用例前，检测后端进程是否真正进入 ready；未 ready 则**早失败并输出可操作诊断**（进程日志尾部、退出码、端口占用、健康检查失败原因）。
- 与既有 `healthz` 校验互补：不仅看 HTTP 200，还捕获「进程起了但崩溃/卡在启动」的中间态。

## Capabilities

### New Capabilities
- `test-infra-startup-failure-hook`：起栈后后端进程启动失败早检测与诊断。

## Impact

- **范围**：仅 `e2e/` 与起栈脚本（`docker-compose.stub.yml` 相关校验、验收 runner）；不涉及 `session-service` 业务代码。
- **风险**：误报——需区分「启动慢」与「启动失败」（给合理就绪宽限 + 重试）。

## Non-goals

- 不改 `session-service` 启动语义或恢复策略（属 Change1/2 已归档范围）。
- 不引入新的产品可观测性能力（仅测试期诊断）。
