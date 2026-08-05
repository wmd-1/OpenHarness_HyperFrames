# 任务清单：session_id 生命周期契约对齐（方案 A）

关联方案：`proposal.md`；设计：`design.md`。状态：**已完成并归档（方案 A 主修复 + M1 迁移脚本 + 单元/契约/迁移测试 7/7 通过；真实 `oh` 二进制 RESUME 契约验收通过；D.4 真实 LLM-turn E2E + 第二 turn 已完整验证通过；E.1 spec 已合入主 spec 并归档）**。

## 验收（实现后须全部满足）

- [x] 1. 真实 `oh` 二进制 RESUME 不再 `exit=1`：`oh --resume <oh_session_id> --backend-only` 越过 `load_session_by_id` 闸门、到达 backend-host await（复现 `proposal.md §1` 失败命令，现不再 `Session not found`）。验证方式见 D.2/D.3（在现有 `openharness_hyperframes_*` 镜像内挂载 `OpenHarness/src` 跑真实 `oh` CLI，命令与 session-service 调用一致）。
- [x] 2. 真实栈第二轮 turn 成功：`docker restart openharness-session` 后重连 RESUME，收到第 2 个 `turn_complete`，`GET /turns` 返回 ≥2 轮，`turn_index=1`（第二 turn 原先被 `rehydrate()` 未还原 `_turn_index` 的 `uq_turns_conv_idx` 冲突阻塞，已由独立 change `2026-08-05-rehydrate-turn-index-restore` 修复，故现完整通过）。
- [x] 3. 快照 `session_id` 与 `oh_session_id`（cwd-based）一致：验收脚本断言 `load_session_by_id` 返回 `session_id == dir`，无 `MISMATCH`（`proposal.md §8.1` 一致性已覆盖）。
- [x] 4. 原生 `oh` 用户（无 `OH_SESSION_ID`）行为不变：`save_session_snapshot` 仍产出 `session-<12hex>.json`（T3 单测覆盖）。
- [x] 5. 单元/契约测试 `proposal.md §7.1`（T1–T3、T6）在既有镜像内通过（oh-session-test 镜像，7/7 通过）。
- [x] 6. 回归：既有 `test_supervisor.py:345`（`test_build_command_resume_flag`）与 `OpenHarness` snapshot 测试（`test_session_storage.py` 7/7）通过（在 oh-session-test 镜像内挂载当前 `src`/`session-service` 复跑确认）。
- [x] 7. 旧随机 id 快照完成 §6 M1 幂等迁移：验收脚本构造旧格式 dir，M1 `migrated=1`、重跑 `migrated=0/skipped=1`，`410d1bc7-...` 类历史会话经迁移后可 RESUME。对实时 tenant 数据目录的 `--dry-run` 预览与执行建议在栈重新起来后跑一次（B.3 配套）。
- [x] 8. **真实 OpenHarness E2E（禁用 stub）通过**：`proposal.md §7.4` `real-resume-session-id.spec.ts` 创建→turn→restart→RESUME→第 2 轮 turn→断言快照内部 `session_id == oh_session_id`。`.env` 补齐 `OH_PROVIDER_API_KEY` 后于 keyed 环境执行，全绿（create→turn1→restart→RESUME→turn2→`session_id == dir`）。
- [x] 9. **失败/兼容验收通过**：`proposal.md §8.2` 旧格式快照仅 A 未迁移下 `oh --resume` 仍 `Session not found` exit 1（证明 A 单独不足、M1 必需）；经 M1 迁移后 `oh --resume` 越过闸门到达 backend-host、且幂等（真实 `oh` 二进制验收脚本全绿）。

## 实现任务

### A. 主修复（必做）
- [x] A.1 `OpenHarness/src/openharness/ui/runtime.py:377`：`session_id = os.environ.get("OH_SESSION_ID") or uuid4().hex[:12]`（已补 `import os`）。
- [x] A.2 确认 `save_snapshot` 调用点（`runtime.py:689/720/753/764`）沿用 `bundle.session_id`，无需改动。
- [x] A.3 `session-service/app/session/supervisor.py:566-568`：修正注释误判，说明 `OH_SESSION_ID` 已被真实 `oh` 用于稳定快照身份、RESUME 依赖该契约。

### B. 迁移脚本（必做，独立构件）
- [x] B.1 新增 `OpenHarness/src/openharness/tools/migrate_session_snapshots.py`：遍历 `<data_dir>/sessions/<dir>/`，幂等重键 `latest.json.session_id = dir` 并将 `session-<old>.json` 重命名为 `session-<dir>.json`（mtime 较新者优先）；支持 `--data-dir` 与 `--dry-run`。
- [x] B.2 单测 T6：构造旧格式 dir，重复调用 `rekey_data_dir` 两次，断言幂等、`session-<dir>.json` 存在且 `latest.json.session_id == dir`（已通过）。
- [x] B.3 M1 逻辑验证：在现有镜像内构造代表性旧格式 dir，`rekey_data_dir` 幂等重键成功（验收脚本覆盖）。对实时 `/tenants/<tid>/openharness/data` 执行建议栈重启后做一次（部署动作，非代码阻塞）。

### C. 兼容性闸门（前置验证）
- [x] C.1 静态确认：本栈 `settings.sandbox.enabled` 默认 `False`，session-service 未注入 `OPENHARNESS_SANDBOX_ENABLED=1`，故 `session_id` 长度 69 远超 63 的容器名闸门不触发（runtime `session_id == OH_SESSION_ID` 保持完整）。rollout 时 `docker exec openharness-session env | grep -i sandbox` 复核即可。
- [ ] C.2 （仅当启用 sandbox 时）`docker_backend.py:72` 对 `_container_name` 本地截断（保持 runtime `session_id == OH_SESSION_ID` 不变）。**N/A（按设计不实现）**：当前栈 sandbox 默认关闭（§2.4 验证闸门通过），故该截断逻辑不实现；若未来启用 sandbox 再单独处理，不阻塞本 change 归档。

### D. 测试与验证
- [x] D.1 单元/契约测试 T1–T3、T6，在既有镜像内执行，禁止宿主机直跑（oh-session-test，7/7 通过；并在容器内实跑真实 `oh --resume` 验证 `Session not found` 已消失）。
- [x] D.2 正常 RESUME 验收（`proposal.md §8.1`）：以真实 `oh` 二进制验证——构造新格式快照→`oh --resume` 越过闸门到达 backend-host、快照 `session_id == dir` 一致。等价于真实栈 RESUME 加载闸门路径（session-service 调用同一 `oh` CLI 与同一 `load_session_by_id`）。需真实 LLM turn 的第二轮断言见 D.4。
- [x] D.3 失败/兼容验收（`proposal.md §8.2`）：旧格式快照仅 A 未迁移下 `oh --resume` 仍 `Session not found` exit 1；M1 后成功且幂等（真实 `oh` 二进制验收脚本全绿）。
- [x] D.4 **真实 OpenHarness E2E（禁用 stub）** `real-resume-session-id.spec.ts`（`proposal.md §7.4`，`.env` 已补齐 `OH_PROVIDER_API_KEY`）。**已完整通过**：真实栈 create→turn1→`docker restart openharness-session`→WS 重连 RESUME→第 2 轮 turn `turn_complete` 带 `turn_index=1`、`turn_count=2`、快照 `session_id == directory name`（`PHASE RESUME OK`）。第二 turn 原先被 `rehydrate()` 未还原 `_turn_index` 的 `uq_turns_conv_idx` 冲突阻塞，已由独立 change `2026-08-05-rehydrate-turn-index-restore` 修复，故 D.4 现完整达标。
- [x] D.5 回归：`test_supervisor.py:345`（`test_build_command_resume_flag`，1 passed）与 `OpenHarness` snapshot 测试（`test_session_storage.py`，7/7 passed）在 oh-session-test 镜像内复跑通过。

### 最终验收记录（Final Acceptance Record，归档前留存）

真实栈（禁用 stub，`docker compose -f docker-compose.yml up -d session`）+ 真实 LLM turn + `OH_PROVIDER_API_KEY` 可用环境下，端到端验证全部达成：

- **real backend**：真实 `oh` 后端（非 stub）承载 RESUME。
- **real LLM turn**：第一轮、第二轮均为真实 LLM 生成（非 stub 回显）。
- **restart**：`docker restart openharness-session` 后会话被驱逐至 `COLD`、快照保留于共享卷。
- **`--resume <oh_session_id>`**：supervisor 重连后派生 `oh --resume <oh_session_id> --backend-only`，`<oh_session_id>` 由 cwd 派生，与快照目录名、环境变量 `OH_SESSION_ID` 同一命名空间。
- **session_ready**：后端越过 `load_session_by_id` 闸门、到达 backend-host await 并发出 `ready`，**不再 `backend exited during startup (exit=1)` / `Session not found`**。
- **turn2 `turn_index=1`**：第二轮 `submit` 收到 `turn_complete` 且 `turn_index=1`（因 `2026-08-05-rehydrate-turn-index-restore` 修复 rehydrate 后 `_turn_index` 还原，消除 `uq_turns_conv_idx` 冲突），`turn_count=2`。
- **snapshot `session_id == directory name`**：容器内读 `latest.json`，断言 `<dir> == latest["session_id"]`（即 == `oh_session_id`），无 `MISMATCH`。

结论：D.4 完整通过，`oh-session-id-resume-contract` 全部验收项达成，E.1 已归档。

### E. spec 合并
- [x] E.1 合并 `specs/interactive-session/spec.md` delta 到 `openspec/specs/interactive-session.md`（新增「A native backend subprocess MUST persist its snapshot under the stable --resume identity」Requirement）。**手动合并（不依赖 `npx openspec archive` 自动 merge）**：已将该 Requirement 追加进主 `openspec/specs/interactive-session.md`，并人工核验主 spec 含该 Requirement；change 目录移至 `openspec/archive/2026-08-05-oh-session-id-resume-contract`（单前缀，符合 openspec 规范路径）。

## 明确不纳入本 change（OUT scope / 独立候选）

- ❌ 方案 B（runtime 回传 session_id → session-service 持久化状态机）：复杂度高、有鸡生蛋问题，已否决。
- ❌ 方案 C（`load_session_by_id` 目录名兜底）：改变 resume 语义、可能掩盖生命周期错误、与 `--list` 展示脱钩，**从本 change 移除**，列为独立候选 change（legacy compat only，需独立 spec + 测试）。
- ❌ session-service 调度/数据库 schema/前端改动：本 change 不动。
