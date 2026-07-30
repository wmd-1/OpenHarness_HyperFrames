# Service / Web 前后端全量测试报告（2026-07-30）

> 测试范围：`service/`（FastAPI 视频服务）与 `web/`（React SPA + nginx 反代）。
> 执行方式：严格遵循仓库规则《测试必须基于已有镜像》——所有单测/冒烟在已有 Docker 镜像内执行，宿主机仅使用 `docker` / `docker compose` / `curl`，未重建任何基础镜像。
> 配套修复方案：[plans/Service_Web_Test_Fixes_Plan_2026-07-30.md](../plans/Service_Web_Test_Fixes_Plan_2026-07-30.md)

## 结论速览

| 维度 | 结果 |
|---|---|
| service 全量 pytest | ✅ 180 passed / 0 failed / 0 skipped（9.15s） |
| web lint + vitest | ✅ eslint 0 违规；49/49 passed（7 个测试文件） |
| web runtime 冒烟 | ✅ HTTP 200 + 安全头齐全 + 无 server 版本泄漏 |
| API 实况测试（22 项） | ✅ 全部通过（1 项 RFC 协议偏差记为低危问题） |
| nginx 反代实况（8 项） | ✅ 全部通过（SSE 流式不缓冲、Range、401 透传） |
| 浏览器真实操作链路 | ✅ 核心链路通过；发现 3 个前端问题 |
| **发现问题** | **1 高危 + 2 中危 + 2 低危**（见文末） |

---

## 1. 测试环境

- 主镜像：`openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1`
- 测试镜像：`oh-e2e-test:latest`（pytest 层）、`openharness-web:test`（node 构建镜像 `--target test`）
- runtime 冒烟复用：`openharness_hyperframes_web:v0.1.9_v0.7.42_v1.4_v2.1`
- 基础设施：compose 内 `postgres:16-alpine` / `redis:7-alpine` / `minio`（均 healthy）
- 实况栈：`docker compose up -d api web`（api :8000，web :5173）
- 无 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`：真实渲染链路用仓库自带 `e2e/oh_stub.sh`（`OH_OH_BIN` 指向 stub，输出真实可 ffprobe 的 mp4）驱动；另保留一个真实失败场景验证失败路径。

## 2. 自动化测试（镜像内）

### 2.1 service 全量 pytest — ✅ 180 passed

```bash
docker run --rm --entrypoint /root/.openharness-venv/bin/python \
  -v $PWD/service:/opt/oh-service -w /opt/oh-service \
  oh-e2e-test:latest -m pytest tests/ -q
# => 180 passed in 9.15s
```

覆盖 21 个测试文件：API 边界、SSE、streaming、租户鉴权/隔离/存储、限流、S3、worker/runner/parser、beat、迁移、可观测性等。

> 踩坑记录：`oh-e2e-test` 镜像默认 entrypoint 是 supervisord（会拉起 api+worker 吞掉命令），跑 pytest 必须显式 `--entrypoint` 覆盖。

### 2.2 web lint + vitest + 冒烟 — ✅ 全绿

```bash
WEB_IMAGE=openharness_hyperframes_web:v0.1.9_v0.7.42_v1.4_v2.1 \
  bash e2e/run-web-docker-tests.sh
```

- lint：eslint 0 违规
- vitest：7 文件 49/49 passed（api/api.harden/utils/store/TaskDetail/Composer/App）
- 冒烟（复用已有 runtime 镜像，未重建）：HTTP 200、`X-Content-Type-Options`、`Referrer-Policy`、`server_tokens off` 全部通过

## 3. API 实况测试（tenant：qa-alpha / qa-beta，测后已 deactivate）

### 3.1 健康与鉴权

| 用例 | 结果 | 说明 |
|---|---|---|
| `GET /healthz` | ✅ | `{"status":"ok","db":"ok","redis":"ok","s3":"ok"}` |
| `GET /readyz` | ✅ | 正常返回 pending/running 计数 |
| 无 key POST | ✅ 401 | 多 key 鉴权模式生效（api_keys 表非空） |
| 错误 key | ✅ 401 | `{"detail":"Invalid API key"}` |
| `X-API-Key` 头鉴权 | ✅ | 正常放行 |
| `?api_key=` 查询参数回退（/events、/file） | ✅ | EventSource/video 标签场景可用 |

> 注意：鉴权头是 **`X-API-Key`**，不是 `Authorization: Bearer`。

### 3.2 输入校验与安全

| 用例 | 结果 |
|---|---|
| 空 prompt / 超长 8001 字符 / 坏 JSON | ✅ 均 422 |
| `extra_oh_args` 注入 `--permission-mode` | ✅ 422，明确报 "not caller-controllable" |
| 非法 UUID 路径参数 | ✅ 422 |

### 3.3 幂等与租户隔离

| 用例 | 结果 |
|---|---|
| 同租户同 `idempotency_key` 重放 | ✅ 返回同一 task_id |
| **跨租户**同 `idempotency_key` | ✅ 各建各的任务（租户作用域幂等） |
| B 租户 GET / DELETE / 下载 A 的任务 | ✅ 全部 404（不泄露存在性） |
| 不存在的任务 | ✅ 404 |

### 3.4 完整生命周期（stub 渲染）

- queued → running → **succeeded**，SSE 实时日志逐条推送（`[oh-stub]` 行）→ `event: done {"status":"completed"}`
- 元数据探测正确：`file_size_bytes=2325`、`duration=1.0s`、`320x240`、`fps=25`、`exit_code=0`
- 产物落 MinIO：`oh-tenants/tenants/qa-alpha/videos/{task_id}.mp4` ✅
- 失败路径（真实 oh 二进制不可执行场景）：`status=failed` + 清晰 `error_message` + workspace 被及时清理 ✅
- 取消运行中任务：`DELETE` → SIGTERM → `status=canceled` ✅

### 3.5 下载与 Range

| 用例 | 结果 |
|---|---|
| 完整下载 | ✅ 200，`video/mp4`，`Accept-Ranges: bytes`，`Content-Disposition` 正确，文件为合法 ISO MP4 |
| `Range: bytes=0-1023` | ✅ 206，精确 1024B，`Content-Range: bytes 0-1023/2325` |
| 越界 Range（start ≥ size） | ⚠️ 返回 206 钳位到末字节，RFC 7233 应为 416（低危，见问题 #4） |

### 3.6 限流与配额（20 并发突发创建）

- 结果：**5×201 + 15×429** ✅
- token bucket（capacity=10, refill=1/s）+ 租户配额（`tenant_max_active=4`）双层生效

## 4. web 实况测试

### 4.1 nginx 反代层（:5173）

| 用例 | 结果 |
|---|---|
| 首页 + CSP/X-Frame-Options/nosniff/Referrer-Policy | ✅ 全齐，CSP 严格（实测拦截了注入的 inline script） |
| 静态资源 `application/javascript` | ✅ 200 |
| SPA fallback（深层路由） | ✅ 200 |
| `/healthz`、`/v1` 反代 | ✅ 后端响应透传（含 401） |
| 反代下载 + Range | ✅ 206 |
| 反代 SSE | ✅ 逐条流式到达，无缓冲 |

### 4.2 浏览器真实操作（Browser subagent）

- ✅ 核心链路：健康徽章 `API: ok` → 写入 key → 提交 prompt（字数统计正常）→ 201 → 任务出现并自动选中 → 实时日志滚动 → 8s 后 succeeded → `<video>` 可播放（readyState=4）→ 下载可用
- ✅ 负面场景：错误 key → ErrorBanner 弹出 `HTTP 401`，8s 自动消失 + 可手动关闭
- ✅ console 无应用自身报错（仅测试操作预期产物）
- ⚠️ 页面**没有 API Key 输入 UI**（组件存在未挂载，测试是直接写 localStorage 绕过的）→ 问题 #2
- ⚠️ 后台标签页下任务列表 UI 不更新（rAF 冻结）→ 问题 #3
- ℹ️ 无任务列表拉取能力（`GET /v1/videos` → 405）→ 问题 #5
- 截图缺失：测试浏览器窗口处于后台，screenshot 工具超时；功能证据均来自 DOM 快照

## 5. 发现的问题

| # | 严重度 | 问题 | 位置 | 修复方案 |
|---|---|---|---|---|
| 1 | 🔴 高 | `docker compose up api` 的任务**永远卡 queued**：镜像内 supervisord 启动 worker 未带 `-Q high,normal,low`（只订阅默认 `celery` 队列），而调度器投递到 high/normal/low；且镜像内 conf 无 beat（丢失任务回收/过期清理不跑）。e2e 入口 `oh-role` 正确，仅 `oh-serve` 路径受影响。仓库 `docker/supervisord.conf` 现版有 beat 但同样缺 `-Q` | 镜像 `/etc/supervisor/conf.d/oh-service.conf`（源头 `docker/supervisord.conf` + `Dockerfile:170`） | 见 plans P1 |
| 2 | 🟡 中 | `ApiKeyInput` 组件存在但 `App.tsx` 从未渲染——多 key 鉴权下页面无填 key 入口，普通用户不可用 | `web/src/App.tsx` | 见 plans P2 |
| 3 | 🟡 中 | `store.tsx` 用 `requestAnimationFrame` 批量刷新 state，后台标签页 rAF 冻结 → UI 与内部状态脱节 | `web/src/store.tsx` L113-140 | 见 plans P3 |
| 4 | 🟢 低 | 越界 Range 返回 206（钳位末字节），RFC 7233 §4.4 应 `416 + Content-Range: bytes */{size}` | `service/app/routers/videos.py` L305 | 见 plans P4 |
| 5 | 🟢 低 | 无任务列表端点（405），前端刷新后历史任务不可见 | 前后端 | 见 plans P5（建议 openspec 立项） |

## 6. 测试遗留与清理

- ✅ 已清理：临时 worker 容器（`oh-live-worker`）、两个测试 API key（qa-alpha / qa-beta，已 deactivate）
- ⏳ 残留（无害，可按需清理）：MinIO 中 3 个测试产物对象（约 7KB，`tenants/qa-alpha|qa-beta/videos/`）、DB 中 20 余条测试任务记录（qa-alpha/qa-beta 租户，可用 `scripts/purge_tenant.py` 清除）

## 7. 复现要点备忘

- 镜像内跑 service pytest：必须 `--entrypoint /root/.openharness-venv/bin/python`（默认 entrypoint 是 supervisord）
- `e2e/oh_stub.sh` git mode 是 644：容器内使用需 `install -m 755` 拷贝，不要改仓库文件权限
- web 测试统一入口：`e2e/run-web-docker-tests.sh`（`WEB_IMAGE=` 复用 runtime 镜像避免重建）
