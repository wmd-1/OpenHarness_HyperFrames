# media-use TTS Specification

Source of truth for the HyperFrames `media-use` shared audio engine TTS provider behavior in OpenHarness.

## Requirements

### QwenTTS as highest-priority TTS provider

When `QWENTTS_URL` is set, the shared audio engine MUST select QwenTTS (local vLLM-Omni, Base voice-clone model served behind an OpenAI-compatible API) as the first provider in the selection chain, above HeyGen / ElevenLabs / Kokoro. This MUST hold on the re-synced upstream baseline (latest `hyperframes_github_skills_latest/` mirrored into `hyperframes_github_skills/`).

#### Scenario: QWENTTS_URL set → auto-select QwenTTS
- **WHEN** `pickProvider()` is called with no explicit provider and `QWENTTS_URL=http://localhost:8091`
- **THEN** returns `"qwentts"`

#### Scenario: explicit qwentts without URL → validation error
- **WHEN** `pickProvider("qwentts")` is called and `QWENTTS_URL` is unset
- **THEN** throws `provider=qwentts but $QWENTTS_URL is not set`

#### Scenario: explicit qwentts without reference audio → validation error
- **WHEN** `pickProvider("qwentts")` is called with `QWENTTS_URL` set but `QWENTTS_REF_AUDIO` unset
- **THEN** throws `provider=qwentts but $QWENTTS_REF_AUDIO is not set (Base voice clone needs a reference audio)`

#### Scenario: synthesizeOne dispatches to QwenTTS
- **WHEN** `synthesizeOne({ provider:"qwentts", ... })` is called
- **THEN** calls `synthesizeQwenTTS()` and returns its result

#### Scenario: QwenTTS runtime failure → graceful degrade
- **WHEN** `synthesizeQwenTTS()` executes and the service is unreachable / synthesis fails / times out
- **THEN** returns `{ ok:false, words:null }` and does NOT throw or write a partial file

#### Scenario: resolveVoiceId resolves qwentts voice
- **WHEN** `resolveVoiceId({ provider:"qwentts", ... })` is called
- **THEN** returns `process.env.QWENTTS_VOICE || null`（null 时由克隆脚本按参考音频内容 hash 生成稳定音色名 `clone_<sha1>`，不再回退 `"vivian"`）

### TTS provider documentation

The provider-chain docs and tables in `media-use/SKILL.md` and `media-use/audio/references/tts.md` MUST list QwenTTS as the first entry, note the exception "QwenTTS wins regardless of the HeyGen switch when `$QWENTTS_URL` is set", and `tts.md` MUST document the voice-clone flow (clone script, `QWENTTS_REF_AUDIO`/`QWENTTS_REF_TEXT`/`QWENTTS_VOICE`/`QWENTTS_CLONE_SCRIPT` env vars) per patch doc §3.6.

#### Scenario: provider table first row is QwenTTS
- **WHEN** viewing the Order=1 row of the `media-use/SKILL.md` TTS provider table
- **THEN** shows `QwenTTS (local) | $QWENTTS_URL set | No word timestamps`

#### Scenario: tts.md has QwenTTS voice-clone reference section
- **WHEN** reading `media-use/audio/references/tts.md`
- **THEN** a `## QwenTTS (local deployment)` section documents the clone-script flow and the four `QWENTTS_*` env vars beyond `QWENTTS_URL`

### QwenTTS synthesis via voice-clone script

`synthesizeQwenTTS()` MUST NOT call the TTS HTTP API directly; it MUST spawn the clone script (`$QWENTTS_CLONE_SCRIPT`, default `/opt/qwen3-tts-script/qwen3_tts_clone.py`) via `pythonInvocation`, which uploads `$QWENTTS_REF_AUDIO` + `$QWENTTS_REF_TEXT` idempotently to `/v1/audio/voices`（音色名按音频内容 SHA1 生成）and synthesizes each sentence via the cached voice. Output MUST be normalized to 44.1kHz mono wav via `transcodeToWav`.

#### Scenario: sentence synthesized through clone script
- **WHEN** `synthesizeQwenTTS({ text, voiceId, lang, wavAbs })` runs with valid configuration
- **THEN** the clone script is spawned with `--api-base/--ref-audio/--ref-text/--text/--output-dir`（voiceId 存在时附 `--voice-name`；非英文 lang 映射为全名 `--language`），its `001.wav` output is transcoded to `wavAbs`, and `{ ok:true, words:null }` is returned

#### Scenario: reference voice reused across calls
- **WHEN** two sentences are synthesized with the same `$QWENTTS_REF_AUDIO`
- **THEN** the reference audio is uploaded at most once（clone 脚本先 `GET /v1/audio/voices` 幂等检查），第二句直接复用服务端 speaker cache

### QwenTTS misconfiguration fails fast

When QwenTTS is the selected provider but `QWENTTS_REF_AUDIO` or `QWENTTS_REF_TEXT` is unset, `synthesizeQwenTTS()` MUST throw immediately（Base-only 部署无预置音色可回退，静默回退会掩盖配置错误）; only runtime failures degrade gracefully with `{ ok:false }`.

#### Scenario: missing REF_AUDIO → throw
- **WHEN** `synthesizeQwenTTS()` runs with `QWENTTS_REF_AUDIO` unset
- **THEN** throws `QwenTTS voice clone: $QWENTTS_REF_AUDIO is not set (Base model has no built-in voices)`

#### Scenario: missing REF_TEXT → throw
- **WHEN** `synthesizeQwenTTS()` runs with `QWENTTS_REF_TEXT` unset
- **THEN** throws `QwenTTS voice clone: $QWENTTS_REF_TEXT is not set (ICL clone needs the reference transcript)`

## Deprecated

### QwenTTS injected at hyperframes-media/scripts/lib/tts.mjs (Removed: 2026-07-08)
Reason: `hyperframes-media` retired and renamed to `media-use`; the QwenTTS injection was migrated to `media-use/audio/scripts/lib/tts.mjs` (see change `sync-hyperframes-latest-patches`).
