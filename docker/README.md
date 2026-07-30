<!-- 最后更新：2026-07-30 -->

# docker — 构建期资源

主镜像（仓库根 `Dockerfile`）构建时使用的资源目录。

## 内容

| 文件/目录 | 用途 |
| --- | --- |
| `supervisord.conf` | 镜像内进程编排：`api`（uvicorn :8000, 2 workers）、`worker`（celery，队列/并发经 `OH_WORKER_QUEUES` / `OH_CELERY_CONCURRENCY` env-fallback）、`beat`（celery beat），工作目录均为 `/opt/oh-service` |
| `chrome/`（git 忽略） | 需手动放入 `chrome-headless-shell-linux64.zip`，构建时解压到镜像 `/opt/chrome-headless-shell-linux64/`（hyperframes 渲染依赖） |

## 注意

- `chrome-headless-shell-linux64.zip` 被 git 忽略，构建前需从上游下载放到
  `docker/chrome/`，否则 `Dockerfile` 构建失败。
- 修改 `supervisord.conf` 属于镜像内容变更：用仓库根 `Dockerfile.fix`
  （`ARG BASE_IMAGE`）在已有镜像上打补丁层，不要从零重建。
