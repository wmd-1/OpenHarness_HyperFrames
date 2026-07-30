# Tasks: add-session-workspace-archive

> 所有测试在已有镜像容器内执行：`docker compose run --rm --entrypoint bash openharness -c "cd /opt/oh-session-service && python -m pytest tests/... -x -q"`（依赖 postgres/redis/minio 时用 compose 既有服务）。源码 volume 挂载，无镜像重建、无 DB migration。

## 1. workspace_store 核心（P1）

- [x] 1.1 新增 `app/config.py` settings：`workspace_sync_ignore`（默认 `node_modules,.venv,__pycache__,.git,.cache,tmp`）、`workspace_sync_max_file_mb`（512）、`workspace_sync_max_total_mb`（2048）、`workspace_sync_debounce_ms`（500，rev2）、`workspace_tombstone_retention_days`（7，rev2）、`s3_public_endpoint`（复用既有则跳过），并同步 `.env.example`
- [x] 1.2 新增 `app/session/workspace_store.py`：`enabled()` 开关（`OH_MINIO_ENDPOINT` 未配置即 no-op）、`workspace_remote_prefix(tenant_id, sid)` 单点 key 生成（`validate_tenant_id` + 相对路径逃逸校验）、per-session `asyncio.Lock` 字典（不复用 tenant_lock）
- [x] 1.3 实现 `stage_out(sid)`：先 GET 远端 manifest，`sync_seq` 前进则 rebase 基线（rev2）；PUT `sync.inprogress.json` 标记 → 扫描本地目录（跳过 symlink、按 ignore/限额过滤并记 `skipped[{path,reason}]`）→ 对 manifest 基线做 size+mtime 增量比对 → 上传变更 + 删除传播（写 `deleted[]` tombstone；**rev3 版本优先判定**：`files[]` 每项带 `last_seen_sync_seq`，节点在本地 sidecar `.oh_sync_state.json`（硬排除，永不上传）维护 `base_sync_seq`——tombstone 路径本地存在时：`base_sync_seq ≥ deleted_seq` → 真重建重传并移除 tombstone；`< deleted_seq` → 残本不重传；sidecar 缺失 → mtime vs `deleted_at` fallback 并记 warning；过期 tombstone 按保留期修剪）→ **最后**整体重写 `manifest.json`（`sync_seq+1`、`last_synced_at`、`node_id`、`sync_state="complete"`、`files[]`、`total_files/bytes`）→ 删除标记并更新 sidecar `base_sync_seq`；失败退避重试 + `oh_workspace_sync_failures_total` metric（`app/observability/metrics.py`）+ warning，绝不抛出到调用方
- [x] 1.4 实现 `stage_in(sid)`：读取远端 complete manifest；**tombstone 判定先行于 LWW 且用推进前旧基线**（rev3 确认）：tombstone 路径不下载、不进 LWW，旧基线（`base_sync_seq < deleted_seq`）残本**本地删除**、真重建保留、无基线 mtime fallback + warning；随后逐文件状态比对（rev2）：本地缺失 → 下载；size+mtime 一致 → 跳过；不一致 → mtime LWW（本地新保留 / 否则覆盖）且冲突记 warning；下载后 `os.utime` 对齐清单 mtime（幂等）；成功后才写 sidecar `base_sync_seq`（rev3）；best-effort（失败仅 warning）
- [x] 1.5 单测 `tests/test_workspace_store.py`（mock MinIO client）：manifest 结构与写序（先 files 后 manifest、恒为 `sync_state="complete"`）、中断回合（部分上传后失败 → 旧 manifest 仍 complete、标记残留、下轮回收）、增量/删除传播 + tombstone（rev3 版本优先：旧基线不复活且未来 mtime 也不复活、已感知删除后重建重传、sidecar 缺失走 mtime fallback + warning、rebase、`.oh_sync_state.json` 永不上传）、ignore 与单文件/总量限额落 `skipped`、路径逃逸拒绝、stage-in 状态比对（一致跳过/LWW 两向裁决 + 冲突日志 + mtime 对齐；tombstone 先行：旧基线残本被本地删除、未来 mtime 不进 LWW、sidecar 推进后下轮 stage-out 不复活）、`enabled()=False` 全程零调用

## 2. 生命周期钩子接线（P2）

- [x] 2.1 turn 完成钩子（`app/session/supervisor.py`）：turn 行持久化 + `turn_completed` WS 帧发出后置 dirty 并确保 per-session sync worker（rev2 单 worker：同 sid 至多一个，debounce `workspace_sync_debounce_ms` 合并多次 dirty 为一次最新同步，循环至 dirty 清空退出）；worker 引用挂 LiveSession，**rev3 close 定序**：置 closing 拒新 dirty → await worker 退出 → 再走 final stage-out
- [x] 2.2 IDLE→COLD 驱逐与 orphan 回收钩子：await `stage_out`（best-effort，失败不阻断驱逐/回收）
- [x] 2.3 close/DELETE 钩子（rev3 四步定序）：closing 拒新 dirty → await worker → per-sid 锁内 final `stage_out`（写入最大 `sync_seq`）→ rmtree 本地 workspace，MinIO `workspaces/{sid}/` 归档**保留**不删除
- [x] 2.4 rehydrate/重建路径：`cwd.mkdir` 之后、后端进程/容器 spawn **之前** await `stage_in`
- [x] 2.5 集成测试 `tests/test_workspace_lifecycle.py`：① stage-out 人为放慢时 `turn_completed` 帧不等待 sync（不阻塞 WS）；② 高频触发 → 至多一个 worker、debounce 合并为一轮跟进 sync（rev2）；③ close 后本地目录删除但归档保留；④ 清空 workspace 后 resume，验证 stage_in 在后端 spawn 前完成且首 turn 可见归档文件；⑤ 超限文件 skipped 但 turn 正常完成；⑥ MinIO 不可达时 turn/驱逐/close 均正常完成；⑦ 同名初始化文件（mtime 旧于清单项）被归档覆盖且有冲突日志（rev2）；⑧ close 时 worker 正在跑中 → 新 dirty 被拒、worker 被 await、final stage-out 写入的 manifest `sync_seq` 全局最大（rev3）

## 3. 只读文件 API（P3）

- [x] 3.1 `GET /v1/sessions/{sid}/workspace/files`（`app/routers/sessions.py` + `app/schemas.py`）：`_load_owned` 租户鉴权；LIVE/IDLE 且本节点 → `source:"live"` 实时列本地；否则读 complete manifest → `source:"archive"` + `last_synced_at`/`sync_seq`，LIVE/IDLE 但走 archive 源时 `stale=true`；无归档且无本地目录 → `source:"none"` + 空列表；两源均支持 `limit`（默认 500）/`page_token`/`prefix` 与 `next_page_token`（rev2 分页预留）
- [x] 3.2 `GET /v1/sessions/{sid}/workspace/files/{path}`：`..`/绝对路径 → 400；live 流式读本地；archive 优先 presigned 302（`OH_S3_PUBLIC_ENDPOINT` 已配置）否则网关流式代理
- [x] 3.3 API 测试 `tests/test_workspace_files_api.py`：closed 会话 archive 源可列可下载、跨租户 404、路径穿越 400、stale 标注、`source:"none"` 空列表、presigned/流式两分支、分页翻页不重不漏 + `prefix` 过滤 + 末页 `next_page_token=null`（rev2）
- [x] 3.4 更新 `API_DOCUMENTATION.md`：两个端点、`source`/`stale`/`last_synced_at` 语义、"归档自本功能上线起生效"标注

## 4. 运维脚本与收尾（P4）

- [x] 4.1 新增 `scripts/purge_workspace_archives.py`：`--older-than-days N`（按 manifest `last_synced_at`）、可选 `--tenant`，删除 files/、manifest、陈旧 `sync.inprogress.json` 标记与未被 manifest 引用的孤儿对象（rev2）；默认不自动运行
- [x] 4.2 回归：容器内全量 `python -m pytest tests/ -x -q` 通过；确认 `OH_MINIO_ENDPOINT` 未配置的既有测试零感知
- [x] 4.3 按 `e2e/run-session-minio-tests.sh` 模式补 MinIO 冒烟路径（真实 MinIO：turn → 归档对象存在 → close → 文件 API 可读）
