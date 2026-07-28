// WebSocket 帧类型 — 与 session-service `app/routers/ws.py` +
// `app/session/supervisor.py::_map_event` 的实际协议对齐。

// ---- 客户端 → 服务端 ----

export type ApprovalReply = 'once' | 'always' | 'reject';

export interface SubmitFrame {
  op: 'submit';
  text: string;
}

export interface InterruptFrame {
  op: 'interrupt';
}

export interface ApprovalFrame {
  op: 'approval';
  request_id: string;
  allowed: boolean;
  reply?: ApprovalReply;
  answer?: string;
}

export interface PingFrame {
  op: 'ping';
}

export type ClientFrame = SubmitFrame | InterruptFrame | ApprovalFrame | PingFrame;

// ---- 服务端 → 客户端 ----

export interface SessionReadyFrame {
  type: 'session_ready';
  session_id?: string;
}

export interface DeltaFrame {
  type: 'delta';
  text: string;
  turn_index: number;
  final?: boolean;
}

export interface TurnCompleteFrame {
  type: 'turn_complete';
  turn_index: number;
  interrupted?: boolean;
  replayed?: boolean;
  assistant_text?: string | null;
  /** 该轮次是否注册了产物（A1）；旧后端可能缺失，缺失按 false 处理。 */
  has_artifact?: boolean;
}

export interface ToolStartFrame {
  type: 'tool_start';
  tool_name: string | null;
  tool_input: Record<string, unknown> | null;
  turn_index: number;
}

export interface ToolEndFrame {
  type: 'tool_end';
  tool_name: string | null;
  output: string | null;
  is_error: boolean | null;
  turn_index: number;
}

export interface TodoFrame {
  type: 'todo';
  todo_markdown: string | null;
  turn_index: number;
}

/** modal 载荷：kind=permission/edit_diff/question（来自 openharness backend_host）。 */
export interface ApprovalModal {
  kind: 'permission' | 'edit_diff' | 'question' | string;
  request_id?: string;
  tool_name?: string;
  reason?: string;
  path?: string;
  diff?: string;
  added?: number;
  removed?: number;
  question?: string;
  [key: string]: unknown;
}

export interface ApprovalRequestFrame {
  type: 'approval_request';
  request_id: string | null;
  modal: ApprovalModal | null;
  turn_index: number;
}

export interface BusyFrame {
  type: 'busy';
}

export interface PongFrame {
  type: 'pong';
}

export interface ErrorFrame {
  type: 'error';
  message: string;
}

export interface TurnErrorFrame {
  type: 'turn_error';
  message: string;
  turn_index?: number;
  /** 结构化错误码（A4）；首个取值 "approval_timeout"，缺失时按文案匹配回退。 */
  code?: string;
}

/** 未知后端事件的透明透传帧。 */
export interface GenericEventFrame {
  type: 'event';
  event: Record<string, unknown>;
  turn_index?: number;
}

export type ServerFrame =
  | SessionReadyFrame
  | DeltaFrame
  | TurnCompleteFrame
  | ToolStartFrame
  | ToolEndFrame
  | TodoFrame
  | ApprovalRequestFrame
  | BusyFrame
  | PongFrame
  | ErrorFrame
  | TurnErrorFrame
  | GenericEventFrame;

/** WS 连接状态机。 */
export type WsStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'auth_failed'
  | 'session_closed'
  | 'session_not_found'
  | 'rate_limited'
  | 'failed'
  | 'closed';
