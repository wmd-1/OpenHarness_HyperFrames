# OpenHarness 对 HyperFrames skill 的定制补丁同步指南

> 用途：本文档记录 OpenHarness 在**上游 HyperFrames skill** 基础上做的定制（**QwenTTS + QwenASR**），供以后从 hyperframes 的 github 拉取最新版 skill 后，照此重新应用补丁。
>
> 对应提交：
>
> - `de72011` — v1.3：升级到 HyperFrames v0.7.2 技能集 + 将 QwenTTS 接入共享音频引擎
> - `0b8097b` — v1.4：重新同步 HyperFrames skill 至 v0.7.77，逐字重放 QwenTTS 全部补丁（OpenSpec `resync-hyperframes-latest-patches`）
> - `09da8fb` — v1.5：集成 QwenASR 远端转写服务补丁（`$QWENASR_URL` 设置时为首选转写引擎），镜像 tag 第三段升至 v1.5（OpenSpec `add-qwen3-asr-preferred-support`）

---

## 1. 背景与目录约定

仓库里有三套 skill 目录，角色不同，**不要混淆**：

| 目录                                  | 角色                                                                                                                      | 处理方式                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `hyperframes_container_skills/`     | 旧版（过期）                                                                                                              | **忽略**，不再维护                                                                                                  |
| `hyperframes_github_skills_latest/` | 从 hyperframes github 同步的**上游原版最新** skill（`.gitignore` 忽略、不入库；拉取后保存为快照，首次拉取前为空） | `./sync_hyperframes_skills.sh` 拉新版时填充，与`hyperframes_github_skills/` 比对确认 skill 集合一致后再覆盖，作为基线 |
| `hyperframes_github_skills/`        | **实际使用**的、已打 OpenHarness 补丁的版本                                                                         | Docker 构建时`COPY` 进镜像；补丁打在这里                                                                                |

镜像构建链路（[Dockerfile:102](../Dockerfile#L102)、[Dockerfile.fix:47](../Dockerfile.fix#L47)）：

```
hyperframes_github_skills/   ──Docker COPY──▶  /opt/oh-skills-builtin/  ──wrapper cp -a──▶  /root/.openharness/skills/  ──oh CLI 加载
```

api 服务（docker-compose `api`）`extends: openharness`，与交互式 CLI **共用同一镜像、同一份 skill**，无独立副本。

### 1.1 Monorepo 布局与双镜像架构

本仓库为 monorepo，**Docker 构建上下文 = 仓库根目录**。关键构建输入文件全部位于**仓库根**，而本文档位于仓库根下的 `docs/`，因此文中对构建文件的相对链接一律为 `../`（上跳一级到仓库根）。

```
OpenHarness_HyperFrames/                # 仓库根 = 构建上下文
├── Dockerfile                          # 镜像 A：OpenHarness 框架 + 后端服务
├── Dockerfile.fix                      # 镜像 A 的增量重建层（pptx 依赖 / wrapper / hf-preview）
├── docker-compose.yml                  # 编排：openharness / api / postgres / redis / web
├── .dockerignore  /  .env.example
├── hyperframes_github_skills/          # 已打补丁的 skill（COPY 进镜像 A）
├── hyperframes_github_skills_latest/   # 上游快照基线（.gitignore 忽略，不入库）
├── pptx2html_github_skills/            # pptx-to-html skill（COPY 进镜像 A，见 §8）
├── docker/                             # chrome zip / supervisord.conf 等镜像 A 资源
├── docs/                              # 本文档（HyperFrames skill 补丁同步指南）
├── OpenHarness/                        # 框架源码（运行时挂载 src/ohmo/frontend）
├── service/                            # FastAPI + Celery 后端（运行时挂载 /opt/oh-service）
└── web/                               # 前端 SPA（镜像 B：独立 Dockerfile + nginx.conf）
```

**双镜像**（均通过 Dockerfile 启动，`docker compose up` 一键拉起）：

| 镜像                            | 构建文件                                                                 | 内容                                                                           | compose 服务                                         |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **A：OpenHarness + 后端** | 仓库根`Dockerfile`（+ `Dockerfile.fix` 增量层）                      | `oh` CLI + 打补丁 skill + FastAPI/Celery 视频服务（`service/` 运行时挂载） | `openharness` / `shell` / `api`（`extends`） |
| **B：前端**               | `web/Dockerfile`（多阶段：node 构建 Vite/React → nginx 提供静态资源） | 构建后的 SPA + nginx 反向代理                                                  | `web`（`5173:80`）                               |

> 前端镜像 B 的 nginx 把 `/v1`、`/healthz` **同源反代**到 `api:8000`（`web/nginx.conf`），因此前端 `VITE_API_BASE` 默认留空、走相对路径，**无需 CORS**。SSE（`/v1/videos/*/events`）关闭 `proxy_buffering`，视频文件（`/v1/videos/*/file`）透传 `Range`。仅当前端与 API 分域名部署时才需设置 `VITE_API_BASE` + 后端 `OH_CORS_ORIGINS`。

---

## 2. 同步工作流

每次 hyperframes 上游发布新版 skill 时：

1. **拉取上游最新** → 运行根目录的 `./sync_hyperframes_skills.sh` 填充 `hyperframes_github_skills_latest/`（脚本从 `heygen-com/hyperframes` main 分支拉 tar、解压 `skills/` 到目标目录，内置代理与重试；也可手动 `npx skills add heygen-com/hyperframes` 或直接 clone github 仓库的 skills 目录）。
2. **用 latest 覆盖实际使用目录**：把 `hyperframes_github_skills_latest/` 的内容覆盖到 `hyperframes_github_skills/`。
3. **重新应用 OpenHarness 补丁**：按本文档第 3 节，在 `hyperframes_github_skills/` 上逐文件打回 QwenTTS 定制。
4. **同步构建配置**：按第 5 节更新 `Dockerfile.fix` / `.env.example` 的版本标签。
5. **重建镜像**：`docker build -f Dockerfile.fix --build-arg BASE_IMAGE=<旧tag> -t <新tag> .`（见第 5 节）。
6. **验证**：按第 6 节确认补丁生效。

> ⚠ 关键原则：只把 **OpenHarness 注入的部分**手动打回。上游 v0.7.2 自带的结构变化（工作流 `audio.mjs` 改薄适配器、faceless-explainer 重构等）拉新版即得，**不要手动重复**（见第 7 节）。

---

## 3. 补丁一：QwenTTS（本地 TTS，最高优先级 provider）

### 3.1 意图与根因

把本地 QwenTTS 服务集成为**最高优先级** TTS provider，修复"容器只会回退 Kokoro"的问题。

**根因**（来自 `de72011` 提交说明）：

1. 旧版 QwenTTS 仅 vendored 在 `product-launch-video` / `pr-to-video` / `faceless-explainer` 三个 per-skill `audio.mjs` 中；`general-video` 等走 `npx hyperframes tts`（Kokoro-only CLI）的工作流**从不查询 QwenTTS**。
2. `QWENTTS_URL=http://localhost:8091` 是容器自身 loopback，GPU 机器上的 QwenTTS 服务不可达，导致 QwenTTS 感知的技能也静默失败、回退 Kokoro。

**解法**：在**唯一共享 TTS 库** `media-use/audio/scripts/lib/tts.mjs` 中加一处 QwenTTS 分支，即覆盖全部视频工作流；设 `QWENTTS_URL` 时优先于 HeyGen / ElevenLabs / Kokoro。

> **v1.4 调用方式变更（克隆脚本）**：部署模型固定为 `Qwen/Qwen3-TTS-12Hz-1.7B-Base`（声音克隆，无预置音色；HF 模型名或本地挂载路径 serve 均可——脚本默认不发送 `model` 字段，不受 served name 校验影响）。`synthesizeQwenTTS` 不再直连 `/v1/audio/speech` 的 speech/chat 双模式，改为调用声音克隆脚本 `qwen3_tts_clone.py`（源码在仓库根 `Qwen3-TTS-Script/`，镜像内 `/opt/qwen3-tts-script/`，见 §3.7）：脚本把 `$QWENTTS_REF_AUDIO` 上传一次到 `/v1/audio/voices`（音色名按音频内容 hash 生成、幂等），之后每句按音色名合成，参考特征只计算一次、跨调用复用。未配置参考音频/转写文本时**直接抛错**（Base-only 部署无预置音色可回退）；`QWENTTS_MODE` / `QWENTTS_INSTRUCTIONS` 随 speech/chat 双模式一并废弃。

### 3.2 涉及文件

| 文件                                              | 补丁性质                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `media-use/audio/scripts/lib/tts.mjs`           | **核心**：注入 QwenTTS provider（检测/选择/voice/克隆脚本合成）                  |
| `media-use/audio/scripts/audio.mjs`             | 注释标注 QwenTTS 优先级（代码靠 import tts.mjs 间接支持）                              |
| `media-use/SKILL.md`                            | provider 文档（description + voice 行；2026-07-28 上游重构后 audio engine 详情已移出） |
| `media-use/references/audio.md`                 | （2026-07-28 上游新增）audio engine 说明，TTS exception 注记落这里                     |
| `media-use/references/setup-providers.md`       | （2026-07-28 上游新增）provider 安装表，voice 行加 QwenTTS 首位                        |
| `media-use/audio/references/tts.md`             | QwenTTS 详细参考节                                                                     |
| `Qwen3-TTS-Script/qwen3_tts_clone.py`（仓库根） | 声音克隆脚本本体，`COPY` 进镜像（§3.7），**非 skill 文件**，不随上游同步覆盖  |
| [Dockerfile.fix](../Dockerfile.fix)                | `COPY` 克隆脚本 + venv 安装 `httpx`（§3.7）                                       |

### 3.3 `media-use/audio/scripts/lib/tts.mjs` — 注入 QwenTTS provider（6 处）

> 上游 v0.7.2 的 `tts.mjs` 自带 HeyGen / ElevenLabs / Kokoro / transcribe 等基础设施。OpenHarness 在其上插入下面 6 处 QwenTTS 片段。若上游新版函数名/结构变化，按"意图"在对应位置适配。

**注入点 ① — 文件顶部 provider chain 注释**：在 provider 列表最前面加 QwenTTS 第 1 条（原上游第 1 条 HeyGen 顺延为第 2）：

```js
//   1. QwenTTS (local)    — $QWENTTS_URL (highest priority when set). Voice clone
//        via qwen3_tts_clone.py (vLLM-Omni Base model: uploads $QWENTTS_REF_AUDIO
//        once to /v1/audio/voices, then reuses the cached voice for every call).
//        No word timings → caller transcribes.
```

**注入点 ② — `qwenttsAvailable()` 检测函数**（与 `heygenAvailable` 等并列）：

```js
export function qwenttsAvailable() {
  return !!process.env.QWENTTS_URL;
}
```

**注入点 ③ — `pickProvider()` 把 QwenTTS 设为链首**：

- 校验白名单加 `"qwentts"`；
- 加 `provider=qwentts` 但未设 `QWENTTS_URL` / `QWENTTS_REF_AUDIO` 的校验（Base 克隆必须有参考音频，缺则**报错**而非静默回退）；
- 自动选择链首加 `qwenttsAvailable() ? "qwentts" :`。

```js
// First available provider wins; an explicit choice is honored (and validated).
// Chain: QwenTTS (local, $QWENTTS_URL) → HeyGen → ElevenLabs → Kokoro (always).
export function pickProvider(userProvider) {
  if (userProvider) {
    if (!["qwentts", "heygen", "elevenlabs", "kokoro"].includes(userProvider))
      throw new Error(`invalid provider "${userProvider}" (qwentts | heygen | elevenlabs | kokoro)`);
    if (userProvider === "qwentts" && !qwenttsAvailable())
      throw new Error("provider=qwentts but $QWENTTS_URL is not set");
    if (userProvider === "qwentts" && !process.env.QWENTTS_REF_AUDIO)
      throw new Error("provider=qwentts but $QWENTTS_REF_AUDIO is not set (Base voice clone needs a reference audio)");
    if (userProvider === "heygen" && !heygenAvailable())
      throw new Error(
        "provider=heygen but no HeyGen credentials (set $HEYGEN_API_KEY or run `hyperframes auth login`)",
      );
    if (userProvider === "elevenlabs" && !process.env.ELEVENLABS_API_KEY)
      throw new Error("provider=elevenlabs but $ELEVENLABS_API_KEY is not set");
    return userProvider;
  }
  return qwenttsAvailable()
    ? "qwentts"
    : heygenAvailable()
      ? "heygen"
      : elevenlabsAvailable()
        ? "elevenlabs"
        : "kokoro";
}
```

**注入点 ④ — `resolveVoiceId()` 加 qwentts 分支**（返回 `QWENTTS_VOICE`；未设则返回 `null`，由克隆脚本按参考音频内容 hash 自动生成稳定音色名 `clone_<sha1>`）：

```js
  // Voice name optional for qwentts: the clone script derives a stable
  // content-hash name (clone_<sha1>) from $QWENTTS_REF_AUDIO when unset.
  if (provider === "qwentts") return process.env.QWENTTS_VOICE || null;
```

**注入点 ⑤ — `synthesizeOne()` 加 qwentts 分发**（在 heygen 分支之前）：

```js
  if (provider === "qwentts") return synthesizeQwenTTS({ text, voiceId, lang, wavAbs });
```

**注入点 ⑥ — `synthesizeQwenTTS()` 实现 + `QWENTTS_LANG_FULL_NAME` 常量**：

- 不直连 HTTP，而是 spawn 声音克隆脚本 `qwen3_tts_clone.py`（upload 模式）：脚本内部先 `GET /v1/audio/voices` 幂等检查，音色未上传时 `POST /v1/audio/voices` 上传 `$QWENTTS_REF_AUDIO` + `$QWENTTS_REF_TEXT`，再按音色名调 `/v1/audio/speech` 合成；音色名按音频内容 SHA1 生成，**同一参考音频跨句/跨进程/跨会话自动复用**，参考特征只计算一次；
- 每句合成到临时目录（脚本输出 `001.wav`），再经 `transcodeToWav` 归一化为 44.1k 单声道 wav；
- **配置缺失（无 `QWENTTS_REF_AUDIO` / `QWENTTS_REF_TEXT`）直接抛错**（Base-only 部署无预置音色可用，静默回退只会产出错误音色，宁可 fail-fast）；**运行期失败（服务不可达/合成失败/超时）仍优雅返回 `{ok:false}`，不写半成品**（保留修复根因 2 的关键语义）。

```js
// QwenTTS (local, vLLM-Omni Qwen3-TTS Base voice clone) — highest-priority
// provider when $QWENTTS_URL is set. Delegates to qwen3_tts_clone.py (upload
// mode): the script uploads $QWENTTS_REF_AUDIO + $QWENTTS_REF_TEXT once to
// /v1/audio/voices (idempotent, content-hash voice name) and synthesizes each
// sentence via the cached voice — reference features are computed once and
// reused across calls. Output normalized to 44.1k mono wav via transcodeToWav
// (same path as the HeyGen mp3). No word timestamps → caller transcribes.
// Missing REF_AUDIO/REF_TEXT throws (misconfiguration, Base-only deployment
// has no fallback voice); runtime failures return { ok:false }.
const QWENTTS_LANG_FULL_NAME = {
  en: "English", zh: "Chinese", ja: "Japanese", ko: "Korean", de: "German",
  fr: "French", ru: "Russian", pt: "Portuguese", es: "Spanish", it: "Italian",
};

const QWENTTS_CLONE_SCRIPT_DEFAULT = "/opt/qwen3-tts-script/qwen3_tts_clone.py";

async function synthesizeQwenTTS({ text, voiceId, lang, wavAbs }) {
  const apiBase = (process.env.QWENTTS_URL || "").replace(/\/+$/, "");
  const refAudio = process.env.QWENTTS_REF_AUDIO;
  const refText = process.env.QWENTTS_REF_TEXT;
  const script = process.env.QWENTTS_CLONE_SCRIPT || QWENTTS_CLONE_SCRIPT_DEFAULT;
  if (!refAudio)
    throw new Error(
      "QwenTTS voice clone: $QWENTTS_REF_AUDIO is not set (Base model has no built-in voices)",
    );
  if (!refText)
    throw new Error(
      "QwenTTS voice clone: $QWENTTS_REF_TEXT is not set (ICL clone needs the reference transcript)",
    );
  const outDir = mkdtempSync(join(tmpdir(), "qwentts-"));
  try {
    const cloneArgs = [
      script,
      "--api-base", apiBase,
      "--ref-audio", refAudio,
      "--ref-text", refText,
      "--text", text,
      "--output-dir", outDir,
    ];
    if (voiceId) cloneArgs.push("--voice-name", voiceId);
    // language omitted for en (server Auto-detects); non-en mapped to full name.
    const language = QWENTTS_LANG_FULL_NAME[lang];
    if (language && lang !== "en") cloneArgs.push("--language", language);
    const { cmd, args } = pythonInvocation(cloneArgs);
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 600_000 });
    if (r.status !== 0) return { ok: false, words: null };
    const wav = join(outDir, "001.wav");
    if (!existsSync(wav)) return { ok: false, words: null };
    if (!transcodeToWav(readFileSync(wav), wavAbs)) return { ok: false, words: null };
    return { ok: true, words: null };
  } catch {
    return { ok: false, words: null };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
```

> `synthesizeQwenTTS` 依赖同文件已有的 `transcodeToWav`（上游基础设施，把任意音频字节 ffmpeg 成 44.1k 单声道 wav）、顶部已有的命名导入 `spawnSync` / `mkdtempSync` / `readFileSync` / `rmSync` / `existsSync` / `tmpdir` / `join`，以及 `./python.mjs` 的 `pythonInvocation`（跨平台 python3 解析，ElevenLabs 分支同型用法，容器内命中 PATH 最前的 `/root/.openharness-venv/bin/python3`，即 §3.7 装了 `httpx` 的 venv）。上游 v0.7.42 这些 import 均已存在，无需新增；若未来上游版本缺失再按名补。

### 3.4 `media-use/audio/scripts/audio.mjs` — 注释标注（2 处）

`audio.mjs` 是共享音频引擎，本身不直接写 QwenTTS，靠 `import { pickProvider, resolveVoiceId, synthesizeOne, ... } from "./lib/tts.mjs"` 间接支持。只需在**顶部注释**里把 QwenTTS 标进 provider chain：

注入点 ① — switch 说明里加 TTS exception：

```js
// The three capabilities degrade on ONE switch — whether HeyGen is configured
// (credential present, NOT the CLI). This mirrors the table in ../SKILL.md:
// (TTS exception: QwenTTS, when $QWENTTS_URL is set, wins regardless of the switch.)
```

注入点 ② — TTS chain 注释把 QwenTTS 放首位：

```js
//   TTS : QwenTTS → HeyGen REST → ElevenLabs → Kokoro (CLI)
```

### 3.5 `SKILL.md` 等 — provider 文档（2026-07-28 上游重构后分布在 3 个文件）

> 上游 2026-07-28 版把 SKILL.md 里的 audio engine 详情移到了新增的 `references/audio.md`，provider 安装表移到了 `references/setup-providers.md`；旧版“provider 表第 1 行”文档点随之重映射。确保以下 4 处存在：

- `media-use/SKILL.md` 的 `description` frontmatter 含 `QwenTTS local`：

  > `... produce voiceover (multi-provider TTS: QwenTTS local / HeyGen / ElevenLabs / Kokoro), transcription ...`
  >
- `media-use/SKILL.md` resolve 类型表的 `voice` 行把 QwenTTS 放首位：

  > `TTS voiceover (local **QwenTTS** when `$QWENTTS_URL` set, highest priority; HeyGen free-usage path; optional local Kokoro)`
  >
- `media-use/references/audio.md`（audio engine 说明所在地）加 TTS exception 条目：

  > - **TTS exception**: QwenTTS, when `$QWENTTS_URL` is set, wins regardless of the HeyGen switch (it sits above HeyGen in `pickProvider`) — local vLLM-Omni voice clone, no cloud dependency. See `audio/references/tts.md`.
  >
- `media-use/references/setup-providers.md` 的 provider 能力表 `voice` 行把 QwenTTS 放首位（写法同 SKILL.md voice 行，附 `see audio/references/tts.md`）。

### 3.6 `media-use/audio/references/tts.md` — QwenTTS 参考节（完整）

上游 `tts.md` 不会有 QwenTTS 节（QwenTTS 是 OpenHarness 本地服务）。需在 `tts.md` 里加回以下内容：

**(a) Provider chain 表加 QwenTTS 第 1 行**：

```markdown
| 1     | QwenTTS (local)   | `$QWENTTS_URL` set                          | Voice clone from `$QWENTTS_REF_AUDIO` (auto-named `clone_<hash>`) | No                                        | ffmpeg → wav 44.1k   |
```

**(b) 整节 `## QwenTTS (local deployment)`**（插入位置：在 HeyGen 节之后、`## When to use which provider` 之前）：

```markdown
## QwenTTS (local deployment)

When `$QWENTTS_URL` is set (e.g. `http://localhost:8091`), QwenTTS becomes the highest-priority provider. Served via vLLM-Omni with the `Qwen/Qwen3-TTS-12Hz-1.7B-Base` voice-clone model; synthesis is delegated to the clone script `qwen3_tts_clone.py` (baked into the image at `/opt/qwen3-tts-script/`).

### How it works (voice clone via script)

1. The script uploads `$QWENTTS_REF_AUDIO` + `$QWENTTS_REF_TEXT` once to `/v1/audio/voices` (idempotent — the voice name is a SHA1 of the audio content, so the same reference audio is reused across sentences, processes and sessions without re-uploading or re-computing reference features).
2. Each sentence is then synthesized via `/v1/audio/speech` with `voice=<name>` — no audio payload, no feature recompute (server-side speaker cache).
3. Output wav is normalized to 44.1kHz mono via ffmpeg.

### Environment variables

| Variable                | Required | Default                                       | Description                                     |
| ----------------------- | -------- | --------------------------------------------- | ----------------------------------------------- |
| `QWENTTS_URL`           | Yes      | —                                             | Service base URL (e.g. `http://localhost:8091`)  |
| `QWENTTS_REF_AUDIO`     | Yes      | —                                             | Reference audio path inside the container (wav/mp3/flac/ogg, 1–30s) |
| `QWENTTS_REF_TEXT`      | Yes      | —                                             | Transcript of the reference audio (ICL clone)   |
| `QWENTTS_VOICE`         | No       | content-hash `clone_<sha1>`                   | Explicit voice name override (rarely needed)    |
| `QWENTTS_CLONE_SCRIPT`  | No       | `/opt/qwen3-tts-script/qwen3_tts_clone.py`    | Clone script path override                      |

### Notes

- The server must be serving the **Base** model variant (`Qwen/Qwen3-TTS-12Hz-1.7B-Base`); it has **no built-in voices** — a reference audio is mandatory. Missing `QWENTTS_REF_AUDIO`/`QWENTTS_REF_TEXT` throws immediately (misconfiguration); runtime failures (server unreachable, synthesis error) fall back gracefully with `{ok:false}`.
- Serving from a **local mounted path** (e.g. a ModelScope download dir named `Qwen3-TTS-12Hz-1___7B-Base`) works as-is: the clone script omits the `model` field by default, so the served model name is never checked — no `--served-model-name` needed.
- All output is normalized to WAV 44.1kHz mono via ffmpeg (QwenTTS may output 24kHz PCM natively).
- `language` is omitted by default (server Auto-detects); when `--lang` is non-English, mapped to full name (e.g. `zh` → `"Chinese"`). Supported: Auto, Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian.
- QwenTTS does not return word timestamps — chain `transcribe` after for caption data.
- Uploaded voices persist server-side (default `~/.cache/vllm-omni/speakers`); list via `GET /v1/audio/voices`, delete via `DELETE /v1/audio/voices/<name>`.
- When `QWENTTS_URL` is unset, the provider chain falls through to HeyGen → ElevenLabs → Kokoro.
```

**(c) `## When to use which provider` 表加 QwenTTS 行**：

```markdown
| Self-hosted / local-first TTS, no cloud dependency         | **QwenTTS** (`$QWENTTS_URL`)                        |
```

### 3.7 克隆脚本进镜像（Dockerfile.fix）

克隆脚本不是 skill 文件（不在 `hyperframes_github_skills/`，不受上游同步覆盖），住仓库根 `Qwen3-TTS-Script/`，随镜像构建 `COPY` 到 `/opt/qwen3-tts-script/`，并把其唯一依赖 `httpx` 装进 OpenHarness venv（与 §8.3 pptx 依赖安装同型）：

```dockerfile
# ---- QwenTTS 声音克隆脚本（tts.mjs 的 synthesizeQwenTTS 通过它调用 Base 模型）----
COPY Qwen3-TTS-Script/qwen3_tts_clone.py /opt/qwen3-tts-script/qwen3_tts_clone.py
RUN /root/.openharness-venv/bin/pip install --no-cache-dir httpx
```

参考音频不烧进镜像（部署环境自带）：通过 `docker-compose.yml` volume 挂载进容器，`QWENTTS_REF_AUDIO` 指向容器内路径（见 §5.3）。

---

## 4. 补丁二（保留 build 兜底）：build 时预装 bundled chrome

> 补丁二的 skill 文档 callout（⑪/⑫/⑬/⑭，见 §9）已按「运行时已预配置」去除；但 **build 时预装 bundled chrome**（原 §4.5）作为兜底予以**保留**——它与「运行时已预配置」并不冲突，且是防止模型首次未读文档就跑 `doctor`/`ensure` 时卡在下载的必要防线。

### 4.1 `Dockerfile` / `Dockerfile.fix` — build 时预装 pinned bundled chrome

**意图**：模型第一次运行 skill 时常常没读文档就先跑 `doctor`/`ensure`。`ensure`/`doctor` 只认 bundled chrome（`~/.cache/hyperframes/chrome/`），**不读 `PRODUCER_HEADLESS_SHELL_PATH`**；镜像若没预装，`ensure` 会去下载 ~150MB pinned chrome，容器网络慢时**卡在下载**（现象："卡在检查浏览器"）。把下载移到 build 时一次性完成，运行时 `ensure` 即 find 到、no-op，`doctor` 的 Chrome 检查也通过。

**根因**：`render` 用 `PRODUCER_HEADLESS_SHELL_PATH`（指向 `/opt/chrome-headless-shell`）没问题；但 `ensure`/`doctor` 走另一条路（bundled chrome），第一次空缓存就触发下载。两套 chrome 互不相干——文档 callout 拦不住"第一次没读文档就行动"的模型，所以需要 build 层兜底。

**主 [Dockerfile](../Dockerfile)** — 在 `npm install -g hyperframes` 之后加：

```dockerfile
# 预装 hyperframes pinned bundled chrome：运行时 `browser ensure`/`doctor` 只认 bundled
# chrome（不读 PRODUCER_HEADLESS_SHELL_PATH），空缓存会在第一次跑 skill 时触发 ~150MB
# 下载并卡住。build 时一次性下载烧进镜像，运行时 ensure 即 find 到、no-op。
# 临时 HYPERFRAMES_NO_AUTO_INSTALL=0 确保显式 ensure 能下载（运行时 ENV 的 =1 不动）。
RUN HYPERFRAMES_NO_AUTO_INSTALL=0 npx hyperframes browser ensure
```

**[Dockerfile.fix](../Dockerfile.fix)** — 在 `HYPERFRAMES_VERSION` 升级块之后加（升级版本后 pinned chrome 版本可能变，需重新 ensure；ensure 幂等，不升级时 no-op）：

```dockerfile
# ---- 预装/刷新 hyperframes pinned bundled chrome ----
# 运行时 `browser ensure`/`doctor` 只认 bundled chrome（不读 PRODUCER_HEADLESS_SHELL_PATH），
# 空缓存会在第一次跑 skill 时触发 ~150MB 下载卡住。ensure 幂等：已存在则 no-op；升级
# hyperframes 版本后会下载该版本 pin 的 chrome。临时关掉 NO_AUTO_INSTALL 确保显式 ensure 下载。
RUN HYPERFRAMES_NO_AUTO_INSTALL=0 npx hyperframes browser ensure
```

> **为何 `HYPERFRAMES_NO_AUTO_INSTALL=0`**：主 [Dockerfile](../Dockerfile#L58-L60) 设了 `HYPERFRAMES_NO_AUTO_INSTALL=1` 禁止运行时自动安装（避免 render 时偷偷下载）。语义上它管"自动"安装，显式 `browser ensure` 应不受限——但保险起见 build 时显式覆盖为 `0`，确保 ensure 真下载。**运行时的 `=1` 不动**，仍禁止自动安装。

---

## 5. 构建配置同步

### 5.1 `Dockerfile.fix` — BASE_IMAGE 标签

`Dockerfile.fix` 的 `BASE_IMAGE` 默认值与示例命令需指向带 QwenTTS + pptx 的镜像 tag（`openharness_hyperframes_qwen-tts_pptx:...`，注意 `_pptx` 后缀；而非旧的 `openharness_hyperframes:...`）：

```dockerfile
ARG BASE_IMAGE=openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1
FROM ${BASE_IMAGE}
```

> tag 4 段含义：`v0.1.9`（OH）_ `v0.7.77`（HyperFrames npm）_ `v1.5`（**Qwen 语音补丁集：TTS 克隆 + ASR 首选**）_ `v2.1`（pptx 适配）。`.env.example` 的 `OH_VERSION_HYPERFRAMES_VERSION` 必须与此产出 tag 完全一致，否则 `docker compose up` 会因找不到镜像而误触发主 `Dockerfile` 全量构建（主 Dockerfile 钉 `hyperframes@0.6.102` 且无 pptx 的 COPY/pip，产出会缺 pptx skill 与依赖）。

示例命令（注释里）：

```bash
# 仅更新 skills（最快，<5s）
docker build -f Dockerfile.fix \
  --build-arg BASE_IMAGE=openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1 \
  -t openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1 .

# 同时升级 Hyperframes 版本（较慢，约 1 分钟）
docker build -f Dockerfile.fix \
  --build-arg BASE_IMAGE=openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1 \
  --build-arg HYPERFRAMES_VERSION=0.7.77 \
  -t openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1 .

# 按需预下载模型（Whisper small ~466MB / u2net ~168MB）+ 装 librosa
docker build -f Dockerfile.fix \
  --build-arg BASE_IMAGE=openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1 \
  --build-arg Model_Download=1 \
  -t openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1 .
```

### 5.2 `.env.example` — 版本标签

```bash
# ---- 镜像版本标签 ----
OH_VERSION_HYPERFRAMES_VERSION=v0.1.9_v0.7.77_v1.5_v2.1
```

> `.env` 被 `.gitignore` 忽略，`QWENTTS_URL` 占位符与镜像 tag 不入库，需在构建/运行环境单独配置。此值必须与 `Dockerfile.fix` 产出 tag（5.1）及 `docker-compose.yml` 的 `image` 完全一致，否则 compose 找不到镜像。

### 5.3 `docker-compose.yml` — QwenTTS / QwenASR 环境变量

`api` 与 `openharness` 服务都需透传 QwenTTS 环境变量（v1.4 克隆脚本版：`QWENTTS_MODE` / `QWENTTS_MODEL` / `QWENTTS_INSTRUCTIONS` 已废弃移除，新增参考音频三项）与 QwenASR 四项（v1.5，见 §15）：

```yaml
environment:
  - QWENTTS_URL=${QWENTTS_URL:-}
  - QWENTTS_REF_AUDIO=${QWENTTS_REF_AUDIO:-}
  - QWENTTS_REF_TEXT=${QWENTTS_REF_TEXT:-}
  - QWENTTS_VOICE=${QWENTTS_VOICE:-}
  - QWENTTS_CLONE_SCRIPT=${QWENTTS_CLONE_SCRIPT:-}
  - QWENASR_URL=${QWENASR_URL:-}
  - QWENASR_MODEL=${QWENASR_MODEL:-}
  - QWENASR_TRANSCRIBE_PATH=${QWENASR_TRANSCRIBE_PATH:-}
  - QWENASR_TIMEOUT_MS=${QWENASR_TIMEOUT_MS:-}
  - PRODUCER_HEADLESS_SHELL_PATH=/opt/chrome-headless-shell-linux64/chrome-headless-shell
  - CHROME_HEADLESS_BIN=/opt/chrome-headless-shell-linux64/chrome-headless-shell
```

参考音频挂载（宿主机音频目录 → 容器内只读），`QWENTTS_REF_AUDIO` 指向容器内路径：

```yaml
volumes:
  - ${QWENTTS_REF_AUDIO_HOST_DIR:-./assets/tts-ref}:/opt/tts-ref:ro
# .env 例：QWENTTS_REF_AUDIO=/opt/tts-ref/reference.wav
#        QWENTTS_REF_TEXT=参考音频的转写文本
```

---

## 6. 验证

### 6.1 静态（源码侧）

```bash
# tts.mjs 语法
node --check hyperframes_github_skills/media-use/audio/scripts/lib/tts.mjs
node --check hyperframes_github_skills/media-use/audio/scripts/audio.mjs

# QwenTTS 注入点计数（tts.mjs 应 ≥ 20 处 qwentts）
grep -c -i qwentts hyperframes_github_skills/media-use/audio/scripts/lib/tts.mjs

# 克隆脚本本体语法（仅需 python3，不需依赖）
python3 -m py_compile Qwen3-TTS-Script/qwen3_tts_clone.py
```

### 6.2 容器侧（确认 api 服务加载的就是改过的 skill）

```bash
# api 容器跑的是 v1.5_v2.1 镜像
docker inspect openharness-api --format '{{.Config.Image}}'
# 期望: openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.5_v2.1

# 镜像内置 skill 含 QwenTTS
docker exec openharness-api grep -c qwentts /opt/oh-skills-builtin/media-use/audio/scripts/lib/tts.mjs

# 镜像内置 skill 含 QwenASR（v1.5，应命中 11 个文件：7 文档 + 3 补丁脚本 + 共享客户端）
docker exec openharness-api sh -c 'grep -ril qwenasr /opt/oh-skills-builtin/ | wc -l'

# 运行时加载的 skill 也含 QwenTTS（证明已同步到卷）
docker exec openharness-api grep -c qwentts /root/.openharness/skills/media-use/audio/scripts/lib/tts.mjs

# 克隆脚本已烧进镜像 + httpx 已装进 venv（§3.7）
docker exec openharness-api ls /opt/qwen3-tts-script/qwen3_tts_clone.py
docker exec openharness-api /root/.openharness-venv/bin/python -c "import httpx;print('ok')"

# 参考音频已挂载、环境变量已透传
docker exec openharness-api sh -c 'ls "$QWENTTS_REF_AUDIO" && echo "$QWENTTS_REF_TEXT" | head -c 60'

# 单句克隆冒烟（需 QwenTTS 服务在线；首次上传音色，第二次起应明显变快）
docker exec openharness-api /root/.openharness-venv/bin/python /opt/qwen3-tts-script/qwen3_tts_clone.py \
  --api-base "$QWENTTS_URL" --ref-audio "$QWENTTS_REF_AUDIO" --ref-text "$QWENTTS_REF_TEXT" \
  --text "克隆链路冒烟测试。" --output-dir /tmp/qwentts-smoke

# bundled chrome 已预装（build 时 ensure 烧进镜像，运行时 ensure 应秒级 no-op，doctor 不报 missing）
docker exec openharness-api ls /root/.cache/hyperframes/chrome/
docker exec openharness-api timeout 30 npx hyperframes browser ensure 2>&1 | tail -3
```

> 命名卷 `openharness-config` 挂在 `/root/.openharness`。wrapper 已改为**先删后拷**（`rm -rf /root/.openharness/skills; mkdir -p ...; cp -a /opt/oh-skills-builtin/. /root/.openharness/skills/`，2026-07-28）：重建镜像后卷内容与 builtin 完全一致，上游已删除的 skill 不再残留。同理 `Dockerfile.fix` 在 COPY skills 前先 `RUN rm -rf /opt/oh-skills-builtin`，消除基础镜像旧层的 builtin 残留（否则 COPY 只覆盖不删除）。

---

## 7. 上游 v0.7.2 自带变化（拉新版即得，**勿手动重复**）

`de72011` 里下面这些改动属于"整体替换为最新技能集"，上游新版自带，不需要手动打补丁：

- `faceless-explainer` 的 `agents/`、`phases/`、`style-presets/` 大量删除/重构（block-frame / capsule / claude / pin-and-paper / scatterbrain 等 preset）。
- 各工作流（`faceless-explainer` / `pr-to-video` / `product-launch-video`）的 per-skill `scripts/audio.mjs` 从"各自 vendored TTS 逻辑"改为"调用共享引擎的薄适配器"。
- 共享引擎组件：`media-use/audio/scripts/audio.mjs`、`media-use/audio/scripts/lib/{heygen,bgm,sfx}.mjs`、`media-use/audio/scripts/heygen-tts.mjs`、`media-use/audio/scripts/wait-bgm.mjs`（HeyGen/BGM/SFX 主体逻辑，**不含 QwenTTS**）。
- `references/bgm.md`、`references/sfx.md` 等 BGM/SFX 文档。

> 判据：文件内容含 `qwen` / `QWENTTS` 的才是 OpenHarness 定制（须手动打回）；其余 HeyGen/ElevenLabs/Kokoro/BGM/SFX 逻辑是上游自带。

---

## 8. pptx-to-html skill 适配（路径 + Python 依赖）

> pptx-to-html 不是 HyperFrames skill，但与 hyperframes 共用同一条镜像构建链路（`COPY` 进 `/opt/oh-skills-builtin/` → wrapper 同步到 `/root/.openharness/skills/` → `oh` 加载），适配模式同型，故一并记录在此。

### 8.1 意图

把上游 `cskwork/pptx-to-html` skill 接入 OpenHarness，使其能在 `oh` 里把 `.pptx` 转成 HTML（再交 hyperframes 渲染成视频）。上游 skill 面向 smithery 云环境，有三处与 OpenHarness 不匹配，须打补丁：

1. **Python 依赖缺失** — 主镜像 venv 未预装 `python-pptx` / `openpyxl` / `fonttools`，skill 跑转换会 `ModuleNotFoundError`。
2. **路径写死云环境** — SKILL.md 全程用 `/mnt/skills/user/pptx-to-html/...` 与 `/mnt/user-data/...`，oh 实际加载路径是 `/root/.openharness/skills/pptx-to-html/`。
3. **脚本名 / Phase 错位** — SKILL.md 引用 Phase 1 的 `convert_pptx_to_html.py`（仓库里已不存在），实际只有 `convert_pptx_to_html_v2.py`；且能力描述仍停留在 Phase 1（charts / SmartArt / animations 标"不支持"，v2 已实现）。

### 8.2 涉及文件

| 文件                               | 补丁性质                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Dockerfile.fix](../Dockerfile.fix) | 删无效的`PPTX2HTML_VERSION` / `npx skills add --agent claude-code` 段（装到 `~/.claude/skills/`，oh 不读）；新增 `pip install -r requirements.txt` 到 `/root/.openharness-venv` |
| `pptx-to-html/SKILL.md`          | 脚本名 →`_v2.py`；路径 → `/root/.openharness/skills/pptx-to-html/`；去掉 `/mnt/user-data` 写死与 `computer://`；能力描述同步到 Phase 2                                          |
| `pptx-to-html/README.md`         | 删引用已移除的 Phase 1 脚本的两处（Basic Usage 的 legacy 示例 + 文件树 legacy 行）                                                                                                        |

### 8.3 Dockerfile.fix — 删 smithery 段 + 装 venv 依赖

删除（对 oh 无效 —— `--agent claude-code` 装到 `~/.claude/skills/`，而 oh 只同步 `/opt/oh-skills-builtin/`）：

```dockerfile
# ---- 可选：升级 PPTX-TO-HTML 版本（不传则跳过）----
ARG PPTX2HTML_VERSION=""
RUN if [ -n "${PPTX2HTML_VERSION}" ]; then \
        npx -y skills add https://smithery.ai/skills/cskwork/pptx-to-html --agent claude-code; \
    fi
```

新增（放在两条 `COPY ... /opt/oh-skills-builtin/` 之后，跟着 skill 自带 `requirements.txt` 走）：

```dockerfile
# ---- 安装 pptx-to-html 的 Python 依赖到 OpenHarness venv ----
RUN /root/.openharness-venv/bin/pip install --no-cache-dir \
        -r /opt/oh-skills-builtin/pptx-to-html/requirements.txt
```

> 为何装到 venv：主 [Dockerfile](../Dockerfile#L91) 把 `/root/.openharness-venv/bin` 放在 `PATH` 最前，容器里 `python` / `python3` / `pip` 自动命中 venv，运行时无需 activate；安装时显式用 `/root/.openharness-venv/bin/pip` 最稳。

### 8.4 SKILL.md — 路径 + 脚本名 + 能力描述

**路径 / 脚本名替换**（4 处命令 + Workflow 叙述）：

| 旧                                                                | 新                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/mnt/skills/user/pptx-to-html/scripts/convert_pptx_to_html.py` | `/root/.openharness/skills/pptx-to-html/scripts/convert_pptx_to_html_v2.py` |
| `/mnt/user-data/uploads/<file>.pptx`                            | `<pptx-path>` / `/path/to/<file>.pptx`（不写死）                          |
| `/mnt/user-data/outputs`                                        | `<output-dir>` / `/path/to/output-dir`                                    |
| `computer:///mnt/user-data/outputs/<file>.html`                 | 直接给输出路径                                                                |

**能力描述同步到 Phase 2**（参照 skill 自带 `CLAUDE.md` 的 ✅ 清单）：

- `What Gets Preserved` 补 Charts（Chart.js）/ Custom Shapes（SVG）/ SmartArt（文本层级）/ Animations / Shadows & Reflections。
- `Current Limitations` 删去 charts / smartart / animations / shadows / custom-shapes 的"不支持"（v2 已实现），改写为 CLAUDE.md 的 Known Limitations（SmartArt 仅文本、custom fonts fallback、3D 不保留、master 复杂继承、Macros/VBA 永不支持）。
- `Roadmap` 把上述项从 Phase 2/3 "In Progress / Future" 提升为 Phase 2 ✅ COMPLETED；Phase 3 仅留 embedded font extraction（FontManager，进行中）/ SmartArt 视觉布局 / 3D / master 继承。
- `Troubleshooting` 修正两条矛盾项（"custom shapes / SmartArt unsupported" → 改为 SmartArt 视觉简化；"Tables on Phase 2 roadmap" → 改为 SmartArt 已知限制）。

### 8.5 验证

```bash
# 依赖装到 venv
docker exec <容器> /root/.openharness-venv/bin/python -c "import pptx,openpyxl,fonttools;print('ok')"

# skill 同步到运行时目录 + 脚本存在
docker exec <容器> ls /root/.openharness/skills/pptx-to-html/scripts/convert_pptx_to_html_v2.py

# SKILL.md 路径已改、无云环境残留
docker exec <容器> grep -c "/root/.openharness/skills/pptx-to-html" /root/.openharness/skills/pptx-to-html/SKILL.md
docker exec <容器> grep -c "/mnt/skills/user\|/mnt/user-data" /root/.openharness/skills/pptx-to-html/SKILL.md  # 期望 0

# 跑一次真实转换
docker exec <容器> /root/.openharness-venv/bin/python \
  /root/.openharness/skills/pptx-to-html/scripts/convert_pptx_to_html_v2.py /path/to/test.pptx /tmp/out
```

### 8.6 上游 bug 修复：relationship Target 路径双重前缀

**现象**：转换含 chart 的 PPTX 时报 `KeyError: "There is no item named 'ppt/ppt/charts/chart1.xml' in the archive"`；media / theme / master / smartart / font 同型失败（chart 先触发）。

**根因**：上游 9 处用 `f"ppt/{target.replace('..', '').lstrip('/')}"` 把 relationship Target 拼成 zip 内路径。当 Target 已是绝对路径（`ppt/charts/chart1.xml`，WPS / Google Slides 导出常见）时，再拼 `ppt/` 前缀 → `ppt/ppt/...`，zip 找不到。

**修法**：新增 `scripts/pptx_path.py` 定义 `normalize_pptx_path(target)` —— 剥 `..` / 前导 `/` / 双斜杠后，若已以 `ppt/` 开头则不再拼前缀。9 处调用点改用之：

| 文件                           | 调用点                                               |
| ------------------------------ | ---------------------------------------------------- |
| `chart_extractor.py`         | chart 路径                                           |
| `smartart_parser.py`         | smartart 路径                                        |
| `font_manager.py`            | font 路径                                            |
| `convert_pptx_to_html_v2.py` | theme / media / master / slide 路径 + 2 处`return` |

> 用公共 helper 而非就地改：9 处同型逻辑，单一来源更可维护；`scripts/` 已有同目录裸 import 模式（`from chart_extractor import ChartExtractor`），新模块无运行时风险。

```bash
# 语法自检（不需依赖）
python3 -m py_compile scripts/pptx_path.py scripts/chart_extractor.py \
  scripts/smartart_parser.py scripts/font_manager.py scripts/convert_pptx_to_html_v2.py
```

---

## 9. 变更历史

| 日期       | 提交               | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-23 | `de72011` (v1.3) | 升级 HyperFrames skill 至 v0.7.2；QwenTTS 接入共享音频引擎`tts.mjs`（最高优先级 provider）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-06-24 | `4feb2ff`        | skill 文档加 OpenHarness 运行时 Chrome 配置说明（`hyperframes-cli/SKILL.md` + `doctor-browser.md`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-06-25 | —                 | 接入 pptx-to-html skill：删 Dockerfile.fix 的 smithery 段、装 venv 依赖、SKILL.md 路径 / 脚本名 / Phase 2 能力描述适配（见第 8 节）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-06-25 | —                 | 修 pptx-to-html relationship 路径双重前缀 bug（`ppt/ppt/...` KeyError）：抽 `scripts/pptx_path.py` 公共 helper，9 处调用（见第 8.6 节）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-06-30 | —                 | 升级 HyperFrames skill 至 v0.7.20（拉取上游最新）；重新应用全部 QwenTTS + Chrome 路径补丁；`.env.example` 同步至 `v0.1.9_v0.7.20_v1.4`、`Dockerfile.fix` 产出 tag 为 `v0.1.9_v0.7.42_v1.3_v2.0`（二者后缀不一致，见 2026-07-07 修正）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-07-06 | —                 | build 时预装 pinned bundled chrome（`Dockerfile` + `Dockerfile.fix` 加 `npx hyperframes browser ensure`），根治"第一次运行 skill 时 `browser ensure` 下载卡住"；`doctor-browser.md` Common issues 加 OpenHarness 预装说明，弱化运行时 ensure（见 4.5）；`Dockerfile.fix` 模型预下载（Whisper small / u2net）与 librosa 安装改为 `ARG Model_Download` 条件触发                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-07 | —                 | 修正版本标签不一致：`.env.example` + `docker-compose.yml` 默认 fallback 对齐 `Dockerfile.fix` 产出 tag `v0.1.9_v0.7.42_v1.3_v2.0`（原先 `.env.example` 为 `v1.4`，按模板部署会找不到镜像而误触发主 Dockerfile 全量构建）；重写第 5 节版本标签（镜像名补 `_pptx`、补 `Model_Download` 示例）；第 1 节 `latest` 描述修正（不再"当前为空"）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-07-08 | —                 | **按第 2 节工作流重新同步 + 重打补丁（OpenSpec 驱动）**：升级 HyperFrames skill 至 v0.7.42；用 `hyperframes_github_skills_latest/` 镜像覆盖 `hyperframes_github_skills/`；关键适配——**上游把 `hyperframes-media` 重命名为 `media-use`**，共享 TTS 库移到 `media-use/audio/scripts/lib/tts.mjs`，全部 QwenTTS / Chrome 补丁按"意图"重映射到 `media-use` / `hyperframes-cli`；静态验证全过（`node --check`、qwentts 计数 20、`OpenHarness runtime` callout 各 1）。详见第 10 节                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-07-23 | —                 | 文档随 monorepo 搬迁至仓库根`docs/`：相对链接 `../../`→`../`、§1.1 布局图补 `docs/`、§2 引用新增 `sync_hyperframes_skills.sh`；修脚本 `DEST_DIR` 误指 `OpenHarness/` 子目录；刷新 Dockerfile/Dockerfile.fix 过时行号锚点；§3/§6/§7 的 `hyperframes-media/` 路径统一为 `media-use/audio/`（落实 §10.1 待办）。详见第 12 节                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-27 | —                 | **补丁二精简（我的操作）**：① 去除 skill 文档 Chrome 路径 callout（`hyperframes-cli/SKILL.md` ⑪、`hyperframes-cli/references/doctor-browser.md` ⑫/⑬/⑭）——运行时已预配置 `PRODUCER_HEADLESS_SHELL_PATH` / `CHROME_HEADLESS_BIN`；② 应需求**保留** build 时预装 bundled chrome 兜底，恢复 `Dockerfile`（第 69 行）与 `Dockerfile.fix`（第 44 行）的 `RUN HYPERFRAMES_NO_AUTO_INSTALL=0 npx hyperframes browser ensure`；③ 文档同步：原 §4 整节删除后重开为"§4 保留 build 兜底"（仅 §4.1），§6.2 恢复 bundled chrome 检查。详见 §13。                                                                                                                                                                                                                                                                                                                        |
| 2026-07-27 | —                 | **QwenTTS 调用方式改为克隆脚本（v1.4）**：部署固定 `Qwen3-TTS-12Hz-1.7B-Base`（无预置音色），`synthesizeQwenTTS` 改为 spawn `qwen3_tts_clone.py` 做声音克隆（upload 模式）；环境变量换血（新增 `QWENTTS_REF_AUDIO`/`QWENTTS_REF_TEXT`/`QWENTTS_CLONE_SCRIPT`，废弃 `QWENTTS_MODE`/`QWENTTS_MODEL`/`QWENTTS_INSTRUCTIONS`）；文档同步 §3.1–§3.7 / §5.3 / §6，并已落地实际文件、静态验证全过。详见 §14                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-28 | —                 | **升级 HyperFrames skill 至 v0.7.77；按§2工作流重新同步 + 重打补丁（OpenSpec `resync-hyperframes-latest-patches`）**：拉取上游最新后先删后拷精确镜像覆盖（185 文件差异 + 大量新增：media-use luts/grading/recipes、hyperframes-animation 新 blueprints/rules 等）；**上游移除 `website-to-video` skill**（无定制标记、无构建引用，随覆盖移除）；重放 QwenTTS v1.4 全部补丁——tts.mjs 6 处逐字重放（锚点完好）、audio.mjs 2 处；**关键适配**：上游 SKILL.md 重构，audio engine 详情移至新增的 `references/audio.md`、provider 表移至 `references/setup-providers.md`，§3.5 的 3 处文档点按意图重映射为 4 处（SKILL.md description + voice 行、audio.md TTS exception、setup-providers.md voice 行）；tts.md §3.6 三处照常插入；静态验证全过（`node --check` ×2、qwentts 计数 31、文档点 grep 全中）；构建配置 §5 仅核对未动。后续已完成：镜像重建并将 hyperframes 升至 0.7.77（产出 tag `v0.1.9_v0.7.77_v1.4_v2.1`，§5 全部默认 tag 同步更正）；§6.2 容器侧验证通过（qwentts=31、克隆脚本+httpx、chrome 预装）；wrapper 与 Dockerfile.fix 改为先删后拷消除 skill 残留 |
| 2026-07-31 | —                 | **补丁三：QwenASR 首选转写引擎（v1.5，OpenSpec `add-qwen3-asr-preferred-support`）**：新增共享客户端 `media-use/scripts/lib/qwenasr.mjs`；三入口接入（transcribe.mjs 引擎链 qwenasr→parakeet→whisper、tts.mjs#transcribeWav() 开头分支、embedded-captions/transcribe.cjs 内联 CJS 孪生客户端）；7 处文档补丁；服务端参考脚本 `Qwen3-ASR-Script/`（不进镜像）；compose/.env.example 透传 4 个 `QWENASR_*` 变量；镜像 tag 第三段 v1.4→v1.5（语义更新为“Qwen 语音补丁集：TTS 克隆 + ASR 首选”）并补丁层重建；容器内验收 18/18 通过（schema + 四种 fallback，含 whisper 真实回退）。详见 §15 |

---

## 10. 改造日志（2026-07-08）

> 本次改造使用新安装的 **OpenSpec** skill（`openspec-proposal` → 实施 → `openspec-archive`）驱动整个流程，并遵循 Superpowers 的"先提案、意图驱动、验证后再归档"方法论。

### 10.1 关键发现：上游 `hyperframes-media` → `media-use` 重命名

本次拉取的上游 `hyperframes_github_skills_latest/` 与之前文档 §3 描述的目录结构有**破坏性变化**：

| 文档 §3 旧路径                           | 上游新路径（本次实际目标）              |
| ----------------------------------------- | --------------------------------------- |
| `hyperframes-media/scripts/lib/tts.mjs` | `media-use/audio/scripts/lib/tts.mjs` |
| `hyperframes-media/scripts/audio.mjs`   | `media-use/audio/scripts/audio.mjs`   |
| `hyperframes-media/SKILL.md`            | `media-use/SKILL.md`                  |
| `hyperframes-media/references/tts.md`   | `media-use/audio/references/tts.md`   |

- 共享 TTS 库从 `hyperframes-media/scripts/lib/tts.mjs` 迁移到 `media-use/audio/scripts/lib/tts.mjs`，内部函数（`pickProvider` / `synthesizeOne` / `transcodeToWav` / `heygenAvailable` / `elevenlabsAvailable`）均保留，可直接套用 §3.3 的 6 处注入点。
- `media-use/SKILL.md` 第 18 行注有 "hyperframes-media retired"，印证重命名。
- **对文档的影响**：第 3 节 / 第 6 节 / 第 7 节里的 `hyperframes-media/...` 路径原指向上游旧名；已于 2026-07-23 统一改为 `media-use/audio/...`（§3.2 涉及文件表、§6.1 验证命令、§7 引用，见第 12 节）。

### 10.2 操作摘要与结果（精简）

- **备份 + 镜像覆盖（§2 第 1–2 步）**：备份后用 `hyperframes_github_skills_latest/` 先删后拷精确镜像 `hyperframes_github_skills/`。技能集合与 latest 一致：**新增** `figma` / `hyperframes-keyframes` / 新版 `media-use`；**移除** 已退休的 `hyperframes-media` / `graphic-overlays`（无 OpenHarness 标记、未被任何 Dockerfile/compose 引用，纯上游漂移）。镜像后 tts.mjs 的 `qwentts` 计数为 **0**（干净基线）。
- **重打补丁**：QwenTTS 注入点 ①–⑩ 按 §3 逐字重放（路径映射为 `media-use/audio/`）；Chrome 路径 callout ⑪–⑭ 按当时的 §4 重放。当次静态验证全过（`node --check` ×2、qwentts 计数 20、`OpenHarness runtime` callout 各 1）。
- **构建配置核对（§5）**：仅校验未改动——`Dockerfile.fix` 已含 `browser ensure` 兜底，`.env.example` / `docker-compose.yml` 版本标签一致。
- **OpenSpec 归档**：变更 `sync-hyperframes-latest-patches` 实施后归档至 `openspec/changes/archive/`，delta 合入主 spec `openspec/specs/media-use-tts.md`（本仓库 `.gitignore` 忽略 `openspec/`，记录本地留存）。

> ⚠ 本节为当次操作快照，部分内容已被后续变更取代：Chrome callout ⑪–⑭ 已于 2026-07-27 删除（§13）；`synthesizeQwenTTS` 的 speech/chat 双模式已改为克隆脚本调用（v1.4，§14），qwentts 计数现为 31。**当前终态一律以 §3 / §4 为准。**

### 10.3 待办 / 风险提示（2026-07-27 刷新）

1. ✅ ~~`hyperframes_github_skills/` 214 处 git 改动待 review 提交~~——已随后续提交入库（`86be446` 等），结项。
2. ✅ ~~备份目录 `hyperframes_github_skills.bak.20260708_170149` 保留为回滚点~~——已删除，结项。
3. ✅ ~~文档 §3/§6/§7 路径仍为 `hyperframes-media`~~——已于 2026-07-23 统一改为 `media-use/audio/`（见 §12），结项。
4. 容器侧 §6.2 验证待补（需 Docker + 运行中镜像）。

---

## 11. Monorepo 重构 + 双镜像架构（2026-07-16）

将原单目录仓库重构为 monorepo，并拆分为**两个镜像**（均由 Dockerfile 启动）。详见 §1.1 布局图。

### 11.1 目录/构建输入对齐

上游 skill 目录与 Docker 构建文件统一上提到**仓库根**（构建上下文），消除子目录漂移：

| 动作                | 对象                                                                                                               | 说明                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 提升到仓库根        | `pptx2html_github_skills/`（21 文件）、`Dockerfile.fix`、`hyperframes_github_skills_latest/`（826 文件基线） | 原散落在`OpenHarness/` 下，`Dockerfile.fix` 的 `COPY pptx2html_github_skills/` 在 monorepo 下会失配 |
| 删除遗留副本        | `OpenHarness/pptx2html_github_skills/`、`OpenHarness/Dockerfile.fix`                                           | 避免双份漂移                                                                                              |
| `.gitignore` 新增 | `hyperframes_github_skills_latest/`、`hyperframes_github_skills.bak.*/`、`hyperframes_container_skills/`     | 上游快照/备份不入库                                                                                       |
| 文档链接修正        | 本文档所有`../Dockerfile*` → `../../Dockerfile*`                                                              | 文档在`OpenHarness/docs/`，构建文件在仓库根，需上跳两级                                                 |

### 11.2 镜像 B（前端）新增文件

- `web/Dockerfile`：多阶段构建。stage1 `node:22-alpine` 跑 `npm ci && npm run build`（`VITE_API_BASE` 默认空）；stage2 `nginx:1.27-alpine` 提供 `dist/` + 自定义 `nginx.conf`。
- `web/nginx.conf`：SPA `try_files` 客户端路由回退；`/v1`+`/healthz` 反代 `upstream oh_api {server api:8000;}`；正则 location 特判 SSE（`proxy_buffering off` + 3600s 超时）与文件下载（透传 `Range`/`If-Range`）。
- `web/.dockerignore`：忽略 `node_modules`/`dist`/`*.tsbuildinfo` 等。
- `docker-compose.yml` 新增 `web` 服务：`build ./web`、`depends_on api`、`5173:80`、`restart unless-stopped`。

### 11.3 启动方式

```
docker compose up --build        # 一键拉起 postgres/redis/api/web
# 前端： http://localhost:5173   （nginx 同源反代到 api:8000）
# 后端： http://localhost:8000   （直连 FastAPI）
```

---

## 12. 文档搬迁 + 脚本修正（2026-07-23，精简记录）

monorepo 重构（§11）后，本指南从 `OpenHarness/docs/` 搬到仓库根 `docs/`（git `c5be468`，纯移动），据此做了四类一次性修订：

- **链接与布局**：全文 7 处 `../../Dockerfile*` → `../Dockerfile*`；§1.1 布局图补 `docs/` 行。
- **同步脚本**：§2 第 1 步改为引用根目录 `./sync_hyperframes_skills.sh`；修脚本 bug——`DEST_DIR` 误指 monorepo 后已不存在的 `OpenHarness/` 子目录，改为仓库根 `hyperframes_github_skills_latest/`。
- **行号锚点**：刷新 Dockerfile / Dockerfile.fix 因构建输入对齐整体下移的过时锚点（一次性修订，明细略）。
- **路径统一（落实 §10.1 待办）**：§3/§6/§7 残留的 `hyperframes-media/...` 统一改为 `media-use/audio/...`；§10.1 映射表与 §9 变更历史作为“重命名事件”记录，保留旧名不改。

---

## 13. 补丁二精简 + 保留 build 兜底（2026-07-27，我的操作）

本次针对「补丁二：Chrome 路径」做了两件事，操作明细如下：

**① 去除 skill 文档 Chrome 路径 callout（运行时已预配置）**

- 删除 `hyperframes-cli/SKILL.md` Render 步骤的 OpenHarness runtime callout（⑪）。
- 删除 `hyperframes-cli/references/doctor-browser.md`：顶部 callout（⑫）、`## Using a specific Chrome for render` 段（⑬）、Common issues "Missing bundled Chrome" 的 OpenHarness caveat（⑭）。
- 理由：OpenHarness 运行时已通过 `PRODUCER_HEADLESS_SHELL_PATH` / `CHROME_HEADLESS_BIN`（`docker-compose.yml` + `Dockerfile` ENV）预配置 `/opt/chrome-headless-shell-linux64/`，`render` 直接可用，无需文档劝模型别设路径。

**② 保留 build 时预装 bundled chrome（应需求）**

- 恢复 `Dockerfile`：在 `npm install -g hyperframes ... && npx skills add heygen-com/hyperframes` 之后加 `RUN HYPERFRAMES_NO_AUTO_INSTALL=0 npx hyperframes browser ensure`（第 69 行）。
- 恢复 `Dockerfile.fix`：在 `HYPERFRAMES_VERSION` 升级块之后加同款 `RUN ... browser ensure`（第 44 行）。
- 理由：`ensure`/`doctor` 只认 bundled chrome（`~/.cache/hyperframes/chrome/`），不读 `PRODUCER_HEADLESS_SHELL_PATH`；空缓存首次跑 `doctor`/`ensure` 会下载 ~150MB 卡住。build 层兜底与"运行时已预配置"不冲突，作为必要防线保留。

**③ 文档同步**

- 删除原 §4「补丁二：Chrome 路径」整节，重开为 **§4 补丁二（保留 build 兜底）：build 时预装 bundled chrome**，仅含 §4.1（原 §4.5 全文：意图 / 根因 / 两处 Dockerfile 片段 / `HYPERFRAMES_NO_AUTO_INSTALL=0` 说明）。
- §6.2 验证恢复 bundled chrome 检查（`ls /root/.cache/hyperframes/chrome/` + `browser ensure` no-op 确认）。
- §9 变更历史新增本条（标注「我的操作」）。

> 净效果：`render` 走运行时预配置的 `PRODUCER_HEADLESS_SHELL_PATH`；`doctor`/`ensure` 走的 bundled chrome 在 build 时一次性预装好，两套 chrome 互不干扰、互不卡下载。

---

## 14. QwenTTS 改为克隆脚本调用 v1.4（2026-07-27，我的操作）

部署固定 `Qwen/Qwen3-TTS-12Hz-1.7B-Base`（无预置音色，只支持 ICL 声音克隆），`synthesizeQwenTTS` 从直连 `/v1/audio/speech` 的 speech/chat 双模式改为 spawn `Qwen3-TTS-Script/qwen3_tts_clone.py`（upload 模式：参考音频只上传一次、音色名按音频内容 SHA1 生成 `clone_<sha1>`、幂等、跨调用复用服务端 speaker cache）。补丁终态见 §3，本节仅记录操作与决策。

**关键决策**

- **fail-fast，不回退**：`QWENTTS_REF_AUDIO` / `QWENTTS_REF_TEXT` 未配置直接抛错（Base 模型没有可回退的预置音色，静默回退只会掩盖配置错误）；运行期失败（服务不可达/合成失败/超时）仍 `{ok:false}` 优雅降级到下一 provider，不写半成品。
- **复用文件既有惯用法**：落地时用 `pythonInvocation`（`lib/python.mjs`，与 ElevenLabs 分支同型的跨平台 python 解析）替代草案硬编码的 `spawnSync("python3")`，并用命名导入（`mkdtempSync`/`join`/`tmpdir`）替代 `fs.*`/`path.*` 前缀写法；§3.3 注入点⑥已回写为落地版，保证未来可逐字重放。
- **脚本 COPY 进镜像**：`Dockerfile.fix` 新增 `COPY Qwen3-TTS-Script/qwen3_tts_clone.py /opt/qwen3-tts-script/` + venv 装 `httpx`（§3.7）；参考音频不烧镜像，经 compose 只读挂载 `${QWENTTS_REF_AUDIO_HOST_DIR:-./assets/tts-ref}:/opt/tts-ref:ro` 进容器。
- **环境变量换血**：新增 `QWENTTS_REF_AUDIO` / `QWENTTS_REF_TEXT` / `QWENTTS_CLONE_SCRIPT` / `QWENTTS_VOICE`（可选覆盖）；废弃 `QWENTTS_MODE` / `QWENTTS_MODEL` / `QWENTTS_INSTRUCTIONS`。

**落地文件**：`hyperframes_github_skills/media-use/audio/scripts/lib/tts.mjs`（4 处注入）+ `media-use/audio/references/tts.md`、`Dockerfile.fix`、`docker-compose.yml`（openharness/api 环境变量 + `/opt/tts-ref` 挂载，shell 经 extends 继承）、`.env.example`；`SKILL.md` 经核对无需改动。

**验证**：静态全过——`node --check` tts.mjs / audio.mjs、qwentts 计数 **31**、克隆脚本 `py_compile`、`docker compose config`。**待办**：重建镜像后按 §6.2 补容器侧验证（脚本存在、venv `import httpx`、参考音频挂载、单句克隆冒烟）。

**追记（同日，适配本地挂载路径部署）**：实际部署为先下载模型再挂载路径 serve（ModelScope 下载目录名为 `Qwen3-TTS-12Hz-1___7B-Base`，served name 是路径而非 HF 模型名），克隆脚本原默认 `--model Qwen/Qwen3-TTS-12Hz-1.7B-Base` 会被服务端 `_check_model` 拒为 404。修复（用户侧改脚本）：`--model` 默认值改为 None，不指定时 payload 不带 `model` 字段（vllm-omni 协议层 `model: str | None`，缺省即跳过模型名校验），显式传入才发送；`Qwen3-TTS-Script/README.md` 同步双部署示例与 Model mismatch 排错行。tts.mjs 本就不传 `--model`，补丁链路零改动；脚本经 Dockerfile.fix COPY 进镜像，随 v1.4 重建一并生效。

---

## 15. 补丁三：QwenASR（远端 GPU 转写，首选引擎，v1.5，2026-07-31）

> OpenSpec 变更：`add-qwen3-asr-preferred-support`；方案文档：`docs/hyperframes-skill-qwen3-asr-integration-plan.md`（rev3）。

### 15.1 意图与架构

把部署在**远端 GPU 机**的 QwenASR wrapper 服务集成为转写链路**最高优先级**引擎（仿 QwenTTS 模式）：一次 HTTP POST 同时拿回文本 + 词级时间戳（ForcedAligner 强制对齐，秒、全局时间轴），替代容器内 CPU 跑 whisper.cpp/whisperx 的慢速路径。

- **服务端**（非本仓交付边界，仅参考脚本入库）：`Qwen3-ASR-Script/qwen3_asr_server.py` — FastAPI wrapper + `Qwen3ASRModel.LLM`（vLLM **offline** backend，**非** OpenAI-compatible `vllm serve`）+ ForcedAligner。默认模型：ASR=`Qwen/Qwen3-ASR-1.7B`（转写+LID），对齐=`Qwen/Qwen3-ForcedAligner-0.6B`（仅对齐，两模型职责互斥）。长音频 chunk（180s）+ offset 合并由 qwen_asr 包服务端原生完成，客户端不切 chunk。部署/5 个服务端变量（`QWEN3_ASR_*`）见 `Qwen3-ASR-Script/README.md`，**不进镜像不进 compose**。
- **skills 侧**：仅 HTTP 客户端接入，零新依赖（Node 18+ 原生 fetch/FormData）。
- **API 契约**：`POST /transcribe` multipart（file/language/model/timestamps）→ `{ok,language,text,words:[{text,start,end}],duration_s}`；超长 413；静音 `{ok:true,text:"",words:[]}`；`GET /healthz`。

### 15.2 容器侧环境变量（4 个，全部经 `.env` → compose 透传）

| 变量 | 说明 |
| --- | --- |
| `QWENASR_URL` | 设置即启用 qwenasr 引擎（最高优先级）；未设时行为与上游完全一致 |
| `QWENASR_MODEL` | 可选，设置才随请求透传 `model` 字段（默认服务端决定） |
| `QWENASR_TRANSCRIBE_PATH` | 可选，转写接口路径，默认 `/transcribe` |
| `QWENASR_TIMEOUT_MS` | 可选，请求超时，默认 600000（与服务端 `QWEN3_ASR_MAX_AUDIO_SEC` 413 构成长音频双层防护） |

### 15.3 注入点（全部，上游同步后照此重放）

**① 共享客户端（新增文件）**：`media-use/scripts/lib/qwenasr.mjs`（~94 行 ESM）— 导出 `qwenAsrConfigured()` / `transcribeViaQwenASR(audioPath,{lang})`；ISO→Qwen 语言全名映射（仅 aligner 11 语言 zh/en/yue/fr/de/it/ja/ko/pt/ru/es，表外语言不发 `language` 字段交服务端 LID）；任何运行期失败（不可达/非 200 含 413/`ok:false`/超时/JSON 解析失败）返回 `null`。上游同步时整文件直接拷回。

**② 入口 A**：`media-use/scripts/transcribe.mjs` — import qwenasr.mjs；引擎链 `qwenasr（$QWENASR_URL 设置时最高优先级）→ parakeet → whisper.cpp`；`--engine qwenasr|parakeet|whisper` 可强制；`runQwenASR()` 成功写 `{text,language,words}` 并 `report("qwenasr",…)`；引擎选择尾部必须是 `else if (engine === "whisper")`（裸 else 会在 qwenasr 成功后误跑 whisper 覆盖结果）。

**③ 入口 B**：`media-use/audio/scripts/lib/tts.mjs#transcribeWav()` — 函数开头注入 QwenASR 分支（import `isAbsolute` + qwenasr.mjs，相对路径 `../../../scripts/lib/qwenasr.mjs`）：成功且 words 可用时映射为既有 flat 词数组 `[{id,text,start,end}]` 直接返回（不再 spawn `npx hyperframes transcribe`）；失败落回 whisper.cpp 原路径。**不触碰**同文件 QwenTTS 补丁（§3）的任何注入点。

**④ 入口 C**：`embedded-captions/scripts/transcribe.cjs` — 内联 ~40 行 CJS 孪生客户端（顶注“CJS twin of media-use/scripts/lib/qwenasr.mjs (keep the two in sync)”，embedded-captions 独立分发不跨 skill import）；引擎链 `qwenasr → whisperx → whisper.cpp`，`TRANSCRIBE_ENGINE=qwenasr|whisperx|whisper` 可强制；main 改 async（`main()` 包装 `_main()`，尾部 `main().catch(…exit(1))`）；成功时 words 补 `type:"word"`、`engine="qwenasr"`；既有静音守卫/尾部幻觉裁剪保持不动。

**⑤ 文档补丁（7 处）**：`media-use/SKILL.md`（frontmatter description）、`media-use/references/audio.md`、`media-use/references/setup-providers.md`、`media-use/references/operations.md`、`media-use/audio/references/transcribe.md`（新增 `## QwenASR (remote deployment)` 节：架构/4 变量表/入口/fallback 语义）、`embedded-captions/SKILL.md`（引擎链）、`talking-head-recut/SKILL.md`（callout + `jq '.words'` 转换）。

### 15.4 fallback 语义（三入口一致，验收已过）

- **结果可用 ⇔** `ok:true` 且 `words` 为非空数组（或静音 `[]` 且 text 为空）；否则**整体丢弃完整回退**，禁止 QwenASR 文本与其他引擎时间戳混合。判定实现：`Array.isArray(words) && (words.length > 0 || text.trim() === "")`。
- **auto 模式**（仅设 `QWENASR_URL`）：运行期失败 `console.error` 一行后优雅回退既有本地链。
- **显式指定**（`--engine qwenasr` / `TRANSCRIBE_ENGINE=qwenasr`）：失败 fail-fast 非零退出（入口 A exit 1，入口 C exit 4）；未配 URL 同样 fail-fast 并报错指明 `$QWENASR_URL`。
- **URL 未设**：三入口行为与上游完全一致，日志无 qwenasr 痕迹。

容器内验收脚本：`e2e/qwenasr-accept/run-qwenasr-acceptance.sh`（+ 契约形状 mock `mock_qwenasr_server.mjs`），覆盖 schema/四种 fallback 情形，2026-07-31 在 v1.5 镜像内 18/18 通过（含 whisper 本地回退真实跑通）；依赖真实远端服务的验收（真实契约/TTS→ASR 链路/长音频）待服务可达后按 tasks 8.1/8.3/8.5 执行。

### 15.5 上游同步重放说明

1. 重放判据：`grep -ril qwenasr hyperframes_github_skills/` 应命中 **11 个文件**（7 文档 + 3 补丁脚本 + 共享客户端）；覆盖上游新版后命中数不足即为丢补丁。
2. ① 客户端为新增文件直接拷回；②③④ 按 15.3 意图在对应函数重新注入（上游结构变化时按意图适配）；④ 的内联客户端需与①保持同步。
3. 服务端参考脚本 `Qwen3-ASR-Script/` 不随上游同步覆盖（非 skill 文件）。
4. 重建镜像后按 §6.2 验证 qwenasr 命中数，并跑 15.4 验收脚本。

