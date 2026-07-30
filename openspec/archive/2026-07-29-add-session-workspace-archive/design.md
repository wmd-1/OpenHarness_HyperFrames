# Design: add-session-workspace-archive

## Context

- workspace 现状：`{workspace_root}/{sid}`（`/workspaces`，named volume）节点孤本；close/DELETE `rmtree`；orphan_scan 回收；跨节点 resume 后目录为空（`cwd.mkdir` 兜底）。
- 已有可复用机制：`tenant_store.py`（MinIO 权威源 + 暂存、`asyncio.to_thread` 驱动 minio SDK、`enabled()` 开关、退避重试 + metrics）、四个 stage-out 钩子调用点、`_load_owned` 租户鉴权、`validate_tenant_id` / `safe_tenant_path` 路径安全原语。
- 约束：无 DB migration；不重建镜像（源码 volume 挂载）；`OH_MINIO_ENDPOINT` 未配置时必须整体退化 no-op；turn artifact 通道（`turn_artifacts` + S3ArtifactStorage）不动。
- 完整设计源与代码核实事实见 `plans/Session_Workspace_MinIO_Archive_Plan_2026-07-29.md`（rev3，用户三轮复核：rev1 裁决 5 个实现注意点，rev2 补 5 项一致性/边界修订，rev3 补 3 项收敛性修订）。

## Goals / Non-Goals

**Goals:**
- workspace 文件持久化到 `tenants/{tid}/workspaces/{sid}/`，manifest 作文件索引（用户 ID、session ID、文件存放前缀、明细、sync 元数据），文件本体单独存放于 `files/`。
- 容器切换/跨节点恢复自动拉回；closed/expired 会话文件只读可见（列表 + 下载 API）。
- 同步 best-effort，绝不阻断 turn 完成、WS 响应与会话生命周期。

**Non-Goals:**
- 不做双向合并/冲突解决（写方向恒为本地 → MinIO；stage-in 只补本地缺失）。
- 不迁移存量已 close 会话（workspace 已删，无从归档）。
- 不做前端文件浏览 UI；不改 turn artifact 通道；不做归档自动 TTL（先运维脚本）。

## Decisions

### D1 对象布局：`tenants/{tid}/workspaces/{sid}/{manifest.json, files/**}`

- 放 `tenants/{tid}/` 之下而非独立 bucket：租户注销"单前缀删除"（session-tenant-isolation）零改动全覆盖；MinIO 凭据/bucket 配置零新增。备选"独立 bucket"被否：多一套凭据与注销路径。
- "表"的实现 = 每会话一个 `manifest.json`（MinIO 无表语义）；"整表查询"= 按 `workspaces/` 前缀枚举。会话归属/列表的权威仍是 Postgres `conversations`（无新列——前缀由 `tenant_id + sid` 确定性派生）。
- key 单点生成 `workspace_remote_prefix(tenant_id, sid)`，tenant_id 走 `validate_tenant_id`，相对路径经逃逸校验。

### D2 manifest 先文件后清单 + sync 元数据/完成状态 + tombstone（rev1 裁决④，rev2 修订②③，rev3 修订①②）

- 写序恒为：先传 `files/`、后整体重写 `manifest.json` → 读侧只信 manifest，永不见悬空引用；多余对象只是垃圾（下轮删除传播/保留期脚本回收）。
- **rev2 同步完成状态**：回合开始 PUT `sync.inprogress.json`（尝试的 `sync_seq`/`started_at`/`node_id`），清单写成后删除；manifest 本体不写中间态，只在回合成功末尾以 `sync_state:"complete"` 落盘，读侧只信 complete 清单。备选"manifest 写入 syncing 中间态"被否：会让归档在每次同步进行中/中断后不可读，丢失"读侧永远可读上一份完整快照"性质；标记对象是等价且无此副作用，中断回合（残留标记 + 未入清单对象）显式可辨、可回收。
- **rev2 删除版本语义 + rev3 版本优先判定**：删除传播写入 `deleted[]` tombstone（`{path, deleted_seq, deleted_at}`）；回合开始 GET 远端 manifest，`sync_seq` 前进则 **rebase** 基线重新差分。判定不依赖时钟：`files[]` 每项携带 `last_seen_sync_seq`，节点在 stage-in / 每次成功 stage-out 后把感知的清单序号写入本地 sidecar `.oh_sync_state.json`（硬排除，永不归档）；本地存在 tombstone 路径文件时：`base_sync_seq ≥ deleted_seq` → 真重建，重传并移除 tombstone；`base_sync_seq < deleted_seq` → 陈旧残本不重传；sidecar 缺失 → fallback 到 mtime vs `deleted_at` 并记 warning。备选"纯 mtime 判定"被 rev3 收紧：跨节点时钟异常可导致旧文件复活。tombstone 按 `OH_WORKSPACE_TOMBSTONE_RETENTION_DAYS`（默认 7）过期修剪。
- **rev3 演进预留（文档级，当前不实现）**：单 manifest 整存 `files` 数组当前可接受；文件数大规模（条目 > 1 万或体积 > 数 MB）后可拆为索引头 + `manifest.pages/{n}.json` 分页对象，`schema_version` 递增标识；API 分页契约（D7）已隔离客户端，届时只改存储实现。
- `sync_seq`（每次成功 stage-out 单调 +1）、`last_synced_at`、`node_id` 入 manifest：孤儿对象排查、多节点问题定位、保留期脚本判据。
- `files[].size/mtime/etag` 同时是增量比对基线，一份数据两用。

### D3 锁：per-session `asyncio.Lock`，不复用 tenant_lock（rev1 裁决①）

- `workspaces/{sid}/` 与 `openharness/`、`rules/` 及其他会话前缀天然不相交，唯一需要串行的是同一 sid 的 stage-in/stage-out（resume 与上一次 final stage-out 的交接窗口、异步 turn sync 与驱逐 sync 的重叠）——per-sid 锁恰好覆盖。
- 备选"复用 tenant_lock"被否：大 workspace 上传会阻塞同租户其他会话（`tenant_max_concurrent>1` 部署）与租户数据同步，且无对应的正确性收益。

### D4 turn 钩子：per-session 单 worker + debounce，其余钩子 await（rev1 裁决②，rev2 固化，rev3 定序 close 竞态）

- turn 行持久化 + `turn_completed` WS 帧发出之后仅置 dirty 并确保该 sid 的 sync worker 存在：同一 session 任意时刻至多一个 worker；worker 循环取走 dirty → debounce（`OH_WORKSPACE_SYNC_DEBOUNCE_MS`，默认 500，高频 turn 多次 dirty 合并成一次最新同步）→ per-sid 锁内跑一轮 → dirty 仍在再来一轮，清空退出；不堆积任务。worker 挂 LiveSession。
- **rev3 close/destroy 竞态四步定序**：①置 closing 标志，拒绝新 dirty；②await 既有 worker 退出（见 closing 跑完当前轮即退）；③per-sid 锁内 final stage-out（无并发回合，rebase 后写入必为最大 `sync_seq`，杜绝旧清单覆盖新清单）；④rmtree。
- 驱逐/close/orphan 钩子 await：非用户交互关键路径；close 必须在 rmtree 前完成 final stage-out（否则丢档）。
- 备选"turn 钩子也 await"被否：大文件上传会直接拖长 WS turn 响应；备选"裸 create_task + dirty"被 rev2 收紧：高频 turn 下可能任务累积，单 worker + debounce 把并发上限与合并行为显式化。

### D5 stage-in：manifest 状态比对 + mtime LWW，spawn 前完成（rev1 裁决③，rev2 修订①）

- 弃用"目录为空"判定；**rev2 同时弃用"本地存在即跳过"差集规则**（初始化文件同名时会盖不回历史归档）。规则：逐条对照 complete manifest——本地缺失 → 下载；本地存在且 size+mtime（etag 可校时并校）一致 → 跳过；不一致 → mtime LWW：本地新于清单项 → 保留本地（未归档的新改动），否则清单胜出覆盖；冲突必记 warning（path + 裁决）。**tombstone 判定先行于 LWW 且用推进前的旧基线**（rev3 确认）：tombstone 路径不下载、不进入 LWW；本地残本按 D2 版本判定——旧基线残本**本地删除**（删除传播到本地）、真重建保留；否则残本可借未来 mtime 在 LWW 胜出，再随 stage-in 末尾基线推进（≥ `deleted_seq`）被下轮 stage-out 误判为真重建而复活；下载后 `os.utime` 对齐清单 mtime（后续增量比对与重复 stage-in 幂等）；stage-in 成功后把清单 `sync_seq` 写入本地 sidecar `.oh_sync_state.json` 作本节点 `base_sync_seq`（rev3，D2 tombstone 版本判定的基线）。
- 时序：`cwd.mkdir` 之后、后端进程/容器 spawn 之前完成（与租户 stage-in 同位），确保 OpenHarness 开始写工作文件前归档文件已就位。
- 失败语义 best-effort（区别于租户 stage-in 的 503 fail-fast）：对话上下文在 OpenHarness 快照里，与 workspace 文件独立，宁可文件暂缺也不阻断 resume。

### D6 大文件顾虑（修订 D2.10）：增量 + 限额 + skipped 可解释

- 增量（size+mtime 对 manifest 基线）+ 排除规则（`node_modules/` 等，可配）+ 单文件/会话总量限额；超限/被排除文件落 manifest `skipped[{path, reason}]`——"看不到某文件"必须可解释，不静默丢。成品视频另有 artifact 通道兜底。

### D7 文件 API：live/archive 双源 + stale 标注 + 分页预留（rev1 裁决⑤，rev2 修订⑤）

- LIVE/IDLE 且本节点 → 实时读本地目录（`source:"live"`）；其余 → 读 manifest（`source:"archive"`，含 `last_synced_at`/`sync_seq`）。会话 LIVE/IDLE 但走了 archive 源（典型：跨节点 LIVE，不做反代特例）→ `stale=true`，明示是最近一次归档快照（至多落后一个 turn）。
- **rev2 分页/过滤预留**：`limit`（默认 500）/`page_token`（不透明游标）/`prefix` 请求参数 + `next_page_token` 响应字段；manifest 仍整体保存 files 数组，分页在 API 层切片，live/archive 两源同契约——文件数增长后接口不劣化。
- 下载：live 流式；archive 优先 presigned 302（`OH_S3_PUBLIC_ENDPOINT` 已配置），否则网关流式代理——对齐 service 计划 Q2 裁决。
- 无归档且本地无目录 → `source:"none"` + 空列表（不 404，会话本身存在）。

### D8 close 保留归档 + 保留期脚本

- destroy 顺序：final stage-out → rmtree 本地 → MinIO 归档保留（历史文件可见的来源）。归档最终清理仅两条路：租户注销（前缀整删）或 `purge_workspace_archives.py --older-than-days N`（按 `last_synced_at`，默认不自动运行）。

## Risks / Trade-offs

- [每 turn 归档写放大] → 增量比对 + 单 worker debounce 合并 + 限额封顶；观测 `oh_workspace_sync_failures_total` 与耗时日志。
- [异步 sync 与节点崩溃竞态：最后一 turn 文件未归档] → 丢失窗口 SLO 与租户数据一致（≤1 turn）；驱逐/close 钩子 await 兜底。
- [manifest 与 files/ 半程不一致] → D2 写序 + `sync_state:"complete"` 只读终态；`sync.inprogress.json` 使中断回合显式可辨，残留由删除传播/保留期脚本回收。
- [多节点下旧节点复活已删文件] → D2 tombstone + 回合开始 rebase；rev3 版本优先判定（sidecar `base_sync_seq` vs `deleted_seq`），mtime 仅无基线时 fallback——跨节点时钟异常不影响判定。
- [close 时后台 worker 与 final stage-out 竞态（旧清单覆盖新）] → D4 四步定序：closing 拒新 dirty → await worker → 锁内 final stage-out（最大 `sync_seq`）→ rmtree。
- [MinIO 容量增长] → 总量限额 + 保留期脚本 + manifest total_bytes 可观测；租户级配额另立计划。
- [文件 API 越权/路径穿越] → `_load_owned` + 相对路径校验单点收敛 + 恶意 path 测试。
- [presigned 地址容器内不可达] → `OH_S3_PUBLIC_ENDPOINT` 部署期配置，未配走流式兜底（既有结论复用）。

## Migration Plan

1. 代码经 volume 挂载生效，无镜像重建、无 DB migration；`OH_MINIO_ENDPOINT` 未配置的部署零感知。
2. 存量 LIVE/IDLE/COLD 会话：下一次 stage-out 钩子自动完成首轮全量归档，无迁移脚本。
3. 存量 CLOSED/EXPIRED：无从归档，文件 API 返回 `source:"none"`；API 文档标注"归档自本功能上线起生效"。
4. 回滚：去掉钩子接线即可；已写入的归档对象无害，可由保留期脚本清理。

## Open Questions

- Q2（限额默认值 512MB/2GB）：按现网实测调 `.env`，代码取建议默认。
- Q3（归档 TTL 自动化）：先脚本手动/cron，容量有压力再自动化。
