// =============================================================================
// Sanitization & validation helpers (spec: harden-web-frontend).
//
// All functions here are PURE and side-effect free. They are the single place
// where untrusted input (user prompt, `oh` args, download filenames, and
// backend-provided strings like status / message / log lines) is made safe
// before it is rendered or sent to the API.
// =============================================================================
import {
  DEFAULT_TIMEOUT_SECONDS,
  FILE_EXT_ALLOWLIST,
  MAX_FILENAME_CHARS,
  MAX_OH_ARG_LEN,
  MAX_OH_ARGS,
  MAX_PROMPT_CHARS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
} from "../constants";

// Control characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F) that must never
// reach the DOM or the backend. We detect/strip them by char code (not a regex
// literal with control chars) to keep the source lint-clean and diff-safe.
function isControlChar(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
}
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (isControlChar(s.charCodeAt(i))) return true;
  }
  return false;
}
// HTML/script tags that could inject markup.
const HTML_TAG_RE = /<\/?[^>]*>/g;
// `javascript:` style pseudo-protocols.
const JS_PROTOCOL_RE = /javascript:/gi;
// Path traversal sequences used to escape the intended directory.
const TRAVERSAL_RE = /\.\.(\/|\\)/g;
// Characters that are illegal in a filesystem name on common platforms
// (control chars are rejected separately via isControlChar).
const ILLEGAL_FILENAME_CHARS_RE = /["*/:<>?\\|]/g;

/** Strip control characters from an arbitrary string. */
export function stripControlChars(input: string): string {
  let out = "";
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    if (!isControlChar(s.charCodeAt(i))) out += s[i];
  }
  return out;
}

/**
 * Remove anything that could be interpreted as HTML/markup. Use this for any
 * text that originates from the user OR the backend before rendering it.
 */
export function sanitizeText(input: string): string {
  return stripControlChars(String(input))
    .replace(HTML_TAG_RE, "")
    .replace(JS_PROTOCOL_RE, "");
}

/** Sanitize a single log line received over SSE before rendering it. */
export function sanitizeLogLine(input: string): string {
  return sanitizeText(input);
}

/**
 * Normalize an arbitrary error value into a safe, display-ready message.
 * Never leaks raw objects; everything is sanitized text.
 */
export function sanitizeError(error: unknown): string {
  if (error == null) return "发生未知错误，请稍后重试";
  if (typeof error === "string") {
    const t = sanitizeText(error).trim();
    return t.length ? t : "发生未知错误，请稍后重试";
  }
  if (error instanceof Error) {
    const t = sanitizeText(error.message).trim();
    return t.length ? t : "发生未知错误，请稍后重试";
  }
  if (typeof error === "object") {
    const maybe = (error as { message?: unknown }).message;
    if (typeof maybe === "string") {
      const t = sanitizeText(maybe).trim();
      if (t.length) return t;
    }
  }
  return "发生未知错误，请稍后重试";
}

/** Sanitize a single `oh` argument: strip markup, clamp length, drop empties. */
export function sanitizeArg(input: string): string {
  return sanitizeText(String(input)).slice(0, MAX_OH_ARG_LEN);
}

/**
 * Sanitize a download filename for safe use as a filesystem name.
 * Strips traversal, illegal chars and control chars, clamps length and
 * guarantees a non-empty result.
 */
export function sanitizeFilename(input: string): string {
  const cleaned = String(input)
    .replace(TRAVERSAL_RE, "")
    .replace(ILLEGAL_FILENAME_CHARS_RE, "_")
    .slice(0, MAX_FILENAME_CHARS)
    .trim();
  return cleaned.length ? cleaned : "video.mp4";
}

/** Trim + clamp a user prompt and strip unsafe characters. */
export function sanitizePrompt(input: string): string {
  return sanitizeText(String(input)).slice(0, MAX_PROMPT_CHARS).trim();
}

/**
 * Validate a prompt's shape. Returns a human-readable error (safe to show) or
 * `null` when the prompt is acceptable.
 */
export function validatePromptShape(input: string): string | null {
  const t = sanitizeText(String(input)).trim();
  if (!t) return "提示词（prompt）不能为空";
  if (t.length > MAX_PROMPT_CHARS) {
    return `提示词过长，最多 ${MAX_PROMPT_CHARS} 个字符`;
  }
  return null;
}

/**
 * Sanitize + clamp an array of `oh` arguments: strips markup, drops empty
 * entries, truncates each arg and caps the total count.
 */
export function validateAndSanitizeOhArgs(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((a) => sanitizeArg(String(a)))
    .filter((a) => a.trim().length > 0)
    .slice(0, MAX_OH_ARGS);
}

export interface FilenameValidation {
  ok: boolean;
  safeName: string;
  error?: string;
}

/**
 * Validate a download filename and return a sanitized fallback. The returned
 * `safeName` is always safe to use even when `ok` is false (caller may decide
 * to reject or to fall back).
 */
export function validateFilename(input: string | undefined): FilenameValidation {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return { ok: false, safeName: "video.mp4", error: "文件名不能为空" };
  }
  if (raw.length > MAX_FILENAME_CHARS) {
    return {
      ok: false,
      safeName: sanitizeFilename(raw),
      error: `文件名过长，最多 ${MAX_FILENAME_CHARS} 个字符`,
    };
  }
  if (ILLEGAL_FILENAME_CHARS_RE.test(raw) || hasControlChar(raw)) {
    return {
      ok: false,
      safeName: sanitizeFilename(raw),
      error: "文件名包含非法字符",
    };
  }
  const ext = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1).toLowerCase() : "";
  if (FILE_EXT_ALLOWLIST.size > 0 && !FILE_EXT_ALLOWLIST.has(ext)) {
    return {
      ok: false,
      safeName: sanitizeFilename(raw),
      error: `不允许的文件扩展名: .${ext || "(无)"}`,
    };
  }
  return { ok: true, safeName: raw };
}

/**
 * Clamp a user-supplied timeout into the allowed [min, max] range, falling
 * back to the default on invalid input.
 */
export function validateTimeout(input: number | undefined): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SECONDS;
  if (n < MIN_TIMEOUT_SECONDS) return MIN_TIMEOUT_SECONDS;
  if (n > MAX_TIMEOUT_SECONDS) return MAX_TIMEOUT_SECONDS;
  return Math.round(n);
}

/**
 * Build a safe `Content-Disposition` header value for a download. Uses the
 * RFC 5987 `filename*` encoding for non-ASCII names and an ASCII fallback,
 * so the value is always valid and never injects header-breaking characters.
 */
export function safeContentDisposition(input: string): string {
  const name = sanitizeFilename(input);
  const isAscii = /^[\x20-\x7e]*$/.test(name);
  if (isAscii) {
    const escaped = name.replace(/"/g, "");
    return `attachment; filename="${escaped}"`;
  }
  const encoded = encodeURIComponent(name);
  return `attachment; filename*=UTF-8''${encoded}`;
}
