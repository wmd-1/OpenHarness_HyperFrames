// WebSocket 连接管理类（task 6.2）：
// - 连接建立（携带 api_key + last_turn_index）
// - 消息发送（submit / interrupt / approval / ping）
// - 指数退避重连（1s→30s，最多 10 次）；4429 每次等待 60s，最多重试 2 次后转 failed
// - 心跳保活（30s ping，连续 3 次无 pong 判定死连接）
// - 关闭码差异化处理（4401/4403/4404/4429 + 准入类 4430/4503/4500，F3.2）

import {
  CAPACITY_MAX_RETRIES,
  CAPACITY_RETRY_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_RETRY_DELAY_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  UNAVAILABLE_MAX_RETRIES,
  PROBE_TIMEOUT_MS,
  PROBE_DEBOUNCE_MS,
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
  /** 4429 限流独立重试计数（连接成功或手动 retry 时清零）。 */
  private rateLimitRetries = 0;
  /** 4503 容量满有界重试计数（F3.2，固定 15s 非指数）。 */
  private capacityRetries = 0;
  /** 4500 会话不可用有界重试计数（F3.2，覆盖 rehydrate 瞬态竞争）。 */
  private unavailableRetries = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private missedPongs = 0;
  private disposed = false;
  /** 手动 disconnect 后不再自动重连。 */
  private intentionalClose = false;
  /** BFCache 唤醒探测相关（Change3）。 */
  private lifecycleStarted = false;
  private probeTimer: number | null = null;
  private probePending = false;
  private probeTimeoutTimer: number | null = null;
  private pageShowHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;

  constructor(opts: WebSocketClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    if (this.disposed) return;
    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.openSocket();
    this.startLifecycleWatchers();
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

  /** 手动重试（达到最大重连次数后 UI 按钮调用；4430 准入失败后也走此入口）。 */
  retry(): void {
    this.reconnectAttempt = 0;
    this.rateLimitRetries = 0;
    this.capacityRetries = 0;
    this.unavailableRetries = 0;
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
      this.rateLimitRetries = 0;
      this.capacityRetries = 0;
      this.unavailableRetries = 0;
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
        if (this.probePending) {
          // 唤醒探测收到 pong：连接确实存活，取消强制重连计时
          this.probePending = false;
          if (this.probeTimeoutTimer !== null) {
            window.clearTimeout(this.probeTimeoutTimer);
            this.probeTimeoutTimer = null;
          }
        }
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
        // 限流：每次等待 60s 重试，有界重试超限后转 failed（A3）
        if (this.rateLimitRetries >= RATE_LIMIT_MAX_RETRIES) {
          this.opts.onStatus('failed', { closeCode: code });
          return;
        }
        this.rateLimitRetries += 1;
        this.opts.onStatus('rate_limited', { closeCode: code });
        this.scheduleReconnect(RATE_LIMIT_RETRY_DELAY_MS);
        return;
      case WS_CLOSE_CODES.QUOTA_EXCEEDED:
        // 4430 租户并发配额已满：另一会话在跑 turn 或仍被其他窗口连着，
        // 自动重试只会继续 4430 → 不重连，等待手动重试（F3.2）
        this.opts.onStatus('quota_exceeded', { closeCode: code });
        return;
      case WS_CLOSE_CODES.CAPACITY_FULL:
        // 4503 节点容量满：固定 15s 有界重试（对齐后端排队超时语义），超限转 failed
        if (this.capacityRetries >= CAPACITY_MAX_RETRIES) {
          this.opts.onStatus('failed', { closeCode: code });
          return;
        }
        this.capacityRetries += 1;
        this.opts.onStatus('reconnecting', { attempt: this.capacityRetries, closeCode: code });
        this.scheduleReconnect(CAPACITY_RETRY_DELAY_MS);
        return;
      case WS_CLOSE_CODES.SERVER_ERROR:
        // 4500 会话不可用（复活失败/瞬态竞争）：有界 2 次后转 failed（不再无限退避）
        if (this.unavailableRetries >= UNAVAILABLE_MAX_RETRIES) {
          this.opts.onStatus('failed', { closeCode: code });
          return;
        }
        this.unavailableRetries += 1;
        this.opts.onStatus('reconnecting', { attempt: this.unavailableRetries, closeCode: code });
        this.scheduleReconnect(RECONNECT_BASE_DELAY_MS * 2 ** (this.unavailableRetries - 1));
        return;
      default:
        break;
    }
    // 网络断开（1006 等）→ 指数退避重连
    if (typeof document !== 'undefined' && document.hidden) {
      // 页面被隐藏/冻结（BFCache）时浏览器会断开套接字；推迟到
      // visibilitychange/pageshow 唤醒后由 probe() 探测重连，避免后台空转
      return;
    }
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

  // ---- BFCache 唤醒探测（Change3）----

  /** 注册页面生命周期监听：BFCache/后台恢复时主动探测连接存活。仅在浏览器环境注册（SSR 安全）。 */
  private startLifecycleWatchers(): void {
    if (this.lifecycleStarted) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this.lifecycleStarted = true;

    this.pageShowHandler = () => this.scheduleProbe();
    this.visibilityHandler = () => {
      // 仅在页面重新可见（从后台/BFCache 恢复）时探测；隐藏时不探测
      if (!document.hidden) this.scheduleProbe();
    };
    this.onlineHandler = () => this.scheduleProbe();

    window.addEventListener('pageshow', this.pageShowHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('online', this.onlineHandler);
  }

  private stopLifecycleWatchers(): void {
    if (!this.lifecycleStarted) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (this.pageShowHandler) window.removeEventListener('pageshow', this.pageShowHandler);
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
    this.pageShowHandler = this.visibilityHandler = this.onlineHandler = null;
    this.lifecycleStarted = false;
    this.clearProbeTimers();
  }

  /** 生命周期事件去抖后触发一次探测（避免 pageshow/visibility/online 集中触发重复 probe）。 */
  private scheduleProbe(): void {
    if (this.disposed || this.intentionalClose) return;
    if (this.probeTimer !== null) window.clearTimeout(this.probeTimer);
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null;
      this.probe();
    }, PROBE_DEBOUNCE_MS);
  }

  /**
   * 探测当前连接是否仍可用。BFCache 冻结会让「OPEN」套接字实际已死但状态不变，
   * 故需主动 ping 验证：
   * - 未 OPEN：立即强制重连（恢复策略不变——api_key / last_turn_index 仍由 getter 现取）。
   * - OPEN：发 ping，PROBE_TIMEOUT 内无 pong 则强制重连。
   */
  probe(): void {
    if (this.disposed || this.intentionalClose) return;
    if (!this.isOpen) {
      this.forceReconnect();
      return;
    }
    if (this.probePending) return;
    this.probePending = true;
    this.ping();
    this.probeTimeoutTimer = window.setTimeout(() => {
      this.probeTimeoutTimer = null;
      this.probePending = false;
      this.forceReconnect();
    }, PROBE_TIMEOUT_MS);
  }

  /** 强制重连：重置有界/指数重试计数（唤醒是新的「会话上下文」），复用既有恢复策略。 */
  private forceReconnect(): void {
    this.clearReconnectTimer();
    this.clearProbeTimers();
    this.probePending = false;
    // 恢复策略（api_key / last_turn_index）由 getter 现取，openSocket 不改变它们
    this.reconnectAttempt = 0;
    this.rateLimitRetries = 0;
    this.capacityRetries = 0;
    this.unavailableRetries = 0;
    this.openSocket();
  }

  private clearProbeTimers(): void {
    if (this.probeTimer !== null) {
      window.clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.probeTimeoutTimer !== null) {
      window.clearTimeout(this.probeTimeoutTimer);
      this.probeTimeoutTimer = null;
    }
    this.probePending = false;
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
    this.stopLifecycleWatchers();
    this.cleanupSocket();
  }
}
