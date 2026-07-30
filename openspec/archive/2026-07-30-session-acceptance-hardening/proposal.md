# Proposal: session-acceptance-hardening

## Why

2026-07-30 的全链路验收（`docs/session-e2e-test-report-2026-07-30.md`）确认了四个系统性问题：① assistant 事件语义未成文，网关把 `assistant_complete` 的全文当增量追加，真实 oh 后端下 `assistant_text` 持久化与前端显示均双份（缺陷 L1）；② compose 依赖 shell 环境变量插值，`depends_on` 连带 recreate 会静默重置 `OH_OH_BIN`，且服务启动不校验其可用性，故障延迟到首个 turn 才暴露（L2，验收中两次复发）；③ 前端镜像 tag 固定 `v0.1.0`、无构建元数据，"代码新镜像旧"不可检测（L3，导致历史回放功能在旧镜像上缺失）；④ 本次人工验收（REST/WS 实况、真实后端联调）无自动化承载，无法回归（L4）。

## What Changes

- **assistant 事件契约成文并修复重复**：`assistant_delta` 定义为增量、`assistant_complete` 定义为权威最终全文（**最终覆盖语义**，语义层唯一真相）。网关 `_map_event` 对 complete 由追加改为整体替换缓冲；WS final 帧改发 `text: ""` 并新增可选 `full_text` 字段（该帧仅为**兼容 envelope**，非语义本身）；Chat 前端收到 `full_text` 时整体替换流缓冲；Terminal 模式**同样支持 full_text 替换**（前缀补尾/非前缀 resync 重放，防 WS 丢帧导致终端内容不完整）。stub 不改（**stub 与生产事件行为保持一致**是明确决策）。
- **配置漂移治理**：新增 `docker-compose.stub.yml` override 固化 stub 模式环境；明确 `OH_OH_BIN` 配置语义为**单一可执行文件路径**（不支持带参 command，参数注入用 wrapper 脚本）；session-service 启动时按语义校验（无空白/存在/可执行），process 运行时不满足则 fail-fast，container 运行时降级 WARN。
- **镜像版本管理**：`session-frontend` 镜像 tag 经 `.env` 的 `SESSION_FRONTEND_VERSION` 参数化（版本 source of truth：package.json 驱动内容版本、.env 驱动 tag）；前端镜像内置 `/version.json` 构建元数据（version/git_sha/build_time）且 nginx 以 `Cache-Control: no-store` 发布（避免版本探测被缓存）；后端 `GET /healthz` 增加 `version`、`oh_bin`、`runtime` 字段。
- **验收自动化**：新增总入口 `e2e/run-session-live-acceptance.sh` + 可独立执行的子脚本 `e2e/session-acceptance/{rest,ws,frontend}.sh`，固化本次人工验收的 REST/WS/反代冒烟断言（含 assistant_text 无重复回归锚点），基于已有镜像 + stub override 运行。
- 明确不做：UX 扩展（会话标题、创建进度、配额可视化，另立变更）。

## Capabilities

### New Capabilities

- `session-deployment-config`: 部署配置的确定性与可观测——stub compose override、OH_OH_BIN 配置语义与启动校验、镜像版本参数化（source of truth 链）、构建元数据（含 no-cache 发布）与 healthz 版本字段。
- `session-live-acceptance`: 实况验收自动化——总入口聚合 + 可独立执行的 REST/WS/frontend 子脚本及其报告输出。

### Modified Capabilities

- `session-ws-protocol`: delta 帧语义细化——新增「final 帧 text 为空且携带 full_text，客户端整体替换流缓冲」的要求；服务端 `assistant_complete` 映射由追加改为覆盖（消除 assistant_text 重复）。

## Impact

- 后端：`session-service/app/session/supervisor.py`（_map_event）、`app/session/protocol.py`（注释/契约）、`app/main.py`（启动校验）、`app/routers/health*`（healthz 字段）及对应测试。
- 前端：`session-frontend/src/types/ws.ts`、`src/ws/useWebSocket.ts`、streamBuffer、`TerminalBridge.ts`（full_text 替换）、`Dockerfile`（version.json）、`nginx.conf.template`（no-store location）及 vitest/Playwright 用例、`e2e/mock-backend.mjs`。
- 部署/工程：`docker-compose.yml`、新增 `docker-compose.stub.yml`、`.env.example`、`e2e/run-session-frontend-docker-tests.sh`、新增 `e2e/run-session-live-acceptance.sh` 与 `e2e/session-acceptance/` 子脚本。
- 兼容性：`full_text` 为新增可选字段；新后端 + 旧前端因 final 帧 text 置空即不再重复；旧后端 + 新前端行为不劣化（无 BREAKING）。
