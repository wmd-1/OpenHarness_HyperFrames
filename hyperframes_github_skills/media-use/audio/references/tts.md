# Text To Speech

`npx hyperframes tts` auto-detects a provider from env vars; explicit override via `--provider`.

> **Run the Preflight first — no credential is not a green light to silently use the local voice.** Before generating a voiceover, complete the sign-in **Preflight** (see `../SKILL.md` → Preflight): run `npx hyperframes auth status`, recommend signing in, and **STOP for the user's choice** (sign in for HeyGen voices, or continue offline with local Kokoro). This applies to a one-off "generate a voiceover" request just as much as inside a full workflow.

## Provider chain

| Order | Provider          | Env trigger                                 | Voice IDs                                   | Word timestamps                           | Audio format         |
| ----- | ----------------- | ------------------------------------------- | ------------------------------------------- | ----------------------------------------- | -------------------- |
| 1     | QwenTTS (local)   | `$QWENTTS_URL` set                          | Voice clone from `$QWENTTS_REF_AUDIO` (auto-named `clone_<hash>`) | No                                        | ffmpeg → wav 44.1k   |
| 2     | HeyGen (Starfish) | `$HEYGEN_API_KEY` / `~/.heygen/credentials` | UUIDs from `GET /v3/voices?engine=starfish` | **Yes** (`word_timestamps[]` in response) | mp3 → wav via ffmpeg |
| 3     | ElevenLabs        | `$ELEVENLABS_API_KEY`                       | UUIDs from elevenlabs.io dashboard          | No                                        | mp3 → wav via ffmpeg |
| 4     | Kokoro-82M        | always (local fallback)                     | `am_michael`, `af_heart`, … (54 voices)     | No                                        | wav direct           |

```bash
# Auto-detect (HeyGen if key set, else ElevenLabs, else Kokoro)
npx hyperframes tts "Welcome to HyperFrames" -o narration.wav

# Pin the provider explicitly
npx hyperframes tts "Hello" --provider kokoro
npx hyperframes tts "Hello" --provider heygen --voice <heygen-uuid>
npx hyperframes tts "Hello" --provider elevenlabs --voice 21m00Tcm4TlvDq8ikWAM

# HeyGen path: capture word timestamps in one call (skips a Whisper pass)
npx hyperframes tts "Hi there" --words narration.words.json
```

## Self-contained HeyGen (no CLI) — `scripts/heygen-tts.mjs`

The published `hyperframes tts` CLI synthesizes locally with Kokoro only. When you
want HeyGen specifically — best quality **plus** word timestamps in one call — use
the skill's bundled script, which calls the HeyGen v3 REST API directly and needs
no CLI provider plumbing:

The script resolves a HeyGen credential the same way the CLI does — first source
wins: `$HEYGEN_API_KEY` → `$HYPERFRAMES_API_KEY` → a project `.env` (auto-loaded,
walks up ≤5 dirs) → `~/.heygen/credentials` (shared with heygen-cli;
`$HEYGEN_CONFIG_DIR` overrides the dir). An OAuth login is sent as
`Authorization: Bearer`; an API key as `X-Api-Key`. If the only credential is an
expired OAuth token it stops with a hint to run `npx hyperframes auth refresh`.

```bash
# Only needed if you haven't run `npx hyperframes auth login`:
export HEYGEN_API_KEY=...   # or put it in a project .env

# Synthesize + capture word timestamps in one call (skips a Whisper pass)
node skills/media-use/audio/scripts/heygen-tts.mjs \
  "Welcome to HyperFrames." -o narration.wav --words narration.words.json

node skills/media-use/audio/scripts/heygen-tts.mjs ./script.txt -o narration.wav
node skills/media-use/audio/scripts/heygen-tts.mjs --list   # public starfish voices
```

- **Voice:** `--voice <id>` must be a **starfish** voice_id (`--list`, or `GET /v3/voices?engine=starfish`). v2-catalog ids are rejected with HTTP 400. Omit `--voice` (English) and it defaults to **Marcia** (`05f19352e8f74b0392a8f411eba40de1`, a fixed default so the choice is deterministic). Non-English with no `--voice` falls back to the first matching catalog voice.
- **Output:** `.wav` → transcoded to 44.1k mono via ffmpeg; `.mp3` → raw bytes (no ffmpeg needed).
- **Words:** `--words <path>` writes the flat `[{id,text,start,end}]` shape below, drop-in for the captions pipeline. HeyGen's `<start>`/`<end>` boundary sentinels are filtered out and ids are re-contiguous.
- **Non-English:** `--lang <code>` (anything but `en`) is sent as the request `language`.

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

## When to use which provider

| Goal                                                      | Use                                                 |
| --------------------------------------------------------- | --------------------------------------------------- |
| Self-hosted / local-first TTS, no cloud dependency        | **QwenTTS** (`$QWENTTS_URL`)                        |
| Best voice quality + word timestamps in one call          | **HeyGen**                                          |
| Drop-in cloud TTS, big voice catalog                      | **ElevenLabs**                                      |
| Offline, no API key, fast iteration                       | **Kokoro**                                          |
| Non-English multilingual with deterministic phonemization | **Kokoro** (`ef_dora`, `jf_alpha`, `zf_xiaobei`, …) |

## ffmpeg requirement

HeyGen + ElevenLabs return mp3. The CLI transcodes to wav when `--output` ends in `.wav` (the default and what downstream `ffprobe` + Whisper expect). If you'd rather skip the transcode, pass `-o file.mp3`. Without `ffmpeg` on PATH, `.wav` output from the cloud providers fails — install ffmpeg or use `.mp3`.

## Voice selection (Kokoro)

Default `af_heart`. Curated picks:

| Content type      | Voice                  |
| ----------------- | ---------------------- |
| Product demo      | `af_heart`, `af_nova`  |
| Tutorial / how-to | `am_adam`, `bf_emma`   |
| Marketing / promo | `af_sky`, `am_michael` |
| Documentation     | `bf_emma`, `bm_george` |
| Casual / social   | `af_heart`, `af_sky`   |

Run `npx hyperframes tts --list` for the bundled set.

## Multilingual (Kokoro voice prefix → language)

The first letter of a Kokoro voice ID picks the phonemizer language; `--lang` overrides auto-detection.

| Prefix | Language             |
| ------ | -------------------- |
| `a`    | American English     |
| `b`    | British English      |
| `e`    | Spanish              |
| `f`    | French               |
| `h`    | Hindi                |
| `i`    | Italian              |
| `j`    | Japanese             |
| `p`    | Brazilian Portuguese |
| `z`    | Mandarin             |

```bash
npx hyperframes tts "La reunión empieza a las nueve" --voice ef_dora --provider kokoro
npx hyperframes tts "Today is a nice day" --voice af_heart --provider kokoro
```

Valid `--lang` codes (only needed to override the voice's auto-detected language): `en-us`, `en-gb`, `es`, `fr-fr`, `hi`, `it`, `pt-br`, `ja`, `zh`.

Non-English phonemization requires `espeak-ng` system-wide (`brew install espeak-ng` / `apt-get install espeak-ng`).

## Speed

- `0.7-0.8` — tutorial, complex content, accessibility
- `1.0` — natural pace (default)
- `1.1-1.2` — intros, transitions, upbeat content
- `1.5+` — rarely appropriate, test carefully

Honored by Kokoro + HeyGen; ElevenLabs ignores `--speed` (use voice settings on their dashboard).

## Long scripts

Past a few paragraphs, write the text to a `.txt` file and pass the path. Inputs over ~5 minutes of speech may benefit from splitting into segments.

## HeyGen word-timestamp shape

When `--words <path>` is passed to a HeyGen call, the file is written in the same flat shape `transcribe` produces — drop-in compatible with the captions pipeline:

```json
[
  { "id": "w0", "text": "Hi", "start": 0.0, "end": 0.21 },
  { "id": "w1", "text": "there", "start": 0.22, "end": 0.55 }
]
```

For ElevenLabs / Kokoro, run `npx hyperframes transcribe narration.wav --model small.en` to get the same shape.
