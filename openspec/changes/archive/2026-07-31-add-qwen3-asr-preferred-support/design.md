# Design: add-qwen3-asr-preferred-support

> 详细设计的完整依据见 [docs/hyperframes-skill-qwen3-asr-integration-plan.md](../../../docs/hyperframes-skill-qwen3-asr-integration-plan.md)（rev3）。本文摘取实施所需的全部技术决策；两文不一致时以本 OpenSpec 为准。

## Context

- skill 侧 3 个 ASR 代码入口：A `media-use/scripts/transcribe.mjs`（默认转写入口，容器内实际恒落 whisper.cpp）、B `media-use/audio/scripts/lib/tts.mjs#transcribeWav()`（TTS 后补词级时间戳，QwenTTS/ElevenLabs/Kokoro 无原生 timings 全靠它）、C `embedded-captions/scripts/transcribe.cjs`（WhisperX → whisper.cpp，80ms 严格时间门 + 静音/幻觉守卫）。其余视频工作流全部经 A/B 覆盖。
- 所有下游消费方要求词级时间戳 flat 数组 `[{text,start,end}]`（秒）。
- ASR/TTS 模型部署在**其他 GPU 服务器**（不归本项目负责）；skills 只做 HTTP 客户端；模型名/接口路径/IP 全部 `.env` 配置（用户 2026-07-31 确认）。
- 既有 QwenTTS 补丁（patches 文档补丁一/二）确立了模式：env 开关 → 最高优先级 provider → 运行失败优雅回退 → 配置缺失 fail-fast → 补丁记录供上游同步重放。

## Goals / Non-Goals

**Goals:**
- `QWENASR_URL` 设置时，三个 ASR 入口首选 QwenASR，一次 HTTP 调用取回文本+词级时间戳。
- 未设置时与上游行为完全一致（零影响）；运行失败/不可对齐时完整回退既有引擎链。
- 打通 QwenTTS 合成 → QwenASR 时间戳 → caption 的自托管闭环。
- 长音频（长视频/课程视频）单请求稳定：服务端上限 + 客户端超时可控。

**Non-Goals:**
- 不评估 Qwen3-ASR vs Whisper 的识别效果（无 WER/CER benchmark）。
- 不负责远端 GPU 服务的部署运维（仅提供部署参考脚本）。
- 不修改 `hyperframes` npm CLI、`local-models.mjs` 本机模型表、embedded-captions 守卫逻辑、TTS provider 链。
- 不支持"QwenASR 纯文本 + 其他引擎时间戳"的混合模式。

## Decisions

### D1 远端服务形态：FastAPI wrapper + `Qwen3ASRModel.LLM`（vLLM offline backend）+ ForcedAligner

一个 FastAPI 进程内嵌 `Qwen3ASRModel.LLM(...)`（vLLM 作**进程内 offline 推理引擎**）+ ForcedAligner，`POST /transcribe` 一次返回 `{language, text, words}`。

**命名澄清**：这**不是** OpenAI-compatible 的 `vllm serve` HTTP server。标准 `vllm serve`（chat completions / transcriptions API）只返回纯文本，无时间戳；时间戳只能来自 Qwen3-ForcedAligner-0.6B（NAR 模型，vLLM 无法直接 serve）。备选路线（vllm serve 纯文本 + 容器侧 whisper 补时间戳；vllm serve + aligner sidecar 双端口）分别因文本/时间戳不一致、复杂度更高而否决。

### D2 API contract（本项目唯一依赖面）

```
POST ${QWENASR_TRANSCRIBE_PATH:-/transcribe}   (multipart/form-data)
  file       required   音频文件（wav/mp3/mp4/m4a/flac…；服务端 ffmpeg 统一转 16k mono wav）
  language   optional   Qwen 全名（"Chinese"/"English"…）；缺省 = 自动语种识别（LID）
  model      optional   $QWENASR_MODEL 设置时透传；未设不发（单模型部署跳过校验）
  timestamps optional   "1"(默认)/"0"

200 → { "ok": true, "language": "English", "text": "…",
        "words": [{"text":"Hello","start":0.0,"end":0.42}, …] | null,   // 秒，全局时间轴
        "duration_s": 12.34 }
4xx/5xx → { "ok": false, "error": "…" }        // 长音频超限为 413
GET /healthz → { "status":"ok", "model":"…", "aligner":"…", "aligner_languages":[…] }
```

- 空音频/纯静音 → `{ok:true, text:"", words:[]}`（"无语音"判断权留给客户端守卫）。
- 部署方可用本仓库参考脚本 `Qwen3-ASR-Script/qwen3_asr_server.py`，也可用任何满足此契约的实现。

### D3 客户端：共享 ESM + 内联 CJS，零新依赖

- `media-use/scripts/lib/qwenasr.mjs`（A、B 共用，skill 内相对 import）：Node 18+ 原生 fetch/FormData，multipart 上传完整音频文件（不 base64、不切 chunk），超时 `QWENASR_TIMEOUT_MS`（AbortController）；**任何运行期失败返回 `null`**。
- embedded-captions 独立分发，**不跨 skill import** → transcribe.cjs 内联 ~40 行 CJS 等价客户端（顶部注释注明与 ESM 版保持同步）。

### D4 引擎选择与 fallback matrix

| 场景 | 行为 |
| ---- | ---- |
| `QWENASR_URL` 未设置 | QwenASR 分支不进入，三入口与上游完全一致（零影响） |
| auto 模式：不可达 / 非 200（含 413）/ 超时 | console.error 一行 → 落回既有链（A→parakeet/whisper；B→whisper.cpp；C→whisperx/whisper.cpp），不写半成品 |
| 显式 `--engine qwenasr` / `TRANSCRIBE_ENGINE=qwenasr` 但未配置或失败 | **fail-fast 非零退出**（同 `provider=qwentts` 语义） |
| `words:null`（aligner 不支持该语言）或 words 空而音频非静音 | **QwenASR 结果整体不可用，完整回退**；text 与 words 均取自回退引擎。**禁止 QwenASR text + 其他引擎 timestamp 混合**（两套文本不逐词一致，拼接产生错位字幕） |
| 静音（`{text:"", words:[]}`） | 合法"无语音"结果，非失败；C 的守卫照常兜底 |

判定规则：**QwenASR 结果可用 ⇔ `ok:true` 且 `words` 非空数组（或确为静音时的 `[]`）；否则丢弃全部输出，完整回退。**

### D5 长音频策略

- chunk 切分与 timestamp offset 合并由 `qwen_asr` 包在 `transcribe()` **内部原生完成**（已核源码）：带时间戳时 180s/chunk、低能量边界切分（±5s 窗口，避免切词）、无重叠无缝隙、prefix-prompt 减少边界断词；`_offset_align_result`/`_merge_align_results` 输出**全局时间轴**。服务端与客户端均不自研 chunk。
- 服务端防护：`QWEN3_ASR_MAX_AUDIO_SEC`（默认 3600s），ffprobe 预检超限返回 413；`max_new_tokens=4096`。
- 客户端防护：`QWENASR_TIMEOUT_MS` 默认 600000ms，长视频场景 `.env` 调大；超时走优雅回退。

### D6 环境变量（模型规格全 `.env` 化，代码零硬编码）

容器侧（compose 透传 `openharness`/`api`，`.env.example` 加占位）：

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `QWENASR_URL` | — | 服务地址；未设 = 全链路零影响开关 |
| `QWENASR_MODEL` | （空） | 模型名；设置时透传 `model` 字段，未设不发 |
| `QWENASR_TRANSCRIBE_PATH` | `/transcribe` | 接口路径（预留形态切换） |
| `QWENASR_TIMEOUT_MS` | `600000` | 单次转写超时 |

远端侧（仅 README 部署参考，不进本项目容器）：`QWEN3_ASR_MODEL`（默认 **`Qwen/Qwen3-ASR-1.7B`**，负责转写+LID）、`QWEN3_ALIGNER_MODEL`（默认 **`Qwen/Qwen3-ForcedAligner-0.6B`**，只负责强制对齐不做识别，缺失则 words 恒 null）、`QWEN3_ASR_GPU_UTIL`、`QWEN3_ASR_PORT`（惯例 8092）、`QWEN3_ASR_MAX_AUDIO_SEC`。

### D7 与既有 QwenTTS patch 的关系

- 完全复用其模式（env 开关 / 最高优先级 / 优雅回退 / fail-fast / patches 文档归档），`qwenasr` 关键字作上游同步时的定制判据（同 `qwentts`）。
- 补丁 B 与 QwenTTS 补丁同文件（`tts.mjs`）不同函数：QwenTTS 改 provider 链与合成，本变更只在 `transcribeWav()` 注入时间戳分支——`media-use-tts` spec 的全部既有 Requirements 不变。
- 组合效果：QwenTTS（无原生 timings，`words:null`）合成后由 QwenASR 补时间戳，形成自托管闭环。
- 归档为 patches 文档"补丁三：QwenASR"；镜像 tag 第三段语义扩为"Qwen 语音补丁集（TTS 克隆 + ASR 首选）"，`v1.4 → v1.5`。

### D8 交付边界

`Qwen3-ASR-Script/` 仅为部署参考（不进主镜像，与 `qwen3_tts_clone.py` 需 COPY 进镜像不同——ASR 客户端纯 HTTP）；skill 文件改动经既有 `COPY hyperframes_github_skills/` 层进镜像，`Dockerfile.fix` 补丁层重建（遵循「测试基于已有镜像」规则）。

## Risks / Trade-offs

- [aligner 仅 11 语言，52 语转写中部分不可对齐] → D4 完整回退语义兜底；lang 不在映射表时不传 language 交给服务端 LID。
- [ForcedAligner 精度 vs 80ms 时间门] → 官方数据优于 WhisperX，风险低；用**既有** `check-timing.cjs --strict` 实测一条样例确认链路可用（不新增 benchmark）。
- [长视频单请求失控] → D5 双层防护；超限/超时按 D4 回退（whisper.cpp 无硬限制）。
- [上游 skill 重构致注入点漂移] → 补丁按意图记录在 patches 文档，同步时以 `qwenasr` 关键字重放。
- [talking-head-recut 期望 flat word array 而 transcribe.mjs 输出对象] → 文档 callout 附一行 `jq '.words'` 转换（不加 `--flat` 选项，改动最小）。

## Migration Plan

- **部署**：远端服务由部署方启动（参考脚本+README）；本项目 curl 契约验收 → 配 `.env` → compose 重启生效；skill 源码经挂载即时生效，镜像重建仅为固化（tag v1.5）。
- **运行期回滚**：unset `QWENASR_URL` + 重启容器 → 行为与上游等价，无数据迁移。
- **代码级回滚**：revert skill 补丁提交 + `.env` 的 `OH_VERSION_HYPERFRAMES_VERSION` 回退 v1.4 tag（旧镜像保留不删）。

## Open Questions

（无。模型规格选择与共卡显存分配已判归部署方，README 仅给参考建议。）
