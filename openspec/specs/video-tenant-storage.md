# Video Tenant Storage Specification（MinIO 按租户权威存储视频产物）

**Component:** `service/`（HyperFrames FastAPI 视频服务）存储层与租户数据生命周期

## Purpose

视频产物的权威存储从本地卷迁移到 MinIO（S3 兼容），对象 key 按租户前缀隔离（与 session-service 共用 `oh-tenants` bucket 的 `tenants/{tid}/` 根前缀约定），并覆盖 key 生成、后端选择、bucket 初始化、presigned 下载与租户注销的全生命周期。设计源：`plans/Service_MinIO_Multi-Tenancy_Plan_2026-07-29.md`（OpenSpec 变更 `video-service-minio-multitenancy`）。

## Requirements

### Requirement: 视频产物对象 key 必须带租户前缀且单点生成

视频产物的对象 key MUST 为 `tenants/{tenant_id}/videos/{task_id}.mp4`，与 session 侧共用 `oh-tenants` bucket 的租户根前缀 `tenants/{tid}/`。key MUST 由单一函数（`app/storage/keys.py::video_object_key(tenant_id, task_id)`）生成，任何保存路径 MUST NOT 自行拼接 key。任务行 `output_path` 列 MUST 记录完整对象 key。

#### Scenario: 保存产物使用租户前缀 key
- **WHEN** 租户 `alice` 的任务 `t1` 生成产物并保存
- **THEN** 对象 key 为 `tenants/alice/videos/{t1}.mp4`，且该 key 写入任务行 `output_path`

#### Scenario: 不同租户产物前缀互不重叠
- **WHEN** 租户 `alice` 与 `bob` 各自完成任务
- **THEN** 两者产物分别位于 `tenants/alice/videos/` 与 `tenants/bob/videos/` 前缀下，无共享路径

---

### Requirement: tenant_id 必须通过白名单校验防止 key 注入

参与对象 key 生成的 `tenant_id` MUST 匹配白名单正则 `^[A-Za-z0-9._-]{1,128}$`。不匹配的 tenant_id MUST 被拒绝（key 生成函数抛错），MUST NOT 生成含路径穿越或前缀逃逸的 key。key 管理脚本与认证中间件写入的 tenant_id MUST 同受此约束。

#### Scenario: 恶意 tenant_id 被拒绝
- **WHEN** 以 `../etc` 或 `a/b` 作为 tenant_id 调用 key 生成函数
- **THEN** 抛出校验错误，不产生任何对象 key

#### Scenario: 合法 tenant_id 通过
- **WHEN** 以 `user-01.test_A` 作为 tenant_id 生成 key
- **THEN** 正常返回 `tenants/user-01.test_A/videos/{task_id}.mp4`

---

### Requirement: 本地与 S3 后端必须统一按完整 key 操作并兼容存量平铺 key

`VideoStorage.save` 的签名 MUST 为 `save(key, src)`（由调用方传入完整对象 key）。`LocalVideoStorage` MUST 将 key 作为相对路径落盘到 `{video_dir}/` 之下（自动创建父目录）；`S3VideoStorage` MUST 以 key 作为对象名。存量平铺 key（`{task_id}.mp4`，无租户前缀）MUST 仍可被 `open`/`exists`/`delete` 正常解析（行自描述，不做搬迁）。

#### Scenario: 本地后端按相对 key 落盘
- **WHEN** `LocalVideoStorage.save("tenants/alice/videos/t1.mp4", src)` 被调用
- **THEN** 文件写入 `{video_dir}/tenants/alice/videos/t1.mp4`，父目录自动创建

#### Scenario: 存量平铺 key 仍可下载
- **WHEN** 存量任务行 `output_path = "{task_id}.mp4"` 且文件位于 `{video_dir}/` 根下，调用 `GET /v1/videos/{id}/file`
- **THEN** 下载成功，行为与改造前一致

---

### Requirement: worker 保存必须按配置选择后端，删除必须按任务行后端解析

`generate_video_task` 保存产物 MUST 使用 `settings.storage_kind` 对应的后端（修复硬编码 `LocalVideoStorage()` 的既有 bug），并将实际使用的后端写入任务行 `storage_kind`。`cleanup_expired_tasks` 与 `DELETE /v1/videos/{id}` 删除产物 MUST 按**任务行** `storage_kind` 解析后端（行自描述），以保证本地/S3 混合存量下删除正确。

#### Scenario: s3 模式下产物真正落入 MinIO
- **WHEN** `OH_STORAGE_KIND=s3` 且任务成功完成
- **THEN** 产物对象存在于 MinIO（`exists(key)` 为真），任务行 `storage_kind='s3'`，下载端点可取到文件

#### Scenario: 混合存量删除各按其后端
- **WHEN** 清理任务处理一条 `storage_kind='local'` 的过期任务与一条 `storage_kind='s3'` 的过期任务
- **THEN** 前者从本地卷删除、后者从 MinIO 删除，均不报错

---

### Requirement: bucket 初始化必须幂等且就绪探针反映 S3 可用性

服务 lifespan 内 MUST 幂等确保 bucket 存在（head → 不存在则 create）；MinIO 不可达时 MUST 仅告警不阻断启动（`OH_STORAGE_KIND=local` 拓扑必须能正常启动）。`storage_kind=s3` 时 `GET /readyz` MUST 追加 S3 探活（短超时），S3 不可达时就绪状态 MUST 反映降级。

#### Scenario: bucket 已存在时启动不报错
- **WHEN** bucket `oh-tenants` 已存在且服务重启
- **THEN** ensure_bucket 幂等通过，启动正常

#### Scenario: s3 模式下 readyz 反映 MinIO 宕机
- **WHEN** `storage_kind=s3` 且 MinIO 不可达时调用 `GET /readyz`
- **THEN** 响应体现 S3 降级状态，core API 进程不崩溃

---

### Requirement: presigned URL 必须使用公网可达地址，未配置时以流式兜底

配置 `OH_S3_PUBLIC_ENDPOINT`（运维经 `.env` 提供）时，`presigned_url` MUST 以该公网地址签发 302 重定向目标。未配置时 `presigned_url` MUST 返回 `None`，下载端点 MUST 自动落入流式返回路径（等效 `?mode=stream`），MUST NOT 向客户端返回容器内网地址（如 `http://minio:9000`）的重定向。

#### Scenario: 配置公网地址时 302 指向公网
- **WHEN** `OH_S3_PUBLIC_ENDPOINT=https://minio.example.com` 且 `mode=redirect` 命中 S3 产物
- **THEN** 302 的 `Location` 以 `https://minio.example.com` 开头

#### Scenario: 未配置公网地址时流式兜底
- **WHEN** `OH_S3_PUBLIC_ENDPOINT` 未配置且客户端请求 `mode=redirect`
- **THEN** 不返回 302，服务直接流式返回文件字节（200/206）

---

### Requirement: 租户注销必须能一次删净该租户的视频数据

MUST 提供租户注销脚本（`scripts/purge_tenant.py`）：删除 MinIO 中 `tenants/{tid}/videos/` 前缀下全部对象及该租户的全部 `video_tasks` 行。脚本 MUST 只操作本服务的 `videos/` 子前缀，MUST NOT 触碰同租户根前缀下 session 侧的其他数据。

#### Scenario: 注销后租户数据清空
- **WHEN** 对租户 `alice` 运行 purge 脚本
- **THEN** `tenants/alice/videos/` 前缀下无对象、`video_tasks` 中无 `tenant_id='alice'` 的行

#### Scenario: 注销不越界 session 数据
- **WHEN** `tenants/alice/` 下同时存在 `videos/` 与 session 侧其他子前缀，运行 purge 脚本
- **THEN** 仅 `videos/` 子前缀被删除，其他子前缀原样保留
