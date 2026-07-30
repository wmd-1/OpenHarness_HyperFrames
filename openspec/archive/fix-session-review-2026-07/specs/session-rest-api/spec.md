## ADDED Requirements

### Requirement: Workspace 文件下载 MUST 支持查询参数鉴权
系统 SHALL 允许 `GET /v1/sessions/{sid}/workspace/files/{path}` 通过 `?api_key=` 查询参数鉴权（与 turn artifact 下载同等待遇），因为 `<a download>` 导航无法携带 `X-API-Key` 请求头。该豁免 SHALL 仅限 GET 方法与该下载路径，其余 REST 端点 SHALL 保持仅接受请求头鉴权。

#### Scenario: 有效 key 经查询参数下载 workspace 文件
- **WHEN** 启用鉴权且客户端请求 `GET /v1/sessions/{sid}/workspace/files/output/a.txt?api_key=<有效key>`
- **THEN** 中间件解析出对应租户并放行，返回 200 或 302（presigned 重定向）

#### Scenario: 无效 key 经查询参数下载被拒
- **WHEN** 启用鉴权且客户端以缺失或无效的 `?api_key=` 请求 workspace 文件下载
- **THEN** 返回 401

#### Scenario: 查询参数鉴权不外溢到其它端点
- **WHEN** 客户端对非下载端点（如列表 `GET .../workspace/files` 或任意 `POST`）携带 `?api_key=`
- **THEN** 中间件忽略查询参数，仅按 `X-API-Key` 请求头鉴权（无有效头则 401）

### Requirement: CORS 响应头 MUST 按需收窄
当配置了跨域来源时，系统 SHALL 仅允许实际使用的方法与请求头，SHALL NOT 使用通配 `*` 的方法/头集合（在 `allow_credentials` 生效场景下尤其如此）。

#### Scenario: 允许的方法与头
- **WHEN** 浏览器对已配置来源发起预检（OPTIONS）
- **THEN** 响应仅通告实际使用的方法（GET/POST/DELETE/OPTIONS）与请求头（X-API-Key、Content-Type）

### Requirement: 健康探针依赖探测 MUST 限频
系统 SHALL 对 `/healthz`、`/readyz` 的 DB/Redis 探测结果做短 TTL 缓存，避免高频探针对依赖造成放大负载；`/healthz` SHALL 保持存活语义（进程在线即 200），依赖降级信息在响应体中体现。

#### Scenario: 探测结果在 TTL 内复用
- **WHEN** 在缓存 TTL 窗口内连续多次调用 `/healthz`
- **THEN** 仅首次实际探测 DB/Redis，后续复用缓存结果，且响应始终 200
