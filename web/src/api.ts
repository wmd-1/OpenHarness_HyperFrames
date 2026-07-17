import type {
  HealthResponse,
  TaskLinks,
  VideoCreateResponse,
  VideoTaskResponse,
} from "./types";

const API_BASE: string = import.meta.env.VITE_API_BASE || "";
export const API_KEY_STORAGE = "oh_api_key";

function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE)?.trim() || "";
  } catch {
    return "";
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getApiKey();
  const headers: Record<string, string> = {
    ...(init?.headers as unknown as Record<string, string> | undefined),
  };
  if (key) headers["X-API-Key"] = key;
  const res = await fetch(API_BASE + path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error("HTTP " + res.status + ": " + text);
  }
  return (await res.json()) as T;
}

export function createVideo(
  prompt: string,
  timeout_seconds: number,
  extra_oh_args: string[] = [],
  idempotency_key?: string
): Promise<VideoCreateResponse> {
  const body: Record<string, unknown> = {
    prompt,
    timeout_seconds,
    extra_oh_args,
  };
  if (idempotency_key) body.idempotency_key = idempotency_key;
  return http<VideoCreateResponse>("/v1/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getVideo(id: string): Promise<VideoTaskResponse> {
  return http<VideoTaskResponse>("/v1/videos/" + id);
}

export function deleteVideo(
  id: string
): Promise<{ task_id: string; status: string; message: string }> {
  return http<{ task_id: string; status: string; message: string }>(
    "/v1/videos/" + id,
    { method: "DELETE" }
  );
}

export function getHealth(): Promise<HealthResponse> {
  return http<HealthResponse>("/healthz");
}

export function fileUrl(id: string): string {
  const base = API_BASE + "/v1/videos/" + id + "/file";
  const key = getApiKey();
  return key ? base + "?api_key=" + encodeURIComponent(key) : base;
}

export function eventsUrl(id: string): string {
  const base = API_BASE + "/v1/videos/" + id + "/events";
  const key = getApiKey();
  return key ? base + "?api_key=" + encodeURIComponent(key) : base;
}

export type { TaskLinks };
