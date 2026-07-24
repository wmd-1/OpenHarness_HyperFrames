# OpenHarness Video Service — API 接口文档

> 本文档由后端代码库（`service/app`）自动分析生成，供前端开发对齐与人工复核。
>
> - 服务名称：**OpenHarness Video Service**
> - 版本：`0.1.0`（`app/main.py`）
> - 框架：FastAPI
> - 交互式文档：`/docs`（Swagger UI）、`/redoc`、`/openapi.json`（FastAPI 默认自带）
> - 代码来源：`service/app/main.py`、`service/app/routers/videos.py`、`service/app/routers/health.py`、`service/app/observability/metrics.py`、`service/app/schemas.py`、`service/app/config.py`、`service/app/models.py`、`service/app/security.py`

---

## 1. 全局约定

### 1.1 鉴权（Authentication）

鉴权由全局 HTTP 中间件实现（`app/main.py`）：

- **触发条件**：当 `OH_REQUIRE_AUTH=true`，或配置了 `OH_API_KEY` 时，鉴权中间件被注册并生效。
- **鉴权方式**：请求头携带 `X-API-Key: <api_key>`，服务端使用 `secrets.compare_digest` 做常量时间比对。
- **仅支持请求头**：后端中间件**只读取 `X-API-Key` 请求头**，不会解析 `?api_key=` 查询参数。即便是 `GET /file`、`GET /events` 也必须通过该请求头鉴权；前端请勿用查询参数携带 key（会被判 401）。
- **失败响应**：`401 Unauthorized`，响应体 `{"detail": "Invalid API key"}`。
- **豁免路径**：`/healthz` 与 `/readyz` 始终无需鉴权（用于探活/就绪探针）。
- **默认行为**：若 `require_auth=false` 且未配置 `api_key`，则中间件不注册，所有接口开放访问（向后兼容）。
- **启动校验**：若 `require_auth=true` 但未设置 `api_key`，服务启动直接抛 `RuntimeError`。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OH_API_KEY` | API 密钥（SecretStr） | 无 |
| `OH_REQUIRE_AUTH` | 是否强制鉴权 | `false` |

### 1.2 CORS

- 由 `OH_CORS_ORIGINS`（逗号分隔的显式来源）控制，默认空 => 不允许跨域。
- 仅当配置了显式来源时才启用 `allow_credentials`。

### 1.3 限流（Rate Limiting）

- 仅作用于 `POST /v1/videos`，基于客户端 IP 的令牌桶算法。
- Redis 不可用时**故障放行**（fail-open）。
- 超限响应：`429 Too Many Requests`，响应体 `{"detail": "Rate limit exceeded"}`。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OH_RATE_LIMIT_CAPACITY` | 令牌桶容量（最大突发） | `10` |
| `OH_RATE_LIMIT_REFILL` | 每秒补充令牌数 | `1.0` |

### 1.4 通用错误响应结构

FastAPI 标准错误结构：

```json
{ "detail": "错误描述字符串，或结构化对象" }
```

参数校验失败（`422`）时 `detail` 为数组，形如：

```json
{
  "detail": [
    { "loc": ["body", "prompt"], "msg": "...", "type": "..." }
  ]
}
```

### 1.5 枚举：任务状态 `TaskStatus`

来源：`app/models.py`

| 值 | 含义 |
| --- | --- |
| `queued` | 已入队，等待执行 |
| `running` | 执行中 |
| `retrying` | 重试中 |
| `succeeded` | 成功完成 |
| `failed` | 失败 |
| `canceled` | 已取消 |

---

## 2. 视频任务接口（`/v1/videos`）

Router 前缀：`/v1/videos`，tag：`videos`。

### 2.1 创建视频生成任务

- **请求路径**：`POST /v1/videos`
- **HTTP 方法**：`POST`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`201 Created`
- **限流**：是（令牌桶，按 IP）

#### 请求参数

无路径/查询参数。

#### 请求体结构（`VideoCreateRequest`）

| 字段 | 类型 | 是否必填 | 默认值 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `prompt` | string | 是 | — | 长度 1~8000 | 视频生成提示词 |
| `timeout_seconds` | integer | 否 | `900` | 30 ≤ x ≤ 3600 | 任务超时秒数 |
| `extra_oh_args` | string[] | 否 | `[]` | 最多 50 项 | 转发给 `oh` CLI 的额外参数（见下方白名单校验） |
| `idempotency_key` | string \| null | 否 | `null` | 最长 256 | 幂等键；重复提交返回已存在任务 |

**`extra_oh_args` 校验规则**（`app/security.py`，校验失败返回 `422`）：

- 仅允许 `--flag` 形式的 token。
- 允许的白名单标志：`--temperature`(float)、`--max-turns`(int)、`--model`(str)、`--no-cache`、`--verbose`。
- 禁止的标志（永不可由调用方控制）：`--permission-mode`、`--permission_mode`、`--output`、`--output-format`、`-p`、`--prompt`、`--workspace`、`--cwd`、`--root`、`--headed`、`--no-headless`、`--browser`、`--chromium` 等。
- 需要值的标志必须携带值；值不得含 shell 元字符；typed 标志需满足类型与长度限制。
- **只写字段**：`extra_oh_args` 仅作为请求输入被接受并落库，**不会**出现在 `GET /v1/videos/{id}` 的响应中（回显/审计需另查）。

#### 请求体示例

```json
{
  "prompt": "生成一段关于秋天森林的短视频",
  "timeout_seconds": 900,
  "extra_oh_args": ["--temperature", "0.7"],
  "idempotency_key": "req-2026-0001"
}
```

#### 响应体结构（`VideoCreateResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | UUID | 任务 ID |
| `status` | TaskStatus | 任务状态（新建通常为 `queued`） |
| `links` | object | 相关资源链接，见下 |
| `links.self` | string | 任务详情链接 `/v1/videos/{id}` |
| `links.file` | string | 文件下载链接 `/v1/videos/{id}/file` |
| `links.events` | string | SSE 事件流链接 `/v1/videos/{id}/events` |

#### 响应示例

```json
{
  "task_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "queued",
  "links": {
    "self": "/v1/videos/3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "file": "/v1/videos/3fa85f64-5717-4562-b3fc-2c963f66afa6/file",
    "events": "/v1/videos/3fa85f64-5717-4562-b3fc-2c963f66afa6/events"
  }
}
```

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `201` | 创建成功（或命中幂等键返回已存在任务） |
| `401` | 鉴权失败（启用鉴权时） |
| `422` | 请求体校验失败（含 `extra_oh_args` 非法） |
| `429` | 触发限流 |
| `503` | 任务已落库但 broker/调度器不可用，任务被标记为 `failed` |

---

### 2.2 查询任务详情

- **请求路径**：`GET /v1/videos/{task_id}`
- **HTTP 方法**：`GET`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK`

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `task_id` | path | UUID | 是 | — | 任务 ID |

#### 响应体结构（`VideoTaskResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | UUID | 任务 ID |
| `prompt` | string | 提示词 |
| `skill` | string | 使用的 skill（固定 `hyperframes`） |
| `status` | TaskStatus | 任务状态 |
| `timeout_seconds` | integer | 超时秒数 |
| `file_size_bytes` | integer \| null | 输出文件大小（字节） |
| `duration_seconds` | number \| null | 视频时长（秒） |
| `resolution` | string \| null | 分辨率，如 `1920x1080` |
| `fps` | integer \| null | 帧率 |
| `exit_code` | integer \| null | `oh` 进程退出码 |
| `error_message` | string \| null | 错误信息 |
| `created_at` | datetime \| null | 创建时间 |
| `started_at` | datetime \| null | 开始时间 |
| `finished_at` | datetime \| null | 完成时间 |

> **注意**：`GET /v1/videos/{id}` 的响应**不含** `links` 字段（仅 `POST /v1/videos` 的创建响应才带 `links`）。前端需按 `task_id` 自行拼装 `/file`（下载）与 `/events`（SSE）的 URL。

#### 响应示例

```json
{
  "task_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "prompt": "生成一段关于秋天森林的短视频",
  "skill": "hyperframes",
  "status": "succeeded",
  "timeout_seconds": 900,
  "file_size_bytes": 10485760,
  "duration_seconds": 12.5,
  "resolution": "1920x1080",
  "fps": 30,
  "exit_code": 0,
  "error_message": null,
  "created_at": "2026-07-24T08:00:00Z",
  "started_at": "2026-07-24T08:00:05Z",
  "finished_at": "2026-07-24T08:02:30Z"
}
```

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功 |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 任务不存在（`{"detail": "Task not found"}`） |
| `422` | `task_id` 非合法 UUID |

---

### 2.3 下载视频文件

- **请求路径**：`GET /v1/videos/{task_id}/file`
- **HTTP 方法**：`GET`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK` / `206 Partial Content` / `302 Found`（S3 重定向）
- **说明**：支持 HTTP Range 分段下载。默认 `mode=redirect` 时，若产物在 S3 且可生成预签名 URL，返回 302 重定向；否则直接流式返回字节。
- **Range 生效范围**：Range 仅在本服务直接流式返回时由本服务处理（本地存储、`?mode=stream`、或 S3 预签名失败回退）。`mode=redirect` 且命中 S3 预签名 302 时，Range 由目标 S3 端点处理，本服务不再改写分段逻辑。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `task_id` | path | UUID | 是 | — | 任务 ID |
| `mode` | query | string | 否 | `redirect` | `redirect`（默认，S3 走 302 预签名）或 `stream`（强制流式返回字节） |
| `Range` | header | string | 否 | — | 标准 Range 头，如 `bytes=0-1023`、`bytes=-500` |

#### 响应体结构

- 二进制视频流（`Content-Type: video/mp4`），非 JSON。
- 响应头：`Content-Disposition: attachment; filename="{task_id}.mp4"`、`Accept-Ranges: bytes`、`Content-Length`；Range 请求时附带 `Content-Range`。
- `mode=redirect` 且 S3 命中时：`302` + `Location` 指向预签名 URL。

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 完整文件流返回成功 |
| `206` | Range 分段返回成功 |
| `302` | 重定向到 S3 预签名 URL |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 任务不存在 / 无 `output_path` / 存储上文件缺失 |
| `409` | 任务未完成（非 `succeeded`），响应体 `{"status": <status>, "message": "Video not ready"}` |
| `422` | `task_id` 非合法 UUID |

---

### 2.4 任务进度事件流（SSE）

- **请求路径**：`GET /v1/videos/{task_id}/events`
- **HTTP 方法**：`GET`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK`（`Content-Type: text/event-stream`）
- **说明**：Server-Sent Events，实时推送任务日志。历史回放上限为最近 500 条。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `task_id` | path | UUID | 是 | — | 任务 ID |

#### 响应体结构（SSE 事件）

| event | data | 说明 |
| --- | --- | --- |
| `log` | 日志文本行 | 一行日志输出 |
| `done` | `{"status": "completed"}` | 任务完成标记 |
| `error` | `{"error": "Redis unavailable"}` | Redis 不可用 |

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 事件流建立成功 |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 任务不存在（`{"detail": "Task not found"}`） |
| `422` | `task_id` 非合法 UUID |

---

### 2.5 取消 / 删除任务

- **请求路径**：`DELETE /v1/videos/{task_id}`
- **HTTP 方法**：`DELETE`
- **鉴权**：需要（当鉴权启用时）
- **成功状态码**：`200 OK`
- **说明**：语义随任务状态而变——`queued` 取消入队；`running` 请求终止；终止态（成功/失败/已取消）则删除产物资源但保留终态状态；`retrying` 同样走「删除产物资源 + 保留状态」分支（清理 `output_path`/`workspace_path` 但保留 `retrying` 状态）。注意：若 `retrying` 任务正被 beat 回收重新入队，删除可能使其指向已清理的产物/工作区，建议调用方先 `GET` 确认状态再删除。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `task_id` | path | UUID | 是 | — | 任务 ID |

#### 响应体结构（`VideoDeleteResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | UUID | 任务 ID |
| `status` | TaskStatus | 操作后的任务状态 |
| `message` | string | 操作说明 |
| `deleted` | boolean | 是否清理了终态任务的资源（默认 `false`；对运行中取消场景为 `false`） |

#### 不同状态的响应示例

- `queued` → 取消：`{"task_id": "...", "status": "canceled", "message": "Task canceled", "deleted": false}`
- `running` → 请求终止：`{"task_id": "...", "status": "canceled", "message": "Task termination requested", "deleted": false}`
- 终态 → 删除资源：`{"task_id": "...", "status": "succeeded", "message": "Task resources deleted", "deleted": true}`

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 操作成功 |
| `401` | 鉴权失败（启用鉴权时） |
| `404` | 任务不存在 |
| `422` | `task_id` 非合法 UUID |

---

## 3. 健康检查接口

Tag：`health`。**这两个接口始终豁免鉴权。**

### 3.1 存活探针

- **请求路径**：`GET /healthz`
- **HTTP 方法**：`GET`
- **鉴权**：无需（始终豁免）
- **成功状态码**：`200 OK`（**始终 200**，即使依赖降级，也不会返回 5xx）

#### 响应体结构（`HealthResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 总体状态：`ok` 或 `degraded` |
| `db` | string | 数据库状态：`ok` / `error` |
| `redis` | string | Redis 状态：`ok` / `error` |
| `s3` | string \| null | S3 状态；该字段**始终出现**——非 S3 部署（`storage_kind != "s3"`）时值为 `null`，S3 部署时取 `ok` / `error` |

#### 响应示例

```json
{ "status": "ok", "db": "ok", "redis": "ok", "s3": null }
```

---

### 3.2 就绪探针

- **请求路径**：`GET /readyz`
- **HTTP 方法**：`GET`
- **鉴权**：无需（始终豁免）
- **成功状态码**：`200 OK`；当 Redis 或 DB 不可用时返回 `503`

#### 响应体结构（`ReadyResponse`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | `ok`（健康）或 `degraded`（降级） |
| `pending` | integer | 排队+重试中的任务数（`queued` + `retrying`） |
| `running` | integer | 运行中任务数 |
| `heartbeat_lag_seconds` | number \| null | 最老运行任务的心跳滞后秒数；无运行任务时为 `null` |

#### 响应示例

```json
{ "status": "ok", "pending": 3, "running": 2, "heartbeat_lag_seconds": 1.5 }
```

#### 状态码说明

| 状态码 | 含义 |
| --- | --- |
| `200` | 就绪 |
| `503` | Redis 或 DB 不可用（负载均衡应停止路由到该副本） |

---

## 4. 监控指标接口

Tag：`metrics`。

### 4.1 Prometheus 指标抓取

- **请求路径**：`GET /metrics`
- **HTTP 方法**：`GET`
- **鉴权**：需要（当鉴权启用时；该路径未在中间件中豁免）
- **成功状态码**：`200 OK`
- **响应体**：Prometheus 文本曝光格式（`Content-Type: text/plain; version=0.0.4`），非 JSON。

#### 暴露的自定义指标

| 指标 | 类型 | 说明 |
| --- | --- | --- |
| `oh_render_inflight` | Gauge | 当前 worker 正在执行的 `oh` 渲染进程数 |
| `oh_render_duration_seconds` | Histogram | 单次 `oh` 渲染的墙钟耗时（秒） |

---

## 5. 接口总览

| # | 方法 | 路径 | 说明 | 鉴权 | 主要成功码 |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/v1/videos` | 创建视频生成任务 | 是* | 201 |
| 2 | GET | `/v1/videos/{task_id}` | 查询任务详情 | 是* | 200 |
| 3 | GET | `/v1/videos/{task_id}/file` | 下载视频文件（支持 Range/S3 重定向） | 是* | 200/206/302 |
| 4 | GET | `/v1/videos/{task_id}/events` | 任务进度 SSE 事件流 | 是* | 200 |
| 5 | DELETE | `/v1/videos/{task_id}` | 取消/删除任务 | 是* | 200 |
| 6 | GET | `/healthz` | 存活探针 | 否（豁免） | 200 |
| 7 | GET | `/readyz` | 就绪探针 | 否（豁免） | 200/503 |
| 8 | GET | `/metrics` | Prometheus 指标 | 是* | 200 |

> \* “是*” 表示仅当 `OH_REQUIRE_AUTH=true` 或配置了 `OH_API_KEY` 时才需要鉴权；否则开放访问。`/healthz` 与 `/readyz` 无论如何都豁免。

---

## 6. 附录：人工复核提示

- 本文档基于源码静态分析生成，实际运行时的 OpenAPI 结构以 `/openapi.json` 为准。
- `POST /v1/videos` 中 `skill` 字段由服务端固定写入 `hyperframes`，非客户端可控。
- 时间字段（`created_at` 等）为带时区的 ISO 8601 datetime。
- `error_message`、`log_tail` 等敏感/大字段的返回策略请与后端确认（`log_tail` 未在响应 schema 中暴露）。
- 部分模型字段仅服务端可见、不在任何响应 schema 中返回：`extra_oh_args`（请求只写，落库但不回显）、`cancellation_requested`（取消时置位但不返回）、`worker_id` / `priority` / `heartbeat_at` / `storage_kind` 等内部字段。
- 任务优先级 `priority` 为**服务端内部固定值**（默认 `5`，对应 `normal` 队列），**不**通过 API 暴露，客户端无法设置；多实例的队列分层（`high` / `normal` / `low`）由后端按 `priority` 自动路由。
- 鉴权仅支持 `X-API-Key` 请求头，所有端点（含 `/file`、`/events`）均不接受 `?api_key=` 查询参数。
