# OpenHarness Interactive Session Service — API 接口文档

> 本文档由后端代码库（`session-service/app`）静态分析生成，供前端开发对齐与人工复核。
>
> - 服务名称：**OpenHarness Interactive Session Service**
> - 版本：`0.1.0`（`app/main.py`）
> - 框架：FastAPI，默认端口 `8001`（`OH_API_PORT`）
> - 交互式文档：`/docs`（Swagger UI）、`/redoc`、`/openapi.json`（FastAPI 自带）
> - 代码来源：`app/routers/sessions.py`、`app/routers/ws.py`、`app/routers/health.py`、`app/observability/metrics.py`、`app/schemas.py`、`app/config.py`、`app/models.py`、`app/security.py`、`app/session/supervisor.py`

---

## 1. 全局约定

### 1.1 鉴权（Authentication）

由全局 HTTP 中间件实现（`app/main.py`）：

- **触发条件**：`OH_REQUIRE_AUTH=true` 或配置了 `OH_API_KEY` 时启用鉴权；否则全部开放（open mode）。
- **HTTP 鉴权方式**：请求头 `X-API-Key: <api_key>`，服务端用 `secrets.compare_digest` 常量时间比对。
- **WebSocket 鉴权方式**：在 `accept()` **之前**校验；密钥可通过请求头 `X-API-Key` **或** 查询参数 `?api_key=<key>` 传递（浏览器 WS 握手无法自定义请求头）。鉴权失败以关闭码 `4401` 关闭连接。
- **失败响应（HTTP）**：`401`，响应体 `{"detail": "Invalid API key"}`。
- **豁免路径**：`/healthz`、`/readyz`、`/metrics`（注意：与 video-service 不同，本服务的 `/metrics` **也豁免**鉴权）。
- **租户**：当前为单密钥模式，鉴权通过后租户固定为 `default`（`request.state.tenant_id`），所有会话按租户隔离（非本租户会话一律 404）。
- **启动校验**：`require_auth=true` 但未设置 `api_key` 时启动抛 `RuntimeError`。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OH_API_KEY` | API 密钥（SecretStr） | 无 |
| `OH_REQUIRE_AUTH` | 是否强制鉴权 | `false` |

### 1.2 CORS

- `OH_CORS_ORIGINS`（逗号分隔显式来源）控制；默认空 => 不允许跨域。仅配置了显式来源时启用 `allow_credentials`。

### 1.3 限流与配额

仅作用于 `POST /v1/sessions`：

| 机制 | 规则 | 超限响应 |
| --- | --- | --- |
| IP 令牌桶限流 | 容量 `OH_RATE_LIMIT_CAPACITY`（默认 10），每秒补充 `OH_RATE_LIMIT_REFILL`（默认 1.0）；Redis 不可用时放行（fail-open） | `429` `{"detail": "Rate limit exceeded"}` |
| 租户并发配额 | 每租户最多 `OH_TENANT_MAX_CONCURRENT`（默认 8）个 LIVE 会话 | `429` `{"detail": "Concurrent session quota exceeded"}` |
| 节点容量 | 单节点最多 `OH_MAX_LIVE_SESSIONS`（默认 16）个 live 子进程；满时自动将最久空闲会话驱逐为 COLD；无可驱逐会话时抛错（表现为 `500`） | `500` |

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
- 禁止（服务端固定注入，不可覆盖）：`--permission-mode`、`--output`、`--output-format`、`-p`、`--prompt`、`--workspace`、`--cwd`、`--root`、`--headed`、`--no-headless`、`--browser`、`--chromium`、`--api-key`、`-k`、`--resume`、`-r`、`--backend-only`。
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
| `422` | 请求体校验失败（含 `extra_oh_args` 非法） |
| `429` | IP 限流 或 租户并发配额超限（`detail` 区分） |
| `500` | 节点容量已满且无可驱逐会话 |

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

## 3. WebSocket 实时交互接口

### 3.1 会话 WS 连接

- **请求路径**：`WS /v1/sessions/{sid}/ws`（`ws://` 或 `wss://`）
- **HTTP 方法**：`GET`（WebSocket Upgrade）
- **鉴权**：需要（当鉴权启用时），在 `accept()` 前校验；支持 `X-API-Key` 头或 `?api_key=` 查询参数
- **说明**：实时流式对话通道。连接时若会话为 `cold` 会自动通过 `--resume` 复活；多节点部署时若会话归属其他节点，服务端**透明反向代理**（客户端无感知）。

#### 请求参数

| 参数 | 位置 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `sid` | path | UUID | 是 | — | 会话 ID |
| `last_turn_index` | query | integer | 否 | `null` | 断线重连时客户端已见的最后轮次序号；服务端会补发（replay）此后已完成轮次的 `turn_complete` 帧 |
| `api_key` | query | string | 否 | — | WS 鉴权替代方式（等价于 `X-API-Key` 头） |

#### 连接关闭码（握手/校验失败）

| 关闭码 | 含义 |
| --- | --- |
| `4400` | `sid` 非合法 UUID（`Invalid session id`） |
| `4401` | 鉴权失败（`Invalid API key`） |
| `4403` | 会话已关闭/过期（`Session is closed`） |
| `4404` | 会话不存在或不属于当前租户（`Session not found`） |
| `4500` | 会话不可用（复活失败等，`session unavailable`） |

#### 客户端 → 服务端消息（JSON 文本帧）

| `op` | 字段 | 说明 |
| --- | --- | --- |
| `submit` | `text: string`（必填，非空） | 提交一轮输入；已有轮次进行中时收到 `busy` 帧 |
| `interrupt` | — | 中断当前轮次 |
| `approval` | `request_id: string`（必填）、`allowed: bool`（默认 `true`）、`reply: string \| null`（`"once"`/`"always"`/`"reject"`，用于 edit_diff）、`answer: string \| null`（用于 question 弹窗） | 响应审批/提问请求（`interactive` 策略下）；超时未答默认拒绝（默认 300s） |
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
| `error` | `message` | 协议级错误（非法 JSON、未知 op） |
| `event` | `event`（原始事件透传）、`turn_index` | 未知后端事件透传 |

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

---

## 6. 接口总览

| # | 方法 | 路径 | 说明 | 鉴权 | 主要成功码 |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/v1/sessions` | 创建会话 | 是* | 201 |
| 2 | GET | `/v1/sessions/{sid}` | 查询会话详情 | 是* | 200 |
| 3 | DELETE | `/v1/sessions/{sid}` | 关闭会话 | 是* | 200 |
| 4 | POST | `/v1/sessions/{sid}/turns` | 提交一轮对话（REST 兜底，阻塞式） | 是* | 200 |
| 5 | GET | `/v1/sessions/{sid}/turns/{idx}/artifact` | 下载轮次产物（Range/S3 302） | 是* | 200/206/302 |
| 6 | WS | `/v1/sessions/{sid}/ws` | 实时流式对话（submit/interrupt/approval） | 是*（头或 `?api_key=`） | — |
| 7 | GET | `/healthz` | 存活探针 | 否（豁免） | 200 |
| 8 | GET | `/readyz` | 就绪探针 | 否（豁免） | 200/503 |
| 9 | GET | `/metrics` | Prometheus 指标 | 否（豁免） | 200 |

> \* “是*” 表示仅当 `OH_REQUIRE_AUTH=true` 或配置了 `OH_API_KEY` 时才需要鉴权，否则开放访问。

---

## 7. 附录：人工复核提示

- 本文档基于源码静态分析，运行时以 `/openapi.json` 为准（WS 接口不出现在 OpenAPI 中）。
- 与 video-service 的差异点：本服务 `/metrics` 豁免鉴权；`extra_oh_args` 白名单额外允许 `--effort`；限流之外还有租户并发配额（`429`，`detail` 不同）。
- 会话生命周期参数（可影响前端交互设计）：空闲宽限 `OH_IDLE_GRACE_SECONDS=300`、会话 TTL `OH_SESSION_TTL_SECONDS=86400`、单轮超时 `OH_TURN_TIMEOUT_SECONDS=900`、单会话最大轮次 `OH_MAX_TURNS_PER_SESSION=200`（超过后 submit 收到 `turn_error`）、审批超时 `OH_APPROVAL_TIMEOUT_SECONDS=300`（超时视为拒绝）。
- WS 断线重连策略：带上 `last_turn_index` 可补发错过的 `turn_complete`（含 `assistant_text`）；`cold` 会话重连会自动复活，首帧恒为 `session_ready`。
- `ArtifactResponse` 已定义但无对应元数据查询路由；每日配额 `OH_TENANT_MAX_DAILY=200` 在配置中定义，但当前路由代码未见强制校验——两处均建议与后端确认。
