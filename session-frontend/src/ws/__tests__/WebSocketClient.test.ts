// WebSocketClient 单测：4429 有界重试（task 3.5 A3）+ 心跳判死（task 5.12 F6）。
// fake timers 驱动：4429 每次等待 60s 重试，超限后转 failed 不再重连；
// 连接成功（onopen）与手动 retry() 清零计数；3×30s 无 pong 主动断开重连。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketClient } from '../WebSocketClient';
import {
  CAPACITY_MAX_RETRIES,
  CAPACITY_RETRY_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_RETRY_DELAY_MS,
  RECONNECT_BASE_DELAY_MS,
  UNAVAILABLE_MAX_RETRIES,
  WS_CLOSE_CODES,
} from '../../utils/constants';
import type { WsStatus } from '../../types/ws';

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

  close(code = 1000): void {
    // 仿真实 WebSocket：关闭后触发 onclose（cleanupSocket 已先置空 handler）
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  serverOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  serverMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

describe('WebSocketClient 4429 有界重试（A3）', () => {
  let statuses: WsStatus[];
  let client: WebSocketClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    MockWebSocket.instances = [];
    statuses = [];
    client = new WebSocketClient({
      sessionId: 's1',
      getApiKey: () => 'k',
      getLastTurnIndex: () => null,
      onFrame: () => undefined,
      onStatus: (status) => statuses.push(status),
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
    });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('4429 每次等待 60s 重试，超限后转 failed 且不再重连', () => {
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    // 前 RATE_LIMIT_MAX_RETRIES 次：rate_limited + 60s 后重连
    for (let i = 0; i < RATE_LIMIT_MAX_RETRIES; i += 1) {
      lastSocket().serverClose(WS_CLOSE_CODES.RATE_LIMITED);
      expect(statuses.at(-1)).toBe('rate_limited');
      vi.advanceTimersByTime(RATE_LIMIT_RETRY_DELAY_MS);
      expect(MockWebSocket.instances).toHaveLength(i + 2);
    }

    // 第 3 次 4429：超限转 failed，60s 后也不再新建连接
    lastSocket().serverClose(WS_CLOSE_CODES.RATE_LIMITED);
    expect(statuses.at(-1)).toBe('failed');
    const count = MockWebSocket.instances.length;
    vi.advanceTimersByTime(RATE_LIMIT_RETRY_DELAY_MS * 2);
    expect(MockWebSocket.instances).toHaveLength(count);
  });

  it('连接成功（onopen）清零限流计数', () => {
    client.connect();
    lastSocket().serverClose(WS_CLOSE_CODES.RATE_LIMITED);
    vi.advanceTimersByTime(RATE_LIMIT_RETRY_DELAY_MS);
    // 重连成功后计数清零
    lastSocket().serverOpen();
    for (let i = 0; i < RATE_LIMIT_MAX_RETRIES; i += 1) {
      lastSocket().serverClose(WS_CLOSE_CODES.RATE_LIMITED);
      expect(statuses.at(-1)).toBe('rate_limited');
      vi.advanceTimersByTime(RATE_LIMIT_RETRY_DELAY_MS);
    }
    lastSocket().serverClose(WS_CLOSE_CODES.RATE_LIMITED);
    expect(statuses.at(-1)).toBe('failed');
  });

  it('手动 retry() 清零限流计数并立即重连', () => {
    client.connect();
    for (let i = 0; i <= RATE_LIMIT_MAX_RETRIES; i += 1) {
      lastSocket().serverClose(WS_CLOSE_CODES.RATE_LIMITED);
      vi.advanceTimersByTime(RATE_LIMIT_RETRY_DELAY_MS);
    }
    expect(statuses.at(-1)).toBe('failed');

    const before = MockWebSocket.instances.length;
    client.retry();
    expect(MockWebSocket.instances).toHaveLength(before + 1);
    // 计数已清零：再次 4429 仍会安排重试而非 failed
    lastSocket().serverClose(WS_CLOSE_CODES.RATE_LIMITED);
    expect(statuses.at(-1)).toBe('rate_limited');
  });
});

describe('WebSocketClient 准入关闭码策略（F3.2）', () => {
  let statuses: WsStatus[];
  let client: WebSocketClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    MockWebSocket.instances = [];
    statuses = [];
    client = new WebSocketClient({
      sessionId: 's1',
      getApiKey: () => 'k',
      getLastTurnIndex: () => null,
      onFrame: () => undefined,
      onStatus: (status) => statuses.push(status),
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
    });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('4430 配额满：置 quota_exceeded 且不自动重连，手动 retry() 可恢复', () => {
    client.connect();
    lastSocket().serverClose(WS_CLOSE_CODES.QUOTA_EXCEEDED);
    expect(statuses.at(-1)).toBe('quota_exceeded');

    // 不自动重连：任意时长后也无新连接
    vi.advanceTimersByTime(CAPACITY_RETRY_DELAY_MS * 10);
    expect(MockWebSocket.instances).toHaveLength(1);

    // 手动重试立即新建连接
    client.retry();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('4503 容量满：固定 15s 有界重试，超限转 failed 不再重连', () => {
    client.connect();

    for (let i = 0; i < CAPACITY_MAX_RETRIES; i += 1) {
      lastSocket().serverClose(WS_CLOSE_CODES.CAPACITY_FULL);
      expect(statuses.at(-1)).toBe('reconnecting');
      // 固定间隔（非指数）：差 1ms 不重连，满 15s 重连
      vi.advanceTimersByTime(CAPACITY_RETRY_DELAY_MS - 1);
      expect(MockWebSocket.instances).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(i + 2);
    }

    // 第 5 次 4503：超限转 failed，不再新建连接
    lastSocket().serverClose(WS_CLOSE_CODES.CAPACITY_FULL);
    expect(statuses.at(-1)).toBe('failed');
    const count = MockWebSocket.instances.length;
    vi.advanceTimersByTime(CAPACITY_RETRY_DELAY_MS * 2);
    expect(MockWebSocket.instances).toHaveLength(count);
  });

  it('4500 会话不可用：指数 1s/2s 有界 2 次，超限转 failed', () => {
    client.connect();

    // 第 1 次：1s 后重连
    lastSocket().serverClose(WS_CLOSE_CODES.SERVER_ERROR);
    expect(statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    expect(MockWebSocket.instances).toHaveLength(2);

    // 第 2 次：2s 后重连
    lastSocket().serverClose(WS_CLOSE_CODES.SERVER_ERROR);
    expect(statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS * 2);
    expect(MockWebSocket.instances).toHaveLength(3);

    // 第 3 次：超限（UNAVAILABLE_MAX_RETRIES=2）转 failed
    expect(UNAVAILABLE_MAX_RETRIES).toBe(2);
    lastSocket().serverClose(WS_CLOSE_CODES.SERVER_ERROR);
    expect(statuses.at(-1)).toBe('failed');
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS * 8);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('连接成功（onopen）清零 4503/4500 计数', () => {
    client.connect();
    lastSocket().serverClose(WS_CLOSE_CODES.CAPACITY_FULL);
    vi.advanceTimersByTime(CAPACITY_RETRY_DELAY_MS);
    // 重连成功后计数清零：再来满额 4503 仍能走完整重试而非提前 failed
    lastSocket().serverOpen();
    for (let i = 0; i < CAPACITY_MAX_RETRIES; i += 1) {
      lastSocket().serverClose(WS_CLOSE_CODES.CAPACITY_FULL);
      expect(statuses.at(-1)).toBe('reconnecting');
      vi.advanceTimersByTime(CAPACITY_RETRY_DELAY_MS);
    }
    lastSocket().serverClose(WS_CLOSE_CODES.CAPACITY_FULL);
    expect(statuses.at(-1)).toBe('failed');
  });

  it('default 回归：1006 网络断开仍走指数退避重连（不受新分支影响）', () => {
    client.connect();
    lastSocket().serverClose(1006);
    expect(statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});

describe('WebSocketClient 心跳判死（F6）', () => {
  let statuses: WsStatus[];
  let client: WebSocketClient;

  const countPings = (ws: MockWebSocket) =>
    ws.sent.filter((raw) => (JSON.parse(raw) as { op: string }).op === 'ping').length;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    MockWebSocket.instances = [];
    statuses = [];
    client = new WebSocketClient({
      sessionId: 's1',
      getApiKey: () => 'k',
      getLastTurnIndex: () => null,
      onFrame: () => undefined,
      onStatus: (status) => statuses.push(status),
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
    });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('连续 3×30s 无 pong：主动断开并自动重连', () => {
    client.connect();
    const ws = lastSocket();
    ws.serverOpen();

    // 前 3 个 tick 各发一次 ping（均无 pong 回应）
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(countPings(ws)).toBe(3);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    // 第 4 个 tick：missedPongs 达上限 → 主动 close 触发重连调度
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(statuses.at(-1)).toBe('reconnecting');

    // 退避 1s 后新建连接
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('每次 ping 后收到 pong：计数重置，连接保持存活', () => {
    client.connect();
    const ws = lastSocket();
    ws.serverOpen();

    // 远超 3 个心跳周期，但每次都及时回 pong
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      ws.serverMessage(JSON.stringify({ type: 'pong' }));
    }
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(countPings(ws)).toBe(6);
  });
});
