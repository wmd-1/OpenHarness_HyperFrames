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
  turn_count: number;
  created_at: string;
  last_active_at: string;
  // 列表接口新增（detail 接口不返回 → merge 时保留旧值，F1.1）
  title?: string | null;
  resumable?: boolean;
  read_only?: boolean;
  // detail 接口独有（summary 不返回 → 选中时懒加载，F1.4）
  permission_policy?: PermissionPolicy;
  oh_session_id?: string | null;
  ws_url?: string | null;
}

/** 终态会话（不再可交互，不建立 WS）。 */
export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = [
  'closed',
  'expired',
  'failed',
];

/** 仅服务存量 status 展示逻辑；职责不再扩大、不新增调用点（F1.5 rev1）。 */
export function isSessionTerminal(status: SessionStatus): boolean {
  return TERMINAL_SESSION_STATUSES.includes(status);
}

// ---- 语义谓词（F1.5 rev1/rev2）：业务判断与内部 status 枚举解耦，
// 建连/只读/唤醒各走专属谓词互不复用；后端加态只改这里的映射。----

/**
 * 是否允许建立 WS（WS 建连门控的唯一入口）。
 * `resumable === true`；字段缺失（仅有 detail 数据的旧后端）回退 `!isSessionTerminal`。
 */
export function canConnectSession(session: Session): boolean {
  if (session.resumable !== undefined) return session.resumable;
  return !isSessionTerminal(session.status);
}

/**
 * 是否只读回看（输入禁用、只读徽标、LifecycleNotice 文案）。
 * `read_only === true`；字段缺失时回退终态 status 判定。
 */
export function isReadonlySession(session: Session): boolean {
  if (session.read_only !== undefined) return session.read_only;
  return isSessionTerminal(session.status);
}

/**
 * 是否可从 cold/failed 唤醒继续对话（卡片可点击性、唤醒流程门槛）。
 * 语义边界（rev2）：现行契约下 `read_only=true` 必然 `resumable=false`，
 * `!isReadonlySession` 一项是防御性冗余；若未来权限模型扩展出
 * `read_only=true && resumable=true` 并存态（如「只读但可唤醒查看实时状态」），
 * 必须重新定义本谓词而非在调用点打补丁。
 */
export function canResumeSession(session: Session): boolean {
  return canConnectSession(session) && !isReadonlySession(session);
}
