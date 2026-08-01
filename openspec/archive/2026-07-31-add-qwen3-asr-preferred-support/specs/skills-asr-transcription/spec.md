# skills-asr-transcription Delta Spec

Source of truth for the HyperFrames skill ASR/transcription chain's QwenASR preferred-provider behavior in OpenHarness.

## ADDED Requirements

### Requirement: QwenASR as highest-priority ASR engine

When `QWENASR_URL` is set, the three skill ASR entry points MUST select QwenASR (remote FastAPI wrapper + `Qwen3ASRModel.LLM` vLLM offline backend + ForcedAligner, **not** an OpenAI-compatible `vllm serve` HTTP server) as the first engine, above the existing chains: A `media-use/scripts/transcribe.mjs`（→ parakeet → whisper.cpp）、B `media-use/audio/scripts/lib/tts.mjs#transcribeWav()`（→ whisper.cpp）、C `embedded-captions/scripts/transcribe.cjs`（→ whisperx → whisper.cpp）。When `QWENASR_URL` is unset, all three entry points MUST behave identically to upstream (the QwenASR branch is never entered).

#### Scenario: QWENASR_URL set → auto-select qwenasr
- **WHEN** entry A runs with `--engine auto`（default）and `QWENASR_URL=http://gpu-host:8092`
- **THEN** QwenASR is attempted first and on success the output reports `engine: "qwenasr"`

#### Scenario: QWENASR_URL unset → upstream behavior
- **WHEN** any of the three entry points runs with `QWENASR_URL` unset
- **THEN** the engine chain and output are identical to upstream, and no `qwenasr` trace appears in run logs

#### Scenario: transcribeWav prefers QwenASR
- **WHEN** `transcribeWav({ wavRel, lang, hyperframesDir })` runs with `QWENASR_URL` set and the service returns non-empty `words`
- **THEN** it returns the QwenASR word array（mapped to the existing flat shape）without spawning `npx hyperframes transcribe`

#### Scenario: embedded-captions engine chain
- **WHEN** `transcribe.cjs` runs with `QWENASR_URL` set and no `TRANSCRIBE_ENGINE` override
- **THEN** QwenASR is tried before WhisperX, and on success the normalized output's `engine` field identifies qwenasr

### Requirement: QwenASR HTTP client contract

The skills-side client MUST call `POST ${QWENASR_URL}${QWENASR_TRANSCRIBE_PATH:-/transcribe}` with multipart/form-data（`file` = complete audio file, no base64, no client-side chunking; optional `language` as Qwen full name mapped from ISO code; `model` forwarded only when `QWENASR_MODEL` is set）, honor `QWENASR_TIMEOUT_MS`（default 600000, via AbortController）, and parse `{ok, language, text, words, duration_s}` where `words` is `[{text,start,end}]` in seconds on a global timeline or `null`. The client MUST use only Node 18+ built-ins (no new dependencies). All model/endpoint specifics MUST come from environment variables（no hardcoding）.

#### Scenario: successful transcription
- **WHEN** the client posts a wav file and the service returns `{ok:true, text, words:[…]}`
- **THEN** the client returns `{language, text, words}` to the caller

#### Scenario: runtime failure returns null
- **WHEN** the service is unreachable, returns non-200（including 413 audio-too-long）, returns `ok:false`, or times out
- **THEN** the client returns `null` and writes no partial output

#### Scenario: unmapped language → server-side LID
- **WHEN** the caller passes an ISO code outside the aligner-supported mapping（e.g. `th`）
- **THEN** the client omits the `language` field, leaving language identification to the server

### Requirement: Word-timestamp availability gates QwenASR usability

For timestamp-consuming callers (all three current entry points), a QwenASR result is usable if and only if `ok:true` AND `words` is a non-empty array (or `[]` for genuinely silent audio). Otherwise the ENTIRE QwenASR result MUST be discarded and the caller MUST fall back completely to the existing engine chain — both text and timestamps MUST then come from the fallback engine. Mixing QwenASR text with another engine's timestamps is FORBIDDEN.

#### Scenario: words null → complete fallback
- **WHEN** the service returns `ok:true` with `words:null`（aligner-unsupported language）in auto mode
- **THEN** the entry point logs one console.error line and re-runs the existing engine chain; the final output contains no QwenASR-derived text or words

#### Scenario: no mixed output
- **WHEN** QwenASR returns usable text but unusable words
- **THEN** the output MUST NOT combine QwenASR text with whisper/WhisperX timestamps

#### Scenario: silent audio is not a failure
- **WHEN** the service returns `{ok:true, text:"", words:[]}` for silent audio
- **THEN** the result is treated as a legitimate no-speech result and existing guards（embedded-captions silence guard, tail-hallucination trim）apply unchanged

### Requirement: Explicit engine selection fails fast

When the user explicitly selects QwenASR（`--engine qwenasr` for entry A, `TRANSCRIBE_ENGINE=qwenasr` for entry C）and `QWENASR_URL` is unset or the call fails, the entry point MUST exit non-zero with a descriptive error instead of silently degrading（same semantics as `provider=qwentts` validation in the QwenTTS patch）.

#### Scenario: explicit engine without URL
- **WHEN** entry A runs `--engine qwenasr` with `QWENASR_URL` unset
- **THEN** it exits non-zero with an error naming `$QWENASR_URL`

#### Scenario: explicit engine with runtime failure
- **WHEN** `TRANSCRIBE_ENGINE=qwenasr` is set and the service call fails
- **THEN** `transcribe.cjs` exits non-zero without falling back

### Requirement: Long-audio stability

The client MUST upload the complete audio in a single multipart request and MUST NOT chunk audio client-side; chunking and timestamp-offset merging are owned by the server side（`qwen_asr` package internals: low-energy boundary splitting, global-timeline merge）. Timestamps returned for long audio MUST be monotonically non-decreasing across chunk seams and cover the full duration. Requests exceeding the server limit（HTTP 413）or `QWENASR_TIMEOUT_MS` MUST follow the standard fallback semantics.

#### Scenario: 10-minute audio transcribed in one request
- **WHEN** entry A transcribes a ≥10-minute audio via QwenASR
- **THEN** one HTTP request is made, and the returned words cover the full duration with monotonically non-decreasing timestamps

#### Scenario: over-limit audio → fallback
- **WHEN** the server responds 413 for an over-limit audio
- **THEN** the caller falls back to the existing engine chain（which has no such limit）

### Requirement: Environment variable configuration

The integration MUST expose exactly four container-side variables — `QWENASR_URL`（enable switch）, `QWENASR_MODEL`（optional model name, forwarded only when set）, `QWENASR_TRANSCRIBE_PATH`（default `/transcribe`）, `QWENASR_TIMEOUT_MS`（default 600000）— passed through `docker-compose.yml` for the `openharness` and `api` services and documented as placeholders in `.env.example`. Server-side variables（`QWEN3_ASR_MODEL` default `Qwen/Qwen3-ASR-1.7B`, `QWEN3_ALIGNER_MODEL` default `Qwen/Qwen3-ForcedAligner-0.6B`, `QWEN3_ASR_GPU_UTIL`, `QWEN3_ASR_PORT`, `QWEN3_ASR_MAX_AUDIO_SEC`）MUST appear only in the `Qwen3-ASR-Script/README.md` deployment reference, not in project compose files.

#### Scenario: compose passthrough
- **WHEN** inspecting `docker-compose.yml` after the change
- **THEN** `openharness` and `api` services each pass through the four `QWENASR_*` variables with empty-string defaults

#### Scenario: no server-side vars in compose
- **WHEN** grepping project compose files for `QWEN3_ASR_`
- **THEN** no matches are found（server-side vars live only in the deployment reference README）

### Requirement: Deployment reference script is not a runtime component

The repository MUST include `Qwen3-ASR-Script/qwen3_asr_server.py` and `Qwen3-ASR-Script/README.md` as a deployment reference for the remote GPU server owner. The script MUST NOT be copied into the main image and the project MUST NOT depend on it at runtime — the only project-side dependency is the HTTP contract. The README MUST state the default model split（ASR = Qwen3-ASR-1.7B for transcription+LID; aligner = Qwen3-ForcedAligner-0.6B for forced alignment only, no recognition）.

#### Scenario: script excluded from image
- **WHEN** inspecting `Dockerfile.fix` and the main image build after the change
- **THEN** no layer copies `Qwen3-ASR-Script/` into the image

#### Scenario: README documents model roles
- **WHEN** reading `Qwen3-ASR-Script/README.md`
- **THEN** it names both default models and their mutually exclusive roles

### Requirement: ASR documentation patches

Skill docs MUST present QwenASR as the preferred transcription engine when `$QWENASR_URL` is set, across seven locations: `media-use/SKILL.md`（frontmatter）, `media-use/references/audio.md`, `media-use/references/setup-providers.md`, `media-use/references/operations.md`, `media-use/audio/references/transcribe.md`（new `## QwenASR (remote deployment)` section with the four env vars and aligner language caveat）, `embedded-captions/SKILL.md`, and `talking-head-recut/SKILL.md`（callout switching to the media-use transcribe entry with a `jq '.words'` conversion）. All customization MUST be greppable by the `qwenasr` keyword for upstream-sync replay, and the final patch state MUST be recorded in `docs/hyperframes-skill-openharness-patches.md` as "补丁三：QwenASR".

#### Scenario: docs greppable by keyword
- **WHEN** running `grep -ril qwenasr` over `hyperframes_github_skills/`
- **THEN** all seven documentation locations plus the three patched scripts and the shared client are matched

#### Scenario: patches doc records final state
- **WHEN** reading `docs/hyperframes-skill-openharness-patches.md` after implementation
- **THEN** a "补丁三：QwenASR" section lists every injection point for upstream-sync replay
