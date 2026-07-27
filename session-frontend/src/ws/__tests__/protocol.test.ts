// protocol 单元测试（task 12.3）：消息编解码、类型校验、WS URL 构建。

import { describe, expect, it } from 'vitest';
import { buildWsUrl, decodeServerFrame, encodeClientFrame } from '../protocol';

describe('encodeClientFrame', () => {
  it('submit 帧编码为 JSON', () => {
    expect(JSON.parse(encodeClientFrame({ op: 'submit', text: 'hi' }))).toEqual({
      op: 'submit',
      text: 'hi',
    });
  });

  it('approval 帧携带 request_id/allowed/reply', () => {
    const raw = encodeClientFrame({
      op: 'approval',
      request_id: 'r1',
      allowed: true,
      reply: 'once',
    });
    expect(JSON.parse(raw)).toMatchObject({ op: 'approval', request_id: 'r1', allowed: true });
  });
});

describe('decodeServerFrame', () => {
  it('解析已知帧类型', () => {
    const frame = decodeServerFrame('{"type":"delta","text":"a","turn_index":0}');
    expect(frame).toEqual({ type: 'delta', text: 'a', turn_index: 0 });
  });

  it('非 JSON 返回 null', () => {
    expect(decodeServerFrame('not-json')).toBeNull();
  });

  it('缺少 type 字段返回 null', () => {
    expect(decodeServerFrame('{"foo":1}')).toBeNull();
    expect(decodeServerFrame('123')).toBeNull();
    expect(decodeServerFrame('null')).toBeNull();
  });

  it('未知 type 包装为透传 event 帧（前向兼容）', () => {
    const frame = decodeServerFrame('{"type":"future_feature","x":1}');
    expect(frame).toEqual({ type: 'event', event: { type: 'future_feature', x: 1 } });
  });
});

describe('buildWsUrl', () => {
  it('携带 api_key 与 last_turn_index', () => {
    const url = new URL(buildWsUrl('sid-1', 'key-1', 3, 'ws://example.test'));
    expect(url.pathname).toBe('/v1/sessions/sid-1/ws');
    expect(url.searchParams.get('api_key')).toBe('key-1');
    expect(url.searchParams.get('last_turn_index')).toBe('3');
  });

  it('无 api_key / 无历史轮次时省略参数', () => {
    const url = new URL(buildWsUrl('sid-1', null, null, 'ws://example.test'));
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(url.searchParams.has('last_turn_index')).toBe(false);
  });

  it('负数 last_turn_index 不携带', () => {
    const url = new URL(buildWsUrl('sid-1', 'k', -1, 'ws://example.test'));
    expect(url.searchParams.has('last_turn_index')).toBe(false);
  });
});
