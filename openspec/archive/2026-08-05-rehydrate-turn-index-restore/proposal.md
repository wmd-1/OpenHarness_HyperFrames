# 方案：rehydrate 路径必须恢复 turn 索引游标（_turn_index）

- 日期：2026-08-05
- 状态：**DRAFT（待确认，确认后再实现）**
- 分类：`session-service` 冷启重连 / turn 记账子域（属 `interactive-session` 能力域）
- 关联缺陷：D.4 真实栈验收中，网关重启后 WS 重连 RESUME 的第二个 turn 提交报 `uq_turns_conv_idx` 唯一冲突 `(conversation_id, turn_index)=(...,0) already exists`。
- 关联 change：本 bug 在 `2026-08-05-oh-session-id-resume-contract` 的真实栈验收（D.4）中被暴露，但属**独立性质**（turn 索引记账缺陷，非 session_id 契约），经用户拍板拆分为独立 change。

---

## Why

`LiveSession.__init__` 将 `_turn_index` 默认置 `0`（supervisor.py:104）。会话历史切换路径 `create_session_from_existing`（supervisor.py:384）正确地把它设为 `conv.turn_count`，但 `rehydrate()`（supervisor.py:746-779）——即「网关重启后孤儿 LIVE 会话被 demote 成 COLD、WS 重连重水化」的路径——**从未恢复该游标**。

结果：网关重启后，会话冷启、WS 重连走 `rehydrate()`，新 `live._turn_index` 停在默认 `0`。首个恢复 turn 以 `turn_index=0` 提交，与已落库的 turn 1（`turn_index=0`，`turn_count=1`）撞 `uq_turns_conv_idx` 唯一约束 → `IntegrityError` → 第二个 turn 永远无法提交。

**为什么仅网关重启场景触发**：正常 idle→COLD 重连时 `live` 对象仍在 registry 中（`_turn_index` 已随每轮 `+=1` 维护正确），不受影响；只有进程被杀死（restart）导致孤儿 LIVE 被 demote 为 COLD、重新 `rehydrate` 新建/复用 `live` 时才会踩中。

**影响范围**：阻塞 `oh-session-id-resume-contract` 的 D.4「第二 turn」验收，使真实栈多轮 RESUME 不可用。

---

## What Changes

1. 在 `supervisor.py::rehydrate()` 内、`_spawn` 之前，从 `conversations` 查询 `conv.turn_count` 并赋给 `live._turn_index`，与 `create_session_from_existing`（384 行）完全对称。
2. `conv` 缺失时不抛错（游标保持默认 `0`，rehydrate 照常进行）。
3. 新增单测：断言 rehydrate 后 `live._turn_index == conv.turn_count`；复用 `test_rehydrate_resume_decision` 的 mock 骨架。
4. 真实栈验收：create+turn1 → `docker restart openharness-session` → WS 重连 RESUME + turn2 成功，`turns` 返回 ≥2 轮，无 `uq_turns_conv_idx` 冲突。

**不改动**：WS 协议、REST 契约、DB schema、`create_session_from_existing`、session_id 契约（属另一 change）。仅补一行游标还原。

---

## 根因分析（Root Cause）

| 项 | 说明 |
|---|---|
| 默认游标 | `LiveSession.__init__`：`self._turn_index: int = 0`（supervisor.py:104） |
| 正确路径 | `create_session_from_existing`：`live._turn_index = conv.turn_count`（supervisor.py:384） |
| 缺失路径 | `rehydrate()`（746-779）未设 `_turn_index`，停在默认 `0` |
| 触发条件 | 网关重启 → startup 把孤儿 LIVE `demote` 成 `COLD` → WS 重连走 `rehydrate()`（register_live_session:208 → rehydrate:208 透传 `db`） |
| 失败点 | `stream_turn` 以 `turn_index = live._turn_index`（=0）持久化 RUNNING 行，与已提交 turn 1 的 `turn_index=0` 冲突（`uq_turns_conv_idx`）；终态 `_turn_index += 1`（1056）永不到达 |

实证（D.4 真实栈）：`docker logs` 在 turn 2 提交后出现 `duplicate key value violates unique constraint "uq_turns_conv_idx" (conversation_id, turn_index)=(<sid>,0) already exists`，且 turn 1 已 `turn_complete`（`turn_count=1`）。

---

## 修复方案（最小、明确正确）

文件：`session-service/app/session/supervisor.py`，`rehydrate()` 内，`await workspace_store.stage_in(...)` 之后、`# Single decision entry point` 之前插入：

```python
            # Restore the in-memory turn cursor from the authoritative count.
            # On gateway restart the orphaned LIVE session is demoted to COLD and
            # rehydrated on WS reconnect, but LiveSession.__init__ resets
            # ``_turn_index`` to 0. Without restoring it from ``conv.turn_count``
            # the first resumed turn reuses index 0 and collides with the already
            # committed turn under uq_turns_conv_idx (IntegrityError).
            # ``create_session_from_existing`` already does this for the re-arm
            # path; rehydrate must mirror it. See change
            # 2026-08-05-rehydrate-turn-index-restore.
            conv_row = (
                await db.execute(
                    select(Conversation).where(
                        Conversation.id == live.sid,
                        Conversation.tenant_id == live.tenant_id,
                    )
                )
            ).scalar_one_or_none()
            if conv_row is not None:
                live._turn_index = conv_row.turn_count
```

- `select` 与 `Conversation` 已在文件顶部 import（supervisor.py:25,30），无需新增 import。
- `db` 由 `register_live_session`（:208）透传，WS 重连路径下处于 open 状态，可直接查询。
- 幂等：对正常 idle→COLD 重连（live 仍在 registry，`_turn_index` 已正确）重复设置也无害。

---

## 测试计划（Test Plan）

### T1 单元（既有 Docker 镜像内，禁宿主机直跑）
- 复用 `test_rehydrate_resume_decision` 骨架（mock `stage_in`/`workspace_store.stage_in`/`has_valid_snapshot`/`_spawn`），构造 `conv.turn_count=2` 的 COLD 会话，调 `sup.rehydrate(live, db=db_session)` 后断言 `live._turn_index == 2`，并 `spawn.await_args.kwargs["resume"]` 为真。

### T2 真实栈验收（D.4 第二 turn，无 stub）
- 栈：`docker compose -f docker-compose.yml up -d --force-recreate session`（真实 oh，免 stub）。
- 步骤：
  1. REST 创建会话 + 真实 LLM turn 1 → `turn_complete`（`turn_count=1`）。
  2. `docker restart openharness-session` → `session_ready`（RESUME 成功）。
  3. WS 提交 turn 2 → `turn_complete` 到达；`GET /v1/sessions/{sid}/turns` 返回 ≥2 轮；容器日志无 `uq_turns_conv_idx` 冲突。
- 复用 `e2e/real_resume_session_id_e2e.py --phase create/resume`（已就位，仅 resume 阶段此前被本 bug 阻塞）。

### 回归
- `test_rehydrate_resume_decision` 原用例（`turn_count=0` 的 FRESH/RESUME/RECOVERY_FAILED 分支）仍通过（本修复对 `conv_row.turn_count=0` 仅把游标设为 0，与默认一致，无副作用）。
- `test_create_session_from_existing_spawns_with_resume` 不受影响。

---

## 验收通过标准

1. `rehydrate` 后 `live._turn_index == conv.turn_count`（单测）。
2. 真实栈：网关重启后 WS 重连 RESUME 的第二 turn 成功提交（`turn_index=1`），`turns` 列表 ≥2 轮，日志无 `uq_turns_conv_idx` 冲突。
3. `oh-session-id-resume-contract` 的 D.4 因此解除阻塞，可完整达标。

---

## 目标（Goals，IN scope）

1. 修复 `rehydrate()` 缺失的 `_turn_index` 还原，消除网关重启后 RESUME 第二 turn 的唯一约束冲突。
2. 与 `create_session_from_existing` 的游标语义保持一致。
3. 真实栈验证 D.4 第二 turn。

## 非目标（Non-goals，OUT scope）

- ❌ 不改动 session_id 契约（属 `2026-08-05-oh-session-id-resume-contract`）。
- ❌ 不改动 WS/REST 协议、DB schema、`create_session_from_existing`。
- ❌ 不重建基础镜像（仅挂载源码 + `docker restart openharness-session`）。
