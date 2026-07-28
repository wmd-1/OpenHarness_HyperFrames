# Design: harden-session-frontend

## Context

`session-service-frontend`（2026-07-27 归档）交付了 Session Console MVP：React 18 + Zustand 前端通过自定义 WS JSON 帧协议与 session-service 网关交互，REST 走 `X-API-Key` 头、WS 握手走 `?api_key=` 查询参数。2026-07-28 的全面代码审查（`session-frontend/CODE_REVIEW_REPORT.md`，含后端契约交叉核对）识别出 27 项问题与 6 个测试缺口，修复计划为 `plans/Session_Frontend_Fix_Plan_2026-07-28.md`（Phase 0–3）。

核心现状约束：

- 后端 `turn_complete` 帧 / `TurnResponse` 无产物标记，前端产物组件是死代码（A1）；`<video>` 元素无法携带自定义头，后端 REST 仅接受 Header 认证（A2）——两者联动，需前后端同一变更内交付。
- 项目规则：所有测试必须在已有 Docker 镜像内执行（`docker build --target test` / `e2e/run-session-frontend-docker-tests.sh`），禁止宿主机 vitest/playwright。
- nginx 已对 `/v1` 关闭 access_log（session-service-frontend 遗留缓解），为查询参数认证扩展提供了日志安全前提。

## Goals / Non-Goals

**Goals:**

- 打通「产物预览/下载」端到端链路（WS 帧标记 → REST 直链认证 → `<video>`/`<a download>`），消除全量 blob 内存路径。
- 协议语义结构化：审批超时按 `code` 分发；4429 限流重试有界化。
- 修订与产品语义冲突的规格条款（HTML 剥离），恢复用户输入正确性，同时保持 XSS 防线不降级。
- 补齐规格既有但未实现的强制项（403 横幅、429 Retry-After、关闭确认），并为不可逆操作加失败回滚。
- Terminal 输出控制序列过滤、CSP connect-src 收紧等纵深防御。
- 按报告 §8 补齐核心测试缺口，全部在镜像内执行。

**Non-Goals:**

- 不替换 WS 的 `?api_key=` 握手认证为 ticket 机制（报告 B3 记录为远期项）。
- 不实施 C3（流式消息拆独立 store 字段），标记 won't-fix-now。
- 不引入路由、i18n 或新状态库；新依赖仅 `remark-gfm` 与显式声明既有传递依赖。
- 不改动 session-service 的会话生命周期 / 限流 / 配额逻辑（属 `harden-session-service` 范畴），本变更后端改动仅限协议字段与 artifact 认证扩展。

## Decisions

### D1 产物标记：`has_artifact` 布尔字段随 `turn_complete` 帧与 `TurnResponse` 下发

- **选择**：后端 `_finalize_turn` 注册产物成功后在 `turn_complete` 帧附 `has_artifact: bool`；`TurnResponse` 同步补字段。前端 `TurnCompleteFrame.has_artifact` 为可选，缺失按 `false` 处理。
- **替代方案**：前端收到 `turn_complete` 后发 `Range: bytes=0-0` 探测请求——被否：每轮次多一次 REST 往返、探测 404 会污染错误日志，且同版本部署下无兼容需求。仅当需要兼容旧后端时才作为回退实现。
- **兼容性**：可选字段，旧前端忽略、新前端回退，无 BREAKING。

### D2 产物认证：artifact GET 扩展 `?api_key=` 查询参数（仅该路径）

- **选择**：认证中间件对 `/v1/sessions/{sid}/turns/{idx}/artifact` 额外接受查询参数，复用 WS 握手同一校验函数；其余 REST 路径保持仅 Header，不扩大攻击面。前端 `artifactStreamUrl`/`artifactUrl` 拼接 key，`<video src>` 直用，下载改 `<a download>` 直链（浏览器流式落盘，顺带解决 C1）。
- **替代方案 1**：fetch → blob → `createObjectURL`——被否：大视频全量进内存，移动端崩标签页，且无法流式 seek。
- **替代方案 2**：短时效签名 URL——更安全但需后端新增签发端点与过期管理，成本高；记录为远期备选（与 B3 的 WS ticket 可合并设计）。
- **日志安全**：nginx `/v1` `access_log off` 已覆盖；需核对 uvicorn access log 不落 query string（或后端日志中间件脱敏）。

### D3 审批超时：`turn_error` 帧结构化 `code` + 过渡期文案回退

- **选择**：后端审批超时产出 `turn_error` 时附 `code: "approval_timeout"`；前端优先按 code 分发，`code` 缺失时保留 `message.includes('审批')` 回退（注释标注移除条件）。`code` 设计为开放枚举字符串，未来错误类型可扩展。
- **理由**：协议语义不应耦合自然语言文案；渐进迁移避免前后端发版顺序耦合。

### D4 4429 限流：独立有界计数，超限转 failed

- **选择**：`WebSocketClient` 为限流路径维护独立计数 `rateLimitRetries`（上限 2，常量 `RATE_LIMIT_MAX_RETRIES`），每次等待 60s；超限置 `failed` 交 UI 手动 `retry()`（重置计数），`onopen` 成功清零。规格从「尝试一次」修订为「有界重试（最多 2 次）」——一次重试对瞬时限流窗口过于苛刻，两次在防风暴与自愈之间平衡。
- **替代方案**：并入指数退避主路径共享 10 次上限——被否：60s 固定等待与指数退避语义混杂，且会快速耗尽主路径重试预算。

### D5 输入清理：删除 HTML 剥离，防线收敛到渲染层 + CSP

- **选择**：`sanitizeUserInput` 仅剥离控制字符；spec session-auth 的防护判据改为「React JSX 自动转义 + react-markdown 默认不渲染 HTML + nginx CSP `script-src 'self'`」三层。同时 CSP `connect-src 'self' ws: wss:` 收紧为 `'self'`（现代浏览器 `'self'` 匹配同源 ws/wss），三处 location 同步修改（规避 add_header 继承陷阱）。
- **理由**：`/<[^>]*>/g` 对开发场景 Agent 前端是实打实的语义破坏（`Vec<T>` 被删改），而 XSS 收益为零——输入的消费端全部在受控渲染层。

### D6 关闭会话：`useCloseSession` 统一确认 + 回滚

- **选择**：三处关闭入口（Sidebar 垃圾桶、Chat `/close`、Terminal `/close`）收敛为单一 hook：`ConfirmDialog` 确认 → 乐观置 `closed` → DELETE 失败回滚原状态 + 错误横幅。`ConfirmDialog` 与 `CreateDialog`/`SettingsPanel` 共用新提取的 `useFocusTrap`（源自 ApprovalModal 既有实现）。
- **理由**：DELETE 清 workspace 不可逆；现状「吞错 + 无重新 GET 路径」导致 UI 与后端永久漂移。

### D7 Terminal 输出过滤：白名单式 ANSI 清洗

- **选择**：`utils/sanitize.ts` 新增 `sanitizeAnsi(text)`：剥离 OSC（`\x1b][^\x07\x1b]*(\x07|\x1b\\)`）与危险 CSI 子集（清屏 `2J`/`3J`、光标定位、模式切换），保留 SGR 颜色（`\x1b\[[0-9;]*m`）；`TerminalBridge` 在 `term.write()` 前调用。
- **理由**：xterm 无沙箱逃逸风险但存在 UI 欺骗面（伪造提示符、WebLinksAddon 超链接欺骗）；SGR 保留维持既有彩色输出体验。

### D8 测试策略：纯逻辑下沉 + 镜像内执行

- 新增测试优先覆盖纯类/纯函数（`TerminalBridge`、`sanitizeAnsi`、slash 分发表、拦截器），mock 面最小；`useApproval`/`WebSocketClient` 心跳用 `vi.useFakeTimers`。F1 的 TerminalBridge 测试先以红测试暴露 A11（多行 Tab），修复后转绿。E2E 的 `mock-backend.mjs` 补 `has_artifact` 帧与产物场景。所有测试经 Dockerfile `test` 阶段与 `e2e/run-session-frontend-docker-tests.sh` 执行。

### D9 StrictMode 恢复

- 恢复 `<StrictMode>`；`useWebSocket` 已有完备 `dispose()` 清理，双挂载仅为开发态噪音。如噪音影响开发，允许 dev 态建连防抖/日志降噪，**不允许**再次关闭 StrictMode（并发特性 `useDeferredValue` 的基线前提）。

## Risks / Trade-offs

- [查询参数携带 API Key 扩大了 Key 出现在 URL 的面] → 仅限 artifact 单一路径；nginx `/v1` access_log 已关闭；核对 uvicorn 日志不落 query；远期以签名 URL / ticket 替代（backlog）。
- [`has_artifact`/`code` 字段前后端需协同发版] → 均为可选字段 + 前端回退逻辑，任意发版顺序均不破坏现有功能；建议后端两字段一次发版（见 tasks 后端合并项）。
- [删除 HTML 剥离依赖渲染层始终受控] → 新增反向断言测试（`Vec<T>` 原样保留）+ 既有 markdown 转义测试守护；CSP 收紧进一步压缩逃逸面。
- [StrictMode 恢复可能暴露未知副作用缺陷] → 视为收益而非风险：E2E 全量回归 + mount/unmount/mount 用例守护 WS 生命周期；发现新缺陷记录新问题项。
- [CSP `connect-src 'self'` 在老浏览器可能不匹配 ws 同源] → 目标环境为现代浏览器（Vite 6 baseline）；如出现兼容反馈可追加 `wss://$host`。
- [4429 上限从「一次」改为「两次」是规格语义变更] → 属放宽而非收紧，UI 文案同步更新；E2E mock 可验证第 3 次不再重连。

## Migration Plan

1. **后端先行**（session-service 一次发版）：`has_artifact`（帧 + TurnResponse）、`turn_error.code`、artifact GET 查询参数认证；三项均向后兼容，旧前端不受影响。
2. **前端跟进**（Phase 0 → 3 按修复计划推进）：每 Phase 结束跑镜像内质量门；Phase 0 完成即恢复产物链路。
3. **回滚**：前端各 Phase 独立可回滚（无 schema/存储迁移）；后端字段为纯增量，回滚仅导致前端走回退分支（产物标记缺失 → 不渲染预览），不产生错误。

## Open Questions

- 403「配额耗尽」与「无权访问」的判别：优先按后端 `detail` 文案判别；若不可靠，是否在本变更后端范围内为错误体补 `code` 字段（成本极小，倾向做，随 D3 的 code 机制一并落地）。
- `Retry-After` 头：后端/nginx 当前是否在 429 响应下发？前端逻辑先就位（无头则用通用文案）；若后端未下发，登记 backlog 而不阻塞本变更。
