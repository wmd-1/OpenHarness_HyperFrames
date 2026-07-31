# Qwen3-ASR-Script — 远端 GPU 部署参考

<!-- Updated: 2026-07-31 -->

本目录是 **QwenASR 封装服务的部署参考**（deployment reference），供拥有 GPU 服务器的部署方使用。

- **不进主镜像、不是本项目运行时组件**：OpenHarness_HyperFrames 容器侧只依赖 HTTP 契约（`QWENASR_URL` 等 4 个环境变量，见根目录 `.env.example`），不依赖本目录任何文件。
- 部署方也可以用**任何满足下述 API contract 的自研实现**替代本脚本。
- 与 `Qwen3-TTS-Script/`（TTS 参考音频克隆）为姊妹目录，共同支撑 QwenTTS 合成 → QwenASR 词级时间戳 → caption 的自托管闭环。

## 架构

```
FastAPI wrapper  ──►  Qwen3ASRModel.LLM(...)   # vLLM 作【进程内 offline 推理引擎】
                 └──►  Qwen3-ForcedAligner      # NAR 强制对齐 → 词级时间戳
```

> **命名澄清**：这**不是** OpenAI-compatible 的 `vllm serve` HTTP server。标准
> `vllm serve`（chat completions / transcriptions API）只返回纯文本、无词级时间戳；
> 时间戳必须经 Qwen3-ForcedAligner（NAR 模型，vLLM 无法直接 serve）。本脚本把
> "转写 + 强制对齐"封装为一次 `POST /transcribe` 调用。

## 默认模型与职责分工

| 环境变量 | 默认值 | 职责 |
| --- | --- | --- |
| `QWEN3_ASR_MODEL` | `Qwen/Qwen3-ASR-1.7B` | **转写 + 语种识别（LID）**，52 语言/方言 |
| `QWEN3_ALIGNER_MODEL` | `Qwen/Qwen3-ForcedAligner-0.6B` | **仅强制对齐产出词级时间戳，不做识别**；置空则 `words` 恒为 `null` |

两个模型**职责互斥、缺一不可**：ASR 模型不产时间戳，对齐模型不产文本。对齐模型仅支持
11 种语言（zh / en / yue / fr / de / it / ja / ko / pt / ru / es）；不支持的语言
`words` 返回 `null`，容器侧会整体回退到既有 whisper 链（不会混用文本与时间戳）。

## 全部环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `QWEN3_ASR_MODEL` | `Qwen/Qwen3-ASR-1.7B` | 转写模型（HF repo id 或本地路径） |
| `QWEN3_ALIGNER_MODEL` | `Qwen/Qwen3-ForcedAligner-0.6B` | 对齐模型；置空禁用时间戳 |
| `QWEN3_ASR_GPU_UTIL` | `0.8` | vLLM `gpu_memory_utilization`（与其他服务共卡时调低） |
| `QWEN3_ASR_PORT` | `8092` | 监听端口 |
| `QWEN3_ASR_MAX_AUDIO_SEC` | `3600` | 单请求最大音频时长（秒），ffprobe 预检，超限返回 413 |

## 部署步骤

```bash
# 1. 依赖（Python 3.10+，NVIDIA GPU；系统需有 ffmpeg/ffprobe）
pip install "qwen-asr[vllm]" fastapi uvicorn python-multipart

# 2. 启动（模型首次运行自动从 HF 下载；也可指定本地路径）
QWEN3_ASR_GPU_UTIL=0.6 python qwen3_asr_server.py
```

## API contract（容器侧唯一依赖面）

```
POST /transcribe   (multipart/form-data)
  file        required   音频文件（wav/mp3/mp4/m4a/flac…，服务端 ffmpeg 统一转 16k mono wav）
  language    optional   Qwen 全名（"Chinese"/"English"…）；缺省 = 自动语种识别
  model       optional   校验用；单模型部署可不发
  timestamps  optional   "1"(默认)/"0"

200 → { "ok": true, "language": "English", "text": "…",
        "words": [{"text":"Hello","start":0.0,"end":0.42}, …] | null,   // 秒，全局时间轴
        "duration_s": 12.34 }
4xx/5xx → { "ok": false, "error": "…" }        // 音频超长为 413
GET /healthz → { "status":"ok", "model":"…", "aligner":"…", "aligner_languages":[…] }
```

- 空音频/纯静音 → `{ok:true, text:"", words:[]}`（"无语音"判断权留给客户端守卫）。
- **长音频**：chunk 切分（带时间戳 180s/chunk、低能量边界 ±5s 窗口）与 timestamp
  offset 合并由 `qwen_asr` 包在 `transcribe()` 内部原生完成，输出全局时间轴，
  时间戳跨 chunk 单调不减；服务端只做时长上限预检。

## 契约自测

```bash
curl -s http://<host>:8092/healthz | jq .
curl -s -F file=@sample.wav http://<host>:8092/transcribe \
  | jq -e '.ok and (.words | type == "array")'
# 指定语言（Qwen 全名）：
curl -s -F file=@sample.wav -F language=Chinese http://<host>:8092/transcribe | jq .
```

## 容器侧接入（本项目）

远端服务就绪后，在根目录 `.env` 配置（详见 `.env.example` 与
`hyperframes_github_skills/media-use/audio/references/transcribe.md`）：

```bash
QWENASR_URL=http://<gpu-host>:8092
# QWENASR_MODEL=Qwen/Qwen3-ASR-1.7B      # 可选，单模型部署可不设
# QWENASR_TRANSCRIBE_PATH=/transcribe    # 可选，默认 /transcribe
# QWENASR_TIMEOUT_MS=600000              # 可选，长视频场景调大
```
