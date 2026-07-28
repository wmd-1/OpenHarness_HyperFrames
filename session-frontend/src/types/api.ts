// REST API 请求 / 响应类型 — 与 session-service `app/schemas.py` 对齐。

import type { PermissionPolicy, Session, SessionStatus } from './session';
import type { TurnStatus } from './conversation';

export interface SessionCreateRequest {
  permission_policy: PermissionPolicy;
  extra_oh_args: string[];
}

export interface TurnSubmitRequest {
  text: string;
}

export type SessionResponse = Session;

export interface TurnResponse {
  turn_id: string;
  turn_index: number;
  status: TurnStatus;
  prompt: string;
  assistant_text: string | null;
  error_message: string | null;
  /** 该轮次是否注册了产物（A1）；旧后端可能缺失。 */
  has_artifact?: boolean;
  started_at: string;
  finished_at: string | null;
}

export interface DeleteResponse {
  session_id: string;
  status: SessionStatus;
  message: string;
}

export interface HealthResponse {
  status: string;
  db: string;
  redis: string;
}

export interface ReadyResponse {
  status: string;
  db: string;
  redis: string;
  live_sessions: number;
  capacity: number;
}

/** 后端错误体：detail 为纯文本或结构化 { code, message }（如配额类 403）。 */
export interface ApiErrorBody {
  detail?: string | { code?: string; message?: string };
}
