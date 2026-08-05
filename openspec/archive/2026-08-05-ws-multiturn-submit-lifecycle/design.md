# 设计：WS 多轮 submit 生命周期错误拒绝修复

> 配套方案见 `proposal.md`。本文给出状态机问题、数据流 before/after、并发风险、回归测试。

## 1. 当前状态机问题（Current state machine problem）

WS 层与 supervisor 各维护一套"是否忙"的判据，且二者在 **turn 尾部窗口**出现分歧，导致合法 submit 被误判。

### 两套 busy 源

```
supervisor.py
  131  @property
  132  def busy(self) -> bool:
  133      return self._busy                # ← 权威源 A：live.busy
  ...
  797  if live.busy:                        # stream_turn 入口守卫
  798      yield {"type": "busy"}
  799      return
  804  live._busy = True                    # turn 开始
  ...
  867  yield {"type": "turn_complete", ...}  # turn 业务完成（用户侧可见）
  868  return
  ...
  880  finally:
  881      live._busy = False               # ← 业务完成即置空闲
  ...
  890      await tenant_store.stage_out(...) # ← 尾部 await（仍在 turn_task 内）

ws.py
  432  turn_task = asyncio.create_task(_run_turn(text))  # ← 源 B 的载体
  428  if turn_task is not None and not turn_task.done(): # ← 错误判据
  429      await _safe_send({"type": "busy"})
  430      continue                          # ← 静默丢弃文本
```

关键分歧时间线（turn0）：
1. `:867` supervisor yield `turn_complete` → `:881` 立刻 `live._busy = False`。
2. `:890` `await stage_out(...)` 仍在运行（耗时实测 256–458ms，随租户数据量增长）。
3. 此刻 **源 A**：`live.busy == False`（业务空闲）；**源 B**：`turn_task.done() == False`（ws 仍认为忙）。
4. ws.py 用源 B（`:428`）→ 回 `busy` 并 `continue`，第二轮 submit 文本被丢弃。

系统内**本就不存在 submit 队列**：`incoming` 只是原始帧读取队列（`ws.py` reader），取出后若未进入 `create_task`（`:432`）即永久丢失。

## 2. 数据流 before / after

### BEFORE（当前，会丢）

```
turn0 流式: live._busy=True,  turn_task.running
  supervisor yield turn_complete(:867) → live._busy=False(:881)
  ┌─ 窗口 ─┐ await stage_out(:890) 仍在跑: live.busy=False, turn_task NOT done
  │   WS 收到 submit(turn1)
  │     ws.py:428 turn_task.done()==False → 发 busy → continue   ← 丢弃
  └────────┘
  turn_task done
  REST /turns → [turn0]  (restTurnCount == 1)
```

### AFTER（修复后）

```
turn0 流式: live._busy=True
  supervisor yield turn_complete(:867) → live._busy=False(:881)
  ┌─ 窗口 ─┐ await stage_out(:890) 仍在跑: live.busy=False
  │   WS 收到 submit(turn1)
  │     ws.py:428 live.busy==False → 不拒绝
  │     create_task(_run_turn(turn1))(:432)
  │       stream_turn → live._busy=True(:804) → 流式 → turn_complete(turn1)
  └────────┘
  REST /turns → [turn0, turn1]  (restTurnCount == 2)
```

修复点唯一：`ws.py:428` 判据由 `turn_task.done()` 改为 `live.busy`，与 supervisor 同源。`:432` 的 `create_task` 保留，仍用于断连时的 `turn_task.cancel()`（`ws.py` 末尾 finally）。

## 3. 并发安全分析（针对「旧 turn task 未结束就创建新 turn」的 overlap 风险）

用户约束：不要机械替换 `turn_task.done()` → `live.busy`，须先确认「旧 turn task 尚未结束就创建新 turn」是否引入并发风险。以下逐组件分析，结论见 §3.5。

### 3.1 `_run_turn` task 生命周期

`ws.py:384-387`：
```
async def _run_turn(text):
    async with db.async_session() as session:
        async for frame in sup.stream_turn(sid_uuid, text, db=session):
            await _safe_send(frame)
```
- `_run_turn` 仅是对 `stream_turn` 异步生成器的 `async for` 消费；它**不持有任何共享可变状态**，只把帧发往 WS。
- `stream_turn` 是异步生成器：yield `turn_complete`（`:867`）→ `return`（`:868`）→ `finally`（`:880-892`，含 `await stage_out`）。生成器在 `finally` 的 `await stage_out`（`:890`）处挂起，完成后抛出 `StopAsyncIteration`，`_run_turn` 才返回 → 此时 `turn_task.done()` 才为 `True`。
- **修复后**：第二轮 submit 在 turn0 的 `finally` 仍 `await stage_out` 时到达，`ws.py:432` 把 `turn_task` 变量**覆盖**为 task2。task1（`_run_turn` for turn0）因此**脱离 `turn_task` 引用但仍由事件循环持有**，继续跑完 `stage_out` 后自然结束（生成器 `finally` 对 `stage_out` 有 try/except，不会抛未捕获异常，不会触发 "Task exception never retrieved"）。

### 3.2 `live._busy` 时间线（关键）

- turn0：`stream_turn` 在 `:804` 置 `live._busy=True`；yield `turn_complete`（`:867`）后，生成器在 `return`→`finally` 中**同步**执行 `live._busy=False`（`:881`），**然后**才 `await stage_out`（`:890`）。
- 因此 `live._busy` 在 `turn_complete` 帧发出后的**同一事件循环回合内（微秒级）**即变为 `False`，远早于 `stage_out` 完成。
- 第二轮 submit 到达时 `live._busy` 已为 `False` → 接受；`stream_turn`(turn1) 在 `:804` 将其置 `True`。task1 的 `finally` 在 `:881` 之后**不再改动** `live._busy`，故无 flag 竞争。

### 3.3 workspace / stage_out 并发

- 两个 turn 都会调用 `tenant_store.stage_out(live.tenant_id)`（`:890`）。**决定性发现**：`stage_out` 被 `async with tenant_lock(tenant_id):` 包裹（`tenant_store.py:473`），而 `tenant_lock` 是**按租户**的 `asyncio.Lock`（`tenant_store.py:123-131`，`_tenant_locks[tenant_id]`）。
- 后果：即使 task1 的 `stage_out` 与 task2 的 `stage_out` 在时序上重叠，它们对**同一租户**也是**严格串行**的（锁内 `asyncio.to_thread(_stage_out_sync)` 同步执行，锁外仅 `await asyncio.sleep` 退避）。→ **不存在 stage_out 并发损坏共享 workspace/存储的可能**。
- `_mark_workspace_dirty(live)`（`:885`）是非 await 调用，每 turn 各调用一次，无共享竞争。
- 唯一可观察影响：turn1 的 `stage_out` 会**等待** task1 的 `stage_out` 释放锁（最多几百 ms），属有界延迟，且 `stage_out` 失败语义本就是「保留 staging + 计数 + 返回 False，调用方 log 后继续」（`tenant_store.py:465-495`），不影响 turn 已完成的事实。

### 3.4 第二轮 turn 创建时序（安全证明）

```
t0  stream_turn(turn0) yield turn_complete(:867)
t1   _run_turn 经 _safe_send 把帧发往 WS；客户端收到 turn_complete
t2   async for 调 anext() → 生成器 return(:868) → finally: live._busy=False(:881)
t3   生成器 await stage_out(:890) [挂起，task1 仍存活但脱离 turn_task 变量]
---- 客户端在 t1 之后立即 submit(turn1)，经 reader→incoming→主循环 ----
t4   ws.py:428 live.busy==False → 接受；:432 覆盖 turn_task=task2
t5   stream_turn(turn1): live._busy=True(:804) → submit_line(:842) → 事件泵 → turn_complete(turn1)
t6   task2 的 finally 同样 await stage_out，与 task1 的 stage_out 被 tenant_lock 串行化
```
- **adapter 独占性**：task1 的 `finally` 不触碰 `live.adapter`（不读事件队列、不写 submit_line）；其事件泵在 `:868` 已 `return`。故 turn1 的 `submit_line` 与事件泵是 adapter 的唯一使用者，无 adapter 竞争。
- **DB 行独占性**：`_finalize_turn`（`:1033`）每 turn 用独立 `ConversationTurn` 行，且 `live._turn_index += 1`（`:1054`）在 finalize 内顺序执行；task1 在 t0 已完成 finalize，task2 在 t5 才 finalize，行互不冲突（与已是事实的「REST 连续两轮成功建 turn_index=1」等价，REST 路径本就逐次 await `stream_turn` 完成）。
- **断连取消**：`ws.py:455-459` finally 仅 `cancel()` 当前 `turn_task`（=task2）；task1 因已被覆盖而脱离引用，但其 `stage_out` 会自行跑完（不丢失 staging），无泄漏危害。

### 3.5 结论：无 overlap 风险 → 可按最小 patch 实现

| 共享资源 | 是否并发访问 | 是否安全 | 依据 |
|---|---|---|---|
| `live._busy` | task1 置 False 后不再改；task2 置 True | 安全 | §3.2 |
| `live.adapter`（stdin/stdout 事件泵） | 仅 task2 使用（task1 finally 不触碰） | 安全 | §3.4 |
| `live._turn_index` / `ConversationTurn` 行 | 各自 turn 独立 finalize | 安全 | §3.4 |
| `tenant_store.stage_out`（同租户） | 可能重叠，但被 `tenant_lock` 串行化 | 安全 | §3.3（`tenant_store.py:473`） |
| `_mark_workspace_dirty` | 每 turn 各一次、非 await | 安全 | §3.3 |

唯一「成本」：turn1 的 `stage_out` 会短暂等待 turn0 的 `stage_out` 释放 per-tenant 锁——有界、失败可容忍、不阻塞 turn 业务。这与「stage_out 后台化」是不同问题（后台化属 OUT scope，本 change 不做）。**因此确认无 overlap 风险，按最小 patch（`ws.py:428` 一处条件）实现。**

## 4. 回归测试（Regression tests）

### 4.1 后端集成测试（在既有 `session-service` 测试镜像内跑）
位置：`session-service/tests/test_ws.py`

- **`test_ws_two_consecutive_submits_create_two_turns`**（新增，核心回归）
  1. WS 建会话（复用既有 `open_session` fixture）。
  2. `submit` turn0 → 收到 `turn_complete` → **立即（0ms 间隔）** `submit` turn1。
  3. 断言：收到 **2 个 `turn_complete`** 帧；两轮 `has_artifact` 与 stub 一致（`True`）；期间**未收到 `busy`** 帧。
  4. 断言：`GET /v1/sessions/{sid}/turns` 返回 **2 轮**。
  - 判据等价于把诊断探针 `e2e/j5-ws-probe.py` 固化成可 CI 的 pytest，且覆盖 0ms 边界。

- **`test_ws_busy_during_active_streaming_preserved`**（扩展既有 `test_ws_busy_on_concurrent_submit`）
  - 在 stub 的 1s `sleep` 期间发第二轮 submit → 仍收到 `busy`、无第二个 turn。
  - 证明修复**没有**误关单写者拒绝（防止回归到"无 busy 门"）。

### 4.2 前端 E2E（J5 恢复，在 `openharness-design-frontend:e2e` 镜像内跑）
- 跑 `design-agent-frontend/e2e/real-multiturn-artifact.spec.ts`：
  - 断言多轮产物切换条出现（`artifactTurns.length > 1`）。
  - 断言两轮的 `turn_complete.has_artifact === true`。
  - 把 `tasks.md` 中 J5 由 **BLOCKED** 翻转为 **PASS**。

## 5. 实现注意（确认后）

- 仅改 `ws.py:428` 一处条件表达式，`live` 在该作用域已保证非 None（否则早已 `return`）。
- 不动 `supervisor.py`、`useWebSocket.ts`、busy 帧协议。
- 改动后需确保既有 41 例前端 E2E 与 `session-service` 单测全绿（本修复缩小而非扩大拒绝窗口，预期无回归）。
