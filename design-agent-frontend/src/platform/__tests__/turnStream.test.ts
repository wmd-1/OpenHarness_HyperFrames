// TurnStream 契约测试（spec：demo 与真实通道事件类型集合 MUST 同构）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerFrame } from '../../types/ws';
import { DEMO_REPLY_DELAY_MS, createDemoAdapter } from '../demoAdapter';
import { mapServerFrame } from '../sessionServiceAdapter';
import { TURN_STREAM_EVENT_TYPES } from '../types';
import type { TurnStreamEvent, TurnStreamEventType } from '../types';

const EVENT_TYPE_SET = new Set<string>(TURN_STREAM_EVENT_TYPES);

/** 真实通道全部服务端帧样例（types/ws.ts ServerFrame 全类型覆盖）。 */
const SERVER_FRAMES: ServerFrame[] = [
  { type: 'session_ready', session_id: 's1' },
  { type: 'delta', text: 'hi', turn_index: 0, final: true, full_text: 'hi' },
  { type: 'turn_complete', turn_index: 0, has_artifact: true },
  { type: 'tool_start', tool_name: 'bash', tool_input: {}, turn_index: 0 },
  { type: 'tool_end', tool_name: 'bash', output: 'ok', is_error: false, turn_index: 0 },
  { type: 'todo', todo_markdown: '- [ ] x', turn_index: 0 },
  { type: 'approval_request', request_id: 'r1', modal: { kind: 'permission' }, turn_index: 0 },
  { type: 'error', message: 'quota', code: 'TENANT_QUOTA_EXCEEDED' },
  { type: 'turn_error', message: 'boom', turn_index: 0 },
  { type: 'busy' },
  { type: 'pong' },
  { type: 'event', event: { foo: 'bar' } },
];

function demoAdapter() {
  return createDemoAdapter({
    agentId: 'test',
    sessions: [{ title: 't', time: 'now' }],
    artifacts: [],
    artifactMediaType: 'text/html',
  });
}

describe('TurnStream 事件类型集合同构', () => {
  it('SessionServiceAdapter 帧映射产出的事件类型 ⊆ 契约集合', () => {
    const produced = new Set<string>();
    for (const frame of SERVER_FRAMES) {
      const event = mapServerFrame(frame);
      if (event) produced.add(event.type);
    }
    for (const type of produced) expect(EVENT_TYPE_SET.has(type)).toBe(true);
    // 真实通道可产出 ready/delta/tool/todo/approval/complete/error（closed 由连接层产出）
    const expected: TurnStreamEventType[] = [
      'ready',
      'delta',
      'tool',
      'todo',
      'approval',
      'complete',
      'error',
    ];
    for (const type of expected) expect(produced.has(type)).toBe(true);
  });

  describe('DemoAdapter 通道', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('产出的事件类型 ⊆ 契约集合，且覆盖 ready/delta/complete/closed', async () => {
      const adapter = demoAdapter();
      const stream = adapter.session.openChannel('test-demo-0');
      const produced = new Set<string>();
      const events: TurnStreamEvent[] = [];
      stream.on((e) => {
        produced.add(e.type);
        events.push(e);
      });

      await vi.advanceTimersByTimeAsync(0); // 模拟建连
      expect(stream.state).toBe('ready');
      expect(stream.submit('画一个页面')).toBe(true);
      await vi.advanceTimersByTimeAsync(DEMO_REPLY_DELAY_MS);
      stream.close();

      for (const type of produced) expect(EVENT_TYPE_SET.has(type)).toBe(true);
      expect(produced.has('ready')).toBe(true);
      expect(produced.has('delta')).toBe(true);
      expect(produced.has('complete')).toBe(true);
      expect(produced.has('closed')).toBe(true);

      // final delta 携带权威全文（覆盖语义与真实协议一致）
      const delta = events.find((e) => e.type === 'delta');
      expect(delta && delta.type === 'delta' && delta.final).toBe(true);
      expect(delta && delta.type === 'delta' && delta.fullText).toBeTruthy();
    });

    it('busy 期间拒绝重复提交；interrupt 产出 interrupted complete', async () => {
      const adapter = demoAdapter();
      const stream = adapter.session.openChannel('test-demo-0');
      const events: TurnStreamEvent[] = [];
      stream.on((e) => events.push(e));

      await vi.advanceTimersByTimeAsync(0);
      expect(stream.submit('第一条')).toBe(true);
      expect(stream.submit('第二条')).toBe(false); // busy 禁止并发轮次
      expect(stream.interrupt()).toBe(true);

      const complete = events.find((e) => e.type === 'complete');
      expect(complete && complete.type === 'complete' && complete.interrupted).toBe(true);
      stream.close();
    });

    it('会话与轮次在内存中持久（listTurns 可回放）', async () => {
      const adapter = demoAdapter();
      const created = await adapter.session.create({ title: '新会话' });
      const stream = adapter.session.openChannel(created.session_id);
      await vi.advanceTimersByTimeAsync(0);
      stream.submit('你好');
      await vi.advanceTimersByTimeAsync(DEMO_REPLY_DELAY_MS);
      stream.close();

      const { turns } = await adapter.session.listTurns(created.session_id);
      expect(turns).toHaveLength(1);
      expect(turns[0].user_text).toBe('你好');
      expect(turns[0].assistant_text).toBeTruthy();
    });
  });
});
