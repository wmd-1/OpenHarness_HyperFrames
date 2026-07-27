// 会话领域类型 — 与 session-service `app/schemas.py::SessionResponse` 对齐。

export type SessionStatus =
  | 'creating'
  | 'live'
  | 'idle'
  | 'cold'
  | 'closed'
  | 'expired'
  | 'failed';

export type PermissionPolicy = 'full_auto' | 'interactive';

export interface Session {
  session_id: string;
  status: SessionStatus;
  permission_policy: PermissionPolicy;
  turn_count: number;
  oh_session_id: string | null;
  created_at: string;
  last_active_at: string;
  ws_url: string | null;
}

/** 终态会话（不再可交互，不建立 WS）。 */
export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = [
  'closed',
  'expired',
  'failed',
];

export function isSessionTerminal(status: SessionStatus): boolean {
  return TERMINAL_SESSION_STATUSES.includes(status);
}
