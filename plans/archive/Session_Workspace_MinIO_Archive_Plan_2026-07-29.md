# Session Workspace 入 MinIO：工作目录归档 + 索引清单 —— 实现计划

> **立项记录（2026-07-29）** —— 本文件为 `session-service/` 会话工作目录（workspace）持久化到 MinIO 的统一设计源。
>
> - 用户需求原文：workspace 目前写死在代码里（节点本地卷），要求**同时写到 MinIO**；在 MinIO 里建"表"，注明**用户 ID、session ID、工作目录文件存放地址**；工作目录文件**单独存放**——这样**容器切换**和**历史记录切换**后仍能看到历史文件。
> - 与姊妹计划《Container_Pool_Multi-Tenancy_Plan_2026-07-29.md》（bucket `oh-tenants`、`tenants/{tid}/` 前缀、`tenant_store` 暂存机制）、《Session_History_Switch_Plan_2026-07-29.md》（历史会话列表/切换）直接衔接。
> - **本计划显式修订姊妹计划的 D2.10**（"workspace 不进 MinIO 同步"）：当时的顾虑是大文件拖垮会话创建；本计划用**增量同步 + 排除规则 + best-effort 语义**化解，正式把 workspace 纳入 MinIO。
> - **rev1（2026-07-29，用户已确认整体架构并裁决 5 个实现注意点）**：①锁改为 per-session（不复用 tenant_lock，避免大 workspace 阻塞同租户其他会话，W3.1）；②turn 钩子异步化（turn 持久化 + WS 帧发出后后台 sync，W3.1）；③stage-in 弃用"目录为空"判定，改为 manifest 差集补齐且必须在后端 spawn 前完成（W3.5）；④manifest 补 `sync_seq`/`last_synced_at`/`node_id`（W2）；⑤文件 API archive 源补 `stale`/`last_synced_at`（W4）。并补三条测试（§6）。Q1 已裁决：每 turn 异步归档。
> - **rev2（2026-07-29，用户复核后补 5 项一致性/边界修订）**：①stage-in 由"本地存在即跳过"改为**基于 manifest 的文件状态比对**（size/mtime/etag 一致才跳过；不一致按 mtime LWW 裁决并记录冲突，W3.5）；②manifest 增加 `sync_state:"complete"`（读侧只信 complete 清单）+ 回合前置 `sync.inprogress.json` 标记，半程中断产生的对象成为**显式可回收垃圾**（W2.1）；③删除传播加 **tombstone**（`deleted[]` + `deleted_seq`）与回合开始 rebase 远端 manifest，防多节点下旧节点复活已删文件（W3.2）；④turn 后台同步固化为 **per-session 单 worker + debounce 合并**，teardown/close await 最终轮（W3.1）；⑤文件清单 API 预留 `limit`/`page_token`/`prefix` 分页与过滤（W4）。
> - **rev3（2026-07-29，用户三审后补 3 项收敛性修订）**：①tombstone 判定改为**版本优先**——manifest `files[]` 增加 `last_seen_sync_seq`，节点在本地 sidecar（`.oh_sync_state.json`，硬排除不入归档）记录最后感知的 `base_sync_seq`，删除恢复优先比较 sync_seq，mtime 仅作无基线信息时的 fallback（防跨节点时钟异常复活旧文件，W3.2）；②文档补充 manifest 演进方向——文件数大规模后可拆 index/pages，当前单 manifest 保持简单（W2.4）；③close/destroy 与后台 sync worker 的竞态显式四步定序：置 closing 拒新 dirty → await worker 退出 → per-sid 锁内 final stage-out（写入最大 `sync_seq`）→ rmtree（W3.1/W3.6）。
> - 全文区分 **已验证事实（VERIFIED）** 与 **设计决策（DECISION）**。

---

## 0. 代码核实结论（VERIFIED）

| # | 事实 | 证据位置 |
| - | ---- | -------- |
| 0.1 | workspace 路径硬编码派生：`{settings.workspace_root}/{session_uuid}`（默认 `/workspaces`，compose 卷 `openharness-workspaces`），只存在于节点本地卷 | `app/config.py:workspace_root`、`supervisor.py:create_session`（`cwd = Path(settings.workspace_root) / str(sid)`） |
| 0.2 | `conversations.workspace_path` 列已存在（String 512, nullable），close 时被置 `None` | `app/models.py:Conversation` |
| 0.3 | **close/DELETE 直接 `rmtree` workspace**，且 `orphan_scan()` 清理 CLOSED/无主 workspace —— 历史文件不可再见 | `supervisor.py:destroy_session`（`shutil.rmtree(live.cwd)`）、`orphan_scan` |
| 0.4 | 租户数据（`openharness/`、`rules/`）已有成熟的 MinIO 权威源 + 本地暂存机制：`tenant_store.stage_in/stage_out`，per-tenant `asyncio.Lock` 串行、minio SDK 走 `asyncio.to_thread`、stage-out 指数退避 + `oh_tenant_sync_failures_total` | `app/session/tenant_store.py` |
| 0.5 | stage-out 四钩子已就位：①turn 完成、②IDLE→COLD 驱逐（`_evict`）、③close/DELETE、④orphan 回收 —— workspace 同步可完全搭同一批钩子 | `supervisor.py:531,670,991,1049` |
| 0.6 | 姊妹计划 D2.10 明确把 workspace 排除在 MinIO 同步外（理由：视频可达百 MB 级） | `plans/Container_Pool_Multi-Tenancy_Plan_2026-07-29.md` §3.1 D2.10 |
| 0.7 | turn 产物（视频等）已有独立归档通道：`turn_artifacts` 表 + `S3ArtifactStorage`（key = `{session_id}/{turn_index}/{filename}`，bucket 由 `OH_S3_BUCKET` 配置）——与 workspace 归档互不重叠 | `app/models.py:TurnArtifact`、`app/storage/s3.py` |
| 0.8 | 跨节点/容器切换现状：租户数据经 MinIO stage-in 恢复，OpenHarness 快照经 `--resume` 恢复，**但 workspace 文件不跟随**——换节点 resume 后工作目录是空的（`cwd.mkdir` 兜底） | `supervisor.py:create_session_from_existing` |
| 0.9 | 历史会话切换计划（已交付）提供 `GET /v1/sessions`、`GET /v1/sessions/{sid}/turns`，closed/expired 会话只读可查 turns，但**无任何查看工作目录文件的接口** | `plans/Session_History_Switch_Plan_2026-07-29.md` §4 |
| 0.10 | `tenant_max_concurrent` 默认 1 + per-tenant lock：同租户 stage-in/stage-out 天然串行，无并发写清单的合并问题 | `app/config.py:106`、`tenant_store.tenant_lock` |
| 0.11 | MinIO 配置已就绪：`OH_MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET(oh-tenants)/SECURE`；endpoint 未配置 = 单机模式，所有同步退化为 no-op | `app/config.py:110-122` |
| 0.12 | **openspec 主规格没有禁止 workspace 入 MinIO**："workspace/产物不进同步流程"（D2.10）只出现在已归档变更的 proposal/design 叙述里，未落成任何主规格 Requirement | `openspec/archive/2026-07-29-session-container-pool-multitenancy/{proposal,design}.md`，全量 grep `openspec/specs/` 无对应条款 |
| 0.13 | `interactive-session` 规格：DELETE "MUST … remove the workspace"，且 bucket 侧清理清单仅限 `data/memory/{ohsid}*`、`data/sessions/{ohsid}*` 前缀——保留 `workspaces/` 归档不违反字面清理清单，但需 spec delta 明确 | `openspec/specs/interactive-session.md`（DELETE Requirement） |
| 0.14 | `session-tenant-isolation` 规格把租户前缀布局定为 `openharness/` + `rules/`（service 侧已有 `videos/` 扩展先例）；"租户注销 = 单前缀删除" Scenario 天然覆盖新增子前缀 | `openspec/specs/session-tenant-isolation.md` Requirement 1、`video-tenant-storage.md` |
| 0.15 | `oh_session_id = {cwd.name}-{sha1(cwd)[:12]}` 由 cwd 派生且 `/workspaces/{sid}` 在各节点/两种 runtime 下同路径 → workspace 归档拉回后跨节点 resume 哈希一致 | `openspec/specs/interactive-session.md`（cwd 派生 Requirement）、`process.py:derive_oh_session_id` |

---

## 1. 问题陈述（Problem Statement）

1. **工作目录是节点孤本**：workspace 只在本地卷（事实 0.1），跨节点恢复、节点重建、卷丢失即全丢（事实 0.8）。
2. **历史文件不可回看**：会话 close/expire 后 workspace 被 rmtree（事实 0.3），用户切回历史会话（History Switch 已交付）只能看到文字轮次，看不到当时生成/编辑的文件。
3. **无文件索引**：没有任何地方记录"某用户某会话的工作目录文件都有什么、存在哪"——`workspace_path` 只是个本地路径字符串，close 后还被置空（事实 0.2）。

---

## 2. 目标与非目标

### 目标

1. workspace 文件持久化到 MinIO，按 `用户(租户) → 会话 → 文件` 前缀分层**单独存放**（与索引清单分开）。
2. MinIO 内建立索引（用户需求的"表"）：每会话一份 `manifest.json` 清单对象，记载 **tenant_id（用户 ID）、session_id、文件存放前缀、文件明细**；按租户前缀可枚举全部会话清单。
3. 容器切换 / 跨节点恢复：resume 时若本地 workspace 缺失，自动从 MinIO 拉回（stage-in）。
4. 历史记录切换：新增只读 API，对任意归属本租户的会话（含 COLD/CLOSED/EXPIRED）列出并下载其工作目录文件。
5. 大文件不拖垮会话生命周期：增量同步 + 排除规则 + best-effort，沿用租户数据同步的既有 SLO（丢失窗口 ≤ 一个进行中 turn）。

### 非目标

- 不做 workspace 的双向合并/冲突解决：MinIO 侧只是**归档镜像**，写入方向永远是"本地 → MinIO"（stage-in 仅发生在本地缺失时的整体拉回）。
- 不迁移存量已 close 的会话（workspace 已被 rmtree，无从归档）。
- 不做前端文件浏览器 UI（本计划只保证 API 契约）；前端另立计划。
- 不改 turn 产物（artifact）通道——`turn_artifacts` 归档链路维持现状（事实 0.7），本计划不与其合并。
- MinIO 未配置（`OH_MINIO_ENDPOINT` 空）时全部功能优雅退化：同步 no-op，文件 API 仅对本地 workspace 尚存的会话可用。

---

## 3. 目标架构（DECISION）

### 3.1 对象布局：文件与索引分开存放（DECISION W1）

复用既有 bucket `oh-tenants` 与租户根前缀（租户注销一把删干净，对齐 D2.9）：

```
tenants/{tenant_id}/                          ← 用户 ID（=tenant_id，来源于 api_keys 认证）
├── openharness/…                             # 既有：租户数据（tenant_store 管辖，不动）
├── rules/…                                   # 既有：租户规则（不动）
├── videos/…                                  # 既有：service/ 视频产物（不动）
└── workspaces/                               # ★ 本计划新增
    └── {session_id}/
        ├── manifest.json                     # ★ 索引"表"的一行：本会话工作目录清单
        └── files/                            # ★ 工作目录文件本体，与清单分开存放
            ├── report.md
            ├── output/final.mp4
            └── …（保持 workspace 内相对路径）
```

- **W1.1 "表"的实现形式**：MinIO 是对象存储，没有表；用户需求的"表"落地为**每会话一个 `manifest.json` 清单对象**（= 表的一行），字段含用户 ID、session ID、文件存放地址（见 §3.2）。"整表查询"= `list_objects(prefix="tenants/{tid}/workspaces/", delimiter)` 枚举会话目录后逐个读 manifest（一个用户的会话数有限，且列表 API 主数据仍走 Postgres，manifest 只做文件级索引——见 W1.4）。
- **W1.2 key 单点生成**：新增 `workspace_remote_prefix(tenant_id, sid) -> "tenants/{tid}/workspaces/{sid}/"`，`tenant_id` 复用 `tenant_store.validate_tenant_id` 白名单校验，`sid` 为服务端 uuid —— 无路径注入面。文件对象 key = 前缀 + `files/` + workspace 内相对路径（相对路径经与 `safe_tenant_path` 同款的逃逸校验）。
- **W1.3 为什么放 `tenants/{tid}/` 之下而不另建 bucket**：与租户数据/视频共享同一租户根前缀，`purge_tenant` 类脚本与 D2.9 注销语义零改动全覆盖；且 MinIO 凭据/bucket 配置零新增。
- **W1.4 Postgres 与 MinIO 索引的分工**：`conversations` 表仍是"哪些会话属于谁"的权威（列表/鉴权走 DB，History Switch 已交付）；MinIO manifest 是"该会话工作目录里有什么文件、存在哪"的权威。**不新增 DB 列、无 migration**——前缀由 `tenant_id + sid` 确定性派生，无需存储。

### 3.2 manifest.json 结构（DECISION W2）

```json
{
  "schema_version": 1,
  "tenant_id": "acme",                        // 用户 ID
  "session_id": "6f9d…",                      // 会话 ID
  "oh_session_id": "6f9d…-a1b2c3d4e5f6",
  "files_prefix": "tenants/acme/workspaces/6f9d…/files/",   // 文件存放地址（bucket 内前缀）
  "bucket": "oh-tenants",
  "sync_seq": 42,                             // rev1：单调递增同步序号（每次成功 stage-out +1）
  "last_synced_at": "2026-07-29T12:00:00Z",   // rev1：最近一次成功同步时刻
  "node_id": "node-a1",                       // rev1：执行同步的节点（排查孤儿对象/多节点问题）
  "sync_state": "complete",                   // rev2：恒为终态——manifest 只在回合成功末尾落盘，读侧只信 complete
  "session_status": "cold",                   // 生成时刻的会话状态（仅供观测）
  "total_files": 12,
  "total_bytes": 10485760,
  "files": [                                  // rev3：last_seen_sync_seq = 该文件最近一次上传/确认在档的回合序号（tombstone 版本判据）
    { "path": "report.md", "size": 2048, "mtime": "…", "etag": "…", "last_seen_sync_seq": 42 },
    { "path": "output/final.mp4", "size": 9437184, "mtime": "…", "etag": "…", "last_seen_sync_seq": 40 }
  ],
  "skipped": [                                // 因排除规则/超限未归档的文件（前端可提示）
    { "path": "node_modules/…", "reason": "ignored_pattern" },
    { "path": "raw.mov", "reason": "file_too_large", "size": 3221225472 }
  ],
  "deleted": [                                // rev2：删除 tombstone（防旧节点复活已删文件，见 W3.2）
    { "path": "draft.md", "deleted_seq": 41, "deleted_at": "2026-07-29T11:58:00Z" }
  ]
}
```

- **W2.1** manifest 在**每次 stage-out 成功后整体重写**（先传文件、后写清单：清单落地即代表文件已就位，读侧以 manifest 为准，天然规避半程失败的悬空引用）。**rev2 同步完成状态**：回合开始先 PUT `sync.inprogress.json`（含本轮尝试的 `sync_seq`、`started_at`、`node_id`），清单写成后删除该标记。manifest 本体**不写中间态**——只在回合成功末尾以 `sync_state:"complete"` 落盘，读侧只信 complete 清单（等价满足"只允许读取 complete 状态 manifest"，且同步进行中/中断后归档始终可读上一份完整快照）。中断回合的痕迹 = 残留标记 + 未入清单的 `files/` 对象，二者作为**显式垃圾**由下一轮成功回合的删除传播与保留期脚本（W3.7）回收。
- **W2.2** `files[].etag/size/mtime` 同时是**增量同步的比对基线**（见 W3.2），一份数据两用；`sync_seq`/`last_synced_at`/`node_id` 是同步状态元数据（rev1 裁决④）：孤儿对象排查（`files/` 下有对象但 manifest 未收录 = 半程失败残留，可按 seq 判断新旧）与多节点问题定位均以此为据。
- **W2.3** `skipped` 显式记录未归档文件及原因——"看不到某文件"必须可解释，不能静默丢。
- **W2.4 演进方向（rev3，文档预留，当前不实现）**：`files` 数组整体保存在单个 manifest 中当前可接受；当 workspace 文件数达到大规模（经验阈值：条目 > 1 万或 manifest 体积 > 数 MB）时，可将 manifest 拆分为**索引头 + 分页对象**（`manifest.json` 只存 sync 元数据与页对象列表，明细落 `manifest.pages/{n}.json`），以 `schema_version` 递增标识。API 层分页契约（W4）已把客户端与存储形态隔离，届时仅改存储实现、接口不变。当前实现保持单 manifest 的简单形态。

### 3.3 同步机制：workspace_store（DECISION W3）

新增 `app/session/workspace_store.py`，**结构对齐 `tenant_store.py`**（`asyncio.to_thread` 驱动 minio SDK、`enabled()` 开关、metrics；锁粒度改为 per-session，见 W3.1）：

- **W3.1 stage-out 钩子与锁（rev1 裁决①②重写）**：搭乘既有四钩子（事实 0.5），但触发方式分两类：
  - **钩子① turn 完成 → 异步（rev2 固化为 per-session 单 worker + debounce）**：turn 行持久化 + `turn_completed` WS 帧发出**之后**仅置 dirty 并确保该 sid 的 **sync worker** 存在——同一 session 任意时刻至多一个 worker task。worker 循环：取走 dirty → debounce 等待 `OH_WORKSPACE_SYNC_DEBOUNCE_MS`（默认 500，高频 turn 的多次 dirty 合并成一次最新同步）→ 在 per-sid 锁内跑一轮 sync → dirty 仍在则再来一轮，清空即退出。绝不阻塞 turn 完成与 WS 响应，也不堆积任务。worker 引用挂在 LiveSession 上；teardown/close 与 worker 的交接按 **rev3 四步定序**执行（置 closing 拒新 dirty → await worker → final stage-out → rmtree，见 W3.6）。
  - **钩子②驱逐 / ③close/DELETE（rmtree 之前）/ ④orphan 回收 → await**：均非用户交互关键路径；close 必须在 rmtree **前**完成 final stage-out（W3.6）。
  - **锁：per-session（per-workspace）`asyncio.Lock`，不复用 `tenant_lock`**。理由：`workspaces/{sid}/` 与 `openharness/`、`rules/` 及其他会话前缀天然不相交，无交叉写；唯一需要串行的是**同一 sid** 的 stage-in/stage-out（resume 与上一次 final stage-out 的交接窗口、异步 turn sync 与驱逐 sync 的重叠），per-sid 锁恰好覆盖；大 workspace 上传不阻塞同租户其他会话及租户数据同步（`tenant_max_concurrent>1` 部署下的阻塞风险归零）。锁表 `_workspace_locks: dict[str, asyncio.Lock]`，setdefault 惰性创建，与 `tenant_lock` 同款写法。调用点仍置于 `tenant_store.stage_out` 之后（但在其锁外）。
- **W3.2 增量上传与删除传播（rev2 补版本语义）**：回合开始先 GET 远端现有 manifest 作基线；若其 `sync_seq` ≠ 本进程上次见到的序号 → **rebase**（以远端清单为新基线重新差分，防多节点交错写）。本地遍历（不跟符号链接，同 `_list_local`）后仅上传 `size+mtime` 变化或新增的文件；本地已删除的文件做删除传播：删远端对象并写入 `deleted[]` **tombstone**（`{path, deleted_seq=本轮 sync_seq, deleted_at}`）。tombstone 判定（**rev3：版本优先，mtime 仅 fallback**）：`files[]` 每项携带 `last_seen_sync_seq`（该文件最近一次上传/确认在档的回合序号），节点在 stage-in 与每次成功 stage-out 后把感知到的清单序号写入本地 sidecar **`.oh_sync_state.json`**（置于 workspace 根，**硬排除**——永不上传、不进文件清单 API、不受 ignore 配置影响）。本地存在 tombstone 路径的文件时：①本节点 `base_sync_seq ≥ deleted_seq`（已感知该删除后文件仍出现）→ 视为用户真重建，上传并移除该 tombstone；②`base_sync_seq < deleted_seq`（节点从未见过该删除）→ 陈旧残本，**不重传**；③sidecar 缺失（无基线信息，如卷残留但状态丢失）→ fallback 到 mtime 与 `deleted_at` 比较（本地新→重建，否则残本），并记 warning 标注走了时钟 fallback。版本判据为主使跨节点时钟异常不再能复活已删文件。tombstone 按 `OH_WORKSPACE_TOMBSTONE_RETENTION_DAYS`（默认 7）过期修剪（陈旧节点最迟在下一次回合 rebase 时收敛）。首轮全量、后续每 turn 通常只有几个变更文件——per-turn 开销可控，这是推翻 D2.10 顾虑的关键。
- **W3.3 排除规则与限额**（新 settings，见 §5）：
  - 目录/模式排除：默认 `node_modules/, .venv/, __pycache__/, .git/, .cache/, tmp/`（`OH_WORKSPACE_SYNC_IGNORE`，逗号分隔，可覆盖）;
  - 单文件上限 `OH_WORKSPACE_SYNC_MAX_FILE_MB`（默认 512）——超限文件跳过并记入 `skipped`（成品视频另有 artifact 通道兜底，事实 0.7）;
  - 会话总量上限 `OH_WORKSPACE_SYNC_MAX_TOTAL_MB`（默认 2048）——超限时按 mtime 新者优先，装不下的记 `skipped(total_quota_exceeded)`。
- **W3.4 失败语义 = best-effort**（与 `tenant_store.stage_out` 一致）：指数退避重试（0.5/1/2s），最终失败只告警 + `oh_workspace_sync_failures_total` 计数，**绝不阻断会话生命周期**；丢失窗口 SLO 与租户数据相同（≤ 一个进行中 turn 的文件增量）。
- **W3.5 stage-in（容器切换/跨节点恢复，rev1 裁决③重写）**：rehydrate / `create_session_from_existing` 中，`cwd.mkdir` 之后、**后端进程/容器 spawn 之前**必须完成 stage-in（与租户 stage-in 同位，确保 OpenHarness 开始写工作文件前文件已就位）。判定规则**弃用"目录为空"**（OpenHarness/规则拷贝等初始化文件会导致误判跳过），改为 **manifest 文件状态比对**（rev2，替代 rev1 的"本地存在即跳过"差集规则），处理顺序（rev3 确认：**tombstone 判定先行于 LWW，且用 stage-in 前的旧 sidecar 基线**）：⓪先处理 `deleted[]` tombstone——路径一律不下载、**不进入后续 LWW**；本地存在残本时按 W3.2 版本判定（用推进前的旧 `base_sync_seq`）：旧基线（< `deleted_seq`）→ **本地删除该残本**（删除传播到本地）；已感知删除后重建（≥ `deleted_seq`）→ 保留待下轮重传；无基线 → mtime fallback + warning。必须先行的原因：若残本进入 LWW（未来 mtime 会胜出保留），而 stage-in 末尾把 sidecar 推进到清单 `sync_seq`（≥ `deleted_seq`），下轮 stage-out 会把残本误判为"真重建"而复活——先行 + 旧基线 + 本地删除彻底封死该绕过路径。随后对 `files[]` 逐条状态比对——①本地缺失 → 下载；②本地存在且 `size+mtime` 与清单项一致（etag 可校验时并校）→ 跳过；③本地存在但状态不一致 → **mtime LWW 裁决**：本地 mtime 新于清单项 → 保留本地（视为尚未归档的新改动），否则清单胜出、下载覆盖；每个冲突及裁决结果记 warning 日志（path + 决策），不静默。下载落地后 `os.utime` 把本地 mtime 对齐清单值，保证后续增量比对与重复 stage-in 幂等；stage-in 成功后把清单 `sync_seq` 写入本地 sidecar `.oh_sync_state.json` 作为本节点 `base_sync_seq`（rev3，tombstone 版本判定的基线，见 W3.2）；同节点热切换（本地状态与清单全一致）自然零下载。**失败语义为 best-effort**（与租户数据 stage-in 的 fail-fast 不同）：拉回失败仅告警，会话照常 resume（对话上下文在 OpenHarness 快照里，与 workspace 文件独立；宁可文件暂缺也不 503）。
- **W3.6 close/DELETE 的保留语义与竞态定序**（本计划的核心行为差异；rev3 明确四步）：destroy 流程为 ①置 per-session **closing 标志**——此后 turn 钩子的新 dirty 一律拒绝（stop accepting new dirty）；②**await 既有 sync worker 退出**（worker 见 closing 后跑完当前轮即退、不再消费 dirty）；③在 per-sid 锁内执行 **final stage-out**——此时无并发回合，final 回合照常先 GET 远端 manifest rebase，写入的清单必然携带**最大 `sync_seq`**，杜绝"后台旧回合覆盖 final 新清单"；④**rmtree 本地 → 保留 MinIO 归档**。`conversations.workspace_path` 照旧置 None（本地路径确实没了），但 MinIO 侧 `workspaces/{sid}/` **不删**——这正是"历史记录切换还能看到历史文件"的来源。归档的最终清理只有两条路：租户注销（前缀整删，D2.9 覆盖）或保留期脚本（W3.7）。
- **W3.7 保留期运维脚本**：`scripts/purge_workspace_archives.py --older-than-days N [--tenant TID]`——按 manifest `last_synced_at` 清理过期归档（对象 + manifest 一并删）。默认不自动运行，部署方按容量自行 cron；无 API。

### 3.4 只读文件 API（DECISION W4）

对齐 History Switch 计划的契约风格（`_load_owned` 租户校验、跨租户 404、closed/expired 可读）：

#### `GET /v1/sessions/{sid}/workspace/files` — 文件清单

- 数据源二选一，后端自动路由：
  - 会话 LIVE/IDLE 且在本节点 → 实时读本地 workspace 目录（用户看的是"现在的"文件）；
  - 其余（COLD/CLOSED/EXPIRED/跨节点）→ 读 MinIO manifest。
- 响应：`{ "source": "live"|"archive", "last_synced_at": …, "sync_seq": …, "stale": false, "total_files": …, "total_bytes": …, "files": [{path,size,mtime}], "skipped": […], "next_page_token": null }`；无归档且本地无目录 → `files: []` + `source: "none"`（不 404，会话本身存在）。**rev1 裁决⑤**：`stale=true` 当且仅当会话当前 LIVE/IDLE 但响应走了 archive 源（典型：跨节点 LIVE）——明示前端拿到的是最近一次归档快照（至多落后一个 turn），`last_synced_at`/`sync_seq` 供展示与排查；live 源固定 `stale=false`、`last_synced_at=null`。
- **rev2 分页与过滤预留**：请求参数 `limit`（默认 500）、`page_token`（不透明游标）、`prefix`（路径前缀过滤）；响应 `next_page_token`（无后续页为 null）。manifest 仍整体保存 `files` 数组（可接受），分页在 API 层切片——契约先行，workspace 文件数增长后接口不劣化；live 源同样支持这组参数。

#### `GET /v1/sessions/{sid}/workspace/files/{path:path}` — 单文件下载

- `path` 经逃逸校验（拒绝 `..`、绝对路径，同 `safe_tenant_path` 原则）。
- live 源 → FileResponse 流式返回本地文件；archive 源 → 优先 presigned URL 302（`OH_S3_PUBLIC_ENDPOINT` 已配置时，对齐 service 计划 Q2 裁决），否则经网关流式代理（minio `get_object` → StreamingResponse）。
- 鉴权与 turns 接口一致：`_load_owned`，closed 会话照常可下载（只读历史）。
- 跨节点 LIVE 会话：不做反代特例——直接走 archive 源（上一次 stage-out 的快照，至多落后一个 turn），响应以 `stale=true` + `last_synced_at` 明示（rev1 裁决⑤），并在 API 文档标注。

---

## 4. 兼容与迁移（DECISION W5）

| 场景 | 行为 |
| ---- | ---- |
| MinIO 未配置（单机/dev） | `workspace_store.enabled()=False`：同步全 no-op，文件 API 仅 live 源可用（本地目录），archive 源返回 `source:"none"`；既有测试零感知 |
| 存量 LIVE/IDLE/COLD 会话（本地 workspace 尚存） | 下一次 stage-out 钩子触发时自动完成首轮全量归档，无需迁移脚本 |
| 存量 CLOSED/EXPIRED 会话 | workspace 已被 rmtree，无从归档：文件 API 返回 `source:"none"`（不报错），文档标注"归档自本功能上线起生效" |
| `tenant_max_concurrent > 1` 部署 | per-tenant lock 下同租户 stage-out 串行，不同会话前缀天然不相交（`workspaces/{sid}/`），无交叉写风险 |
| 租户注销 | `tenants/{tid}/` 前缀整删即含 `workspaces/`，D2.9 脚本零改动 |

---

## 5. 文件改动清单

| 文件 | 改动 |
| ---- | ---- |
| `app/session/workspace_store.py` | **新增**：`workspace_remote_prefix` / `stage_out(tenant_id, sid, cwd)`（增量+manifest 重写）/ `stage_in(tenant_id, sid, cwd)` / `load_manifest(tenant_id, sid)` / `open_archived_file(...)`；结构对齐 tenant_store |
| `app/config.py` | 新增 `workspace_sync_ignore`（str，默认见 W3.3）、`workspace_sync_max_file_mb`（int=512）、`workspace_sync_max_total_mb`（int=2048）、`workspace_sync_debounce_ms`（int=500，rev2 W3.1）、`workspace_tombstone_retention_days`（int=7，rev2 W3.2）、`s3_public_endpoint`（presigned 用，缺省 None → 流式兜底） |
| `app/session/supervisor.py` | 四个 stage-out 钩子点接线：turn 钩子→置 dirty + 确保 per-session sync worker（rev2 单 worker + debounce）、其余三钩子 await（各一行 + try/except 告警）；destroy 定序为 closing 拒新 dirty → await worker → final stage-out → rmtree（rev3 W3.6）；rehydrate/`create_session_from_existing` 在 spawn 前增加 W3.5 stage-in |
| `app/routers/sessions.py` | 新增 `GET /{sid}/workspace/files`、`GET /{sid}/workspace/files/{path:path}` 两个 handler（`_load_owned` + live/archive 路由） |
| `app/schemas.py` | 新增 `WorkspaceFileEntry` / `WorkspaceFileListResponse`（含 `next_page_token`；请求侧 `limit`/`page_token`/`prefix`，rev2 W4） |
| `app/observability/metrics.py` | 新增 `oh_workspace_sync_failures_total{direction}` counter |
| `scripts/purge_workspace_archives.py` | **新增**：保留期清理脚本（W3.7） |
| `API_DOCUMENTATION.md` | 补两个文件接口、manifest 结构、归档语义（closed 可看文件 / 存量 closed 无归档 / 跨节点 live 落后一个 turn） |

**无 DB migration、无镜像重建**（源码 volume 挂载即生效，minio SDK 已是既有依赖）。

---

## 6. 测试计划（遵循 test-on-existing-images 规则）

全部在既有镜像容器内执行，宿主机不跑 pytest：

```bash
docker compose run --rm --entrypoint bash openharness \
  -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"
```

### 新增/扩展用例

1. **`tests/test_workspace_store.py`（新增，fake minio client 注入，对齐 `test_tenant_store.py` 模式）**
   - 首轮全量上传 + manifest 字段完整（tenant_id/session_id/files_prefix/files/skipped）；
   - 增量：改 1 个文件再 stage-out → 仅该文件重传；本地删文件 → 远端删除传播 + manifest 移除；
   - 排除规则命中（node_modules）、单文件超限、总量超限 → 均落 `skipped` 且不上传；
   - 符号链接不跟随、相对路径逃逸（`../x`）被拒；
   - stage-in（rev2 状态比对）：本地缺 manifest 所列文件 → 补齐；本地存在且 size+mtime 一致 → 跳过（含"本地有初始化文件但非空"场景，rev1 测试补充）；状态不一致且本地 mtime 旧 → 被覆盖；本地 mtime 新 → 保留，均断言冲突日志；下载后本地 mtime 对齐清单值（幂等）；tombstone 判定先行（rev3 确认）：旧基线残本被本地删除、未来 mtime 不进 LWW、sidecar 推进后下轮 stage-out 不复活；远端无 manifest → no-op；拉回失败 → 不抛（best-effort）；
   - manifest sync 元数据：每次成功 stage-out 后 `sync_seq` 单调递增、`last_synced_at` 更新、`sync_state="complete"`；
   - **rev2 中断回合**：上传部分文件后注入失败 → 远端 manifest 仍为上一份 complete、`sync.inprogress.json` 残留；下一轮成功后残留对象与标记被回收；
   - **rev2/rev3 tombstone（版本优先）**：删文件归档后以旧基线（sidecar `base_sync_seq < deleted_seq`）再 stage-out → 文件不复活，**残本 mtime 人为调到未来（时钟异常）也不复活**；已感知删除后重建（`base_sync_seq ≥ deleted_seq`）→ 正常重传且 tombstone 移除；sidecar 缺失 → 走 mtime fallback 且断言 warning；远端 `sync_seq` 前进时 rebase 基线；`.oh_sync_state.json` 本身永不上传；
   - 并发合并（rev2 单 worker + debounce）：同 sid 高频触发 N 次 → 任意时刻至多一个 worker、同步轮数 ≤ 2（debounce 合并，上传总次数断言）；**rev3 close 竞态**：closing 后新 dirty 被拒、worker 被 await、final stage-out 写入的 manifest `sync_seq` 全局最大（无旧覆盖新）；
   - `enabled()=False` 全链路 no-op。
2. **`tests/test_supervisor.py`（扩展）**
   - 四钩子各触发一次 `workspace_store.stage_out`（mock 计数）；stage_out 抛异常不影响 evict/close 主流程；
   - **rev1：stage-out 慢不阻塞 turn**：mock workspace_store.stage_out 为慢速（asyncio.sleep），断言 `turn_completed` 帧发出/`stream_turn` 返回不等待 sync（turn 钩子是后台 task），且 teardown 时 task 被 await 收尾；
   - **rev1：stage-in 时序**：清空本地 workspace 后 rehydrate，断言 stage_in 完成时刻早于后端 spawn（mock 调用顺序）；
   - destroy（rev3 四步）：closing 拒新 dirty → await worker → final stage-out → rmtree（顺序断言），MinIO 前缀不被删除；
   - rehydrate 本地文件齐全 → 零下载。
3. **`tests/test_protocol.py` / `tests/test_ws.py`（扩展，rev1）**
   - 超限大文件存在时 turn 照常完成：工作区含超 `max_file_mb` 文件 → turn 正常 completed，文件落 `skipped(file_too_large)`，WS 无额外错误帧。
4. **`tests/test_sessions_api.py`（扩展）**
   - live 会话文件列表走本地目录（`source:"live"`、`stale=false`）；cold/closed 走 manifest（`source:"archive"`，含 `last_synced_at`/`sync_seq`）；会话 LIVE 但走 archive 源 → `stale=true`；无归档 → `source:"none"`；
   - **rev2 分页/过滤**：`limit` + `page_token` 翻页遍历完整且不重不漏、`prefix` 过滤、末页 `next_page_token=null`（live/archive 两源均覆盖）；
   - 单文件下载：live 流式；archive presigned 302（配 public endpoint）/流式（未配）；
   - `path` 穿越（`..%2f`、绝对路径）→ 400；跨租户 → 404；closed 会话可下载。
5. **e2e 冒烟（真 MinIO，扩展 `e2e/run-session-minio-tests.sh`）**
   - 创建会话 → turn 生成文件 → 驱逐到 COLD → bucket 内 `workspaces/{sid}/manifest.json` 与 `files/` 就位（`scripts/tenant_bucket_ls.py` 校验）；
   - 模拟容器切换：清空本地 workspace 卷内该 sid 目录 → 重连 WS resume → 文件被拉回；
   - close 会话 → 本地目录消失、MinIO 归档仍在 → 文件 API 仍能列出并下载。

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
| ---- | ---- | ---- | ---- |
| 每 turn stage-out 拖慢会话（D2.10 的原始顾虑） | Med | Med | W3.2 增量比对（size+mtime，纯本地 stat + 一次远端 manifest 读）；上传走 to_thread 不阻塞事件循环；W3.3 限额封顶；best-effort 不阻断 turn 完成事件 |
| 大 workspace 首轮全量上传耗时 | Med | Low | 首轮发生在 turn 完成后/驱逐时，均非用户交互关键路径；超限部分直接 skipped |
| MinIO 容量被归档撑爆 | Med | Med | 总量限额（W3.3）+ 保留期脚本（W3.7）+ `total_bytes` 在 manifest 可观测；后续可加租户级配额（另立计划） |
| manifest 与 files/ 不一致（半程失败） | Low | Med | W2.1 先文件后清单的写序 + `sync_state:"complete"` 只读终态清单；`sync.inprogress.json` 标记使中断回合显式可辨，残留对象由下轮删除传播/保留期脚本回收，不会指向缺失文件 |
| 多节点下旧节点复活已删文件（rev2/rev3） | Low | Med | W3.2 tombstone（`deleted[]` + `deleted_seq`）+ 回合开始 rebase 远端 manifest；rev3 版本优先判定（sidecar `base_sync_seq` vs `deleted_seq`），mtime 仅无基线时 fallback——跨节点时钟异常不影响判定 |
| close 时后台 worker 与 final stage-out 竞态（旧清单覆盖新，rev3） | Low | Med | W3.6 四步定序：closing 拒新 dirty → await worker 退出 → 锁内 final stage-out（最大 `sync_seq`）→ rmtree |
| 文件 API 泄露路径/越权 | Low | High | `_load_owned` 租户校验 + 相对路径逃逸校验单点收敛 + 恶意 path 单测覆盖 |
| presigned URL 用容器内地址不可达 | High | Low | 复用 service 计划 Q2 结论：`OH_S3_PUBLIC_ENDPOINT` 部署期配置，未配置走网关流式兜底 |
| 与 tenant_store 钩子叠加后 stage-out 总时长变长 | Low | Low | rev1 已拆 per-session 锁：两者不共锁、互不阻塞；均增量、均 best-effort；观测 `oh_workspace_sync_failures_total` 与日志耗时 |

---

## 8. 实施阶段（Phases）

| Phase | 内容 | 交付物 | 依赖 |
| ----- | ---- | ------ | ---- |
| P1 | `workspace_store.py`（W1/W2/W3.1-W3.4 stage-out + manifest）+ settings + metrics + 单测 | 归档写路径闭环 | — |
| P2 | supervisor 接线：四钩子、destroy 顺序、rehydrate stage-in（W3.5/W3.6）+ 单测 | 容器切换/跨节点文件跟随 | P1 |
| P3 | 文件 API 两个端点（W4）+ schemas + 单测 + API 文档 | 历史文件可见可下载 | P1 |
| P4 | 保留期脚本（W3.7）+ e2e 冒烟扩展 + 文档收尾 | 可运维、有验收 | P2, P3 |

---

## 9. 待用户裁决的问题（Open Questions）

| # | 问题 | 裁决 |
| - | ---- | ---------- |
| Q1 | 每 turn 完成都 stage-out，还是只在驱逐/close 时归档 | **已裁决（rev1）：每 turn，但异步 best-effort**——turn 持久化成功后后台 sync，不阻塞 turn 完成与 WS 响应（W3.1） |
| Q2 | 单文件/总量限额默认值（512MB / 2GB）是否符合实际视频产出体量 | 按现网 workspace 实测后可在 `.env` 调整，代码默认取建议值 |
| Q3 | closed 会话归档是否需要 TTL 自动清理（当前设计：仅脚本手动/cron） | **建议先脚本**，容量有压力再上自动化 |

---

## 10. OpenSpec 对接（历史文档核对结论）

实施时按项目既有 openspec 工作流立一个变更（建议名 `add-session-workspace-archive`，proposal/design/tasks/specs delta 四件套，完成后归档并同步主规格）。规格影响面已逐一核对：

| 主规格 | delta 类型 | 内容 |
| ------ | ---------- | ---- |
| `session-workspace-archive.md` | **ADDED（新能力）** | W1-W4 全部要求：`tenants/{tid}/workspaces/{sid}/{manifest.json,files/}` 布局、manifest 字段（tenant_id/session_id/files_prefix/files/skipped/deleted + sync 元数据与 `sync_state`，rev2）、四钩子增量 stage-out（单 worker + debounce、tombstone/rebase 版本优先判定、close 四步定序、best-effort + metrics）、spawn 前 stage-in（状态比对 + LWW + sidecar 基线）、只读文件 API（live/archive 双源、closed 可读、路径逃逸校验、分页预留）、保留期脚本 |
| `interactive-session.md` | **MODIFIED** | DELETE Requirement 追加：清理本地 workspace **前**执行 final workspace stage-out；MinIO 侧 `workspaces/{sid}/` 归档**保留**（新增 Scenario：closed 会话文件仍可经文件 API 读取）。现有 "remove the workspace" 指本地目录，字面不冲突（事实 0.13），但归档保留语义必须显式入规格 |
| `session-tenant-isolation.md` | **MODIFIED** | Requirement 1 的前缀布局清单 `openharness/` + `rules/` 追加 `workspaces/`（沿 `videos/` 扩展先例，事实 0.14）；"tenant offboarding is a single-prefix removal" Scenario 自动覆盖归档，不改 |
| `session-history-switch.md` | 不改 | 文件 API 是新增能力，不触碰 list/turns/WS 准入契约；API 文档交叉引用即可 |
| `session-pool-scheduling.md` / `session-container-runtime.md` | 不改 | 钩子只是搭现有 stage-out 调用点（事实 0.5），不改驱逐/准入结构；container runtime 下 workspace 同卷同路径，无 runtime 差异 |

**与已归档决策的关系**：D2.10（"workspace 不进 MinIO"）属归档变更的设计叙述而非主规格条款（事实 0.12），本计划以 W3.2 增量 + W3.3 限额 + W3.4 best-effort 化解其原始顾虑（大文件拖垮会话创建），在新变更 proposal 的 Why 段落注明对 D2.10 的修订理由即可，无规格违约。姊妹计划《Service_MinIO_Multi-Tenancy_Plan》D3.7（service/ 渲染 workspace 不入 MinIO）**不受影响**——那是 video 任务的短命中间产物（其规格事实 0.9），与本计划的会话工作目录是两回事。
