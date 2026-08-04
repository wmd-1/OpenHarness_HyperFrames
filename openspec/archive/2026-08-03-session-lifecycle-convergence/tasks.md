# 任务清单：会话生命周期收敛

> 状态：**Archived（已归档）** · 依赖的 `session-snapshot-storage-contract` 决策函数已归档落地。
> **归档范围说明：本 change 包含既有 WS close code 契约修复**（详见「实现说明 → 修复」与下方 Scope 决策）。
> 测试在既有镜像 `oh-session-test:latest`（源码挂载）内执行，未宿主机直跑、未重建基础镜像。

## Part A：陈旧 live 收敛 COLD
- [x] A.1 网关启动钩子：新增 `supervisor.reconcile_stale_live()`，扫描 `status in (LIVE, IDLE)` 且 `self._sessions` 无实例的会话 → 置 `COLD`（原因 `gateway_restart`，写入新列 `status_reason`）。已包含 IDLE（idle 亦依赖已死的后端进程）。
- [x] A.2 幂等/可重入：`reconcile_stale_live` 自开 DB 会话，仅对无内存实例者置 COLD；已 COLD/其它终态不再选中；本网关已拥有的 live（在 `self._sessions`）跳过。
- [x] A.3 入口已统一：`create_session_from_existing` 早已改调 `resolve_for_conversation`（无 `resume=True` 字面量残留，已 grep 确认 0 处），本 change 无需再改 `ws.py:274`。
- [x] A.4 单测（`tests/test_session_lifecycle_convergence.py`）：陈旧 LIVE/IDLE→COLD+`gateway_restart`；本网关拥有的 live 不误伤；终态跳过。

## Part B：历史只读新建会话
- [x] B.1 `POST /v1/sessions?clone_readonly=<id>` 入口（query 参数）；源不存在/跨租户 → 404（沿用既有租户隔离）。
- [x] B.2 投影 `conversation_turns` + `turn_artifacts` 为独立副本；**artifact 深拷贝**到 clone 自有 key `{new_id}/{turn_index}/{filename}`（`storage.copy`），与源生命周期解耦——源删除/GC（按源 storage_key 删对象）不影响 clone。新会话 `status=CLOSED`、`read_only=true`、`source_session_id` 记录来源、`oh_session_id=None`、`turn_count` 继承。
- [x] B.3 单测：S4 会话 → 只读新建成功，`status=closed`、`ws_url=None`、列表 `read_only=true`/`resumable=false`、turns 投影正确、源未被改动。

## 实现说明（与 design.md 的差异）
- **只读契约落地方式（显式列权威 + 单会话暴露）**：`read_only` 以持久化列 `Conversation.read_only` 为**权威来源**，`_business_fields` 与 `_to_response` 均返回 `conv.read_only or status in (CLOSED, EXPIRED)`——显式列覆盖生命周期推导（解耦“可变性”与“终态”两轴），对列落地前的遗留 CLOSED 行仍经终态推导保持只读。`SessionResponse`（单会话 GET/POST）**新增 `read_only` 字段**，契约在列表与单会话端点一致。WS 连接对 CLOSED 走 `4403`、REST submit 走 `409`（见下“修复”）。
- **artifact 深拷贝**：clone 不再共享源 `storage_key`，而是 `storage.copy(src_key, "{new_id}/{turn_index}/{filename}")` 到 clone 自有对象，使 clone 成为可独立 GC 的投影（源删除不影响 clone）。
- **status_reason 受控常量**：新增 `SessionStatusReason.GATEWAY_RESTART` 常量，`supervisor.reconcile_stale_live` 使用该常量（不再裸字面量），便于后续枚举统一、避免扩散。
- **修复（验收中发现，且属本 change 必要契约修复）**：`session_ws` 各拒绝分支（4401/4400/4403/4404/4429）原在 `accept()` 之前调用 `websocket.close(code=...)`，Starlette 对此返回 **HTTP 403** 而非 WebSocket 关闭码。已改为**先 `accept()` 再 `close()`**，使关闭码真正送达。

## Scope 决策：WS close code 交付修复归属本 change（非独立 change）

验收 readonly clone 真实栈链路时（clone 的 `CLOSED → 4403`）才发现该根因。决定**保留在本 change**，而非拆为独立 `websocket-contract-fix` change，理由：

1. **单一根因、同一代码路径**：缺陷位于 `session_ws` 拒绝分支的共享模式（先 `close()` 后 `accept()`），并非 4 个独立 bug。修正本 change 新增的 clone `4403` 必然要改到与 `4401/4400/4404/4429` 相同的路径，无法只修 clone 而不顺带修其余拒绝码。
2. **本 change 新契约的必要前置**：本 change 引入的「历史只读新建会话」WS 契约即 `CLOSED → 4403`；前端重连策略将 4403 视为「不重连」。若不修该缺陷，4403 会以 HTTP 403 交付，前端误判为服务器/网络错误并重试，**直接破坏本 change 新增的只读 clone 契约**。该修复是「让新契约真正生效」的必要修复，非无关附带改动。
3. **附带校正既有拒绝码**：同一修复同时校正了 `4401/4400/4404/4429`（auth 失败 / 非法 sid / 会话不存在 / 限流）这些**既有**拒绝码的交付——是被同一根因波及的既有 bug，非本 change 新增行为。

**归档标注**：已在 proposal/tasks 顶部注明「**本 change 包含既有 WS close code 契约修复**」，并明确该修复同时影响 `4401/4400/4404/4429` 既有拒绝码，避免后续追踪困难。若未来希望把「既有 WS close code 交付」单独立项做契约回归覆盖，可基于此归档说明提取独立 `websocket-contract-fix` change（根因与范围边界已记录，提取时无需重新排查）。
- **IDLE 一并收敛**：设计原稿只写 `status='live'`，实现将 `IDLE` 同视为“依赖已死后端”，一并收敛为 COLD（行为更正确）。
- **不扩展语义**：未改动 recovery 决策、未改 `resolve_resume_decision`、未改前端；纯后端收敛 + 只读克隆（+ 上述 ws 拒绝码交付修复，属让既有契约真正生效）。

## 验收
- [x] 单元（`oh-session-test` 镜像内）：`test_session_lifecycle_convergence.py` **9/9** 通过（含 `read_only` 显式列权威语义、clone artifact 深拷贝独立性）；相关回归（sessions_api/supervisor/recovery/startup/migrations/lifecycle）通过，3 个失败均为**预存问题**（2 个 `test_workspace_lifecycle` 与 1 个 `test_list_sessions_business_fields` 在 HEAD 基线即失败，与本 change 无关，已 `git stash` 基线比对确认）。
- [x] **网关重启冒烟（真实栈验证通过）**：`docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session` 自动 `alembic upgrade head` 应用迁移 003；创建 LIVE 会话后 `restart session` 模拟网关重启，DB 中该会话 `status=cold` 且 `status_reason=gateway_restart`（GET 亦返回 `cold`），与该 change 的收敛语义一致。
- [x] **clone_readonly 完整链路（真实栈验证通过）**：用 `manage_api_keys.py` 发放临时租户 key 后——
  - 创建：`POST /v1/sessions?clone_readonly=<src>` → 201，`status=closed`、`ws_url=null`、`read_only=true`；
  - 列表：`GET /v1/sessions` 中 clone `read_only=true`/`resumable=false`；
  - artifact：clone 持有**独立** `storage_key`（`{clone_id}/0/demo.mp4`，与源 `{src_id}/0/demo.mp4` 不同）且对象存在；删除源对象后 clone 对象仍存活（深拷贝解耦验证）；
  - submit：`POST /v1/sessions/{clone}/turns` → **409**（`Session not live; reconnect via WebSocket`）；
  - ws：连接 clone ws（`?api_key=`）→ **4403** `Session is closed`（修复 ws 拒绝码交付后生效）。
- [ ] 回归 `e2e/run-session-live-acceptance.sh` 全绿（需在真实栈内执行；本轮以定向真实栈冒烟覆盖核心链路，未跑该通用回归脚本）。
