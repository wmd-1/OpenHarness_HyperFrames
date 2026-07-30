# Proposal: fix-service-web-test-findings

## Why

2026-07-30 前后端全量实况测试（见 `docs/service-web-test-report-2026-07-30.md`）发现 4 个需修复的问题，其中 P1 为高危：compose `api` 单容器路径（oh-serve/supervisord）的 Celery worker 未订阅优先级队列，导致该部署形态下**所有任务永久卡在 `queued`**。其余为前端 API Key 入口未挂载（多租户下 UI 不可用）、后台标签页 UI 冻结、越界 Range 违反 RFC 7233。修复方案已评审通过（`plans/Service_Web_Test_Fixes_Plan_2026-07-30.md`，含 4 项评审调整）。

## What Changes

按 Phase 交付（P5 任务列表端点不在本变更范围，另行立项）：

- **Phase 1（P1，高危）**：`docker/supervisord.conf` worker command 改为 `bash -c` + `${OH_WORKER_QUEUES:-high,normal,low}` env-fallback（不硬编码，与 `oh-role` 同构）；`Dockerfile.fix` 补丁层同步 conf 进现有镜像；**新增部署契约测试** `service/tests/test_deployment_contract.py`，断言镜像内 supervisord conf 的 worker 订阅集合与 `app/config.py::worker_queues`、`scheduler.queue_for_priority()` 值域对齐，防止配置再次漂移。
- **Phase 2（P4）**：`GET /v1/videos/{id}/file` 对不可满足的 Range（first-byte-pos ≥ 文件长度，含 `bytes=-0`）返回 `416 + Content-Range: bytes */{size}`，替代现行钳位返回 206 的行为。
- **Phase 3（P2+P3，前端同一提交）**：
  - P2：在 `App.tsx` sidebar 挂载已实现但未渲染的 `ApiKeyInput` 组件；新增真实链路测试（输入 key → localStorage → `X-API-Key` 请求头 / SSE `?api_key=` → 清除后不再携带）。
  - P3：`store.tsx` 批量刷新调度从 `requestAnimationFrame` 改为统一 trailing `setTimeout(32ms)`（去 rAF、不引入 visibilitychange 监听），消除后台标签页 UI 冻结；保留 ref-based pending 合并缓冲。

无 **BREAKING** 变更（416 是对既有未定义越界行为的 RFC 修正；合法 Range 语义不变）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `video-service-hardening`：
  - R13（queue tiering）从 SHOULD 收紧：**所有部署入口**（oh-role 与 oh-serve/supervisord）的 worker MUST 订阅全部优先级队列，队列集合 MUST 支持 env 覆盖 + 默认值兜底，并由镜像内部署契约测试守护；
  - 下载端点新增 Range 合规要求：不可满足范围 MUST 返回 416。
- `web-front-end`：
  - WF5/WF6 补充：API Key 管理入口 MUST 在 UI 挂载可用，key 链路（输入 → localStorage → 请求头/SSE 查询参数 → 清除）MUST 有自动化测试覆盖；
  - WF7 补充：任务状态批量刷新调度 MUST NOT 依赖仅在页面可见时触发的调度原语（rAF），后台标签页下状态提交不得无限期延迟。

## Impact

- **代码**：`docker/supervisord.conf`、`Dockerfile.fix`、`service/app/routers/videos.py`（Range 判定）、`web/src/App.tsx`、`web/src/store.tsx`
- **测试**：新增 `service/tests/test_deployment_contract.py`、`service/tests/test_streaming.py` +3 用例、`web/src/__tests__/ApiKeyFlow.test.tsx`、`web/src/__tests__/store.test.tsx` +3 用例、`App.test.tsx` +1 断言
- **镜像/部署**：主镜像 `openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1` 经 `Dockerfile.fix` 打补丁层同 tag 覆盖（先备份 tag）；`oh-e2e`/`oh-e2e-test` 衍生层重建；web runtime 镜像按需 `WEB_NEW_TAG` 发新 tag。契约测试在未打补丁镜像上预期先红后绿。
- **API 面**：`/file` 端点对越界 Range 的响应码从 206 变为 416（客户端标准行为，curl/浏览器原生兼容）；无新增端点。
- **依赖/系统**：无新依赖；所有测试遵循「已有镜像 + 挂载源码/叠加测试层」规则执行。
