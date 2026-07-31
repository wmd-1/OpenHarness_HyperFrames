// qwenasr.mjs — shared HTTP client for the remote QwenASR wrapper service
// (FastAPI wrapper + Qwen3ASRModel.LLM vLLM offline backend + ForcedAligner —
// NOT an OpenAI-compatible `vllm serve`). One POST returns text + word-level
// timestamps on a global timeline. See Qwen3-ASR-Script/README.md for the
// server-side deployment reference and docs/hyperframes-skill-openharness-patches.md
// ("补丁三：QwenASR") for the patch record.
//
// Configuration is env-only (no hardcoded endpoints/models):
//   QWENASR_URL             enable switch; unset = caller must not enter this path
//   QWENASR_MODEL           optional; forwarded as `model` field only when set
//   QWENASR_TRANSCRIBE_PATH optional; default /transcribe
//   QWENASR_TIMEOUT_MS      optional; default 600000 (raise for long videos)
//
// Contract: transcribeViaQwenASR() returns {language, text, words} on success,
// or null on ANY runtime failure (unreachable / non-200 incl. 413 / ok:false /
// timeout / bad JSON) — callers fall back to their existing engine chain.
// words is [{text,start,end}] in seconds, [] for silent audio, or null when the
// aligner can't handle the language. Callers that need timestamps MUST treat
// words:null (or a missing array) as "entire result unusable" and fall back
// completely — never mix QwenASR text with another engine's timestamps.
//
// Node 18+ built-ins only (fetch/FormData/Blob/AbortController) — no deps.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

// ISO 639-1 → Qwen full language names, limited to the 11 languages the
// Qwen3-ForcedAligner supports (timestamps are the whole point here). Anything
// outside this map is NOT sent — server-side LID decides, and if the aligner
// can't align, words comes back null and the caller falls back.
const ISO_TO_QWEN = {
  zh: "Chinese",
  en: "English",
  yue: "Cantonese",
  fr: "French",
  de: "German",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese",
  ru: "Russian",
  es: "Spanish",
};

export function qwenAsrConfigured() {
  return Boolean(process.env.QWENASR_URL);
}

// POST the complete audio file (no base64, no client-side chunking — long-audio
// chunking + timestamp offset merge happen inside the server's qwen_asr package).
// Returns {language, text, words} or null. Never throws.
export async function transcribeViaQwenASR(audioPath, { lang } = {}) {
  const base = process.env.QWENASR_URL;
  if (!base) return null;
  const path = process.env.QWENASR_TRANSCRIBE_PATH || "/transcribe";
  const url = base.replace(/\/+$/, "") + path;
  const timeoutMs = Number(process.env.QWENASR_TIMEOUT_MS || 600000);

  let body;
  try {
    body = new FormData();
    body.set("file", new Blob([readFileSync(audioPath)]), basename(audioPath));
    body.set("timestamps", "1");
    const qwenLang = lang ? ISO_TO_QWEN[String(lang).toLowerCase()] : undefined;
    if (qwenLang) body.set("language", qwenLang);
    if (process.env.QWENASR_MODEL) body.set("model", process.env.QWENASR_MODEL);
  } catch (err) {
    console.error(`qwenasr: cannot read audio ${audioPath}: ${err.message}`);
    return null;
  }

  try {
    const res = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      console.error(`qwenasr: ${url} returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data || data.ok !== true || typeof data.text !== "string") {
      console.error(`qwenasr: bad response from ${url}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    const words = Array.isArray(data.words)
      ? data.words
          .filter((w) => w && typeof w.text === "string" && Number.isFinite(w.start) && Number.isFinite(w.end))
          .map((w) => ({ text: w.text, start: w.start, end: w.end }))
      : null;
    return { language: data.language || "", text: data.text, words };
  } catch (err) {
    console.error(`qwenasr: request to ${url} failed: ${err.message}`);
    return null;
  }
}
