# Tasks: add-qwen3-asr-preferred-support

## 1. 部署参考脚本入库（不进镜像）

- [x] 1.1 新增 `Qwen3-ASR-Script/qwen3_asr_server.py`：FastAPI wrapper + `Qwen3ASRModel.LLM`（vLLM offline backend）+ ForcedAligner；实现 `POST /transcribe`（multipart：file/language/model/timestamps → `{ok,language,text,words,duration_s}`）、`GET /healthz`、`QWEN3_ASR_MAX_AUDIO_SEC` ffprobe 预检（超限 413）、静音返回 `{ok:true,text:"",words:[]}`
- [x] 1.2 新增 `Qwen3-ASR-Script/README.md`：远端部署步骤、5 个服务端环境变量（含默认 `Qwen/Qwen3-ASR-1.7B` / `Qwen/Qwen3-ForcedAligner-0.6B` 及两模型职责互斥说明）、aligner 11 语言限制、curl 契约自测示例
- [x] 1.3 确认 `Dockerfile.fix` / 主镜像构建不 COPY `Qwen3-ASR-Script/`（D8 交付边界）

## 2. 共享 HTTP 客户端

- [x] 2.1 新增 `hyperframes_github_skills/media-use/scripts/lib/qwenasr.mjs`：Node 18+ 原生 fetch/FormData multipart 上传完整音频（不 base64、不客户端 chunk）；ISO→Qwen 语言全名映射（表外语言不发 `language` 字段）；`QWENASR_MODEL` 设置时才透传 `model`；`QWENASR_TIMEOUT_MS`（默认 600000）AbortController 超时；任何运行期失败（不可达/非 200 含 413/`ok:false`/超时/JSON 解析失败）返回 `null`
- [x] 2.2 `node --check` 通过（宿主机仅静态检查，运行验证在容器内）

## 3. 补丁 A：media-use/scripts/transcribe.mjs

- [x] 3.1 引擎链扩为 `qwenasr（QWENASR_URL 设置时最高优先级）→ parakeet → whisper.cpp`；auto 模式失败 console.error 一行后落回既有链；输出 `engine:"qwenasr"`
- [x] 3.2 `--engine qwenasr` 显式指定：未配置 `QWENASR_URL` 或调用失败时非零退出（fail-fast，报错指明 `$QWENASR_URL`）
- [x] 3.3 落实 words 可用性判定：`words` 非空（或静音 `[]`）才采用，否则完整回退（禁止混合）；`node --check` 通过

## 4. 补丁 B：media-use/audio/scripts/lib/tts.mjs#transcribeWav()

- [x] 4.1 `transcribeWav()` 开头注入 QwenASR 分支：成功且 words 可用时映射为既有 flat 词数组直接返回（不再 spawn `npx hyperframes transcribe`）；失败/words 不可用时落回 whisper.cpp 原路径
- [x] 4.2 确认不触碰同文件 QwenTTS 补丁的 provider 链与合成逻辑（D7）；`node --check` 通过

## 5. 补丁 C：embedded-captions/scripts/transcribe.cjs

- [x] 5.1 内联 ~40 行 CJS 等价客户端（顶部注释注明与 `qwenasr.mjs` 保持同步，不跨 skill import）；引擎链扩为 `qwenasr → whisperx → whisper.cpp`，归一化输出 `engine` 字段标识 qwenasr
- [x] 5.2 `TRANSCRIBE_ENGINE=qwenasr` 显式指定 fail-fast；auto 模式失败完整回退；既有静音守卫/尾部幻觉裁剪逻辑保持不动；`node --check` 通过

## 6. 文档补丁（7 处，qwenasr 关键字可 grep）

- [x] 6.1 `media-use/SKILL.md` frontmatter、`media-use/references/audio.md`、`media-use/references/setup-providers.md`、`media-use/references/operations.md`：QWENASR_URL 设置时 QwenASR 为首选转写引擎
- [x] 6.2 `media-use/audio/references/transcribe.md` 新增 `## QwenASR (remote deployment)` 节：4 个容器侧变量、aligner 语言限制与完整回退语义
- [x] 6.3 `embedded-captions/SKILL.md` 引擎链说明更新
- [x] 6.4 `talking-head-recut/SKILL.md` callout：切换到 media-use transcribe 入口 + `jq '.words'` flat 数组转换
- [x] 6.5 `grep -ril qwenasr hyperframes_github_skills/` 命中 7 处文档 + 3 个补丁脚本 + 共享客户端

## 7. 配置与镜像

- [x] 7.1 `docker-compose.yml`：`openharness`、`api` 服务透传 4 个 `QWENASR_*` 变量（空串默认）；确认无 `QWEN3_ASR_*` 服务端变量进 compose
- [x] 7.2 `.env.example` 加 4 个变量占位与注释
- [x] 7.3 `Dockerfile.fix` 补丁层重建镜像，tag 第三段 `v1.4 → v1.5`；`.env` 的 `OH_VERSION_HYPERFRAMES_VERSION` 更新（旧 v1.4 镜像保留不删）

## 8. 容器侧五项验收（基于已有镜像，宿主机仅 docker/curl）

> 说明：8.1 / 8.3 / 8.5 依赖远端真实 GPU 上的 QwenASR 服务（按 `Qwen3-ASR-Script/README.md` 部署并配置 `QWENASR_URL`），
> 当前环境无 GPU 服务，标记为 `[~]` **延后至目标机由用户验证**。其余可在已有镜像内完成的项（8.2 schema / 8.4 fallback）已验收通过（18/18）。

- [~] 8.1 API 契约：远端服务可达后 `curl /healthz` + `curl -F file=@sample.wav /transcribe | jq -e '.ok and (.words|type=="array")'` 验证契约字段 —— ⏳ 待远端服务就绪后由用户在目标机验证
- [x] 8.2 timestamp schema 兼容：容器内跑入口 A/B/C 各一条样例，确认输出 `[{text,start,end}]`（秒）且下游消费方（captions/check-timing.cjs --strict）解析通过
- [~] 8.3 TTS → ASR → caption 链路：QwenTTS 合成一条 wav → `transcribeWav()` 经 QwenASR 取回词级时间戳 → 生成 caption，全程无 whisper 进程被 spawn —— ⏳ 待远端服务就绪后由用户在目标机验证
- [x] 8.4 fallback 行为：四情形逐一验证——URL 未设（行为与上游一致、日志无 qwenasr 痕迹）、服务不可达（auto 回退）、`words:null`（完整回退，无混合输出）、显式 engine 失败（非零退出）
- [~] 8.5 长音频稳定性：≥10 分钟样例单请求成功，words 覆盖全时长且时间戳单调不减；超限 413 情形回退验证 —— ⏳ 待远端服务就绪后由用户在目标机验证

## 9. 补丁归档

- [x] 9.1 实施终态并入 `docs/hyperframes-skill-openharness-patches.md` 作"补丁三：QwenASR"：全部注入点、env 变量、fallback 语义、上游同步重放说明（`qwenasr` 关键字判据）；镜像 tag 第三段语义更新为"Qwen 语音补丁集（TTS 克隆 + ASR 首选）"
