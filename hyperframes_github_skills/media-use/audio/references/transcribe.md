# Transcription

Create normalized word-level timestamps. **Always specify `--model` explicitly** — the CLI default is `small.en`, which silently translates non-English audio into English.

## QwenASR (remote deployment)

When `$QWENASR_URL` is set, transcription prefers the remote **QwenASR** wrapper
service over every local engine: a GPU-hosted FastAPI wrapper around
`Qwen3ASRModel.LLM` (vLLM as in-process offline backend — NOT an
OpenAI-compatible `vllm serve`) + Qwen3-ForcedAligner. One
`POST /transcribe` (multipart) returns `{language, text, words}` with word-level
timestamps in seconds on a global timeline; long audio is chunked and
offset-merged server-side, so clients always upload the complete file.
Deployment reference: `Qwen3-ASR-Script/` at the repo root (default models:
`Qwen/Qwen3-ASR-1.7B` for transcription+LID, `Qwen/Qwen3-ForcedAligner-0.6B`
for alignment only).

Container-side env (all config lives in `.env` — nothing hardcoded):

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWENASR_URL` | — | service base URL; **unset = feature off**, behavior identical to upstream |
| `QWENASR_MODEL` | (empty) | optional model name; forwarded only when set |
| `QWENASR_TRANSCRIBE_PATH` | `/transcribe` | endpoint path |
| `QWENASR_TIMEOUT_MS` | `600000` | per-request timeout; raise for long videos |

Entry points: `scripts/transcribe.mjs` (`--engine qwenasr` to force, fail-fast),
the audio engine's `transcribeWav()` (QwenTTS synth → QwenASR timestamps →
captions, no whisper spawn), and embedded-captions `transcribe.cjs`
(`TRANSCRIBE_ENGINE=qwenasr`).

**Fallback semantics**: the ForcedAligner covers only 11 languages (zh en yue fr
de it ja ko pt ru es). A QwenASR result is usable ⇔ `ok:true` AND `words` is a
non-empty array (`[]` only for genuine silence). `words:null` or any runtime
failure (unreachable / non-200 / timeout) discards the ENTIRE result and falls
back to the engines below — QwenASR text is never mixed with another engine's
timestamps.

## Local engines (hyperframes CLI / whisper.cpp)

```bash
npx hyperframes transcribe audio.mp3  --model small.en             # known English
npx hyperframes transcribe video.mp4  --model small --language es  # known Spanish
npx hyperframes transcribe audio.mp3  --model small                # unknown language (auto-detect)
npx hyperframes transcribe subtitles.srt                           # import existing
npx hyperframes transcribe subtitles.vtt
npx hyperframes transcribe openai-response.json
```

## Language Rule (Non-Negotiable)

`.en` models (`tiny.en` / `base.en` / `small.en` / `medium.en`) **translate** non-English audio into English. This silently destroys the original language.

1. **Known English** → `--model small.en` (or `medium.en` for music / noisy audio)
2. **Known non-English** → `--model small --language <iso-code>` (no `.en` suffix)
3. **Unknown language** → `--model small` (whisper auto-detects)

**CLI default is `small.en`** — do not rely on it; always pass `--model` to make the choice explicit. `--language` also filters out non-target-language segments from mixed-language audio.

## Model Sizes

| Model      | Size   | Speed    | When                                  |
| ---------- | ------ | -------- | ------------------------------------- |
| `tiny`     | 75 MB  | Fastest  | Quick previews, smoke tests           |
| `base`     | 142 MB | Fast     | Short clips, clear audio              |
| `small`    | 466 MB | Moderate | Default for most multilingual content |
| `medium`   | 1.5 GB | Slow     | Music with vocals, noisy audio        |
| `large-v3` | 3.1 GB | Slowest  | Production quality                    |

### Picking a model by content type

1. Speech over silence / light background → `small.en`
2. Speech over music, or music with vocals → start with `medium.en`
3. Produced music track (vocals + full instrumentation) → start with `medium.en`; expect to need manual lyrics or an external API ([`captions/transcript-handling.md`](captions/transcript-handling.md) → "Using External Transcription APIs")
4. Multilingual → `medium` or `large-v3` (no `.en` suffix), pair with `--language`

## Output Shape

Compositions consume a flat array of word objects. The `id` (`w0`, `w1`, …) is added during normalization for stable references in caption overrides; optional for backwards compatibility.

```json
[
  { "id": "w0", "text": "Hello", "start": 0.0, "end": 0.5 },
  { "id": "w1", "text": "world.", "start": 0.6, "end": 1.2 }
]
```

For mandatory caption-quality checks, retry rules, and the OpenAI/Groq Whisper API import path, see `captions/transcript-handling.md`.
