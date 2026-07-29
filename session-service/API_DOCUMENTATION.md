# OpenHarness Interactive Session Service — API 接口文档

> 本文档由后端代码库（`session-service/app`）静态分析生成，供前端开发对齐与人工复核。
>
> - 服务名称：**OpenHarness Interactive Session Service**
> - 版本：`0.1.0`（`app/main.py`）
> - 框架：FastAPI，默认端口 `8001`（`config.api_port` 对应 `OH_API_PORT`；但 `main.py` 不消费该字段，实际绑定端口由 ASGI 启动器/部署命令决定）
> - 交互式文档：`/docs`（Swagger UI）、`/redoc`、`/openapi.json`（FastAPI 自带）
> - 代码来源：`app/routers/sessions.py`、`app/routers/ws.py`、`app/routers/health.py`、`app/observability/metrics.py`、`app/schemas.py`、`app/config.py`、`app/models.py`、`app/security.py`、`app/session/supervisor.py`

---

## 1. 全局约定

### 1.1 鉴权（Authentication）

由全局 HTTP 中间件实现（`app/main.py`）：

- **触发条件**：`OH_REQUIRE_AUTH=true` 或配置了 `OH_API_KEY` 或 `api_keys` 表非空时启用鉴权；否则全部开放（open mode，解析为租户 `default`）。
- **HTTP 鉴权方式**：请求头 `X-API-Key: <api_key>`，统一经 `security.resolve_tenant` 解析：① 单 key 模式——与 `OH_API_KEY` 常量时间比对，命中则租户为 `default`；② 多 key 模式——`sha256(key)` 查 `api_keys` 表（仅 `active=true`），命中则租户为该行 `tenant_id`，`actor_key_id` 记录 key id 供审计。解析结果有进程内 TTL 缓存（`OH_APIKEY_CACHE_TTL`，默认 60s），吊销 key 最多在 TTL 后生效。key 的增删查走 `scripts/manage_api_keys.py create/revoke/list`（只存 hash，明文仅创建时打印一次）。
- **WebSocket 鉴权方式**：在 `accept()` **之前**校验，同一 `resolve_tenant` 路径；密钥可通过请求头 `X-API-Key` **或** 查询参数 `?api_key=<key>` 传递（浏览器 WS 握手无法自定义请求头）。鉴权失败以关闭码 `4401` 关闭连接。
- **失败响应（HTTP）**：`401`，响应体 `{"detail": "Invalid API key"}`。
- **豁免路径**：`/healthz`、`/readyz`、`/metrics`（注意：与 video-service 不同，本服务的 `/metrics` **也豁免**鉴权）。
- **租户**：多 key 模式下每个 key 归属一个租户（`request.state.tenant_id`），所有会话按租户隔离（非本租户会话一律 404）；单 key/开放模式固定为 `default`，与历史行为完全兼容。
- **启动校验**：`require_auth=true` 但未设置 `api_key` 时启动抛 `RuntimeError`。
- **日志脱敏**：`api_key`（含 WS 查询参数 `?api_key=` 形式）在服务端访问日志中自动脱敏为 `***`，不会明文落盘。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OH_API_KEY` | 单 key 模式的 API 密钥（SecretStr，租户 `default`） | 无 |
| `OH_REQUIRE_AUTH` | 是否强制鉴权 | `false` |
| `OH_APIKEY_CACHE_TTL` | 多 key 解析结果的进程内缓存 TTL（秒，吊销生效上限） | `60` |

### 1.2 CORS

- `OH_CORS_ORIGINS`（逗号分隔显式来源）控制；默认空 => 不允许跨域。仅配置了显式来源时启用 `allow_credentials`。

### 1.3 限流与配额

主要作用于 `POST /v1/sessions`（IP 令牌桶 + 租户并发/每日配额）。

> ✅ **WS 连接限流已实现**：openspec 要求 **per-tenant WS 连接建立** 同样受同一令牌桶限流；`app/routers/ws.py` 在 `accept()` 前校验，超限以关闭码 `4429`（`Rate limit exceeded`）关闭连接。`POST /v1/sessions` 的限流同上。

| 机制 | 规则 | 超限响应 |
| --- | --- | --- |
| IP 令牌桶限流 | 容量 `OH_RATE_LIMIT_CAPACITY`（默认 10），每秒补充 `OH_RATE_LIMIT_REFILL`（默认 1.0），令牌扣减为 Redis Lua 原子操作；Redis 不可用时放行（fail-open） | `429` `{"detail": "Rate limit exceeded"}` |
| 租户并发配额 | 每租户最多 `OH_TENANT_MAX_CONCURRENT`（**默认 1**：单租户单活跃会话，配合 per-tenant 同步锁消除对租户 MinIO 前缀的并发写；调高则接受租户数据 last-writer-wins）个 live 会话；检查在 `ContainerPool` 准入第①段（事件循环原子，无 TOCTOU）。**同租户 IDLE 让位（session-history-switch）**：配额超限时若本租户存在可让位会话（live/idle、无 WS 连接、非 busy、非驱逐中），最久空闲者先被驱逐为 `cold` 腾出配额，新会话直接准入（**不返回 429**）；仅当无可让位候选（如唯一会话正在执行 turn 或仍有 WS 挂着）才拒绝 | `429` `{"detail": "Concurrent session quota exceeded"}` |
| 租户每日配额 | 每租户每日（UTC 日历日）最多创建 `OH_TENANT_MAX_DAILY`（默认 200）个会话；设为 `0` 关闭 | `403` `{"code": "daily_quota_exceeded", ...}` |
| 节点容量（四段式准入，WS-D） | 单节点最多 `OH_MAX_LIVE_SESSIONS`（默认 16）个 live 后端（process 子进程或 container）。create/rehydrate 统一走 `ContainerPool.acquire`：① 租户配额（429）→ ② 容量未满直接准入 → ③ 满则驱逐最久空闲 IDLE 会话为 COLD 腾位 → ④ 无可驱逐时进有界 FIFO 队列（`OH_POOL_QUEUE_SIZE` 默认 32，等待上限 `OH_POOL_QUEUE_TIMEOUT` 默认 15s）。队满/超时 → `503` + `Retry-After` 头；单租户队列占位 ≤ `OH_TENANT_MAX_CONCURRENT`（防刷满，超出立即 429）；槽位释放（退出/销毁/驱逐）唤醒队头；`OH_POOL_QUEUE_SIZE=0` 退化为旧 fail-fast（满 → 裸 `503`，无 Retry-After） | `503`（队满/超时带 `Retry-After`） |

**限流客户端 IP 判定（`X-Forwarded-For` 信任策略）**：

- 仅当**直连对端**地址在 `OH_TRUSTED_PROXY`（逗号分隔 IP 列表，默认空）名单中时，才读取 `X-Forwarded-For` 首个地址作为限流 key；否则一律使用 socket 对端地址，客户端伪造 XFF 头无法绕过限流。
- ⚠️ **部署提示**：经 nginx 等反向代理部署时必须配置 `OH_TRUSTED_PROXY`（填反代的出口 IP），否则所有请求将共享同一个限流桶。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OH_TRUSTED_PROXY` | 可信反代 IP 列表（逗号分隔），在名单内才信任 XFF | `""`（从不信任） |
| `OH_TENANT_MAX_CONCURRENT` | 每租户并发 live 会话上限（兼作队列占位上限） | `1` |
| `OH_TENANT_MAX_DAILY` | 每租户每日创建上限（`0` = 关闭） | `200` |
| `OH_MAX_LIVE_SESSIONS` | 单节点 live 后端容量 | `16` |
| `OH_POOL_QUEUE_SIZE` | 准入等待队列长度（`0` = 禁用排队，退化 fail-fast） | `32` |
| `OH_POOL_QUEUE_TIMEOUT` | 队内最长等待秒数（也是 `Retry-After` 建议值） | `15` |
| `OH_BACKEND_EVENT_MAX_BYTES` | 单条后端事件 payload 上限（超限拒绝解析，见 §3.1） | `1048576`（1 MiB） |

### 1.3.1 多租户数据隔离（MinIO 权威源，WS-B）

配置了 `OH_MINIO_ENDPOINT` 时启用（未配置则完全旁路，行为不变）：租户的 agent 记忆/会话快照等数据以 MinIO bucket 前缀 `tenants/{tenant_id}/` 为权威源；create/rehydrate 前 **stage-in** 镜像到节点本地暂存 `/tenants/{tenant_id}/`（MinIO 不可达 → `503 tenant data store unavailable`，fail-fast 不建会话）；turn 完成/驱逐/关闭/孤儿回收四钩子 **stage-out** 镜像回 bucket（指数退避重试，耗尽后计 `oh_tenant_sync_failures_total`）。丢失窗口 SLO：节点崩溃最多丢失自上一次 stage-out（即上一个完成 turn）以来的增量记忆。DELETE 会在 final stage-out 后同时清理暂存与 bucket 内该会话的 `data/memory|sessions/{oh_session_id}*` 痕迹（租户级记忆保留）。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OH_MINIO_ENDPOINT` | MinIO 地址（空 = 禁用租户数据隔离） | 无（compose 内 `minio:9000`） |
| `OH_MINIO_ACCESS_KEY` / `OH_MINIO_SECRET_KEY` | 凭据（SecretStr，不落 bucket/暂存） | 无 |
| `OH_MINIO_BUCKET` | 租户数据 bucket | `oh-tenants` |
| `OH_TENANTS_ROOT` | 节点本地暂存根（所有本地清理路径必须 resolve 在其租户前缀下） | `/tenants` |

### 1.4 通用错误响应结构

FastAPI 标准结构：`{"detail": "..."}`；参数校验失败（`422`）时 `detail` 为数组（`loc`/`msg`/`type`）。

### 1.5 枚举

**`SessionStatus`**（`app/models.py`）：

| 值 | 含义 |
| --- | --- |
| `creating` | 创建中 |
| `live` | 子进程存活，可交互 |
| `idle` | 无 WS 连接的宽限期（默认 300s） |
| `cold` | 已驱逐，快照保留，可通过 WS 重连自动复活（`--resume`） |
| `closed` | 已关闭（保留 turn 记录） |
| `expired` | 超过会话 TTL（默认 86400s） |
| `failed` | 失败 |

**`TurnStatus`**：

| 值 | 含义 |
| --- | --- |
| `running` | 执行中 |
| `completed` | 完成 |
| `failed` | 失败 |
| `interrupted` | 被中断 |
| `timed_out` | 超时（单轮超时默认 900s） |

---

## 2. 会话接口（`/v1/sessions`）

Router 前缀：`/v1/sessions`，tag：`sessions`。

### 2.1 创建会话

- **请求路径**：`POST /v1/sessions`
- **HTTP 方法**：`POST`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`201 Created`
- **限流**：是（IP 令牌桶 + 租户并发配额）

#### 请求体结构（`SessionCreateRequest`）

| 字段 | 类型 | 是否必填 | 默认值 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `permission_policy` | string | 否 | `"full_auto"` | 正则 `^(full_auto|interactive)$` | `full_auto`：无人值守；`interactive`：审批/提问回传客户端 |
| `extra_oh_args` | string[] | 否 | `[]` | 最多 50 项 | 转发给 `oh` CLI 的额外参数（白名单校验，见下） |

**`extra_oh_args` 校验规则**（`app/security.py`，非法返回 `422`）：

- 仅允许 `--flag` 形式 token。
- 白名单：`--temperature`(float)、`--max-turns`(int)、`--model`(str)、`--no-cache`、`--verbose`、`--effort`(str) ← 注意比 video-service 多了 `--effort`。
- 禁止（服务端固定注入，不可覆盖）：`--permission-mode`、`--permission_mode`（下划线变体）、`--output`、`--output-format`、`-p`、`--prompt`、`--workspace`、`--cwd`、`--root`、`--headed`、`--no-headless`、`--browser`、`--chromium`、`--api-key`、`-k`、`--resume`、`-r`、`--backend-only`。
- 带值标志必须携带值；值禁含 shell 元字符，并做类型/长度校验。

#### 请求体示例

```json
{
  "permission_policy": "interactive",
  "extra_oh_args": ["--model", "some-model", "--effort", "high"]
}
```

#### 响应体结构（`SessionResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | UUID | 会话 ID |
| `status` | SessionStatus | 会话状态（创建成功为 `live`） |
| `permission_policy` | string | 权限策略 |
| `turn_count` | integer | 已完成轮次数 |
| `oh_session_id` | string \| null | 底层 `oh` 会话 ID |
| `created_at` | datetime | 创建时间 |
| `last_active_at` | datetime | 最后活跃时间 |
| `ws_url` | string \| null | WS 连接路径 `/v1/sessions/{sid}/ws`；`closed`/`expired` 状态时为 `null` |

#### 响应示例

```json
{
  "session_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "live",
  "permission_policy": "interactive",
  "turn_count": 0,
  "oh_session_id": "oh-abc123",
  "created_at": "2026-07-24T08:00:00Z",
  "last_active_at": "2026-07-24T08:00:00Z",
  "ws_url": "/v1/sessions/3fa85f64-5717-4562-b3fc-2c963f66afa6/ws"
}
```

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `201` | 创建成功 |
| `401` | 鉴权失败（启用鉴权时） |
| `403` | 租户每日配额超限（`{"detail": "Daily session quota exceeded"}`，UTC 日起算） |
| `422` | 请求体校验失败（含 `extra_oh_args` 非法） |
| `429` | IP 限流 或 租户并发配额超限（`detail` 区分） |
| `503` | 节点容量已满且无可驱逐会话（按 openspec；与 `/readyz` 一致） |

---

### 2.2 查询会话详情

- **请求路径**：`GET /v1/sessions/{sid}`
- **HTTP 方法**：`GET`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK`

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `sid` | path | UUID | 是 | — | 会话 ID |

#### 响应体

同 `SessionResponse`（见 2.1）。

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功 |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 会话不存在或不属于当前租户（`{"detail": "Session not found"}`） |
| `422` | `sid` 非合法 UUID |

---

### 2.3 关闭会话

- **请求路径**：`DELETE /v1/sessions/{sid}`
- **HTTP 方法**：`DELETE`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK`
- **说明**：终止子进程、清理资源、状态置为 `closed`；**轮次（turn）记录保留**。若会话不在本节点 live，则仅在 DB 中标记 `closed`。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `sid` | path | UUID | 是 | — | 会话 ID |

#### 响应体结构（`DeleteResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | UUID | 会话 ID |
| `status` | SessionStatus | 固定为 `closed` |
| `message` | string | 固定为 `"Session closed"` |

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 关闭成功 |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 会话不存在或不属于当前租户 |
| `422` | `sid` 非合法 UUID |

---

### 2.4 提交一轮对话（REST 兜底，非流式）

- **请求路径**：`POST /v1/sessions/{sid}/turns`
- **HTTP 方法**：`POST`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK`
- **说明**：无 WS 场景的兜底接口。**同步阻塞**至该轮完成后一次性返回结果；实时流式请使用 WS（见第 3 节）。要求会话已在本节点 live（COLD 会话需先通过 WS 重连复活）。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `sid` | path | UUID | 是 | — | 会话 ID |

#### 请求体结构（`TurnSubmitRequest`）

| 字段 | 类型 | 是否必填 | 默认值 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `text` | string | 是 | — | 长度 1~32000 | 用户输入文本 |

#### 响应体结构（`TurnResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `turn_id` | UUID | 轮次 ID |
| `turn_index` | integer | 轮次序号（会话内递增） |
| `status` | TurnStatus | 轮次状态 |
| `prompt` | string | 用户输入 |
| `assistant_text` | string \| null | 助手完整回复文本 |
| `error_message` | string \| null | 错误信息 |
| `started_at` | datetime | 开始时间 |
| `finished_at` | datetime \| null | 结束时间 |

#### 响应示例

```json
{
  "turn_id": "9f1c2d3e-...",
  "turn_index": 3,
  "status": "completed",
  "prompt": "把背景换成夜景",
  "assistant_text": "已完成背景替换……",
  "error_message": null,
  "started_at": "2026-07-24T08:10:00Z",
  "finished_at": "2026-07-24T08:11:30Z"
}
```

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 该轮完成 |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 会话不存在或不属于当前租户 |
| `409` | `{"detail": "Session not live; reconnect via WebSocket"}`（会话不在本节点 live）或 `{"detail": "A turn is already in progress"}`（单写者：已有轮次进行中） |
| `422` | 参数/请求体校验失败 |
| `502` | 该轮出错（`turn_error`，如超时/后端进程退出）或未正常完成 |

---

### 2.5 下载轮次产物（视频）

- **请求路径**：`GET /v1/sessions/{sid}/turns/{idx}/artifact`
- **HTTP 方法**：`GET`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK` / `206 Partial Content` / `302 Found`（S3 预签名重定向）
- **说明**：支持 HTTP Range 分段下载。产物在 S3 且可预签名时默认 302 重定向；`?mode=stream` 可强制流式返回。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `sid` | path | UUID | 是 | — | 会话 ID |
| `idx` | path | integer | 是 | — | 轮次序号 |
| `mode` | query | string | 否 | （重定向优先） | 传 `stream` 强制流式返回字节，否则 S3 命中时 302 |
| `Range` | header | string | 否 | — | 如 `bytes=0-1023`、`bytes=-500` |

#### 响应体结构

- 二进制视频流，`Content-Type: video/mp4`，非 JSON。
- 响应头：`Content-Disposition: attachment; filename="{filename|sid_idx.mp4}"`、`Accept-Ranges: bytes`、`Content-Length`；Range 请求附 `Content-Range`。
- **文件名 sanitize**：`filename` 仅保留 `[A-Za-z0-9_\-.]` 及 Unicode 字母数字字符，其余（含 `/`、`"`、控制字符等）替换为 `_`（防响应头注入）；前端不应假设下载文件名与产物原始名完全一致。
- S3 命中且未指定 `mode=stream`：`302` + `Location` 预签名 URL。

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 完整文件流 |
| `206` | Range 分段返回 |
| `302` | 重定向到 S3 预签名 URL |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 会话不存在 / 产物记录不存在（`Artifact not found`）/ 存储上文件缺失（`Artifact file not found`） |
| `422` | `sid`/`idx` 类型校验失败 |

> 注：`ArtifactResponse` schema（`artifact_id`、`turn_index`、`storage_kind`、`filename`、`file_size_bytes`、`duration_seconds`、`resolution`、`fps`）已定义，但当前路由未暴露产物元数据 JSON 接口，仅提供文件下载。前端如需元数据列表接口请与后端确认。

---

### 2.6 会话历史列表

- **请求路径**：`GET /v1/sessions`
- **HTTP 方法**：`GET`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK`
- **说明**：当前租户的会话列表（含 `cold`/`closed` 历史会话），按 `created_at` **倒序**（最新在前）分页返回。用于「会话历史/切换」侧栏（session-history-switch D9）。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `status` | query | SessionStatus | 否 | — | 按状态过滤（如 `?status=cold`） |
| `limit` | query | integer | 否 | `20` | 每页条数，1~100 |
| `offset` | query | integer | 否 | `0` | 偏移量（≥0） |

#### 响应体结构（`SessionListResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | SessionSummary[] | 会话摘要列表 |
| `total` | integer | 过滤条件下的总条数（用于分页） |
| `limit` | integer | 回显生效的 limit |
| `offset` | integer | 回显生效的 offset |

**`SessionSummary`**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | UUID | 会话 ID |
| `status` | SessionStatus | 内部状态（仅供展示；**前端决策请只用 `resumable`/`read_only`**） |
| `title` | string \| null | 首轮 prompt 截断 80 字符（页内一次批量查询）；0 轮会话为 `null` |
| `turn_count` | integer | 已完成轮次数 |
| `resumable` | bool | 是否可通过连 WS 复活继续对话（见下方语义） |
| `read_only` | bool | 是否只读（仅可查历史，不可再交互） |
| `created_at` | datetime | 创建时间 |
| `last_active_at` | datetime | 最后活跃时间 |

**`resumable` / `read_only` 语义**（`_business_fields`，内部状态到前端契约的唯一映射点）：

- `read_only = status ∈ {closed, expired}`（终态只读）。
- `resumable = not read_only`，且对 `cold`/`failed` 会话额外要求**快照存在性检查**通过（本地暂存 `sessions/{oh_session_id}*` 优先，缺失回退 MinIO bucket 前缀查询）；**例外**：`turn_count == 0` 的 `cold` 会话即使无快照也保持 `resumable=true`（rehydrate 会自动回退为全新拉起，没有上下文可丢）。
- 前端渲染建议：`resumable=true` → 可点击切换（连 WS）；`read_only=true` → 仅展示历史（走 2.7 接口）；两者皆 false（如快照已丢失的 `cold`）→ 置灰并提示不可恢复。

#### 响应示例

```json
{
  "items": [
    {
      "session_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "status": "cold",
      "title": "把背景换成夜景",
      "turn_count": 3,
      "resumable": true,
      "read_only": false,
      "created_at": "2026-07-24T08:00:00Z",
      "last_active_at": "2026-07-24T09:12:00Z"
    }
  ],
  "total": 12,
  "limit": 20,
  "offset": 0
}
```

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功（无会话时 `items=[]`、`total=0`） |
| `401` | 鉴权失败（启用鉴权时） |
| `422` | 查询参数校验失败（`limit`/`offset`/`status` 非法） |

> 租户隔离：仅返回当前租户的会话，他租户会话不可见（不是 404，而是根本不出现在列表里）。

---

### 2.7 轮次历史列表（回显）

- **请求路径**：`GET /v1/sessions/{sid}/turns`
- **HTTP 方法**：`GET`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK`
- **说明**：按 `turn_index` 升序返回历史轮次，游标分页。用于切换会话时先回显历史对话；`closed`/`expired` 会话**依然可读**（只读历史）。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `sid` | path | UUID | 是 | — | 会话 ID |
| `after_index` | query | integer | 否 | `-1` | 游标：只返回 `turn_index > after_index` 的轮次（默认从头） |
| `limit` | query | integer | 否 | `50` | 每页条数，1~200 |

#### 响应体结构（`TurnListResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | TurnResponse[] | 轮次列表（字段同 2.4 的 `TurnResponse`，含 `has_artifact`，批量查询产物标记） |
| `total` | integer | 该会话的轮次总数（不受游标影响，用于判断是否还有下一页） |

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功 |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 会话不存在或不属于当前租户 |
| `422` | 参数校验失败 |

---

## 3. WebSocket 实时交互接口

### 3.1 会话 WS 连接

- **请求路径**：`WS /v1/sessions/{sid}/ws`（`ws://` 或 `wss://`）
- **HTTP 方法**：`GET`（WebSocket Upgrade）
- **鉴权**：需要（当鉴权启用时），在 `accept()` 前校验；支持 `X-API-Key` 头或 `?api_key=` 查询参数
- **说明**：实时流式对话通道。连接时若会话为 `cold` 会自动通过 `--resume` 复活；**多个客户端并发重连同一 COLD 会话时，仅触发一次 `--resume`，其余连接等待并复用同一复活后的会话**（单写者保证）；多节点部署时若会话归属其他节点，服务端**透明反向代理**（客户端无感知）。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `sid` | path | UUID | 是 | — | 会话 ID |
| `last_turn_index` | query | integer | 否 | `null` | 断线重连时客户端已见的最后轮次序号；服务端会补发（replay）此后已完成轮次的 `turn_complete` 帧 |
| `api_key` | query | string | 否 | — | WS 鉴权替代方式（等价于 `X-API-Key` 头） |

#### 连接关闭码（握手/校验失败）

| 关闭码 | reason | 含义 |
| --- | --- | --- |
| `4400` | `Invalid session id` | `sid` 非合法 UUID |
| `4401` | `Invalid API key` | 鉴权失败 |
| `4403` | `Session is closed` | 会话已关闭/过期 |
| `4404` | `Session not found` | 会话不存在或不属于当前租户 |
| `4429` | `Rate limit exceeded` | 限流（WS 连接建立频率超限，与 `POST /v1/sessions` 同一 IP 令牌桶） |

#### 准入失败关闭码（accept 后、rehydrate/切换阶段，session-history-switch D6）

准入失败时服务端**先发一帧结构化错误**再关闭连接（错误帧发送失败不影响 close）：

```json
{ "type": "error", "code": "<reason 常量>", "message": "<人类可读说明>" }
```

close 帧的 `reason` 字段携带同一机器可解析常量（WS reason 限 123 字节，长文本走错误帧）：

| 关闭码 | reason 常量 | 含义 | 前端建议 |
| --- | --- | --- | --- |
| `4430` | `TENANT_QUOTA_EXCEEDED` | 租户并发配额已满且无可让位会话（如另一会话正在执行 turn 或仍有 WS 连接） | 提示先断开/等待其他会话；`4429` 已被握手限流占用，故用 `4430` |
| `4503` | `CAPACITY_FULL` | 节点容量已满（队满/排队超时，对应 REST 的 `503`） | 可稍后指数退避重试 |
| `4500` | `SESSION_UNAVAILABLE` | 会话不可用（复活失败等内部错误；内部驱逐异常不外泄，未知异常一律降级到此码） | 提示重试或新建会话 |

#### 客户端 → 服务端消息（JSON 文本帧）

| `op` | 字段 | 说明 |
| --- | --- | --- |
| `submit` | `text: string`（必填，非空） | 提交一轮输入；已有轮次进行中时收到 `busy` 帧 |
| `interrupt` | — | 中断当前轮次 |
| `approval` | `request_id: string`（必填）、`allowed: bool`（默认 `true`）、`reply: string \| null`（仅限 `"once"`/`"always"`/`"reject"`，用于 edit_diff）、`answer: string \| null`（用于 question 弹窗） | 响应审批/提问请求（`interactive` 策略下）；**非法 `reply` 值会被拒绝**，返回 `{"type":"error","message":"invalid reply: ..."}` 帧且不透传给子进程；超时未答默认拒绝（默认 300s） |
| `ping` | — | 心跳，服务端回 `{"type": "pong"}` |

非法 JSON → `{"type":"error","message":"invalid JSON"}`；未知 `op` → `{"type":"error","message":"unknown op: ..."}`。

#### 服务端 → 客户端帧（JSON）

| `type` | 字段 | 说明 |
| --- | --- | --- |
| `session_ready` | `session_id?` | 会话就绪（连接建立后先于首轮下发） |
| `delta` | `text`、`turn_index`、`final?: true` | 助手增量文本；`final: true` 表示该段为完整文本收尾 |
| `tool_start` | `tool_name`、`tool_input`、`turn_index` | 工具调用开始 |
| `tool_end` | `tool_name`、`output`、`is_error`、`turn_index` | 工具调用结束 |
| `todo` | `todo_markdown`、`turn_index` | TODO 列表更新 |
| `approval_request` | `request_id`、`modal`（原始弹窗对象）、`turn_index` | 需客户端以 `op=approval` 应答 |
| `turn_complete` | `turn_index`、`interrupted?: true`、`replayed?: true`、`assistant_text?`（仅补发帧携带） | 轮次完成；补发（replay）帧带 `replayed: true` |
| `turn_error` | `message`、`turn_index?` | 轮次错误（超时 `turn timed out`、后端退出、超过 `max_turns_per_session` 等） |
| `busy` | — | 并发提交被拒（单写者约束） |
| `pong` | — | 心跳应答 |
| `error` | `message`、`code?` | 协议级错误（非法 JSON、未知 op）；准入失败时额外携带 `code`（reason 常量，见上方准入失败表）并随后 close |
| `event` | `event`（原始事件透传）、`turn_index` | 未知后端事件透传 |

> ⚠️ **超大事件保护**：单条后端事件 payload 超过 `OH_BACKEND_EVENT_MAX_BYTES`（默认 1 MiB）时**不会**作为任何帧下发，而是截断后转入服务端诊断日志流（防内存耗尽）。

#### 典型交互时序

```
Client                            Server
  |--- WS connect (?api_key&last_turn_index) -->|
  |<-- {"type":"session_ready"} ----------------|
  |<-- turn_complete (replayed) x N ------------|   # 补发错过的轮次
  |--- {"op":"submit","text":"..."} ----------->|
  |<-- delta / tool_start / tool_end / todo ----|   # 流式
  |<-- {"type":"approval_request",...} ---------|   # interactive 策略
  |--- {"op":"approval","request_id":...} ----->|
  |<-- {"type":"turn_complete","turn_index":N} -|
```

### 3.2 历史会话切换流程（session-history-switch）

前端实现「会话历史侧栏 + 点击切换」的推荐流程：

1. **列表**：`GET /v1/sessions` 拉取会话列表，用 `resumable`/`read_only` 决定每项可否点击切换/仅只读（不要自行解读 `status`）。
2. **回显**：点击目标会话后先 `GET /v1/sessions/{sid}/turns` 分页回显历史对话（只读会话到此为止）。
3. **连目标 WS**：`resumable=true` 时直接连 `WS /v1/sessions/{sid}/ws`（可带 `last_turn_index` 去重已回显轮次）：
   - 目标为 `cold` → 服务端自动 `--resume` 复活；0 轮无快照时自动回退全新拉起；
   - 若本租户配额已满但原会话处于空闲（无 WS、非 busy），原会话**自动让位**被驱逐为 `cold`（快照保留，后续可切回），无需先手动断开/关闭；
   - 让位不可行（原会话正在执行 turn 或仍有 WS 挂着）→ 收到 `error` 帧 `code=TENANT_QUOTA_EXCEEDED` + close `4430`。
4. **就绪**：收到首帧 `session_ready` 后即可继续 `submit`；来回切换重复 1–4 即可（A ↔ B 切换时另一侧自动变 `cold`，历史不丢）。

并发切换同一租户多个目标时，让位驱逐有单飞行保护（恰驱逐一次）：恰好一个连接获得槽位，其余收 `4430`。

---

## 4. 健康检查接口

Tag：`health`。**均豁免鉴权。**

### 4.1 存活探针

- **请求路径**：`GET /healthz`
- **HTTP 方法**：`GET`
- **鉴权**：无需（豁免）
- **成功状态码**：`200 OK`（**始终 200**，依赖状态在响应体中体现）

#### 响应体结构（`HealthResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | `ok` 或 `degraded` |
| `db` | string | `ok` / `error` |
| `redis` | string | `ok` / `error` |

#### 响应示例

```json
{ "status": "ok", "db": "ok", "redis": "ok" }
```

---

### 4.2 就绪探针

- **请求路径**：`GET /readyz`
- **HTTP 方法**：`GET`
- **鉴权**：无需（豁免）
- **成功状态码**：`200 OK`；DB/Redis 不可用**或进程池无余量**（`live_sessions >= capacity`）时返回 `503`

#### 响应体结构（`ReadyResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | `ok` 或 `degraded` |
| `db` | string | `ok` / `error` |
| `redis` | string | `ok` / `error` |
| `live_sessions` | integer | 本节点 live 会话数 |
| `capacity` | integer | 本节点容量（`OH_MAX_LIVE_SESSIONS`，默认 16） |

#### 响应示例

```json
{ "status": "ok", "db": "ok", "redis": "ok", "live_sessions": 3, "capacity": 16 }
```

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 就绪 |
| `503` | DB/Redis 不可用，或容量已满（响应体仍返回详情） |

---

## 5. 监控指标接口

### 5.1 Prometheus 指标抓取

- **请求路径**：`GET /metrics`
- **HTTP 方法**：`GET`
- **鉴权**：无需（**本服务已豁免**，与 video-service 不同）
- **成功状态码**：`200 OK`
- **响应体**：Prometheus 文本曝光格式，非 JSON。

#### 暴露的自定义指标

| 指标 | 类型 | 说明 |
| --- | --- | --- |
| `oh_session_live` | Gauge | 本节点 live 的 `oh --backend-only` 子进程数 |
| `oh_session_turns_inflight` | Gauge | 当前正在流式执行的轮次数 |
| `oh_session_turn_duration_seconds` | Histogram | 单轮墙钟耗时（秒），buckets: 1~900 |
| `oh_tenant_sync_failures_total{direction}` | Counter | 租户 stage-in/out 重试耗尽次数（`in`/`out`，WS-B） |
| `oh_pool_backends_live` | Gauge | 池内当前占用的 live 后端槽位数（WS-D） |
| `oh_pool_queue_depth` | Gauge | 准入队列当前等待请求数 |
| `oh_pool_queue_wait_seconds` | Histogram | 队内等待时长（秒），buckets: 0.1~60 |
| `oh_pool_evictions_total` | Counter | 为腾槽位被驱逐到 COLD 的会话数 |
| `oh_pool_admission_rejected_total{reason}` | Counter | 准入拒绝数（`tenant_quota`/`queue_full`/`queue_timeout`） |
| `oh_session_create_duration_seconds` | Histogram | 会话创建端到端耗时（准入等待+stage-in+后端拉起），冷启动 P95 供变体 A 预热池立项评估 |

---

## 6. 接口总览

| # | 方法 | 路径 | 说明 | 鉴权 | 主要成功码 |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/v1/sessions` | 创建会话 | 是* | 201 |
| 2 | GET | `/v1/sessions` | 会话历史列表（分页/过滤，含 `resumable`/`read_only`） | 是* | 200 |
| 3 | GET | `/v1/sessions/{sid}` | 查询会话详情 | 是* | 200 |
| 4 | DELETE | `/v1/sessions/{sid}` | 关闭会话 | 是* | 200 |
| 5 | POST | `/v1/sessions/{sid}/turns` | 提交一轮对话（REST 兜底，阻塞式） | 是* | 200 |
| 6 | GET | `/v1/sessions/{sid}/turns` | 轮次历史列表（游标分页回显） | 是* | 200 |
| 7 | GET | `/v1/sessions/{sid}/turns/{idx}/artifact` | 下载轮次产物（Range/S3 302） | 是* | 200/206/302 |
| 8 | WS | `/v1/sessions/{sid}/ws` | 实时流式对话（submit/interrupt/approval） | 是*（头或 `?api_key=`） | — |
| 9 | GET | `/healthz` | 存活探针 | 否（豁免） | 200 |
| 10 | GET | `/readyz` | 就绪探针 | 否（豁免） | 200/503 |
| 11 | GET | `/metrics` | Prometheus 指标 | 否（豁免） | 200 |

> \* “是*” 表示仅当 `OH_REQUIRE_AUTH=true` 或配置了 `OH_API_KEY` 时才需要鉴权，否则开放访问。

---

## 7. 附录：人工复核提示

- 本文档基于源码静态分析，运行时以 `/openapi.json` 为准（WS 接口不出现在 OpenAPI 中）。
- 与 video-service 的差异点：本服务 `/metrics` 豁免鉴权；`extra_oh_args` 白名单额外允许 `--effort`；限流之外还有租户并发配额（`429`，`detail` 不同）与每日配额（`403`）。
- 会话生命周期参数（可影响前端交互设计）：空闲宽限 `OH_IDLE_GRACE_SECONDS=300`、会话 TTL `OH_SESSION_TTL_SECONDS=86400`、单轮超时 `OH_TURN_TIMEOUT_SECONDS=900`、单会话最大轮次 `OH_MAX_TURNS_PER_SESSION=200`（超过后 submit 收到 `turn_error`）、审批超时 `OH_APPROVAL_TIMEOUT_SECONDS=300`（超时视为拒绝）。
- WS 断线重连策略：带上 `last_turn_index` 可补发错过的 `turn_complete`（含 `assistant_text`）；`cold` 会话重连会自动复活（并发重连仅触发一次 `--resume`），首帧恒为 `session_ready`。会话切换（列表 → turns 回显 → 连目标 WS）见 §2.6/§2.7/§3.2；准入失败先收 `error` 帧（带 `code`）再收 close `4430`/`4503`/`4500`。
- `ArtifactResponse` 已定义但无对应元数据查询路由，前端如需元数据列表接口请与后端确认。每日配额 `OH_TENANT_MAX_DAILY=200` **已强制校验**（超限 `403`，见 §1.3/§2.1）。
