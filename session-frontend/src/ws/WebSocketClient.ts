// WebSocket 连接管理类（task 6.2）：
// - 连接建立（携带 api_key + last_turn_index）
// - 消息发送（submit / interrupt / approval / ping）
// - 指数退避重连（1s→30s，最多 10 次）；4429 等待 60s 单次重试
// - 心跳保活（30s ping，连续 3 次无 pong 判定死连接）
// - 关闭码差异化处理（4401/4403/4404/4429）

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  RATE_LIMIT_RETRY_DELAY_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  WS_CLOSE_CODES,
} from '../utils/constants';
import type { ApprovalReply, ClientFrame, ServerFrame, WsStatus } from '../types/ws';
import { buildWsUrl, decodeServerFrame, encodeClientFrame } from './protocol';

export interface WebSocketClientOptions {
  sessionId: string;
  getApiKey: () => string | null;
  /** 每次（重）连时取最新 last_turn_index，用于服务端补发。 */
  getLastTurnIndex: () => number | null;
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: WsStatus, detail?: { attempt?: number; closeCode?: number }) => void;
  /** 测试注入用；默认使用全局 WebSocket。 */
  wsFactory?: (url: string) => WebSocket;
}

export class WebSocketClient {
  private readonly opts: WebSocketClientOptions;
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private missedPongs = 0;
  private disposed = false;
  /** 手动 disconnect 后不再自动重连。 */
  private intentionalClose = false;

  constructor(opts: WebSocketClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    if (this.disposed) return;
    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.opts.onStatus('closed');
  }

  dispose(): void {
    this.disposed = true;
    this.intentionalClose = true;
    this.cleanup();
  }

  /** 手动重试（达到最大重连次数后 UI 按钮调用）。 */
  retry(): void {
    this.reconnectAttempt = 0;
    this.connect();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ---- 消息发送 ----

  send(frame: ClientFrame): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(encodeClientFrame(frame));
    return true;
  }

  submit(text: string): boolean {
    return this.send({ op: 'submit', text });
  }

  interrupt(): boolean {
    return this.send({ op: 'interrupt' });
  }

  approve(requestId: string, allowed: boolean, reply?: ApprovalReply, answer?: string): boolean {
    return this.send({ op: 'approval', request_id: requestId, allowed, reply, answer });
  }

  ping(): boolean {
    return this.send({ op: 'ping' });
  }

  // ---- 内部 ----

  private openSocket(): void {
    this.cleanupSocket();
    const url = buildWsUrl(
      this.opts.sessionId,
      this.opts.getApiKey(),
      this.opts.getLastTurnIndex(),
    );
    this.opts.onStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', {
      attempt: this.reconnectAttempt,
    });
    const ws = this.opts.wsFactory ? this.opts.wsFactory(url) : new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.missedPongs = 0;
      this.startHeartbeat();
      // ready 状态在收到 session_ready 帧时上报
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const frame = decodeServerFrame(event.data);
      if (!frame) return;
      if (frame.type === 'pong') {
        this.missedPongs = 0;
      }
      if (frame.type === 'session_ready') {
        this.opts.onStatus('ready');
      }
      this.opts.onFrame(frame);
    };

    ws.onclose = (event: CloseEvent) => {
      this.stopHeartbeat();
      if (this.disposed || this.intentionalClose) return;
      this.handleClose(event.code);
    };

    ws.onerror = () => {
      // onclose 会随后触发，统一在 onclose 处理
    };
  }

  private handleClose(code: number): void {
    switch (code) {
      case WS_CLOSE_CODES.AUTH_FAILED:
        this.opts.onStatus('auth_failed', { closeCode: code });
        return; // 不重连，等待重新认证
      case WS_CLOSE_CODES.SESSION_CLOSED:
        this.opts.onStatus('session_closed', { closeCode: code });
        return; // 不重连
      case WS_CLOSE_CODES.SESSION_NOT_FOUND:
      case WS_CLOSE_CODES.BAD_REQUEST:
        this.opts.onStatus('session_not_found', { closeCode: code });
        return; // 不重连
      case WS_CLOSE_CODES.RATE_LIMITED:
        // 限流：60s 后单次重试
        this.opts.onStatus('rate_limited', { closeCode: code });
        this.scheduleReconnect(RATE_LIMIT_RETRY_DELAY_MS);
        return;
      default:
        break;
    }
    // 网络断开（1006 等）→ 指数退避重连
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.opts.onStatus('failed', { closeCode: code });
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.opts.onStatus('reconnecting', { attempt: this.reconnectAttempt + 1, closeCode: code });
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectAttempt += 1;
      this.openSocket();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.isOpen) return;
      if (this.missedPongs >= HEARTBEAT_MAX_MISSED) {
        // 死连接：主动关闭触发重连
        this.missedPongs = 0;
        this.ws?.close();
        return;
      }
      this.missedPongs += 1;
      this.ping();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanupSocket(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(WS_CLOSE_CODES.NORMAL);
      }
      this.ws = null;
    }
  }

  private cleanup(): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.cleanupSocket();
  }
}
