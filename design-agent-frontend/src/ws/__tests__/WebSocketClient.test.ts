// WebSocketClient BFCache 唤醒探测 + 生命周期监听测试（Change3：ws-bfcache-reconnect）。
// 复用与 useWebSocket.test.ts 一致的 MockWebSocket 行为（记录实例、可控服务端帧）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketClient, type WebSocketClientOptions } from '../WebSocketClient';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  serverOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverFrame(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const baseOpts = (): WebSocketClientOptions => ({
  sessionId: 's1',
  getApiKey: () => 'k',
  getLastTurnIndex: () => 7,
  onFrame: () => {},
  onStatus: () => {},
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', MockWebSocket);
  MockWebSocket.instances = [];
});

afterEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WebSocketClient BFCache 唤醒探测', () => {
  it('probe() 在未 OPEN 时强制重连并保留恢复策略（api_key / last_turn_index）', () => {
    const client = new WebSocketClient(baseOpts());
    client.connect();
    const first = MockWebSocket.instances[0];
    // 未 serverOpen → 仍为 CONNECTING（非 OPEN）
    client.probe();
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = MockWebSocket.instances[1];
    const url = new URL(second.url);
    expect(url.searchParams.get('api_key')).toBe('k');
    expect(url.searchParams.get('last_turn_index')).toBe('7');
    first.close();
    second.close();
  });

  it('probe() 在 OPEN 且收到 pong 时不重连（连接确为存活）', () => {
    const client = new WebSocketClient(baseOpts());
    client.connect();
    const ws = MockWebSocket.instances[0];
    ws.serverOpen();
    client.probe();
    expect(ws.sent.some((m) => JSON.parse(m).op === 'ping')).toBe(true);
    ws.serverFrame({ type: 'pong' });
    vi.advanceTimersByTime(5000); // 超过 PROBE_TIMEOUT_MS(4000)
    expect(MockWebSocket.instances).toHaveLength(1);
    ws.close();
  });

  it('probe() 在 OPEN 但超时未收到 pong 时强制重连', () => {
    const client = new WebSocketClient(baseOpts());
    client.connect();
    const ws = MockWebSocket.instances[0];
    ws.serverOpen();
    client.probe();
    vi.advanceTimersByTime(5000); // > PROBE_TIMEOUT_MS
    expect(MockWebSocket.instances).toHaveLength(2);
    ws.close();
    MockWebSocket.instances[1].close();
  });

  it('页面可见性恢复（visibilitychange）触发去抖 probe 并在死连接时重连', () => {
    const client = new WebSocketClient(baseOpts());
    client.connect();
    const ws = MockWebSocket.instances[0]; // BFCache 冻结态：未 OPEN
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1500); // > PROBE_DEBOUNCE_MS(1000)
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    ws.close();
    MockWebSocket.instances.forEach((w) => w.close());
  });

  it('页面隐藏时网络断开（1006）不自动重连，推迟到唤醒探测', () => {
    const client = new WebSocketClient(baseOpts());
    client.connect();
    const ws = MockWebSocket.instances[0];
    ws.serverOpen();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    ws.serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1); // 不应排程任何重连
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    ws.close();
  });
});
