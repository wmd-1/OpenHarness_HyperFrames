// =============================================================================
// API client (spec: harden-web-frontend).
//
// Hardening notes:
//  - All responses go through `expectOkJson`, which throws on non-2xx and on
//    non-JSON content types, so a backend error page can never be parsed as a
//    task object.
//  - Task ids used in URLs are sanitized and `encodeURIComponent`-escaped to
//    prevent path traversal / injection into the API path.
//  - `getHealth` is defensive: any failure is treated as `degraded` rather
//    than throwing.
// =============================================================================

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/** localStorage key under which the user-supplied API key is stored. */
export const API_KEY_STORAGE = "oh_api_key";

export interface TaskLinks {
  self?: string;
  file?: string;
  events?: string;
}

export interface VideoTask {
  task_id: string;
  status: TaskStatus;
  links: TaskLinks;
  error?: string;
  message?: string;
  progress?: number;
}

export interface HealthStatus {
  status: "ok" | "degraded" | string;
  [key: string]: unknown;
}

/** Read the API key (if any) from localStorage, tolerating disabled storage. */
function getApiKey(): string | null {
  try {
    return localStorage.getItem("oh_api_key");
  } catch {
    return null;
  }
}

/**
 * Make a task id safe for use inside a URL path: keep only benign characters
 * and strip any `..` traversal segments. We also `encodeURIComponent` the
 * result at the call site.
 */
function sanitizeId(id: string): string {
  const cleaned = String(id).replace(/[^A-Za-z0-9._:-]/g, "");
  return cleaned.replace(/\.\./g, "");
}

/** Build request headers, injecting X-API-Key when the user configured one. */
function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key
    ? { "Content-Type": "application/json", "X-API-Key": key }
    : { "Content-Type": "application/json" };
}

/**
 * Resolve a `Response` to JSON, throwing a sanitized error on failure.
 *  - Non-2xx  -> throws `HTTP <status>: <body>`
 *  - Non-JSON -> throws an explicit "expected JSON" error
 * The error message is derived from the response body (sanitized downstream by
 * the UI), never from an unchecked object.
 */
async function expectOkJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const snippet = (body || `HTTP ${res.status}`).slice(0, 500);
    throw new Error(`HTTP ${res.status}: ${snippet}`);
  }
  let ct = "";
  try {
    ct = res.headers?.get?.("content-type") ?? "";
  } catch {
    ct = "";
  }
  if (ct && !ct.includes("application/json")) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Expected JSON response, got: ${ct || "unknown"} (${body.slice(0, 200)})`
    );
  }
  return res.json();
}

/** Same-origin file URL for a task (api_key appended for auth when set). */
export function fileUrl(id: string): string {
  const safe = encodeURIComponent(sanitizeId(id));
  const key = getApiKey();
  return key
    ? `/v1/videos/${safe}/file?api_key=${encodeURIComponent(key)}`
    : `/v1/videos/${safe}/file`;
}

/** Same-origin SSE URL for a task (api_key appended for auth when set). */
export function eventsUrl(id: string): string {
  const safe = encodeURIComponent(sanitizeId(id));
  const key = getApiKey();
  return key
    ? `/v1/videos/${safe}/events?api_key=${encodeURIComponent(key)}`
    : `/v1/videos/${safe}/events`;
}

export async function createVideo(
  prompt: string,
  timeoutSeconds: number,
  extraOhArgs: string[] = [],
  idempotencyKey?: string
): Promise<VideoTask> {
  const body: Record<string, unknown> = {
    prompt,
    timeout_seconds: timeoutSeconds,
    extra_oh_args: extraOhArgs,
  };
  if (idempotencyKey !== undefined) {
    body.idempotency_key = idempotencyKey;
  }
  const res = await fetch("/v1/videos", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return (await expectOkJson(res)) as VideoTask;
}

export async function getVideo(id: string): Promise<VideoTask> {
  const res = await fetch(`/v1/videos/${encodeURIComponent(sanitizeId(id))}`, {
    headers: authHeaders(),
  });
  return (await expectOkJson(res)) as VideoTask;
}

export async function deleteVideo(id: string): Promise<VideoTask> {
  const res = await fetch(`/v1/videos/${encodeURIComponent(sanitizeId(id))}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return (await expectOkJson(res)) as VideoTask;
}

/**
 * Health probe. Any network/parse failure is mapped to `degraded` so the UI
 * degrades gracefully instead of crashing.
 */
export async function getHealth(): Promise<HealthStatus> {
  try {
    const res = await fetch("/healthz", { headers: { Accept: "application/json" } });
    if (!res.ok) return { status: "degraded" };
    const data = (await res.json().catch(() => null)) as HealthStatus | null;
    if (!data || typeof data !== "object") return { status: "degraded" };
    if (data.status !== "ok" && data.status !== "degraded") {
      return { status: "degraded" };
    }
    return data;
  } catch {
    return { status: "degraded" };
  }
}
