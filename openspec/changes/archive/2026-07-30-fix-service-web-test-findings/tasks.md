# Tasks: fix-service-web-test-findings

> 按 Phase 1 → 2 → 3 顺序实施；三个 Phase 相互独立、可单独回滚。所有测试遵循「已有镜像 + 挂载源码/叠加测试层」规则。

## 1. Phase 1 — worker 队列部署契约（P1，高危）

- [x] 1.1 修改 `docker/supervisord.conf`：`[program:worker]` command 改为 `/bin/bash -c 'exec ... celery worker -l info -c "${OH_CELERY_CONCURRENCY:-4}" -Q "${OH_WORKER_QUEUES:-high,normal,low}"'`（design D1）
- [x] 1.2 新增 `service/tests/test_deployment_contract.py`：三条断言（worker 订阅集合 ⊇ `settings.worker_queues`、`[program:beat]` 存在、`queue_for_priority()` 值域 ⊆ 订阅集合）；conf 路径经 `OH_SUPERVISORD_CONF` 可覆盖，缺失时 skip（design D2）
- [x] 1.3 修改 `Dockerfile.fix`：在 `COPY service /opt/oh-service` 附近追加 `COPY docker/supervisord.conf /etc/supervisor/conf.d/oh-service.conf`
- [x] 1.4 备份现有主镜像 tag（`docker tag ...:v0.1.9_v0.7.77_v1.4_v2.1 ...:v0.1.9_v0.7.77_v1.4_v2.1-backup-20260730`），再用 `Dockerfile.fix`（`BASE_IMAGE=备份 tag`）同 tag 覆盖构建
- [x] 1.5 重建 `oh-e2e` / `oh-e2e-test` 衍生叠加层（不重建基础镜像）
- [x] 1.6 验证：契约测试由红转绿；`docker run --rm --entrypoint cat <镜像> /etc/supervisor/conf.d/oh-service.conf` 确认 worker 行含 env-fallback 且有 `[program:beat]`
- [x] 1.7 实况验证：`docker compose up -d --force-recreate api`，容器内确认 worker `[queues]` 含 high/normal/low + beat 进程；curl 建任务（临时 key，测完 deactivate）确认状态离开 `queued`，`redis-cli llen normal` 归零
- [x] 1.8 回归：oh-e2e-test 镜像 + 挂载 `service/` 跑全量 pytest（180 passed + 新增契约用例）

## 2. Phase 2 — 越界 Range 返回 416（P4）

- [x] 2.1 修改 `service/app/routers/videos.py`：Range 解析成功后、钳位前加 416 判定（first-byte-pos ≥ size 含 `bytes=-0` → `416 + Content-Range: bytes */{size}`）；判定提前到 `storage.open` 之前或确保 fileobj 先关闭（design D4）
- [x] 2.2 `service/tests/test_streaming.py` 新增 3 条用例：`bytes={size}-` → 416；`bytes=-0` → 416；回归 `bytes=0-1023` / `bytes=-100` 仍 206
- [x] 2.3 镜像内跑 `tests/test_streaming.py` + 全量 pytest 回归（`--entrypoint` 覆盖，挂载 `service/`）

## 3. Phase 3 — 前端 API Key 入口 + 批量刷新去 rAF（P2+P3，同一提交）

- [x] 3.1 修改 `web/src/App.tsx`：sidebar `<Composer />` 之上渲染 `<ApiKeyInput />`（组件与样式零改动）
- [x] 3.2 修改 `web/src/store.tsx`：`rafRef` → `flushTimerRef`，`requestAnimationFrame(flush)` 替换为 `scheduleFlush()`（trailing `setTimeout(32ms)`）；cleanup 改 `clearTimeout`；删除全部 rAF 句柄与 `cancelAnimationFrame`；不新增 visibilitychange 监听（design D5）
- [x] 3.3 `web/src/__tests__/App.test.tsx` 增加断言：渲染 App 后存在 `API Key（X-API-Key）` label
- [x] 3.4 新增 `web/src/__tests__/ApiKeyFlow.test.tsx` 真实链路 4 用例：输入+保存 → localStorage；mock fetch → `X-API-Key` 头；mock EventSource → `?api_key=`；清除 → 不再携带
- [x] 3.5 `web/src/__tests__/store.test.tsx` 新增 3 用例（fake timers）：32ms 后提交（后台冻结回归）；窗口内多次更新单次合并提交；卸载后无 setState 告警
- [x] 3.6 跑镜像内流水线：`WEB_IMAGE=<现有 runtime 镜像> bash e2e/run-web-docker-tests.sh`（lint + vitest + 冒烟）
- [x] 3.7 发布：按需 `WEB_NEW_TAG` 打新 runtime tag，`docker compose up -d web`，浏览器确认 sidebar 有 API Key 输入区

## 4. 收尾

- [x] 4.1 更新 `service/API_DOCUMENTATION.md`：`/file` Range 语义补充 416 行为
- [x] 4.2 更新 `web/README.md`（如有 UI 截图/说明涉及 sidebar 布局则同步；WF6 要求的 key 风险说明确认仍在）
- [x] 4.3 全量回归：service 全量 pytest + `e2e/run-web-docker-tests.sh` 全绿；清理临时测试 key 与任务记录
