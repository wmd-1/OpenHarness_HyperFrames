# Qwen3-ASR 首选支持集成方案（hyperframes skill ASR 链路）

> 状态：**方案 rev3（已按 2026-07-31 review 意见修订，待落成 OpenSpec 并 review 通过后实施）** · 起草日期：2026-07-31
>
> 目标：仿照 QwenTTS 补丁模式（见 [hyperframes-skill-openharness-patches.md](./hyperframes-skill-openharness-patches.md)），把基于 **vLLM backend 部署的 Qwen3-ASR** 集成为 `hyperframes_github_skills/` 全部 ASR/转写链路的**最高优先级 provider**：设置 `QWENASR_URL` 时首选 Qwen3-ASR，未设置时行为与上游完全一致（零影响）；运行期失败优雅回退到既有引擎链。
>
> **验收定位（2026-07-31 review 意见）**：本次目标是解决 HyperFrames 链路中 **word-level timestamp 的获取问题**，不是评估 Qwen3-ASR 相比 Whisper 的识别收益——**不做 WER/CER 等 ASR 效果 benchmark 验收**。验收五项：① API 契约正确；② timestamp schema 兼容；③ TTS → ASR → caption 链路打通；④ fallback 行为正确；⑤ 长音频稳定性。
>
> **边界约定（2026-07-31 已确认）**：ASR/TTS 模型均部署在**其他 GPU 服务器**上，部署与运维**不归本项目负责**；skills 侧只做 HTTP 客户端调用接口，模型规格（模型名、接口路径、调用 IP/端口）全部经 `.env` 配置。远端服务形态已确认为 **FastAPI wrapper + `Qwen3ASRModel.LLM`（vLLM offline backend）+ ForcedAligner**（一次调用返回文本+词级时间戳；本仓库仅提供部署参考脚本）。**注意命名澄清：这不是 OpenAI-compatible 的 `vllm serve` HTTP server**——vLLM 在这里是进程内推理引擎（offline engine），HTTP 面由 FastAPI wrapper 提供。
>
> 实施完成后，本方案的补丁终态应并入 `hyperframes-skill-openharness-patches.md`（新增"补丁三：QwenASR"章节），供上游同步时重放。

---

## 1. 现状盘点：skill 里的 ASR 链路

`hyperframes_github_skills/` 中的 ASR（语音转文字 + 词级时间戳）共有 **3 个代码入口** 和一批文档点。所有消费方最终都要拿到**词级时间戳数组** `[{text, start, end}]`（秒），这是本方案最核心的约束（见 §2.2）。

### 1.1 代码入口（必须打补丁）

| # | 文件 | 现有引擎链 | 消费方 / 用途 |
| - | ---- | ---------- | ------------- |
| A | `media-use/scripts/transcribe.mjs` | Parakeet（parakeet-mlx，Mac 专属）→ whisper.cpp（`npx hyperframes transcribe`） | media-use 的默认转写入口；transcript-cut、captions、`/hyperframes` capability-menu 都指到这里。**容器内无 parakeet-mlx（mlx 是 Apple Silicon 框架），实际永远落到 whisper.cpp** |
| B | `media-use/audio/scripts/lib/tts.mjs` → `transcribeWav()` | whisper.cpp（`npx hyperframes transcribe`，model=small/small.en） | **共享音频引擎** `audio.mjs`：TTS 合成后无原生 word timings 的 provider（QwenTTS / ElevenLabs / Kokoro）全靠它补时间戳 → 驱动 captions。**当前 QwenTTS 链路的时间戳质量瓶颈就在这里** |
| C | `embedded-captions/scripts/transcribe.cjs` | WhisperX（`uvx whisperx`，wav2vec2 强制对齐）→ whisper.cpp 回退 | embedded-captions 的 80ms 严格时间门（`check-timing.cjs --strict`）；输出 normalized schema `{text, language_code, engine, words}`；带静音/幻觉守卫（须保留） |

覆盖关系：`faceless-explainer` / `pr-to-video` / `product-launch-video` / `general-video` / `music-to-video` 的转写全部经共享引擎（B）或 media-use 入口（A），打 A+B 即全覆盖工作流。

### 1.2 文档级调用点（`npx hyperframes transcribe` 直连，不可打代码补丁）

`hyperframes` npm 包自带的 whisper.cpp CLI 不在 skill 目录内，无法改代码，只能在 skill 文档里引导：

- `talking-head-recut/SKILL.md`（Step 4 直接 `npx hyperframes transcribe ... --model small.en`）
- `embedded-captions/modes/standard/_anatomy.md`（`npx hyperframes transcribe subject.mp4 --model small`）
- `media-use/audio/references/transcribe.md`（整篇是 `hyperframes transcribe` 用法 + Whisper 模型选择规则）

### 1.3 不改动的部分

- `media-use/scripts/lib/local-models.mjs` 的 `asr` 表：**不改**。该表语义是"用户本机安装的本地模型"（spec-gated 推荐），QwenASR 是远程 GPU 服务，性质同 `QWENTTS_URL`——QwenTTS 也未进此表，保持一致。
- `hyperframes` CLI 本体（npm 包）：不动。

---

## 2. Qwen3-ASR 的 vLLM 调用方式与关键约束

（依据 [Qwen3-ASR/README.md](../Qwen3-ASR/README.md)，仓库根已 clone 完整源码）

### 2.1 官方提供的调用方式

| 方式 | 部署 | 调用 | 时间戳 |
| ---- | ---- | ---- | ------ |
| ① 标准 vLLM serve | `vllm serve Qwen/Qwen3-ASR-1.7B`（或 `qwen-asr-serve`，即 vllm serve 的 wrapper） | `POST /v1/chat/completions`，content 里放 `audio_url`（URL/base64）；也支持 OpenAI `POST /v1/audio/transcriptions`（file 上传） | **无**（纯文本） |
| ② qwen-asr 包 vLLM backend | `pip install qwen-asr[vllm]`，进程内 `Qwen3ASRModel.LLM(model=..., forced_aligner="Qwen/Qwen3-ForcedAligner-0.6B")` | Python API：`model.transcribe(audio=..., language=..., return_time_stamps=True)` | **有**（ForcedAligner 输出词级 start/end） |

方式①的输出是带元信息的字符串 `"language English<asr_text>transcribed text"`，官方提供 `qwen_asr.parse_asr_output()` 解析为 `(language, text)`（已核对 [qwen_asr/inference/utils.py](../Qwen3-ASR/qwen_asr/inference/utils.py) 实现：按 `<asr_text>` 标签切分，`language None` 视为空音频）。

### 2.2 关键约束：词级时间戳

- skill 侧 3 个入口的下游（captions、transcript-cut、embedded-captions 80ms 时间门、talking-head-recut 卡片同步）**全部依赖词级时间戳**，纯文本转写在本仓库几乎没有独立消费场景。
- 标准 `vllm serve`（方式①）**不返回时间戳**；时间戳只能来自 `Qwen3-ForcedAligner-0.6B`（NAR 强制对齐模型，vLLM 不支持直接 serve 它）。
- ForcedAligner 支持 **11 种语言**（zh / en / yue / fr / de / it / ja / ko / pt / ru / es），ASR 本身支持 52 种语言方言 → 服务端须处理"可转写但不可对齐"的语言（返回 `words: null`，客户端按 §7 回退语义处理时间戳）。

### 2.3 架构路线对比与决策

| 路线 | 构成 | 优点 | 缺点 |
| ---- | ---- | ---- | ---- |
| **A（已确认采用）：FastAPI wrapper + `Qwen3ASRModel.LLM`（vLLM offline backend）+ ForcedAligner** | 远端 GPU 服务器上一个 FastAPI 进程，进程内用 `Qwen3ASRModel.LLM(...)`（vLLM 作为 **offline 推理引擎**，非 OpenAI-compatible `vllm serve` HTTP server）+ ForcedAligner，暴露 `POST /transcribe` 一次返回 `{language, text, words}` | 单端口、单次调用、文本与时间戳天然一致；`qwen_asr` 包封装好了 vLLM batch 推理 + 对齐 + 长音频 chunk（见 §3.4）；与 vllm-omni TTS 的部署形态对称（本地模型挂载同样适用） | GPU 侧需多跑一个 ~150 行封装服务（**由部署方运维，不归本项目**；本仓库仅提供参考脚本） |
| B：标准 `vllm serve` 纯文本 + 容器侧 whisper 补时间戳 | `vllm serve` 出文本；时间戳仍跑 whisper.cpp | 零服务端代码 | 同一段音频转写两遍、两份文本可能不一致（时间戳对的是 whisper 的词），违背"首选 Qwen3-ASR"的初衷，**不推荐** |
| C：标准 `vllm serve` + ForcedAligner sidecar | 两个服务：vllm serve 出文本，另一进程 serve aligner 做 `/align` | 转写走"纯正"的 vllm serve HTTP | 两个端口、两次调用、两个进程管理；aligner sidecar 依然是自定义脚本——复杂度高于 A 却无额外收益 |

**决策：路线 A（用户已确认，2026-07-31）。** **命名澄清**：本方案/OpenSpec 统一使用 **"FastAPI wrapper + vLLM backend + ForcedAligner"** 表述——`Qwen3ASRModel.LLM` 在 wrapper 进程内以 vLLM offline 引擎做批量推理，与方式①的 OpenAI-compatible `vllm serve` HTTP server（无时间戳）是两条路线，不得混淆。职责边界：封装服务跑在远端 GPU 服务器、由部署方部署运维；本仓库的 `Qwen3-ASR-Script/` 仅为**部署参考脚本**（入库供分发，不进主镜像、不属本项目运行时组件），skills 侧自始至终只调 §3.2 的 HTTP 契约。若未来 vLLM 官方给 transcription API 加时间戳，可平滑切回标准 serve（客户端只需换 `.env` 里的接口路径）。

---

## 3. 远端服务接口契约（部署运维归部署方，本项目只依赖此契约）

### 3.1 新增 `Qwen3-ASR-Script/`（仓库根，**部署参考脚本**，定位同 `Qwen3-TTS-Script/`）

```
Qwen3-ASR-Script/
├── qwen3_asr_server.py    # 封装服务参考实现：FastAPI wrapper + vLLM backend + ForcedAligner
└── README.md              # 给部署方的部署说明（HF 模型名 / 本地挂载双模式）+ curl 冒烟示例
```

服务脚本**不进主镜像、不由本项目部署运维**（跑在远端 GPU 服务器，由部署方启动），入库仅为版本管理与部署分发参考；这点与 `qwen3_tts_clone.py`（要 COPY 进镜像供 tts.mjs spawn）不同——ASR 客户端走纯 HTTP，容器内不需要 Python 脚本。**本项目真正依赖的只有 §3.2 的 HTTP 契约**：部署方可以用参考脚本，也可以用任何满足契约的自研实现。

### 3.2 API 契约

```
POST ${QWENASR_TRANSCRIBE_PATH:-/transcribe}          (multipart/form-data)
  file       required     音频文件（wav/mp3/mp4/m4a/flac…，服务端用 ffmpeg 统一转 16k 单声道 wav 后喂模型）
  language   optional     Qwen 全名（"Chinese"/"English"…）；缺省 None = 自动语种识别（LID）
  model      optional     模型名（$QWENASR_MODEL 设置时透传；单模型部署可不设，服务端跳过校验——与 TTS 克隆脚本不发 model 字段的约定对称）
  timestamps optional     "1"(默认)/"0"；为 1 且语言在 aligner 支持列表时返回词级时间戳

200 → {
  "ok": true,
  "language": "English",            // LID 结果或强制语言
  "text": "transcribed text",
  "words": [{"text":"Hello","start":0.0,"end":0.42}, …] | null,   // null = 该语言不可对齐或 timestamps=0
  "duration_s": 12.34
}
4xx/5xx → { "ok": false, "error": "…" }

GET /healthz → { "status":"ok", "model":"…", "aligner":"…", "aligner_languages":[…] }
```

- `words` 单位统一为**秒**（ForcedAligner 的 `start_time`/`end_time` 直接映射为 `start`/`end`），与 skill 侧 transcript 契约一致。
- 空音频/纯静音（`parse_asr_output` 判出 `language None`）→ `{ok:true, text:"", words:[]}`，把"无语音"判断权留给客户端守卫（embedded-captions 的静音守卫依赖这一点）。

### 3.3 参考脚本实现要点（供部署方使用/替换）

```python
# 核心初始化（启动时一次）：
model = Qwen3ASRModel.LLM(
    model=os.environ.get("QWEN3_ASR_MODEL", "Qwen/Qwen3-ASR-1.7B"),   # 支持本地挂载路径
    gpu_memory_utilization=float(os.environ.get("QWEN3_ASR_GPU_UTIL", "0.7")),
    max_new_tokens=4096,                        # 长音频
    forced_aligner=os.environ.get("QWEN3_ALIGNER_MODEL", "Qwen/Qwen3-ForcedAligner-0.6B"),
    forced_aligner_kwargs=dict(dtype=torch.bfloat16, device_map="cuda:0"),
)
# 每请求：
results = model.transcribe(audio=tmp_wav_path, language=language_or_none,
                           return_time_stamps=want_ts and lang_alignable)
```

- **默认模型建议（README 写明职责分工，避免部署方误解）**：
  - ASR 模型默认 **`Qwen/Qwen3-ASR-1.7B`**：负责语音→文本转写与语种识别（LID）；
  - 对齐模型默认 **`Qwen/Qwen3-ForcedAligner-0.6B`**：只负责"文本+音频→词级时间戳"的强制对齐，**不做识别**；两者职责互斥、缺一不可（不配 aligner 则 `words` 恒为 null，本集成即失去意义）。
- **本地挂载部署**：`QWEN3_ASR_MODEL` / `QWEN3_ALIGNER_MODEL` 支持本地目录路径（ModelScope 下载目录，如 `Qwen3-ASR-1___7B`），与既有 vllm-omni TTS 本地挂载模式对齐；不涉及 served-model-name 校验问题（进程内 API，无 HTTP 模型名检查）。
- 语言不在 aligner 的 11 种支持列表 → 自动降级为 `return_time_stamps=False`，返回 `words:null`（不报错）。
- 单 worker 串行即可（vLLM 引擎内部有并发批处理；FastAPI 层加一个 asyncio 锁防止并发 transcribe 调用打进同一引擎）。
- 依赖：`qwen-asr[vllm]`、`fastapi`、`uvicorn`、`python-multipart`；GPU 机器上建议 `uv venv` 独立环境（README 写清，由部署方执行）。
- 默认端口 **8092**（TTS 服务惯例 8091 顺延，实际以部署方配置为准——客户端只认 `.env` 里的 `QWENASR_URL`）。

### 3.4 长音频处理策略

已核对 `qwen_asr` 源码（[inference/utils.py](../Qwen3-ASR/qwen_asr/inference/utils.py)、[inference/qwen3_asr.py](../Qwen3-ASR/qwen_asr/inference/qwen3_asr.py)）：**chunk 切分与时间戳 offset 合并由 `qwen_asr` 包在 `transcribe()` 内部原生完成**，封装服务与客户端均无需自研 chunk 逻辑：

| 环节 | 机制 |
| ---- | ---- |
| 是否 chunk / 触发条件 | `transcribe()` 内部自动切分：带时间戳时 `MAX_FORCE_ALIGN_INPUT_SECONDS = 180s`/chunk（aligner 单段上限 5 分钟以内），纯文本时 `MAX_ASR_INPUT_SECONDS = 1200s`/chunk；短于上限则不切 |
| chunk 边界 | `split_audio_into_chunks()` 在目标切点 ±5s 窗口内找**低能量点**下刀（避免切在词中间）；保证无重叠、无缝隙，拼接可精确还原原音频；ASR 用前一 chunk 识别结果作 prefix prompt（token rollback 机制）减少边界断词 |
| timestamp offset 合并 | 每 chunk 携带 `offset_sec`；`_offset_align_result()` 给对齐结果统一加 offset，`_merge_align_results()` 按序拼接 → 返回的 `words` 已是**全局时间轴**（秒），封装服务直接映射 `start`/`end` 即可 |

在包内机制之上，服务端与客户端各加一层防护（防长视频/课程视频场景单请求失控）：

- **服务端最大音频时长**：`QWEN3_ASR_MAX_AUDIO_SEC`（默认 `3600`，1 小时）；接收后先 ffprobe 探测时长，超限直接返回 `413 {ok:false, error:"audio too long (Xs > Ys)"}`，不进推理队列；`max_new_tokens=4096` 覆盖 20 分钟量级转写文本，README 注明更长音频需同步调大。
- **客户端超时**：`QWENASR_TIMEOUT_MS` 默认 `600000`（10 分钟）；长视频场景在 `.env` 调大即可；超时同样走优雅回退（不写半成品）。
- **客户端不做 chunk**：单请求 multipart 上传完整音频文件（不经 base64），chunk 全权交给服务端包内机制——避免客户端切分带来的时间轴/边界二次处理。
- 音频超服务端上限时客户端收到 4xx，按 §6 统一回退语义落回既有引擎链（whisper.cpp 对长音频无硬限制）。

---

## 4. 容器/skill 侧补丁清单

### 4.1 新增共享客户端 `media-use/scripts/lib/qwenasr.mjs`（ESM）

media-use 内部的 A、B 两个入口共用一份客户端（skill 内相对 import，不跨 skill）：

```js
// qwenasr.mjs — QwenASR (remote vLLM service) client. Preferred ASR engine
// when $QWENASR_URL is set. POST $QWENASR_TRANSCRIBE_PATH (multipart) →
// { language, text, words:[{text,start,end}] | null }. Runtime failures return
// null so callers fall through to the existing engine chain
// (Parakeet / whisper.cpp / WhisperX).
export function qwenasrAvailable() { return !!process.env.QWENASR_URL; }

// ISO code → Qwen full language name (same pattern as QWENTTS_LANG_FULL_NAME).
// Only alignable languages are forced; others left to server-side LID.
export const QWENASR_LANG_FULL_NAME = {
  en: "English", zh: "Chinese", yue: "Cantonese", fr: "French", de: "German",
  it: "Italian", ja: "Japanese", ko: "Korean", pt: "Portuguese", ru: "Russian",
  es: "Spanish",
};

export async function qwenasrTranscribe({ inputPath, lang }) {
  // Node ≥18 内置 fetch/FormData/Blob：读文件 → multipart POST → 解析 JSON。
  // URL = $QWENASR_URL + ($QWENASR_TRANSCRIBE_PATH || "/transcribe")；
  // $QWENASR_MODEL 设置时随表单透传 model 字段（未设不发）。
  // 超时 $QWENASR_TIMEOUT_MS（默认 600_000，AbortController）。
  // 返回 { language, text, words } 或 null（任何失败：不可达/非200/ok:false/超时）。
}
```

要点：

- 纯 HTTP、无新依赖（Node 18+ 原生 fetch，容器内 node 版本满足）。
- **所有运行期失败一律返回 `null`**，由调用方落回既有链（与 QwenTTS `{ok:false}` 优雅降级同语义）。
- `lang` 传入 ISO 码时映射为全名；不在映射表内（如 `th`/`vi`）不传 language，交给服务端 LID，届时 `words` 可能为 `null`。

### 4.2 补丁 A：`media-use/scripts/transcribe.mjs`

- `--engine` 白名单扩为 `auto | qwenasr | parakeet | whisper`。
- 选择逻辑（auto）：`qwenasrAvailable() → qwenasr`，否则维持原链（parakeet → whisper）。
- 新增 `runQwenasr()`：调 `qwenasrTranscribe`，成功则 `atomicWrite` 输出 `{ text, language_code, engine:"qwenasr", words }`（与现有 normalized 形状一致）；**`words` 为 null 或失败 → console.error 提示并落回原链**（auto 模式）；显式 `--engine qwenasr` 时失败直接报错退出（fail-fast，同 `--engine parakeet` 未装的语义）。
- `report()` engine 标签支持 `qwenasr`。
- help 文本 / 顶部注释更新引擎链说明。

### 4.3 补丁 B：`tts.mjs` 的 `transcribeWav()`

在函数开头加 QwenASR 分支（import 来自 `../../../scripts/lib/qwenasr.mjs`，media-use skill 内部相对路径）：

```js
export async function transcribeWav({ wavRel, lang = "en", hyperframesDir }) {
  // QwenASR (remote vLLM service) preferred when $QWENASR_URL is set — pairs
  // with the QwenTTS provider for a self-hosted synth→timestamp loop. Any
  // failure (unreachable / unalignable language) falls through to whisper.cpp.
  if (qwenasrAvailable()) {
    const r = await qwenasrTranscribe({ inputPath: join(hyperframesDir, wavRel), lang });
    if (r?.words?.length) return r.words.map((w, i) => ({ id: `w${i}`, ...w }));
  }
  const model = lang === "en" ? "small.en" : "small";
  …(原实现不动)…
}
```

- 返回形状对齐现有消费方（flat `[{id,text,start,end}]`；`audio.mjs` 里再过一次 `withWordIds`，id 字段冗余无害，实施时以最小侵入为准，可只返回 `{text,start,end}`）。
- 该补丁使 **QwenTTS 合成 → QwenASR 时间戳** 形成全本地闭环，captions 时间戳精度直接受益。
- 顶部 provider chain 注释同步（"No word timings → caller transcribes (QwenASR preferred)"）。

### 4.4 补丁 C：`embedded-captions/scripts/transcribe.cjs`

- 引擎链变为：**qwenasr（`QWENASR_URL` 设置时）→ whisperx → whisper.cpp**；`TRANSCRIBE_ENGINE=qwenasr|whisperx|whisper` 可强制。
- embedded-captions 是独立分发的 skill，**不跨目录 import** media-use 的 ESM 客户端 → 在 transcribe.cjs 内联一份 ~40 行 CJS 客户端（fetch + FormData，逻辑与 qwenasr.mjs 相同；文件顶部注释注明与 media-use 版本保持同步）。
- QwenASR 成功且有 words → 直接进入既有 normalize（`{text,start,end,type:"word"}`）；`engine` 标记为 `qwenasr(qwen3-asr-1.7b+aligner)`。
- **守卫全部保留且继续生效**：尾部幻觉裁剪（`audibleEnd`）与静音守卫（`meanVolumeDb`）在引擎无关的后处理段，无需改动——Qwen3-ASR 对静音返回空文本时，"already normalized skip"逻辑与 no-speech 守卫路径照常工作。
- QwenASR 失败或 `words:null` → console.error 说明后落 whisperx（保持现有回退风格）。

### 4.5 文档补丁点（7 处）

| 文件 | 改动 |
| ---- | ---- |
| `media-use/SKILL.md` | frontmatter description 的 transcription 处标注 `(QwenASR remote preferred / Parakeet / whisper.cpp)` |
| `media-use/references/audio.md` | Transcription 段首加一句：`$QWENASR_URL` 设置时首选 QwenASR（远端 vLLM 服务，52 语言 + ForcedAligner 词级时间戳），指向 `audio/references/transcribe.md` |
| `media-use/references/setup-providers.md` | provider 表 transcription 行首位加 QwenASR（`$QWENASR_URL`）；"no parakeet → whisper.cpp"示例句同步 |
| `media-use/references/operations.md` | "Transcription (default: Parakeet…)" 节顶部加 QwenASR 首选段（含 `--engine qwenasr` 用法与回退说明） |
| `media-use/audio/references/transcribe.md` | 新增 `## QwenASR (remote deployment)` 节：环境变量表（URL/MODEL/PATH/TIMEOUT）、输出 shape、语言规则差异（**Qwen3-ASR 自动 LID，无 `.en` 模型误翻译问题**；但 aligner 仅 11 语言，不可对齐语言无时间戳）；原 Whisper 模型选择规则保留为回退路径说明 |
| `embedded-captions/SKILL.md` | Requirements/transcription 两处说明补 QwenASR 首选（"Transcription = QwenASR when `$QWENASR_URL` set, else WhisperX via uvx…"） |
| `talking-head-recut/SKILL.md` | Step 4 加 callout：`$QWENASR_URL` 设置时改用 `node <media-use>/scripts/transcribe.mjs --input audio.mp3`（输出 shape 兼容 flat word array，需 `--json`→取 words 或直接读输出文件转换——实施时给出确切的一行命令），否则维持 `npx hyperframes transcribe` |

> 判据延续 patches 文档 §7：内容含 `qwenasr` / `QWENASR` 的才是 OpenHarness 定制，上游同步后按本清单重放。

---

## 5. 环境变量与构建配置

### 5.1 环境变量（全部新增，`QWENASR_` 前缀与 `QWENTTS_` 对称；**模型规格全部经 `.env` 配置，不在代码里硬编码**）

| 变量 | 必填 | 默认 | 说明 |
| ---- | ---- | ---- | ---- |
| `QWENASR_URL` | 是（启用时） | — | ASR 服务地址（如 `http://<gpu-host>:8092`，IP/端口以部署方为准）；未设 = 全链路零影响 |
| `QWENASR_MODEL` | 否 | （空） | 模型名（如 `Qwen/Qwen3-ASR-1.7B` 或本地目录名）；设置时随请求透传 `model` 字段，未设不发——单模型部署无需配置 |
| `QWENASR_TRANSCRIBE_PATH` | 否 | `/transcribe` | 转写接口路径；预留给未来接口形态变化（如官方 transcription API 支持时间戳后切换） |
| `QWENASR_TIMEOUT_MS` | 否 | `600000` | 单次转写超时（长音频可调大） |

远端服务器侧变量（仅出现在 `Qwen3-ASR-Script/README.md` 部署参考中，由部署方配置，**不进本项目容器/compose**）：`QWEN3_ASR_MODEL`（默认 `Qwen/Qwen3-ASR-1.7B`）、`QWEN3_ALIGNER_MODEL`（默认 `Qwen/Qwen3-ForcedAligner-0.6B`）、`QWEN3_ASR_GPU_UTIL`、`QWEN3_ASR_PORT`、`QWEN3_ASR_MAX_AUDIO_SEC`（默认 3600，见 §3.4）。

### 5.2 `docker-compose.yml` / `.env.example`

- `openharness` 与 `api` 服务 environment 各加四行透传（`shell` 经 extends 继承）：

```yaml
      - QWENASR_URL=${QWENASR_URL:-}
      - QWENASR_MODEL=${QWENASR_MODEL:-}
      - QWENASR_TRANSCRIBE_PATH=${QWENASR_TRANSCRIBE_PATH:-}
      - QWENASR_TIMEOUT_MS=${QWENASR_TIMEOUT_MS:-}
```

- `.env.example` 加占位与注释（同 `QWENTTS_URL` 风格，不入库实值）。

### 5.3 `Dockerfile.fix` 与镜像 tag

- **无需新增安装层**：客户端是纯 Node fetch，无 Python/npm 依赖；skill 文件改动经既有 `COPY hyperframes_github_skills/ /opt/oh-skills-builtin/` 层进镜像。
- 重建走 `Dockerfile.fix` 补丁层（遵循「测试必须基于已有镜像」规则，不从零构建）。
- **镜像 tag 第三段 `v1.4 → v1.5`**：该段语义从"QwenTTS 补丁版本"扩为"Qwen 本地语音补丁集（TTS 克隆 + ASR 首选）"。产出 tag `openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1`，同步三处：`Dockerfile.fix` 默认 `BASE_IMAGE`/示例命令、`.env.example` 的 `OH_VERSION_HYPERFRAMES_VERSION`、patches 文档 §5。

---

## 6. 回退与失败语义（fallback matrix，与 QwenTTS 补丁对齐）

| 场景 | 行为 |
| ---- | ---- |
| `QWENASR_URL` 未设置 | 三个入口行为与上游完全一致（QwenASR 分支不进入），零影响 |
| auto 模式下服务不可达 / 非 200（含长音频 413）/ 超时 | console.error 一行说明 → 落回既有引擎链（A→parakeet/whisper；B→whisper.cpp；C→whisperx/whisper.cpp），不写半成品 |
| 显式 `--engine qwenasr` / `TRANSCRIBE_ENGINE=qwenasr` 但 URL 未设或调用失败 | **fail-fast 报错退出**（用户显式选择不静默降级，同 `provider=qwentts` 校验语义） |
| 语言可转写但 aligner 不支持（`words:null`）或 `words` 为空而音频非静音 | **整个 QwenASR 结果视为不可用，完整回退到既有 ASR 引擎**（文本+时间戳均取自回退引擎）。**禁止任何形式的混合：不得出现 QwenASR text + 其他引擎 timestamp 的拼接结果**（两套文本不保证逐词一致，拼接会产生错位字幕）。当前三个入口（A auto/B/C）全部按"需要时间戳"处理；未来若出现纯文本消费方，需显式声明后方可单独用 text |
| 静音/空音频（`{text:"", words:[]}`） | 不视为失败：这是合法的"无语音"结果；C 的静音守卫、尾部幻觉裁剪照常兜底（守卫逻辑引擎无关，不改） |

判定规则统一收敛为一句：**对需要时间戳的调用方，QwenASR 结果可用 ⇔ `ok:true` 且 `words` 为非空数组（或音频确为静音时的 `[]`）；否则丢弃全部 QwenASR 输出，完整回退。**

---

## 7. 验证计划（遵循「测试基于已有镜像」规则）

> **验收定位**：不做 WER/CER 等 ASR 效果 benchmark——本次目标是解决 word-level timestamp 获取问题，不是评估识别收益。验收五项对应如下：① API 契约正确（§7.2）；② timestamp schema 兼容（§7.3-a）；③ TTS → ASR → caption 链路打通（§7.3-b）；④ fallback 行为正确（§7.4）；⑤ 长音频稳定性（§7.5）。

### 7.1 静态（宿主机仅做语法/计数检查，不跑测试）

```bash
node --check hyperframes_github_skills/media-use/scripts/lib/qwenasr.mjs
node --check hyperframes_github_skills/media-use/scripts/transcribe.mjs
node --check hyperframes_github_skills/media-use/audio/scripts/lib/tts.mjs
node --check hyperframes_github_skills/embedded-captions/scripts/transcribe.cjs
grep -rc -i qwenasr hyperframes_github_skills/media-use/ hyperframes_github_skills/embedded-captions/  # 注入点计数基线
python3 -m py_compile Qwen3-ASR-Script/qwen3_asr_server.py
```

### 7.2 验收① API 契约（部署由部署方完成，本项目只做 curl 契约验收）

```bash
curl -s http://<gpu-host>:8092/healthz                     # status/model/aligner/aligner_languages 字段齐全
curl -s -F "file=@sample.wav" http://<gpu-host>:8092/transcribe \
  | jq -e '.ok and (.language|type=="string") and (.text|type=="string") and (.words|type=="array")'
curl -s -F "file=@sample.wav" -F "language=Chinese" http://<gpu-host>:8092/transcribe | jq .   # 强制语种
curl -s -F "file=@sample.wav" -F "timestamps=0" http://<gpu-host>:8092/transcribe | jq '.words'  # 应为 null
```

### 7.3 验收②③ schema 兼容与链路打通（容器侧，复用主镜像，源码经挂载即时生效）

```bash
# 前置：skill 已同步 + 环境变量透传
docker exec openharness-api grep -c qwenasr /root/.openharness/skills/media-use/scripts/transcribe.mjs
docker exec openharness-api sh -c 'echo $QWENASR_URL'

# (a) timestamp schema 兼容：入口 A 输出的 words 必须是 [{text,start,end}]（秒、单调递增），
#     与入口 C 的 normalized schema（type:"word"）均能直接被下游消费
docker compose run --rm --entrypoint bash openharness -c \
  "node /root/.openharness/skills/media-use/scripts/transcribe.mjs --input /opt/tts-ref/reference.wav --json" \
  | jq -e '.engine=="qwenasr" and (.words | all(.start <= .end))'

# (b) TTS → ASR → caption 链路：音频引擎跑一条 QwenTTS voice line，transcribeWav 走 QwenASR，
#     words 非空且 captions 渲染成功；embedded-captions 对样例工程跑 transcribe.cjs，
#     核对 engine 字段为 qwenasr 且 check-timing.cjs 通过（既有时间门，非新增 benchmark）
```

### 7.4 验收④ fallback 行为

```bash
# 未配置：unset QWENASR_URL → 三入口产出与上游一致，运行日志 grep 无 qwenasr 痕迹
# 不可达：QWENASR_URL 指向不存在的端口 → 三入口均打印回退提示后产出与上游一致结果
# words:null：用 aligner 不支持的语种样例（如泰语）→ 完整回退，产物中 text 与 words 均来自回退引擎（不得混合）
# 显式引擎：--engine qwenasr + 无 URL → 非零退出码报错（fail-fast）
```

### 7.5 验收⑤ 长音频稳定性

```bash
# 用 ≥10 分钟样例音频（可由已有素材 ffmpeg concat 制作）过入口 A：
#   - 返回成功，words 覆盖全时长（末词 end ≈ 音频时长），时间戳单调递增、无 chunk 接缝处时间轴回跳
#   - 超服务端 QWEN3_ASR_MAX_AUDIO_SEC 的样例 → 客户端收 413 并正确回退
#   - QWENASR_TIMEOUT_MS 调小（如 1000）人为触发超时 → 优雅回退不写半成品
```

---

## 8. 实施顺序

0. **前置：本方案落成 OpenSpec 变更（proposal + design + 增量 spec + tasks），review 通过后方可开始以下步骤**。
1. **部署参考脚本**：`Qwen3-ASR-Script/qwen3_asr_server.py` + README 入库；交由部署方在远端 GPU 服务器部署，本项目以 §7.2 curl 验收契约。
2. **共享客户端**：`media-use/scripts/lib/qwenasr.mjs`。
3. **补丁 A → B → C**（每个入口打完即做 §7.1 对应静态检查）。
4. **文档补丁**（§4.5 七处）。
5. **配置**：docker-compose / .env.example / Dockerfile.fix tag（v1.5）。
6. **重建补丁层镜像 + §7.3/7.4 容器侧验证**。
7. **归档**：补丁终态并入 `hyperframes-skill-openharness-patches.md`（新增"补丁三：QwenASR（本地 ASR，最高优先级引擎）"章节 + 变更历史行 + §6 验证命令），本方案文档标记为已实施。

---

## 9. 风险与开放问题

| # | 风险 / 待决 | 应对 |
| - | ----------- | ---- |
| 1 | **模型规格选择**：1.7B（精度最优）vs 0.6B（吞吐 2000x@128 并发）| **归部署方决定**（README 建议默认 1.7B，离线转写精度优先）；客户端侧经 `.env` 的 `QWENASR_MODEL` 透传，代码不锁死 |
| 2 | ForcedAligner 时间戳精度 vs embedded-captions 的 80ms 严格时间门 | 官方数据显示对齐精度优于 WhisperX，风险低；验收仅用**既有** `check-timing.cjs --strict` 时间门实测一条真实样例确认链路可用（属验收③链路打通，**不新增任何效果 benchmark**） |
| 3 | 大音频 multipart 体积与超时、长视频/课程视频单请求失控 | 长音频策略见 §3.4：chunk/offset 合并由 `qwen_asr` 包内置；服务端 `QWEN3_ASR_MAX_AUDIO_SEC` 硬上限 + 客户端 `QWENASR_TIMEOUT_MS`；超限/超时均按 §6 完整回退 |
| 4 | 远端 GPU 服务器与 QwenTTS（vllm-omni）共卡部署 | **归部署方负责**；README 仅给参考建议（两个 vLLM 进程分配 `gpu_memory_utilization`，如 TTS 0.5 + ASR 0.4；显存不足优先独立卡） |
| 5 | 上游 skill 重构导致注入点漂移 | 与 QwenTTS 同法：补丁按"意图"记录在 patches 文档，同步时重映射；`qwenasr` 关键字作为定制判据 |
| 6 | talking-head-recut 文档 callout 的具体命令形态（transcribe.mjs 输出是 `{text,words,...}` 对象，而该 skill 期望 flat word array） | 实施时二选一：callout 附一行 `jq '.words'` 转换，或 transcribe.mjs 增加 `--flat` 输出选项（倾向前者，改动更小） |

---

## 变更历史

| 日期 | 内容 |
| ---- | ---- |
| 2026-07-31 | 初版方案：现状盘点（3 代码入口 + 文档点）、路线对比与决策（自定义 FastAPI + vLLM backend + ForcedAligner）、补丁清单、配置/验证/实施顺序 |
| 2026-07-31 | 按用户确认修订边界：ASR/TTS 服务部署运维归远端部署方，本项目只做 HTTP 客户端；接口形态选定"标准 vllm serve + 对齐封装"；模型规格（`QWENASR_MODEL`）、接口路径（`QWENASR_TRANSCRIBE_PATH`）、调用地址（`QWENASR_URL`）全部 `.env` 化；模型规格与共卡显存两个开放问题改判归部署方 |
| 2026-07-31 | rev3，按 review 六点意见修订：① 验收去 benchmark 化，收敛为五项（API 契约/schema 兼容/链路打通/fallback/长音频稳定性，§7 重构）；② 服务命名澄清为"FastAPI wrapper + `Qwen3ASRModel.LLM`（vLLM offline backend）+ ForcedAligner"，与 OpenAI-compatible vllm serve 划清界限；③ 新增 §3.4 长音频策略（包内置 chunk/低能量边界/offset 合并已核源码，叠加 `QWEN3_ASR_MAX_AUDIO_SEC` 与超时控制）；④ §6 明确 words 不可用时整体不可用、禁止 text/timestamp 跨引擎混合、完整回退；⑤ 明确默认模型建议（ASR=Qwen3-ASR-1.7B，对齐=Qwen3-ForcedAligner-0.6B，职责互斥）；⑥ §8 增加 OpenSpec 前置步骤，review 通过后方可实施 |
