# 任务清单：WS 多轮 submit 生命周期错误拒绝修复

关联方案：`proposal.md`；设计：`design.md`。**后端 + 单测已验证；J5 E2E 集成验收【BLOCKED / 未通过】——失败原因为前端 `activeTurn` 默认选中逻辑（本 change OUT scope，按指令 #6 不改码、保留 trace）。**

## 验收（实现后须全部满足）

- [x] 1. 连续两轮 WS `submit` 均被接受（无 `busy` 帧打断）。✅ `test_ws_consecutive_submits_after_turn_complete_create_two_turns` 验证无 busy、2×turn_complete。
- [x] 2. 出现两个 `turn_complete` 帧。✅
- [x] 3. 两个 `turn_complete` 的 `has_artifact` 均为 `true`（stub 栈下确定触发）。✅ 断言 `completes[0/1].has_artifact is True`。
- [x] 4. `GET /v1/sessions/{sid}/turns` 返回 2 轮。✅ `items` 长度 == 2。
- [ ] 5. **J5 E2E 恢复通过**：`design-agent-frontend/e2e/real-multiturn-artifact.spec.ts` 在 `openharness-design-frontend:e2e` 镜像内跑通，多轮产物切换条出现（J5 由 BLOCKED → PASS）。
  - **2026-08-05 E2E 实跑结果：FAIL（未通过）**，但**失败非本 change 引入、且非后端问题**：
    - 同跑的 `real-multiturn-artifact-diag.spec.ts`（诊断探针）**PASS**，其 `J5_DIAG_SUMMARY` 决定性证明后端修复生效：2×`turn_complete`（turn_index 0/1，`has_artifact=true`）、`restTurnCount=2`、`restHasArtifactTrue=2`、`secondTurnArrived=true`、`consoleErrors=[]`、**全程 0 个 busy 帧**。原 J5 根因（第二轮 submit 被 `busy` 静默丢弃 → 仅 1 轮）已彻底消失。
    - 验收 spec 在 `real-multiturn-artifact.spec.ts:44` 断言 `video` 的 `src` 应为 `turns/1/artifact`（默认选中最新轮=第 2 轮），实际为 `turns/0/artifact`（第 1 轮）。而 `第 2 轮` tab 的 `aria-selected=true` 已通过（`:43`），即**切换条渲染与选中态正确，唯独预览视频源绑定到了旧轮（turn 0）**。
    - **根因 = 前端 `activeTurn` 自动选中逻辑**（`VideoModulePage.tsx:179-191` turn-complete 边界判定），默认/回填未指向最新产物轮。属**前端缺陷，本 change 明确 OUT scope（不改 frontend）**。
  - **按指令 #6：不修改代码，保留 trace**。J5 维持 BLOCKED，待独立前端 change 修复 `activeTurn` 默认最新轮后翻 PASS。
  - **依赖解锁项（新建）**：`2026-08-05-video-artifact-active-turn-consistency`（前端 activeTurn 单一权威 / 默认最新轮 / tab↔src 一致）。该前端 change 完成且 E2E `real-multiturn-artifact.spec.ts` 翻 PASS 后，本 change 的 #5 方可解除 BLOCKED 并把 J5 标 completed（不在本次操作）。
  - **trace 留存**：`/tmp/j5_e2e.log`（完整 `J5_DIAG_SUMMARY` + 失败断言 + Playwright 调用日志）；Playwright `trace.zip` 因 e2e 容器 `--rm` 已随容器销毁，权威证据见该 log。


## 实现任务

### A. 后端修复（最小改动）
- [x] A.1 `session-service/app/routers/ws.py:428`：守卫改为 `if live.busy:`（复用 supervisor 单一权威状态 `live.busy`）。
- [x] A.2 确认 `ws.py:436`（原 432）的 `turn_task = asyncio.create_task(_run_turn(text))` 保留（仍用于断连 `cancel`）。
- [x] A.3 不改 `supervisor.py`、`useWebSocket.ts`、busy 帧协议（OUT scope 严守）。

### B. 契约更新
- [x] B.1 `openspec/specs/interactive-session.md`：已合并 `specs/interactive-session/spec.md` delta（改写 single-writer 要求，busy 只来自 `live.busy`，新增 after-turn_complete 接受场景）。

### C. 回归测试
- [x] C.1 `session-service/tests/test_ws.py::test_ws_consecutive_submits_after_turn_complete_create_two_turns`：注入 slow `stage_out`(0.5s) 保证 post-turn_complete 窗口存在，立即 submit（不 sleep 等 stage_out）→ 2×turn_complete、2 轮 REST、无 busy。✅ 通过。
- [x] C.2 既有 `test_ws_busy_on_concurrent_submit`（活跃流式期间并发 submit 仍收 busy，单写者不变式保留）✅ 仍通过（未退化）。
- [ ] C.3 在 `openharness-design-frontend:e2e` 镜像内跑 `real-multiturn-artifact.spec.ts`，把 J5 翻为 PASS。
  - **2026-08-05 已实跑（KEEP=1 保留栈，`docker compose -f ... -f docker-compose.stub.yml up -d session` 重建 session 带 patch + stub OH）**：诊断探针 `real-multiturn-artifact-diag.spec.ts` PASS（后端证据齐备）；验收 spec `real-multiturn-artifact.spec.ts` FAIL 于 `:44` 视频源绑定（前端 `activeTurn` 默认选中旧轮，OUT scope）。J5 维持 BLOCKED。详见验收 #5。

### D. 验证与清理
- [x] D.1 单测：`test_ws.py` 模块 11 例中 10 通过；唯一失败 `test_ws_rate_limit_returns_4429`（连接限流/4429，与本次改动无关的独立既有失败，隔离运行亦失败，非回归）。
- [ ] D.2 更新 `2026-08-01-design-frontend-real-backend-e2e/tasks.md` 中 J5 由 BLOCKED → PASS（勾选 1.6）。← 待 J5 E2E 通过。
- [x] D.3 诊断数据已清理（api_key + j5-probe 会话已删，`e2e/j5-ws-probe.py` 保留归档）。
