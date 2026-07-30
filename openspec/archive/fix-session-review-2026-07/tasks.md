## 1. 鉴权与部署加固（F1/F3/F11）

- [x] 1.1 `main.py` 新增 `_WORKSPACE_FILE_PATH_RE` 并将中间件查询参数放行扩为「GET ∧ (artifact ∨ workspace-file)」，更新注释（F1/D1）
- [x] 1.2 `main.py` CORS `allow_methods`→`[GET,POST,DELETE,OPTIONS]`、`allow_headers`→`[X-API-Key,Content-Type]`（F11/D8，先核对前端 ky 实际用法）
- [x] 1.3 `.env.example` 增加 session 鉴权小节（`OH_API_KEY`/`OH_REQUIRE_AUTH` 注释 + 开放模式风险说明）（F3/D7）
- [x] 1.4 `docker-compose.yml` session 服务：透传 `OH_API_KEY`/`OH_REQUIRE_AUTH`（默认开放）、`8001:8001`→`127.0.0.1:8001:8001`（F3/D7）
- [x] 1.5 `docker compose config` 校验渲染无误；核对 e2e 脚本访问方式不受端口绑定影响

## 2. 单写者与多节点正确性（F4/F2/F9）

- [x] 2.1 `main.py` 新增 `_assert_single_worker()`，`api_workers != 1` fail-fast（F4/D3）
- [x] 2.2 `proxy.py::proxy_ws` 增 `client_api_key` 参数，转发客户端原始 key、删除 `settings.api_key` 注入、开放模式不带头（F2/D2）
- [x] 2.3 `ws.py::session_ws` 将握手已提取的 `provided` 原始 key 传入 `proxy_ws`（F2/D2）
- [x] 2.4 复核 `registry.py` epoch 比较语义后，`next_epoch` 改 Redis `INCR` + `SET NX` 时间戳播种（F9/D5）

## 3. 健壮性与校验（F5/F6/F7/F10）

- [x] 3.1 `schemas.py` 定义 `MAX_TURN_TEXT_LEN=32000`，`TurnSubmitRequest.text.max_length` 引用之（F5/D4）
- [x] 3.2 `ws.py` submit 分支超限回 `error`（`code=text_too_long`），不断开、不启动轮次（F5/D4）
- [x] 3.3 `supervisor.py::_await_approval` 保存 timeout task 引用并在完成/`finally` 路径 `cancel()`（F6/D6）
- [x] 3.4 `supervisor.py::respond_approval` 的 `assert live.adapter is not None` 改显式检查抛既有异常（F7/D6）
- [x] 3.5 `health.py` 为 `_db_ok`/`_redis_ok` 加 5s TTL 缓存，healthz/readyz 共享，语义不变（F10/D9）

## 4. 代码清理（F8/L1–L4）

- [x] 4.1 `workspace_store.py` 暴露 `scan_local`/`safe_local_path` 公共 API，`sessions.py` 改用（F8/D10）
- [x] 4.2 grep 确认无引用后删除 `deps.py::get_current_tenant_id`（L1）
- [x] 4.3 `db.py` 弃用的 `asyncio.get_event_loop()` 替换为 `get_running_loop()`（确认调用点在运行事件循环内）（L2）
- [x] 4.4 `sessions.py` 移除未使用的 `SessionBusy` import（L3）；`supervisor.py` 三元 kill_group 表达式展开为 if（L4）

## 5. 测试与验证（已有镜像内执行）

- [x] 5.1 新增 `tests/test_auth_query_param.py`：F1 白名单矩阵（artifact/workspace-file/其它 × GET/POST × header/query）
- [x] 5.2 新增 `tests/test_ws_submit_limit.py`：F5 长度边界（32000 通过、+1 拒绝且不断开）
- [x] 5.3 新增 `tests/test_proxy_credential.py`：F2 mock `websockets.connect` 断言透传客户端 key / 开放模式不带头
- [x] 5.4 新增 `tests/test_registry_epoch.py`：F9 严格递增 + 存量播种
- [x] 5.5 F4 启动校验、F6 task 取消并入既有对应测试文件
- [x] 5.6 在主镜像容器内跑全量 pytest：`docker compose run --rm --entrypoint bash session -c "cd /opt/oh-session-service && python -m pytest tests/ -q"`
- [x] 5.7 （可选）session e2e 冒烟回归端口绑定变更

## 6. 文档

- [x] 6.1 `session-service/README.md` 补充：多节点明文 `ws://` 须置于加密内网、多进程部署禁忌、生产鉴权开启方式

## 7. 收尾

- [x] 7.1 `openspec validate fix-session-review-2026-07 --strict` 通过
- [x] 7.2 全部任务勾选后归档 change 到 `openspec/archive/`
