# web — HyperFrames 视频工厂前端

基于 **Vite + React + TypeScript** 的单页应用，对应后端的
`POST /v1/videos` 视频生成服务。

## 开发

```bash
npm install
npm run dev      # http://localhost:5173
```

开发服务器通过 `vite.config.ts` 中的代理把 `/v1` 和 `/healthz`
转发到 `http://localhost:8000`（即后端 `api` 服务），因此本地
开发无需配置 CORS。

## 生产构建

```bash
npm run build    # 产物在 dist/
npm run preview  # 本地预览构建产物
```

生产环境（非代理）通过环境变量 `VITE_API_BASE` 指向后端地址：

```bash
VITE_API_BASE=https://your-domain.example.com npm run build
```

## CORS

后端只允许 `OH_CORS_ORIGINS`（逗号分隔）中的来源跨域访问，
且 `allow_credentials=false`。生产部署时务必在 `.env` 中设置：

```bash
OH_CORS_ORIGINS=https://your-frontend.example.com
```

## API 约定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/videos` | 创建任务，返回 `task_id` 与 `links` |
| GET | `/v1/videos/{id}` | 查询任务状态 |
| GET | `/v1/videos/{id}/file` | 视频文件（HTTP Range 流式） |
| GET | `/v1/videos/{id}/events` | SSE 事件流（`log`/`done`/`error`） |
| DELETE | `/v1/videos/{id}` | 取消/删除任务 |
| GET | `/healthz` | 健康检查 |

前端在提交后会同时：① 打开 `events` SSE 流接收实时日志；② 每 2 秒
轮询一次任务状态，直到进入终态（SUCCEEDED / FAILED / CANCELED），
成功后展示视频播放器。
