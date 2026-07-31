// WS 消息编解码与类型校验（task 6.1）。

import type { ClientFrame, ServerFrame } from '../types/ws';

/** 已知服务端帧类型集合（未知类型仍透传，但标记为 generic）。 */
const KNOWN_FRAME_TYPES = new Set([
  'session_ready',
  'delta',
  'turn_complete',
  'tool_start',
  'tool_end',
  'todo',
  'approval_request',
  'busy',
  'pong',
  'error',
  'turn_error',
  'event',
]);

export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

/**
 * 解析服务端帧：非 JSON / 缺少 type 字段返回 null（调用方忽略该帧）。
 * 未知 type 的帧包装为透传 event 帧，保证协议前向兼容。
 */
export function decodeServerFrame(raw: string): ServerFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.type !== 'string') return null;
  if (!KNOWN_FRAME_TYPES.has(obj.type)) {
    return { type: 'event', event: obj };
  }
  return obj as unknown as ServerFrame;
}

/** 构建 WS URL：/v1/sessions/{sid}/ws?api_key=...&last_turn_index=N */
export function buildWsUrl(
  sid: string,
  apiKey: string | null,
  lastTurnIndex: number | null,
  base?: string,
): string {
  const origin = base ?? window.location.origin.replace(/^http/, 'ws');
  const url = new URL(`/v1/sessions/${sid}/ws`, origin);
  if (apiKey) url.searchParams.set('api_key', apiKey);
  if (lastTurnIndex !== null && lastTurnIndex >= 0) {
    url.searchParams.set('last_turn_index', String(lastTurnIndex));
  }
  return url.toString();
}

export { WS_CLOSE_CODES, WS_CLOSE_MESSAGES } from '../utils/constants';
