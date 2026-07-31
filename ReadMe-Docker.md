# OpenHarness_HyperFrames — Docker 镜像说明

> 更新日期：2026-07-31

本项目所有测试遵循「已有镜像 + 挂载源码/叠加测试层」原则（见 `.qoder/rules/test-on-existing-images.md`），禁止从零重建基础镜像。

## 一、运行链（docker-compose.yml 正式启动必需）

| 镜像 | 大小 | 用途 |
|---|---|---|
| `openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1` | 11.1GB | **主镜像**。compose 的 `openharness` 与 `session` 服务；同时是所有测试镜像的根。tag 由 `.env` 的 `OH_VERSION_HYPERFRAMES_VERSION` 控制（默认 `v0.1.9_v0.7.77_v1.5_v2.1`）。tag 第三段 `v1.5` = Qwen 语音补丁集（TTS 克隆 + ASR 首选，见 `docs/hyperframes-skill-openharness-patches.md` §15） |
| `openharness_hyperframes_web:v0.1.9_v0.7.77_v1.5_v2.1` | 78MB | web 前端 runtime（nginx）。tag 同样由 `OH_VERSION_HYPERFRAMES_VERSION` 控制，须与主镜像 tag 一致（前端代码与 QwenASR 补丁无关，v1.5 由 v1.4 retag 而来，未重建） |
| `openharness_session_frontend:v0.1.0` | 79MB | session-frontend runtime，tag 由 `SESSION_FRONTEND_VERSION` 控制 |
| `postgres:16-alpine` | 420MB | 数据库 |
| `redis:7-alpine` | 58MB | 缓存 / celery broker |
| `minio/minio:latest` | 241MB | workspace / 产物对象存储 |
| `minio/mc:latest` | 117MB | MinIO 初始化客户端 |

## 二、测试链（派生关系）

派生树（FROM 关系）：

```
openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1  (主镜像)
 └─ oh-e2e:latest (11GB)              <- Dockerfile.e2e
     └─ oh-e2e-test:latest (11.1GB)   <- Dockerfile.test（加 pytest 等测试依赖）
         └─ openharness-session-frontend:e2e (12.3GB)
                                      <- session-frontend Playwright E2E 用
```

| 镜像 | 大小 | 用途 / 入口脚本 |
|---|---|---|
| `oh-e2e:latest` | 11GB | E2E 基础镜像。`docker-compose.e2e.yml`、`e2e/run_e2e.sh` |
| `oh-e2e-test:latest` | 11.1GB | 带 pytest 的测试基座。`Dockerfile.session-test` / `Dockerfile.oh-test` 的 FROM 源 |
| `openharness-session-frontend:e2e` | 12.3GB | session-frontend Playwright E2E（`e2e/run-session-frontend-docker-tests.sh`） |
| `openharness-session-frontend:test` | 709MB | session-frontend 单测/lint 阶段 |
| `openharness-web:test` | 504MB | web 单测/lint 阶段（`e2e/run-web-docker-tests.sh`） |
| `openharness-web:smoke` | 78MB | web 冒烟 runtime（`e2e/run-web-docker-smoke.sh`，可用 `WEB_IMAGE=<runtime镜像>` 复用） |
| `oh-session-test:latest` | 12.2GB | session-service MinIO 测试（`e2e/run-session-minio-tests.sh`）。**注意**：基于旧版主镜像构建，已与 v0.7.77 链路脱节，后续建议基于 `oh-e2e-test` 重建替代 |
| `node:22-alpine` | 230MB | 前端多阶段构建的 build 基础镜像 |
| `mcr.microsoft.com/playwright:v1.50.1-noble` | 3.5GB | Playwright E2E 基础镜像（版本须与 `package.json` 中 playwright 版本严格对齐） |

三条链的 11GB 级镜像大量共享 layer，实际磁盘占用远小于表面加和。

## 三、备份 / 历史镜像

| 镜像 | 大小 | 说明 |
|---|---|---|
| `openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1` | 11GB | v1.5（QwenASR 补丁）前的主镜像。**当前主回滚点**，与 v1.5 共享大部分 layer，实际额外占用小；待 v1.5 稳定后可删 |
| `openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1-backup-20260730` | 11GB | 2026-07-30 打补丁前的主镜像快照，与现镜像共享大部分 layer，实际额外占用小 |
| `openharness_hyperframes_web:v0.1.9_v0.7.77_v1.4_v2.1` | 78MB | v1.5 前的 web 镜像（v1.5 即由它 retag），占用可忽略 |
| `openharness_hyperframes_web:v0.1.9_v0.7.77_v1.4_v2.1-backup-20260730` | 78MB | web 同日备份，占用可忽略 |
| `openharness_hyperframes_web:v0.1.9_v0.7.42_v1.4_v2.1` | 78MB | 旧版 web tag（占用极小，暂留） |
| `openharness_hyperframes_web:v1.1` | 78MB | 旧版 web tag（占用极小，暂留） |

## 四、与本项目相关的其他镜像

- `vllm/vllm-omni:v0.24.0`（30.9GB）：Qwen3-TTS / Qwen3-ASR 服务框架，本地挂载模型部署（部署在远端 GPU 机），**保留**。QwenASR wrapper 参考脚本见仓库根 `Qwen3-ASR-Script/`（不进镜像）。

> 宿主机上另有 longcat-video、video-claw-backend、weknora 等其他项目的镜像与数据卷，与本项目无关，勿动。

## 五、清理记录（2026-07-30）

**已删除：**

- `session-frontend-test:p1 / p2 / p3 / p4 / tmp`（补丁迭代中间产物，约 3.5GB）
- `openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.42_v1.4_v2.1`（旧版主镜像 8.3GB）
- `openharness:v0.1.9`（旧基础镜像 4.58GB）
- `docker builder prune -a`（回收 Build Cache 54.26GB）
- `docker volume prune`（仅匿名卷，回收 4.95GB，126 个匿名卷）

**未动：**

- 具名 volume（`weknora_*`、`llm_wiki_*`、`deeppresenter-*` 等属于其他项目）
- `backup-20260730` 两个备份 tag（主镜像回滚点之一，待稳定后再删）

## 五点一、v1.5 构建记录（2026-07-31，QwenASR 首选转写补丁）

- **主镜像**：基于 `v1.4` 用 `Dockerfile.fix` 打补丁层产出 `v0.1.9_v0.7.77_v1.5_v2.1`（新 skill：QwenASR 共享客户端 + 三入口接入），旧 `v1.4` 与 backup 保留作回滚点。
- **web 镜像**：compose 的 web tag 也由 `OH_VERSION_HYPERFRAMES_VERSION` 控制，前端代码与 QwenASR 无关，直接 `docker tag <web:v1.4> <web:v1.5>` 对齐，**未重建**。
- 未配 `QWENASR_URL` 时行为与补丁前完全一致（详见 `docs/hyperframes-skill-openharness-patches.md` §15）。

## 六、常用命令

```bash
# 镜像 tag 变更：改 .env 的 OH_VERSION_HYPERFRAMES_VERSION，勿多处硬编码
# 在已有镜像上打补丁层（不重建）:
docker build -f Dockerfile.fix --build-arg BASE_IMAGE=<现有镜像:tag> -t <新tag> .

# 例：QwenASR 补丁（v1.4 → v1.5）主镜像打补丁 + web 镜像 retag 对齐:
docker build -f Dockerfile.fix \
  --build-arg BASE_IMAGE=openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1 \
  -t openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1 .
docker tag openharness_hyperframes_web:v0.1.9_v0.7.77_v1.4_v2.1 \
  openharness_hyperframes_web:v0.1.9_v0.7.77_v1.5_v2.1

# 后端测试（容器内跑，禁止宿主机 pytest）:
docker compose run --rm --entrypoint bash openharness -c \
  "cd /opt/oh-service && python -m pytest ..."

# E2E / 前端测试入口:
e2e/run_e2e.sh                              # 基于 oh-e2e
e2e/run-session-frontend-docker-tests.sh    # session-frontend 全流水线
e2e/run-web-docker-tests.sh                 # web 单测 + 冒烟
e2e/run-session-minio-tests.sh              # session-service MinIO 套件
```
