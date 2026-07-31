# Proposal: add-qwen3-asr-preferred-support

## Why

HyperFrames skill 的 ASR 链路（captions、transcript-cut、embedded-captions 80ms 时间门、talking-head 卡片同步）全部依赖**词级时间戳** `[{text,start,end}]`，目前只能靠容器内 CPU 跑 whisper.cpp / WhisperX 获取，速度慢且是 QwenTTS 合成链路的时间戳质量瓶颈。远端 GPU 服务器已具备部署 Qwen3-ASR + Qwen3-ForcedAligner 的条件，可通过一次 HTTP 调用同时返回文本与词级时间戳。本变更解决的是 **word-level timestamp 的获取问题**，不是评估 Qwen3-ASR 相对 Whisper 的识别收益（不做 WER/CER benchmark）。

方案依据：[docs/hyperframes-skill-qwen3-asr-integration-plan.md](../../../docs/hyperframes-skill-qwen3-asr-integration-plan.md)（rev3，用户已确认）。

## What Changes

- **新增共享 HTTP 客户端** `hyperframes_github_skills/media-use/scripts/lib/qwenasr.mjs`：纯 Node 18+ fetch，调远端 QwenASR 封装服务（FastAPI wrapper + `Qwen3ASRModel.LLM`（vLLM offline backend）+ ForcedAligner，**非** OpenAI-compatible `vllm serve`），任何运行期失败返回 `null`。
- **补丁 A**：`media-use/scripts/transcribe.mjs` 引擎链扩为 `qwenasr（QWENASR_URL 设置时最高优先级）→ parakeet → whisper.cpp`，`--engine qwenasr` 可显式指定（fail-fast）。
- **补丁 B**：`media-use/audio/scripts/lib/tts.mjs` 的 `transcribeWav()` 开头注入 QwenASR 分支，打通 QwenTTS 合成 → QwenASR 时间戳 → caption 的自托管闭环；失败落回 whisper.cpp。
- **补丁 C**：`embedded-captions/scripts/transcribe.cjs` 引擎链扩为 `qwenasr → whisperx → whisper.cpp`（内联 ~40 行 CJS 客户端，不跨 skill import）；既有静音守卫/尾部幻觉裁剪保留不动。
- **fallback 语义**：对需要时间戳的调用方，QwenASR 结果可用 ⇔ `ok:true` 且 `words` 非空（或静音时 `[]`）；`words:null`/为空 → **整体不可用、完整回退**，禁止 QwenASR text + 其他引擎 timestamp 混合。
- **新增部署参考脚本** `Qwen3-ASR-Script/`（qwen3_asr_server.py + README）：仅供远端部署方参考，不进主镜像、部署运维不归本项目。
- **配置**：新增 4 个 `.env` 变量（`QWENASR_URL` / `QWENASR_MODEL` / `QWENASR_TRANSCRIBE_PATH` / `QWENASR_TIMEOUT_MS`），docker-compose 透传，`.env.example` 加占位；镜像 tag 第三段 `v1.4 → v1.5`（`Dockerfile.fix` 补丁层重建，不从零构建）。
- **文档补丁 7 处**（media-use 4 处、embedded-captions 1 处、talking-head-recut 1 处、audio/references/transcribe.md 1 处新增节）。
- **补丁归档**：实施后终态并入 `docs/hyperframes-skill-openharness-patches.md` 作"补丁三：QwenASR"（与既有 QwenTTS 补丁并列，`qwenasr` 关键字作上游同步时的定制判据）。
- `QWENASR_URL` 未设置时全链路行为与上游完全一致（零影响）——非 BREAKING。

## Capabilities

### New Capabilities

- `skills-asr-transcription`: hyperframes skill ASR/转写链路的 QwenASR 首选 provider 行为——三个代码入口的引擎选择、HTTP API 契约消费、词级时间戳 schema、fallback matrix（含禁止跨引擎混合）、长音频防护、文档补丁点。

### Modified Capabilities

（无。`media-use-tts` 的 TTS 行为不变；本变更只在 `transcribeWav()` 的时间戳获取路径上叠加最高优先级分支，TTS provider 链与合成语义均不受影响。）

## Impact

- **修改**：`hyperframes_github_skills/media-use/scripts/transcribe.mjs`、`media-use/audio/scripts/lib/tts.mjs`、`embedded-captions/scripts/transcribe.cjs` + 7 处 skill 文档；`docker-compose.yml`、`.env.example`、`Dockerfile.fix`。
- **新增**：`media-use/scripts/lib/qwenasr.mjs`、`Qwen3-ASR-Script/qwen3_asr_server.py`、`Qwen3-ASR-Script/README.md`。
- **不改**：`media-use/scripts/lib/local-models.mjs`（本机模型表，QwenASR 是远程服务，同 QwenTTS 先例）、`hyperframes` npm CLI 本体、embedded-captions 守卫逻辑、TTS provider 链。
- **依赖**：无新增容器内依赖（客户端为 Node 18+ 原生 fetch）；远端服务依赖（`qwen-asr[vllm]` 等）由部署方管理。
- **回滚**：unset `QWENASR_URL` 即行为回到上游等价（运行期开关）；代码级回滚 revert skill 补丁 + 镜像 tag 回退 v1.4。
