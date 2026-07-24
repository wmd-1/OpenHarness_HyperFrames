// =============================================================================
// Frontend hardening constants.
// Centralized limits/knobs so validation, sanitization and runtime guards
// share a single source of truth (spec: harden-web-frontend).
// =============================================================================

// --- Prompt / free-text limits ---------------------------------------------
/** Max characters accepted for the generation prompt (defense against abuse). */
export const MAX_PROMPT_CHARS = 4000;

// --- `oh` extra args limits ------------------------------------------------
/** Max number of extra `oh` arguments allowed per request. */
export const MAX_OH_ARGS = 50;
/** Max length of a single `oh` argument; longer values are truncated. */
export const MAX_OH_ARG_LEN = 512;

// --- Download filename limits ----------------------------------------------
/** Max length of a requested download filename. */
export const MAX_FILENAME_CHARS = 255;
/**
 * Allowed download filename extensions. Empty/unknown extensions are rejected
 * so the client never triggers a download with a dangerous type.
 */
export const FILE_EXT_ALLOWLIST = new Set<string>([
  "mp4",
  "webm",
  "mov",
  "mkv",
  "avi",
  "m4v",
  "gif",
]);

// --- Timeout bounds (seconds) ----------------------------------------------
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 3600;

// --- Client-side guards ----------------------------------------------------
/** Minimum interval between two create requests (naive rate limiting). */
export const API_RATE_LIMIT_MS = 700;
/** Base delay before reconnecting a dropped SSE stream (ms). */
export const EVENT_RETRY_MS = 2000;
/** Hard cap on SSE reconnect attempts per task. */
export const EVENT_MAX_RETRIES = 5;
/** Interval between progress polls (ms). */
export const PROGRESS_POLL_MS = 2000;
/** Consecutive poll failures before we stop tracking a task (B1). */
export const MAX_POLL_FAILURES = 3;
