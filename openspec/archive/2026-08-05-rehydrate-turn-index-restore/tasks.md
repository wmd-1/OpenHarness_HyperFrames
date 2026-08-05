# 任务：rehydrate 路径恢复 turn 索引游标

- [x] 1. 代码修复：在 `supervisor.py::rehydrate()` 内从 `conv.turn_count` 恢复 `live._turn_index`（mirror `create_session_from_existing`）
- [x] 2. 单测：断言 rehydrate 后 `live._turn_index == conv.turn_count`（复用 `test_rehydrate_resume_decision` mock 骨架）
- [x] 3. 真实栈验收：create+turn1 → `docker restart openharness-session` → resume+turn2 成功（D.4 第二 turn），无 `uq_turns_conv_idx` 冲突
- [x] 4. 归档 change（`oh-session-id-resume-contract` 的 D.4 因此解除阻塞）
