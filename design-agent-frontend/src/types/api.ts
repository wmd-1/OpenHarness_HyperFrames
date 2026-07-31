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

/** 会话摘要（GET /v1/sessions 列表项，§2.6）：不含 permission_policy/ws_url 等 detail 独有字段。 */
export interface SessionSummary {
  session_id: string;
  status: SessionStatus;
  /** 首轮 prompt 截断 80 字符；0 轮会话为 null。 */
  title: string | null;
  turn_count: number;
  /** 是否可连 WS 复活继续对话（前端决策只用此字段，不解读 status）。 */
  resumable: boolean;
  /** 是否只读（仅可查历史，不可再交互）。 */
  read_only: boolean;
  created_at: string;
  last_active_at: string;
}

export interface SessionListResponse {
  items: SessionSummary[];
  total: number;
  limit: number;
  offset: number;
}

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

/** 轮次历史列表（GET /{sid}/turns，§2.7）：按 turn_index 升序，游标分页。 */
export interface TurnListResponse {
  items: TurnResponse[];
  /** 该会话轮次总数（不受游标影响）。 */
  total: number;
}

/** 工作区文件条目（§2.8）。 */
export interface WorkspaceFileEntry {
  path: string;
  size: number;
  mtime: string;
  /** 仅 archive 源。 */
  etag?: string | null;
}

export type WorkspaceFileSource = 'live' | 'archive' | 'none';

export interface WorkspaceFileListResponse {
  source: WorkspaceFileSource;
  /** 会话 LIVE/IDLE 但走了 archive 源（跨节点）：快照至多落后一个 turn。 */
  stale: boolean;
  sync_seq: number | null;
  last_synced_at: string | null;
  total: number;
  files: WorkspaceFileEntry[];
  next_page_token: string | null;
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
