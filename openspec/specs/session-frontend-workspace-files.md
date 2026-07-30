# Session Frontend Workspace Files Specification

**Component:** `session-frontend/`（Session Service 专用 React 前端）
**Established by change:** `session-frontend-history-switch` (2026-07-30)
**上游契约：** `session-service` 基线规格 `session-workspace-archive`（本规格是其前端消费方）

工作区文件面板：live/archive 双源列表与 stale 语义、page_token 分页与错误自愈、`?api_key=` 直链下载（跟随 presigned 302）。

---

## Requirements

### Requirement: 工作区文件面板 MUST 呈现双源列表与 stale 语义

前端 MUST 提供工作区文件面板（选中会话时经「文件」入口打开的右侧抽屉，移动端全屏覆盖），通过 `GET /v1/sessions/{sid}/workspace/files?limit=200[&page_token][&prefix]` 拉取并渲染 `path/size/mtime`（size 人性化格式）。列表 MUST 按 `source` 区分呈现：`live` 显示「实时」角标；`archive` 显示「归档快照」角标 + `last_synced_at` 相对时间，`stale=true` 时追加「可能落后最新一轮」提示；`none` 显示空态「暂无文件归档」。本期为平铺列表 + `prefix` 输入过滤，不做目录树。面板打开时 MUST 拉取一次，收到 `turn_complete` 帧 MUST 自动刷新，并提供手动刷新按钮。

#### Scenario: 归档快照与 stale 提示
- **WHEN** closed 会话的文件列表返回 `source=archive` 且 `stale=true`
- **THEN** 面板显示「归档快照」角标、`last_synced_at` 相对时间与落后提示

#### Scenario: 无归档空态
- **WHEN** 文件列表返回 `source=none`
- **THEN** 面板显示「暂无文件归档」空态，不显示错误

#### Scenario: 轮次完成自动刷新
- **WHEN** 面板处于打开状态且收到 `turn_complete` 帧
- **THEN** 文件列表自动重新拉取

### Requirement: 文件列表 MUST 支持分页与错误恢复

`next_page_token` 非空时面板 MUST 提供「加载更多」（携带 `page_token` 续拉并追加）。400（page_token 非法）MUST 重置分页重拉；404（文件已不存在）MUST 提示并刷新列表。

#### Scenario: token 续拉
- **WHEN** 首页返回 `next_page_token` 且用户点击「加载更多」
- **THEN** 携带该 token 请求下一页并追加渲染

#### Scenario: 非法 token 自愈
- **WHEN** 携带过期 `page_token` 请求返回 400
- **THEN** 面板重置分页并重新拉取第一页

### Requirement: 单文件下载 MUST 复用 api_key 直链并跟随 presigned 302

前端 MUST 提供 `workspaceFileUrl(sid, path)` 生成 `/v1/sessions/{sid}/workspace/files/{path}?api_key=` 直链（`path` 逐段 `encodeURIComponent`、保留 `/` 分隔），以 `<a download>` 直链导航触发下载，由浏览器跟随后端 presigned 302 重定向（不经 fetch，不受 CSP `connect-src 'self'` 限制）。closed 会话的归档文件 MUST 同样可下载。

#### Scenario: 归档文件下载
- **WHEN** 用户点击 closed 会话文件面板中某 archive 源文件的下载
- **THEN** 浏览器经 `?api_key=` 直链请求后端并自动跟随 302 到 presigned URL 完成下载

#### Scenario: 特殊字符路径编码
- **WHEN** 文件路径包含空格或中文（如 `output/最终 视频.mp4`）
- **THEN** 生成的直链对每段做 URL 编码且保留 `/` 分隔，下载正常
