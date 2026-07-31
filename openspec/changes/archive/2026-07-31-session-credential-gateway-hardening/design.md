# Design: session-credential-gateway-hardening

> 实现基线：`plans/Session_Tenant_Credential_Isolation_Fix_Plan_2026-07-31.md`（rev2，已确认）。
> 本文只固化架构决策与契约；行级细节以 rev2 计划为准，不再扩展。

## Context

- WS-B 租户隔离把 backend 的 `OPENHARNESS_CONFIG_DIR/DATA_DIR` 重定向到 `/tenants/{tid}/openharness`；首见租户 seed 为 `{}`。
- `oh` 的凭据解析：provider profile 的 `auth_source` 只认 env（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）与自身配置文件；`--api-key` CLI 参数对 profile 无效（容器内实测矩阵见 rev2 §1）。
- 空 seed → `oh` 回退 anthropic 默认 profile → 无凭据 → 启动即 exit=1；`_await_ready` 对 EOF/timeout 静默放行 → 假 LIVE → 第一轮 turn 报 `WriteUnixTransport closed`。
- 现状：`SessionStatus.FAILED` 已存在，`CREATING→FAILED` 为合法状态迁移（`lifecycle.py`），router 已把 COLD/FAILED 视为 resumable；无 CREATING 残留清理机制。

## Goals / Non-Goals

**Goals:**

- node-level credential gateway：credential 为节点级资产，spawn 时经 env 注入；租户 bucket/staging/settings.json 永不保存 secret。
- 固化 credential 四级优先级契约，spawn 时实时 resolve（无缓存），rotation 免重启。
- backend spawn 生命周期硬失败：ready 前任何异常（exit≠0 / EOF / timeout）→ FAILED + 完整清理，禁止进入 LIVE。
- CREATING 不允许长期存在：create failure → FAILED；startup sweep → FAILED。
- 存量 `{}` seed 可安全修复（三分类，非空绝不自动覆盖）。
- 真实 backend 启动链路契约可回归验证（环境门控）。

**Non-Goals:**

- 仅 single-node startup sweep；不解决 multi-node ownership reconciliation（多节点需按路由归属过滤，代码注释注明为演进项）。
- 不引入 per-tenant credential / tenant secret persistence。
- 不修改 `oh` 二进制（零 OpenHarness 改动）。

## Decisions

### D1. credential 走 env 注入而非 `--api-key` / 文件

实测 `--api-key` 不被 provider profile 的 auth_source 认可；写入租户文件违反 secret 红线。唯一可行且已验证的通道是按 auth_source 注入 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`（rev2 §1 矩阵第 5 行：scrubbed settings + env key → ready）。

### D2. credential priority contract（固化，测试锁定）

```
OH_PROVIDER_API_KEY                    # 显式网关级覆盖，最高优先
  > OPENAI_API_KEY / ANTHROPIC_API_KEY # service 进程 env 中、按 auth_source 判定出的同名变量
  > global settings.json api_key       # 节点全局配置文件（OH_GLOBAL_SETTINGS_PATH）
  > none                               # 不注入，log warning，依赖 oh 自身回退
```

env var 名判定：`profiles[active_profile].auth_source`（`openai_api_key`→`OPENAI_API_KEY`，`anthropic_api_key`→`ANTHROPIC_API_KEY`）→ 回退顶层 `api_format` → 仍无法判定则 none。
备选（已否决）：pydantic Settings 快照读取 —— 与实时性冲突（见 D3）。

### D3. resolver 无缓存，spawn 时实时 resolve

每次 spawn 实时读 `os.environ` + 全局 settings.json（≤数 KB，spawn 频率下开销可忽略）。credential rotation / 环境变化对下一次 spawn 即时生效，不需重启 session-service。文件读/解析失败按「该层级缺失」降级到下一优先级。
备选（已否决）：模块级缓存 + 失效钩子 —— 复杂度换不来收益，且 rotation 需显式失效或重启。

### D4. 租户 seed = 全局配置的递归 denylist 剥离副本

denylist（键名大小写不敏感，等于或以其结尾即整键删除）：`api_key`、`token`、`access_token`、`refresh_token`、`auth_token`、`secret`、`client_secret`、`password`；模式 `*_key`/`*_token`/`*_secret`；`credential_slot` 置 null。剥离后对序列化结果做全键名断言（双保险）。全局文件缺失/损坏回退 `{}` + warning（与现状等价）。
备选（已否决）：字段白名单 —— 全局配置结构演进时新增非敏感字段会被静默丢弃，denylist 天然透传。

### D5. backend spawn 生命周期（状态机契约）

```
SPAWN
  |
  +-- ready (15s 内)          --> LIVE
  |
  +-- fail                    --> FAILED + cleanup
       (exit != 0 / stdout EOF / ready timeout / credential 缺失致启动即退)

cleanup = 取消 heartbeat/log helper task + kill 进程组(幂等)
        + 释放池槽(幂等) + SESSIONS_LIVE 递减 + 异常向上传播
```

`_await_ready` 由静默 return 改为 raise `BackendProcessError`（EOF 附 exit code；timeout 先 kill_group）。三条 spawn 路径（create / rehydrate / re-arm）共享该语义，调用方既有兜底（pool.release 幂等、占位 LiveSession 弹出）保持不变。

### D6. CREATING 生命周期收敛

- create 失败：`create_session` 异常路径 best-effort 将已提交的 CREATING 行更新为 FAILED（失败仅 log，不吞原异常）。
- startup sweep：lifespan 一次性将 DB 中所有 CREATING 行标 FAILED。依据：live 会话与进程绑定，重启后不可能存在合法 CREATING 行。**single-node 语义**（Non-goal 已声明）。
- 备选（已否决）：周期性 sweep —— 稳态下 CREATING 窗口只有 spawn 的秒级时长，失败路径已同步收敛，常驻循环无必要。

### D7. FAILED 恢复语义

FAILED 非终态：`lifecycle.py` 中 `FAILED → {COLD, LIVE, CLOSED}` 均合法；router 的 resumable 判定已包含 FAILED（快照存在时可 `--resume`）。本 change 将其从实现事实固化为 spec 契约：客户端对 FAILED 会话重连 → 走 COLD 同款 rehydrate 路径重试；不引入独立 retry API。

### D8. 存量修复三分类（只修 `{}`）

`empty_seed`（`json.loads == {}`）→ 覆盖为派生 seed（bucket + 本地 staging 同步刷，防 stage_out 回写竞态；脚本在 service 重启前运行）；`invalid`（坏 JSON / 缺 provider 关键字段 / 含 denylist secret 键）→ 只脱敏报告不修改；`ok` → 跳过。默认 `--dry-run`，`--apply` 才落盘。

### D9. 测试拆分

- 默认 pytest：stub backend（`scripts/oh_backend_stub.py`），无凭据依赖，覆盖 seed 剥离、优先级四层、去缓存、spawn 失败清理、CREATING sweep、修复脚本三分类。
- 真实 backend 契约测试：`OH_REAL_BACKEND_TEST=1` 门控整文件 skip；镜像内真实 `oh` 二进制验证「scrubbed settings + env credential → ready + auth_status=configured」正向与「无 credential → 非零退出 + `No API key configured`」反向。防 `oh` 的 auth_source/env 契约回归。
- 全部在已有镜像容器内执行（仓库规则《测试必须基于已有镜像》）。

## Risks / Trade-offs

- [硬失败暴露既有环境缺陷] → 预期 fail-fast；报错含 exit code；FAILED 可恢复不砖化。
- [无缓存 resolver 读到并发改写的半截文件] → 解析失败按层级缺失降级；下一次 spawn 自愈。
- [startup sweep 在多节点误伤他节点 CREATING 行] → 当前单节点部署；Non-goal 显式声明，代码注释标注演进点。
- [全局配置结构漂移导致 seed 字段变化] → denylist 按键名模式透传新增非敏感字段；secret 泄露由测试全键名断言锁定。
- [修复脚本误改租户配置] → 仅严格 `{}` 自动修复；invalid 只报告；默认 dry-run。
- [回滚] → 纯代码改动、无 migration：git revert + `docker compose restart session`；新 seed 对旧代码可读。

## Migration Plan

1. 代码落地（volume 挂载，无镜像重建）→ 镜像内 pytest 全绿；
2. 真实 backend 契约测试（`OH_REAL_BACKEND_TEST=1`）通过；
3. 存量修复脚本 `--dry-run` 人工核对 invalid 清单 → `--apply`；
4. `docker compose restart session`；
5. 前端真实对话 + 坏路径（FAILED 而非 CREATING）+ rotation 免重启三项实况验收；
6. `e2e/run-session-live-acceptance.sh` + `e2e/run_e2e.sh` 回归。

## Open Questions

无 —— rev2 计划已确认，全部决策已闭合。
