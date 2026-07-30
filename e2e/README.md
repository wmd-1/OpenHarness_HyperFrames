<!-- 最后更新：2026-07-30 -->

# e2e — 端到端 / 冒烟 / 验收测试

本目录收纳全部 E2E、冒烟与实况验收脚本及历史测试报告。核心约定
（见仓库规则 `test-on-existing-images`）：

1. **一切测试在已有 Docker 镜像内执行**，宿主机只允许 `docker` / `docker compose` / `curl`；
2. **不从零重建基础镜像**：测试镜像一律 `FROM` 已有镜像叠加测试层
   （`Dockerfile.e2e` → `Dockerfile.test` → `Dockerfile.session-test` / `Dockerfile.oh-test`）；
3. 源码经 volume 挂载进容器，改代码后无需重建镜像。

## 脚本清单

### 后端 E2E / 冒烟

| 脚本 | 用途 |
| --- | --- |
| `run_e2e.sh` | 多实例验收主入口：构建 e2e 叠层镜像，拉起 api×2 / worker×2 + beat + postgres/redis/minio 全栈跑验收 |
| `run-video-minio-smoke.sh` | 视频服务 MinIO 多租户冒烟（产物入桶、租户前缀、下载端点） |
| `run-session-minio-tests.sh` | session 服务 WS-B 租户存储套件（在已有 `oh-session-test` 镜像内跑，源码挂载） |
| `run-session-container-pool-tests.sh` | WS-C/WS-D 容器运行时 + 池化调度 E2E |
| `run-session-live-acceptance.sh` | session 实况验收入口（REST/WS/前端三段，见 `session-acceptance/`），固化 2026-07-30 手工验收流程 |

### 前端流水线

| 脚本 | 用途 |
| --- | --- |
| `run-web-docker-tests.sh` | web 前端全量流水线：镜像内 lint+vitest → 构建 runtime 镜像 → 容器冒烟；`WEB_NEW_TAG=<tag>` 可给通过验证的镜像打标 |
| `run-web-docker-smoke.sh` | web 冒烟（安全响应头断言）；`WEB_IMAGE=<已有镜像>` 复用已有 runtime 镜像不重建 |
| `run-session-frontend-docker-tests.sh` | session-frontend 全量流水线：单测 → runtime 冒烟 → Playwright E2E（`mock-backend.mjs` 模拟后端） |

### 辅助

| 文件 | 用途 |
| --- | --- |
| `oh_stub.sh` | `oh` CLI 的忠实替身（仅用于多实例 e2e，复刻真实调用形态） |
| `flatten-oh-image.sh` | 把多层镜像压平为 1 层，规避目标机 overlay2 的 125 层上限 |
| `session-acceptance/` | 实况验收分段脚本：`lib.sh`（公共库）、`rest.sh`、`ws.sh`、`frontend.sh` |
| `*_report_*.txt` | 历史执行报告（只读存档） |

## 常用入口

```bash
bash e2e/run_e2e.sh                                # 视频服务多实例验收
bash e2e/run-session-live-acceptance.sh            # session 实况验收
bash e2e/run-web-docker-tests.sh                   # web 前端全量流水线
bash e2e/run-session-frontend-docker-tests.sh      # session 前端全量流水线
```

stub 模式（无 LLM key 离线验收）用 override 固化，避免配置漂移：

```bash
docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session
```

## 新增脚本约定

- `FROM` 已有镜像叠加测试层，或直接 `docker compose run` 进已有镜像；
- 镜像 tag 通过环境变量传入（`WEB_IMAGE`、`WEB_NEW_TAG`、`OH_VERSION_HYPERFRAMES_VERSION` 等），不要多处硬编码；
- 执行报告以 `*_report_<date>.txt` 存档在本目录。
