// 对话领域类型（消息、工具调用、轮次、产物）。

export type MessageRole = 'user' | 'assistant' | 'system';

export type ToolCallStatus = 'running' | 'success' | 'error';

export interface ToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown> | null;
  output: string | null;
  status: ToolCallStatus;
  turnIndex: number;
  startedAt: number;
}

export type TurnStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'timed_out';

export interface ArtifactInfo {
  artifact_id: string;
  turn_index: number;
  storage_kind: string;
  filename: string | null;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  resolution: string | null;
  fps: number | null;
}

interface MessageBase {
  id: string;
  turnIndex: number;
  createdAt: number;
}

export interface UserMessage extends MessageBase {
  kind: 'user';
  text: string;
}

export interface AssistantMessage extends MessageBase {
  kind: 'assistant';
  text: string;
  /** 流式接收中（打字光标）。 */
  streaming: boolean;
  /** 轮次完成且有产物时填充，用于内嵌视频预览。 */
  hasArtifact: boolean;
}

export interface SystemMessage extends MessageBase {
  kind: 'system';
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface ToolMessage extends MessageBase {
  kind: 'tool';
  toolCall: ToolCall;
}

export type Message = UserMessage | AssistantMessage | SystemMessage | ToolMessage;
