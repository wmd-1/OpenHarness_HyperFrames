# Proposal: session-credential-gateway-hardening

## Why

session-frontend 实测中第一轮对话即失败（`WriteUnixTransport closed`）：租户隔离把 `OPENHARNESS_CONFIG_DIR` 指向 seed 为 `{}` 的租户 staging，`oh --backend-only` 因无 provider 配置且无凭据启动即退（exit=1）；而 `_await_ready` 对 EOF 静默放行，坏会话被标为 LIVE，错误被推迟到第一轮 turn 才以不可读的 transport 报错暴露。已在主镜像容器内完成复现矩阵验证（见 `plans/Session_Tenant_Credential_Isolation_Fix_Plan_2026-07-31.md` rev2，本 change 以该 rev2 为唯一实现基线，不再扩展方案）。

## What Changes

- **确立 node-level credential gateway 架构**：provider credential 是节点级资产，由 session-service 在每次 backend spawn 时通过进程 env 注入（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`，按全局配置 auth_source/api_format 判定）；租户 bucket / staging / `settings.json` **永不保存 secret**。
- **租户 seed 从全局 settings 派生**：首见租户 seed 不再是 `{}`，而是全局 `settings.json` 经递归 denylist 剥离 secret 后的非敏感 provider 配置副本（model / base_url / api_format / profiles / active_profile）。
- **固化 credential priority contract**（spawn 时实时 resolve，无缓存，支持运行期 rotation）：
  `OH_PROVIDER_API_KEY` > `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`（service 进程 env）> global settings.json `api_key` > none。
- **backend spawn 生命周期硬失败**：`SPAWN → ready → LIVE`；`SPAWN → (exit≠0 / EOF / ready timeout) → FAILED + 完整清理`（池槽、metric、helper task、进程组）。**BREAKING**（行为收紧）：原「_await_ready 超时/EOF 静默进入 LIVE」路径被取缔，坏 backend 一律显式 5xx / WS 拒绝。
- **CREATING 不允许长期存在**：create 失败路径把 DB 行收敛为 FAILED；服务启动时一次性 sweep 将残留 CREATING 行标记 FAILED（仅 single-node 语义）。
- **FAILED 恢复语义显式化**：FAILED 非终态，等同 COLD 可经 `--resume` 恢复（router 已将 COLD/FAILED 视为 resumable，本 change 将其固化为 spec 契约）。
- **存量租户修复工具**：脚本按 `empty_seed`（自动重 seed）/ `invalid`（只分类报告）/ `ok`（跳过）三分类处理 bucket 中的存量 `settings.json`，默认 dry-run，绝不自动覆盖非空配置。
- **测试拆分**：默认 pytest（stub backend、无凭据依赖）+ 环境门控（`OH_REAL_BACKEND_TEST=1`）的真实 backend 契约测试（scrubbed settings + env credential → ready），防 auth_source / env 注入契约回归。

### Non-goals

- **仅支持 single-node startup sweep**：CREATING 残留对账假设本节点是唯一 owner；**不解决 multi-node ownership reconciliation**（多节点需按路由归属过滤，留待演进）。
- 不引入 per-tenant credential / tenant secret persistence（credential 解析层已预留替换点）。
- 不修改 `oh` 二进制自身的凭据解析逻辑（零 OpenHarness 改动原则不变）。

## Capabilities

### New Capabilities

- `session-credential-gateway`: node-level credential gateway 契约 —— 租户 seed 的非敏感派生与 secret 剥离红线、credential 四级优先级链与 spawn 时实时解析（rotation 免重启）、env 注入映射（auth_source → env var）、存量 seed 修复工具三分类语义、真实 backend 启动链路契约验证。

### Modified Capabilities

- `session-tenant-isolation`: 「first-seen tenant seed」需求从 server-owned 空模板改为**全局配置派生的无凭据副本**；「credentials MUST NOT be stored」红线细化为可测试的递归 denylist 契约。
- `interactive-session`: 新增 backend spawn 生命周期需求 —— ready 前 EOF/exit≠0/timeout 必须失败并清理，禁止进入 LIVE；CREATING 状态不允许滞留（create failure → FAILED、startup sweep → FAILED）；FAILED 的 resume 恢复语义固化。

## Impact

- **代码**（全部在 `session-service/`，源码 volume 挂载，无镜像重建）：
  `app/session/tenant_store.py`（seed 派生）、`app/session/credentials.py`（新增 resolver）、`app/session/supervisor.py`（`_tenant_env` 注入、`_await_ready` 硬失败、`_spawn` 清理、`create_session` FAILED 收敛）、`app/config.py`（`oh_global_settings_path`）、`app/main.py`（startup 告警 + CREATING sweep）、`scripts/repair_tenant_settings_seed.py`（新增）。
- **配置**：新增 env `OH_PROVIDER_API_KEY`、`OH_GLOBAL_SETTINGS_PATH`（均可缺省）；`.env.example` / `session-service/README.md` 同步。
- **数据**：无 DB migration；MinIO bucket 存量 `{}` seed 需一次性脚本修复（幂等、dry-run 先行）。
- **行为**：创建/复活/重挂三条 spawn 路径对坏 backend 由「假 LIVE + turn 期谜语错误」变为「显式 5xx / WS 拒绝 + DB 行 FAILED」；对既有 stub E2E 无影响（stub 正常发 ready）。
