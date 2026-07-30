# Change: add-session-workspace-archive

> 设计源：`plans/Session_Workspace_MinIO_Archive_Plan_2026-07-29.md`（rev3，用户已确认架构方向；rev1 裁决 5 个实现注意点，rev2 补 5 项一致性/边界修订，rev3 补 3 项收敛性修订）。

## Why

会话工作目录（`/workspaces/{sid}`）目前是节点本地卷孤本：跨节点/容器切换恢复后工作目录是空的，会话 close/expire 时被 `rmtree` 永久丢弃——用户切回历史会话（session-history-switch 已交付）只能看到文字轮次，看不到当时生成的文件。租户数据已有 MinIO 权威源机制（session-tenant-isolation），workspace 是最后一块不跟随用户的数据。

## What Changes

- 新增 `workspace_store`：会话工作目录增量归档到 MinIO `tenants/{tid}/workspaces/{sid}/`，文件本体（`files/`）与索引清单（`manifest.json`，含 tenant_id / session_id / files_prefix / 文件明细（含 `last_seen_sync_seq` 版本关联）/ sync 元数据 / `sync_state:"complete"` / `deleted[]` tombstone）分开存放；回合前置 `sync.inprogress.json` 标记使中断回合的残留对象显式可回收，读侧只信 complete 清单；文件数大规模后 manifest 可演进为 index/pages 拆分（`schema_version` 标识，当前保持单 manifest）。
- stage-out 搭现有四钩子：turn 完成钩子为 **per-session 单 worker + debounce**（turn 持久化 + WS 帧发出后置 dirty，多次触发合并成一次最新同步，不阻塞响应；teardown/close await 最终轮），驱逐/close/orphan 钩子 await；删除传播带 tombstone + 回合开始 rebase 远端 manifest，tombstone 判定**版本优先**（节点 sidecar `base_sync_seq` vs `deleted_seq`，mtime 仅无基线时 fallback，防时钟异常复活已删文件）；close/destroy 四步定序（closing 拒新 dirty → await worker → final stage-out 写最大 `sync_seq` → rmtree）杜绝旧清单覆盖新清单；全部 best-effort，绝不阻断会话生命周期。
- 锁粒度为 per-session（不复用 tenant_lock）：`workspaces/{sid}/` 前缀互不相交，大 workspace 上传不阻塞同租户其他会话。
- rehydrate/跨节点恢复时在后端 spawn **前** stage-in：基于 manifest 做文件状态比对（一致跳过；不一致按 mtime LWW 裁决并记录冲突；不以"本地存在"为准），best-effort。
- close/DELETE 语义调整：final stage-out → rmtree 本地，**MinIO 归档保留**——closed/expired 会话文件仍可只读查看。
- 新增只读文件 API：`GET /v1/sessions/{sid}/workspace/files`（live/archive 双源 + `stale`/`last_synced_at` 标注；预留 `limit`/`page_token`/`prefix` 分页与过滤）与 `GET /v1/sessions/{sid}/workspace/files/{path}`（下载，presigned 302 或流式）。
- 排除规则与限额（ignore patterns / 单文件 / 会话总量），超限文件记入 manifest `skipped` 并可解释；新增保留期清理脚本 `scripts/purge_workspace_archives.py`。
- 修订已归档变更 `session-container-pool-multitenancy` 的设计叙述 D2.10（"workspace 不进 MinIO 同步"）：该叙述从未落成主规格条款，其原始顾虑（大文件拖垮会话创建）由增量同步 + 限额 + 异步 best-effort 化解。

## Capabilities

### New Capabilities

- `session-workspace-archive`: 会话工作目录的 MinIO 归档能力——对象布局与 manifest 索引契约（含 sync 元数据/完成状态/tombstone/`last_seen_sync_seq`）、四钩子增量 stage-out（turn 钩子单 worker + debounce、per-session 锁、删除版本优先判定、close 四步定序）、spawn 前 stage-in 状态比对 + LWW + sidecar 基线、只读文件 API（live/archive 双源、closed 可读、路径逃逸校验、stale 标注、分页预留）、排除规则/限额、保留期清理脚本。

### Modified Capabilities

- `interactive-session`: DELETE 清理要求追加——移除本地 workspace **前**必须完成 final workspace stage-out，且 MinIO 侧 `workspaces/{sid}/` 归档**保留**（closed 会话文件仍可经文件 API 读取）。
- `session-tenant-isolation`: 租户前缀权威布局清单 `openharness/` + `rules/` 追加 `workspaces/`（沿 `videos/` 扩展先例）；"租户注销 = 单前缀删除" Scenario 自动覆盖归档，语义不变。

## Impact

- **代码**（全部 `session-service/`，源码 volume 挂载生效，无 DB migration、无镜像重建）：
  - 新增 `app/session/workspace_store.py`、`scripts/purge_workspace_archives.py`；
  - 修改 `app/session/supervisor.py`（四钩子接线、destroy 顺序、spawn 前 stage-in）、`app/routers/sessions.py`（两个文件端点）、`app/schemas.py`、`app/config.py`（6 个新 settings，含 debounce / tombstone 保留期）、`app/observability/metrics.py`（`oh_workspace_sync_failures_total`）、`API_DOCUMENTATION.md`。
- **依赖**：无新增（minio SDK、boto3 均为既有依赖）。
- **存储**：复用 bucket `oh-tenants` 与既有 MinIO 凭据配置；`OH_MINIO_ENDPOINT` 未配置时全部功能退化 no-op，现有部署与测试零感知。
- **不受影响**：turn artifact 归档通道（`turn_artifacts` + S3ArtifactStorage）、session-history-switch 的 list/turns/WS 契约、`service/` 的渲染 workspace（短命中间产物，维持本地）。
