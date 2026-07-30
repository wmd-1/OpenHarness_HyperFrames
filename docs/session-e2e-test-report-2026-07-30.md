# session-service / session-frontend 全链路测试报告

- 日期：2026-07-30
- 范围：`session-service`（后端）、`session-frontend`（前端）、前后端真实联调
- 执行约束：全程遵循「已有镜像 + 挂载源码」规则（`.qoder/rules/test-on-existing-images.md`），宿主机仅使用 docker / docker compose / curl。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 主镜像 | `openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1` |
| 后端测试镜像 | `oh-session-test:latest`（FROM oh-e2e-test:latest，源码挂载覆盖） |
| 前端 E2E 基镜像 | `oh-e2e-test:latest`（Node 22 + chrome-headless-shell） |
| 前端 runtime 镜像 | `openharness_session_frontend:v0.1.0`（测试中重建一次，见问题②） |
| oh 后端 | `scripts/oh_backend_stub.py`（OHJSON 协议 stub，无 LLM key 环境）|
| 基础设施 | compose 内 postgres:16-alpine / redis:7-alpine / minio（真实实例） |
| 运行时 | `OH_SESSION_RUNTIME=process`，`OH_IDLE_GRACE_SECONDS=20→60` |

## 2. 结果总览

| 层 | 项目 | 结果 |
|---|---|---|
| 后端 | pytest 全量（oh-session-test 镜像 + 挂载源码） | ✅ 251 passed, 9 skipped（92s） |
| 后端 | MinIO 集成层（`e2e/run-session-minio-tests.sh`，真实 minio） | ✅ 43 passed |
| 后端 | REST 实况冒烟（compose 拉起 + curl） | ✅ 全部通过 |
| 后端 | WS 全流程（容器内 `ws_e2e_driver.py`） | ✅ 全部通过 |
| 前端 | lint + vitest（`docker build --target test`） | ✅ 通过（含 tsc） |
| 前端 | runtime 镜像冒烟（SPA + CSP/安全头 + fallback） | ✅ 通过 |
| 前端 | Playwright E2E（oh-e2e-test 镜像内，mock 后端） | ✅ 12/12 通过 |
| 联调 | 浏览器模拟真实用户（真实后端） | ✅ 复验通过（首轮发现 2 个环境/部署问题，见 §4） |

## 3. 实况覆盖明细

### 3.1 REST（curl，stub 后端）

- 鉴权：无 key → 401；DB 存在 api_keys 记录时开放模式自动关闭；`manage_api_keys.py create` 签发即生效。
- 多租户隔离：租户 B 用自己的 key 访问租户 A 会话 → 404；list 互不可见；`tenant_max_concurrent=1` 超配额 → 429 "Concurrent session quota exceeded"。
- 会话生命周期：create(201) → live → REST 多轮 turn（`turn_index` 递增、`has_artifact=true`）→ 空闲驱逐 live→cold（workspace files `source=archive`，走 MinIO 归档）→ cold→resume（`--resume` 复活约 2.3s，turn_count 连续）→ DELETE 软关闭（closed 后 turns/产物仍可读，符合历史切换设计）。
- 产物：mp4 下载 200（`video/mp4`，`accept-ranges: bytes`）；`Range: bytes=0-99` → 206。
- 安全：路径穿越 `..%2f`、绝对路径 → 400；空 text → 422；不存在 SID → 404。
- 附注：后端仅接受 `X-API-Key` 头（`Authorization: Bearer` 返回 401），前端同源反代场景无影响。

### 3.2 WS（容器内 driver）

- WS turn：`submit` → `delta` 流式帧 → `turn_complete`（`has_artifact=true`）。
- 保持 attach 时不被 idle 驱逐；detach 后 grace 到期驱逐为 cold。
- cold 状态直接 WS 建连 + submit → rehydrate-on-connect（fresh `--resume` 后端）→ 正常完成 turn。

### 3.3 前端镜像流水线（`e2e/run-session-frontend-docker-tests.sh`）

Playwright 12 用例（mock 后端）：认证、创建会话、流式回复、产物卡片渲染与下载入口、断线重连、Chat↔Terminal 切换、关闭二次确认、历史回显+补发去重、closed 只读回看、`resumable=false` 置灰、4430 并发配额提示、401 回退认证页、文件面板（archive 源 + stale + ?api_key 直链 + prefix 过滤）。

### 3.4 浏览器真实联调（复验轮）

- API Key 持久化（localStorage，设置面板脱敏显示）✅
- 创建会话、流式回复+打字光标、`render_video` 工具卡片、内嵌视频播放器+下载 ✅
- 多轮对话、轮次计数递增 ✅
- **刷新后历史回放**：`GET /v1/sessions/{id}/turns?after_index=-1&limit=200` 正常发出，两轮历史+两个产物（206 视频流）完整回放 ✅
- 5 种主题切换、Terminal 模式渲染、关闭确认、closed 只读态 ✅
- 全程 console 零 error ✅

## 4. 首轮联调发现的问题与定位结论

### 问题①：发消息报 `WriteUnixTransport closed`（定位：环境操作失误，非产品 bug）

- 现象：WS submit 立即返回 `turn_error: unable to perform operation on <WriteUnixTransport closed…>`。
- 根因：中途执行 `docker compose up -d session-frontend` 时，`depends_on` 连带 recreate 了 session 容器，而当时 shell 里没有 `OH_OH_BIN` 覆盖，compose 插值回退为默认真 `oh`；真 `oh` 无 LLM key 启动即退出（Redis 诊断日志流明确记录 `Error: No API key configured`），stdin 管道关闭导致写失败。
- 佐证：该失误在测试中复现了两次（两次连带 recreate 均复位 env）；恢复 `OH_OH_BIN` 后现象消失。
- 产品侧表现正常：后端把 spawn 失败的 stderr 落入诊断日志流、turn 返回结构化 `turn_error`、前端红色错误行展示正确。
- **风险结论**：compose 的 shell 环境变量插值属于「隐式配置」，任何 `up` 类操作都可能静默漂移；且服务启动时不校验 `OH_OH_BIN` 可用性，故障要到第一次 turn 才暴露。→ 转化为修复项 P1-2（见遗留问题）。

### 问题②：刷新后聊天历史不回放（定位：部署镜像过期，非代码 bug）

- 现象：首轮测试刷新后聊天区为空，Network 无 `/turns` 请求。
- 根因：运行中的 `openharness_session_frontend:v0.1.0` 镜像构建于 2026-07-28，而 `useTurnHistory` 历史回放代码是 2026-07-30 新增——运行 bundle 内无该逻辑（`grep hydrateHistory` 无命中）。镜像 tag 固定 `v0.1.0` 不随代码演进，代码新、镜像旧不可感知。
- 处置：重建 runtime 镜像后浏览器复验通过（§3.4）。
- **风险结论**：前端镜像缺乏版本递增与构建元数据，部署漂移不可检测。→ 转化为修复项 P1-3。

## 5. 遗留问题（转入修复计划）

### L1（缺陷，必须修复）：assistant 事件语义不明确导致 assistant_text 重复

- 现象：stub 场景下助手回复文本双份（气泡显示与 `turns` 接口的 `assistant_text` 均重复）。
- 代码级定位（已核实，**真实 oh 后端同样受影响，非 stub 特有**）：
  - 真 `oh --backend-only`（`OpenHarness/src/openharness/ui/backend_host.py` AssistantTurnComplete 分支）发出的 `assistant_complete.message` 是**最终全文**（`event.message.text.strip()`）；
  - 网关 `session-service/app/session/supervisor.py::_map_event` 对 `assistant_complete` 执行 `_assistant_buf.append(message)` 并再发一帧 `{"type":"delta","text":<全文>,"final":true}`——把「全文覆盖」语义当「增量」处理；
  - 持久化 `turn.assistant_text = "".join(_assistant_buf)` = 所有 delta + 全文 = 双份；
  - 前端 `useWebSocket.ts` 对 delta 帧一律 `streamBuffer.push`（`final` 仅触发 flush），同样追加 → 显示双份。
- 协议映射注释（`protocol.py` L84 "emitted as a delta flush"）与实现不一致，属于协议语义未成文导致的实现分歧。

### L2（配置漂移，必须修复）：compose env 插值 + depends_on 连带 recreate + 无启动校验

见 §4 问题①风险结论。

### L3（版本管理，必须修复）：前端镜像 tag 固定、无构建元数据；后端版本不可观测

见 §4 问题②风险结论；后端 `healthz` 亦无版本信息，运行版本与源码版本的偏差无法在线检测。

### L4（测试资产，必须补齐）：本次人工验收无自动化承载

REST/WS 实况冒烟、真实后端浏览器验收均为手工执行，无脚本沉淀；stub 模式的环境拉起步骤（`OH_OH_BIN` 覆盖）无固化载体（正是问题①的诱因）。

### L5（UX 观察项，优化，不在本轮范围强制）

- 创建会话对话框无标题字段，列表仅显 UUID 前缀，多会话难区分；
- 创建耗时较长时无进度提示；
- 残留/他端会话占配额时用户仅见「配额已满」，无法自助清理。

## 6. 测试数据残留

- 租户 key：`live-smoke`、`live-smoke-b`（api_keys 表）；
- 若干 closed 测试会话（conversations 表）与对应 MinIO 归档对象；
- session 服务当前以 stub 后端运行（`OH_OH_BIN=/opt/oh-session-service/scripts/oh_backend_stub.py`，`OH_IDLE_GRACE_SECONDS=60`）。

以上均不影响功能，可按需清理/恢复。

## 7. 关联文档

- 修复计划：`plans/Session_Acceptance_Hardening_Plan_2026-07-30.md`
- OpenSpec 变更：`openspec/`（session 验收加固变更，与本报告 §5 逐条对应）

## 8. 修复完成备注（2026-07-30 追加）

本报告 §5 全部必修遗留项已经 `session-acceptance-hardening` 变更修复并验收完成（L5 UX 观察项按约定不在本轮范围）：

| 遗留项 | 修复落点 | 验证结果 |
| --- | --- | --- |
| L1 assistant_text 重复风险 | `assistant_complete` 改为权威最终覆盖语义（supervisor 整体替换缓冲），WS 发 `delta+final+full_text` 兼容 envelope；前端 Chat 整体替换、Terminal 前缀补尾/resync 重放 | 后端 pytest 262 passed；前端流水线全绿（Playwright 12/12） |
| L2 配置漂移 | `docker-compose.stub.yml` override 固化；`OH_OH_BIN` 三条启动校验（process fail-fast / container WARN） | 实况验证：误配启动即失败且日志可定位；override 连带 recreate 不漂移 |
| L3 版本管理 | 前端镜像 tag 经 `SESSION_FRONTEND_VERSION` 插值；`/version.json`（version/git_sha/build_time + `Cache-Control: no-store`）；后端 healthz 增加 `version`/`oh_bin`/`runtime` | 实况 curl 确认 version.json 三字段 + no-store；healthz 新字段在线可读 |
| L4 验收自动化 | 总入口 `e2e/run-session-live-acceptance.sh` + `e2e/session-acceptance/{lib,rest,ws,frontend}.sh`（子脚本可独立执行） | 基线全绿：rest 24 + ws 13 + frontend 8 = 45 PASS / 0 FAIL，报告 `e2e/session_live_acceptance_report_2026-07-30.txt` |

补充说明：

- §5 L4 中提及的「配额 429」断言在自动化时确认了一个设计行为：同租户 idle 且无 WS 连接的会话在配额满时会被驱逐腾 slot（session-history-switch D2/D4），故 429 仅在首会话 busy 或 WS attached 时触发；验收脚本据此用 `OH_STUB_TURN_SECONDS=3` 制造确定性 busy 窗口后断言。
- §6 测试数据残留已由验收总入口的 trap 清理机制接管（临时 key 用后即 revoke）；session 容器已恢复默认真 oh 模式（healthz `oh_bin=/root/.local/bin/oh`）。
- 规范已同步主 specs：`openspec/specs/session-ws-protocol.md`（assistant 事件映射语义 + full_text 帧处理）、新增 `session-deployment-config.md`、`session-live-acceptance.md`。
