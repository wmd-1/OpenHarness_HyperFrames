// useApproval 倒计时测试（task 4.6 F4）：fake timers 推进 250s/300s
// 验证警告区间与超时清理；倒计时基准为 receivedAt（A7），
// request_id 变化时重置。

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApproval } from '../useApproval';
import { useConversationStore } from '../../store/conversationStore';
import type { PendingApproval } from '../../store/conversationStore';

const SID = 's1';

function approvalFrame(requestId: string, receivedAt = Date.now()): PendingApproval {
  return {
    type: 'approval_request',
    request_id: requestId,
    modal: { kind: 'permission' },
    turn_index: 0,
    receivedAt,
  } as PendingApproval;
}

beforeEach(() => {
  vi.useFakeTimers();
  useConversationStore.setState({ conversations: {} });
  useConversationStore.getState().setPendingApproval(SID, approvalFrame('r1'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useApproval 倒计时', () => {
  it('初始 300s，推进 250s 后进入警告区间', () => {
    const { result } = renderHook(() => useApproval(SID, approvalFrame('r1')));
    expect(result.current).toMatchObject({ remainingS: 300, warning: false, expired: false });

    act(() => {
      vi.advanceTimersByTime(250_000);
    });
    expect(result.current).toMatchObject({ remainingS: 50, warning: true, expired: false });
  });

  it('推进 300s 超时：清除待处理审批并写入警告消息', () => {
    const { result } = renderHook(() => useApproval(SID, approvalFrame('r1')));
    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(result.current.expired).toBe(true);
    expect(result.current.remainingS).toBe(0);
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.pendingApproval).toBeNull();
    expect(conv.messages.at(-1)).toMatchObject({
      kind: 'system',
      level: 'warning',
      text: '审批请求超时（300s），已按拒绝处理',
    });
  });

  it('request_id 变化时重置倒计时；同一 request_id 重渲染不重置', () => {
    const { result, rerender } = renderHook(({ frame }) => useApproval(SID, frame), {
      initialProps: { frame: approvalFrame('r1') },
    });
    act(() => {
      vi.advanceTimersByTime(100_000);
    });
    expect(result.current.remainingS).toBe(200);

    // 同一 request_id（重连补发）不重复计时（即使 receivedAt 被重新构造）
    rerender({ frame: approvalFrame('r1') });
    expect(result.current.remainingS).toBe(200);

    // 新审批请求重建截止时间
    rerender({ frame: approvalFrame('r2') });
    expect(result.current.remainingS).toBe(300);
  });

  it('倒计时基准为 receivedAt：晚挂载的弹窗不重置剩余时间（A7）', () => {
    // 审批帧 100s 前收到（如重连补发后重新挂载），剩余应为 200s
    const { result } = renderHook(() =>
      useApproval(SID, approvalFrame('r1', Date.now() - 100_000)),
    );
    expect(result.current.remainingS).toBe(200);
  });
});
