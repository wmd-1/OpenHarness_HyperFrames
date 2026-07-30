# Tasks: session-frontend-history-switch

> 对应计划 §7 五阶段（P1-P5）；每组末尾的测试任务遵循 test-on-existing-images 规则（镜像内执行）。P4（第 4 组）与第 2/3 组无耦合可并行。

## 1. P1 契约层 + 会话列表服务端权威化

- [x] 1.1 `types/api.ts` 新增 `SessionSummary/SessionListResponse/TurnListResponse/WorkspaceFileEntry/WorkspaceFileListResponse`；`types/ws.ts` 增 `ErrorFrame.code?` 与 `WsStatus.quota_exceeded`（F6）
- [x] 1.2 `utils/constants.ts`：`WS_CLOSE_CODES` 增 `QUOTA_EXCEEDED:4430`/`CAPACITY_FULL:4503`，新增 `WS_ADMISSION_MESSAGES`、`CAPACITY_RETRY_DELAY_MS=15000`、`CAPACITY_MAX_RETRIES=4`、`UNAVAILABLE_MAX_RETRIES=2`；`STORAGE_KEYS` 去 `sessionIds` 增 `currentSessionId`
- [x] 1.3 `types/session.ts`：`Session` 增可选 `title/resumable/read_only`、detail 独有字段转可选；新增语义谓词 `canConnectSession`/`isReadonlySession`/`canResumeSession`（含字段缺失回退与 rev2 语义边界注释），`isSessionTerminal` 保持原实现不新增调用点（F1.5）
- [x] 1.4 `api/sessions.ts` 新增 `listSessions(params)`；`api/client.ts` 扩展 `extractRetryAfter`
- [x] 1.5 `store/sessionStore.ts`：summary∪detail patch 合并、分页状态（total/offset/hasMore）、`removeSession` 收窄为 4404 专用、currentId 持久化、删除 localStorage ID 缓存函数（F1.1/F1.2/F1.7）
- [x] 1.6 新增 `hooks/useSessionList.ts`：拉取/分页/五触发刷新编排（认证/创建/关闭/session_ready/focus 节流），404/405 降级空列表 + 「后端版本过旧」banner（F1.3）
- [x] 1.7 `App.tsx` 用 `useSessionList` 替换 `restoreSessions`，启动清除 `sf.sessionIds` 并恢复 `sf.currentSessionId` 选中
- [x] 1.8 `Sidebar.tsx` 加载更多/手动刷新；`SessionCard.tsx` title 主行 + 三态（可恢复/只读/置灰）；`StatusBadge.tsx` 「只读」「不可恢复」变体（F1.5/F1.6）
- [x] 1.9 `hooks/useCloseSession.ts` 关闭成功改 patch 只读态（不 removeSession）；`ConfirmDialog` 文案更新（F1.8）
- [x] 1.10 单测：谓词真值表（新增 `types/__tests__/session.test.ts`，断言 `isSessionTerminal` 行为不变）、store merge 不丢字段/分页保序/关闭保留只读/currentId 持久化、`extractRetryAfter`；镜像内 `--target test` 跑绿

## 2. P2 轮次历史回显（hydration）

- [x] 2.1 `api/sessions.ts` 新增 `listTurns(sid, params)`；`store/conversationStore.ts` 新增 `hydrateHistory(sid, turns)`（整体替换 + interrupted/error/has_artifact 映射）与 `hydratedAt` 标记（F2.1/F2.3）
- [x] 2.2 新增 `hooks/useTurnHistory.ts`：触发判定（本地空 + turn_count>0 + 未 hydrate）、一页拉全 + while 兜底、输出 `hydrated/loading/error/retry`（F2.2）
- [x] 2.3 `SessionWorkspace.tsx` 实现三步串行强门控：hydrate 完成 → `setLastTurnIndex` → 才传 sessionId 给 `useWebSocket`（禁止并行，F2.4）；`useWebSocket` 建连门控改用 `canConnectSession`
- [x] 2.4 `ChatView.tsx` hydrating 骨架条 + 失败重试条（F2.5）；只读会话 hydration 后不建连、`LifecycleNotice` 区分已关闭/已过期、输入栏禁用（F2.6）
- [x] 2.5 单测：`useTurnHistory`（跳过/拉全/续拉/重试/lastTurnIndex 写入）、hydrate 映射、三步顺序显式断言、hydrate 后同 index 补发不重复；closed 四不变量回归（不移除/不清历史/不建连/直链可生成）；镜像内跑绿

## 3. P3 WS 准入细化 + 创建错误映射

- [x] 3.1 `WebSocketClient.ts`：4430 不重连置 `quota_exceeded`、4503 有界 15s×4、4500 有界 2 次，default 网络退避回归不变（F3.2）
- [x] 3.2 `useWebSocket.ts`：error 帧按 `code` 查 `WS_ADMISSION_MESSAGES` 落 system 消息，error 帧与 close 码一次性标志去重；`session_ready` 触发列表刷新（让位可视化，F3.3/F3.5）
- [x] 3.3 `SessionWorkspace.tsx` 唤醒等待态：以 `canResumeSession` 为门槛、status 仅选文案、30s 追加排队提示、`session_ready` 清除并 patch status→live（F3.4）
- [x] 3.4 `useConversation` REST 兜底 409 明确提示「会话未激活」（F3.6）
- [x] 3.5 `CreateDialog.tsx` 四类错误映射（429 双语义/403 每日配额/503+Retry-After 倒计时重试按钮，F4）
- [x] 3.6 单测：关闭码三策略 + default 回归、error 帧 code 映射与去重、`resumable=false` 不建连、CreateDialog 四类文案与倒计时；镜像内跑绿

## 4. P4 工作区文件面板（可与第 2/3 组并行）

- [x] 4.1 `api/sessions.ts` 新增 `listWorkspaceFiles(sid, params)` 与 `workspaceFileUrl(sid, path)`（path 逐段 encode，F5.4）
- [x] 4.2 新增 `hooks/useWorkspaceFiles.ts`：拉取/page_token 续拉/prefix 过滤/400 重置/404 提示刷新（F5.2/F5.6）
- [x] 4.3 新增 `components/Session/WorkspaceFilesPanel.tsx`：抽屉布局（移动端全屏）、双源角标 + stale 提示 + none 空态、`<a download>` 直链下载、`turn_complete` 自动刷新 + 手动刷新（F5.1/F5.3/F5.5）；`SessionDetail.tsx` 增「文件」入口
- [x] 4.4 单测：useWorkspaceFiles 分页/过滤/错误恢复、面板双源角标与空态渲染、workspaceFileUrl 编码；镜像内跑绿

## 5. P5 E2E 与全链路验收

- [x] 5.1 `e2e/mock-backend.mjs` 补 `GET /v1/sessions`、`GET /{sid}/turns`、workspace files 两端点（结构从 `API_DOCUMENTATION.md` 示例复制）、WS 4430/4503 场景开关
- [x] 5.2 Playwright 用例：切换主流程（历史回显 + 补发去重顺序断言 + 侧栏让位刷新）、只读回看与关闭保留四不变量、4430 无自动重连、不可恢复置灰、文件面板（archive+stale+`?api_key=` 直链）
- [x] 5.3 全链路镜像流水线跑绿：`bash e2e/run-session-frontend-docker-tests.sh`（单测/lint → 冒烟 → E2E），既有 83 个 vitest 用例回归全绿
- [x] 5.4 文档收尾：`session-frontend/CODE_REVIEW_REPORT.md` 增补本次改动说明、README 增列表/历史/文件面板能力描述
