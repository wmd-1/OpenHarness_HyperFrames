# 方案：WS 多轮 submit 生命周期错误拒绝修复

- 日期：2026-08-05
- 状态：**DONE（已实现并通过验收，待归档）**
- 分类：`session-service` 后端契约修复（属既有 `session-ws-protocol` 能力域）

## 1. 为什么（根因摘要）

多轮对话场景下，客户端在上一轮 `turn_complete` 之后**立即**发出第二轮 WS `submit`，后端会回 `busy` 帧并**静默丢弃**该 submit（无队列、无重投、DB 零痕迹）。这导致单会话永远只有 1 轮，`artifactTurns.length>1` 不可能成立，前端「多轮产物切换条」（J5）无法出现。

根因是 **WS 层与 supervisor 各用一套 busy 判据，且两者在 turn 尾部窗口不一致**：

- **supervisor 权威源**：`LiveSession._busy`（属性 `live.busy`，`supervisor.py:131-133`）。在 `stream_turn` 入口置 `True`（`:804`），在 `finally` 中先于尾部 `await tenant_store.stage_out(...)`（`:890`）置 `False`（`:881`）。
- **ws 层判据**：`turn_task.done()`（`ws.py:428`）。`turn_task` 是 `create_task(_run_turn(...))`（`:432`）返回的 Task，只有在 `_run_turn` 完全返回（即 `stream_turn` 的 `finally` 含 `stage_out` 全部跑完）后才 `done()`。

在 `turn_complete` 已 yield（`:867`）但 `stage_out`（`:890`）仍 await 的窗口内：supervisor 认为**空闲**（`live.busy==False`），但 ws 认为**忙**（`turn_task.done()==False`）。ws.py 用后者 → 把合法的第二轮 submit 判为 busy 丢弃。

> 证据闭环见工作记忆 / 诊断 harness `design-agent-frontend/e2e/real-multiturn-artifact-diag.spec.ts` 与 `e2e/j5-ws-probe.py`：同一时刻改走 REST `POST /turns`（判据是 `live.busy`）返回 200 并成功建 `turn_index=1`，证明 supervisor/lease/state/OH 全空闲，唯 ws 层 `turn_task.done()` 守卫拒收。

## 2. 目标（本 change 的 IN scope）

1. 修复 `ws.py:428` 基于 `turn_task.done()` 的错误 busy 判断。
2. 统一 WS 层与 supervisor 的 busy 状态来源——WS 复用 supervisor 的单一权威状态 `live.busy`。
3. 保证 `turn_complete` 之后的下一轮 `submit` 可以创建新的 `ConversationTurn`（第二个 `turn_complete` 正常产生）。

## 3. 非目标（明确 OUT of scope，本 change 不做）

- ❌ **`stage_out` 后台化**（`supervisor.py:890` 的 `await` 移出关键路径）——属独立优化，不在本 change。
- ❌ **busy retry 协议设计**——不发 `retry_after`、不改 `busy` 帧语义、不要求前端自动重投。
- ❌ **任何前端修改**——`useWebSocket.ts` 保持现状。

## 4. 影响文件

| 文件 | 改动 |
|---|---|
| `session-service/app/routers/ws.py` | `:428` 守卫由 `turn_task is not None and not turn_task.done()` 改为 `live.busy`；`:432` 保留 `create_task` 用于断连取消 |
| `session-service/tests/test_ws.py` | 新增回归用例（见 design.md §4），扩展既有 busy 用例 |
| `openspec/specs/interactive-session.md` | 改写「single-writer turn serialization」要求（位于该 spec），明确 busy 判定只来自 `live.busy` |

## 5. 验收（确认后实现并跑通）

1. 连续两轮 WS `submit` 均被接受。
2. 出现两个 `turn_complete` 帧。
3. 两个 `turn_complete` 的 `has_artifact` 均为 `true`（stub 栈下可确定触发）。
4. `GET /v1/sessions/{sid}/turns` 返回 2 轮。
5. **J5 E2E 恢复通过**：`design-agent-frontend/e2e/real-multiturn-artifact.spec.ts` 在 `openharness-design-frontend:e2e` 镜像内跑通，多轮产物切换条出现。

## 6. 诊断数据清理（已执行）

- 删除 `api_keys` 中 `tenant_id='j5-probe'` 的测试密钥（1 行）。
- 删除该租户下的探测会话：`conversation_turns`/`turn_artifacts`/`conversations` 共 22 会话 / 29 轮 / 29 产物（验证 0 残留）。
- 诊断探针 `e2e/j5-ws-probe.py` **保留归档**于 `e2e/`（手动复现/回归用），但其专属密钥已删，需重签 `j5-probe` key 才能复跑。
