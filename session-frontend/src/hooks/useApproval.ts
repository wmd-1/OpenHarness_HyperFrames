// 审批流 Hook（task 10.5）：审批超时倒计时（后端 300s 未回复视为拒绝）。
// 到期后自动清除待处理审批并写入系统消息。

import { useEffect, useMemo, useState } from 'react';
import { useConversationStore } from '../store/conversationStore';
import type { ApprovalRequestFrame } from '../types/ws';
import { APPROVAL_TIMEOUT_S, APPROVAL_WARN_AT_S } from '../utils/constants';

export interface UseApprovalResult {
  /** 剩余秒数（0-300）。 */
  remainingS: number;
  /** 进入警告区间（剩余 ≤ 300-250=50s）。 */
  warning: boolean;
  /** 已超时（弹窗即将被自动关闭）。 */
  expired: boolean;
}

/**
 * 以 request_id 为界重置倒计时；同一审批在重连补发时不重复计时
 * （以首次收到该 request_id 的时刻为准）。
 */
export function useApproval(sessionId: string, approval: ApprovalRequestFrame): UseApprovalResult {
  const requestId = approval.request_id;
  // request_id 变化时重建截止时间
  const deadline = useMemo(
    () => Date.now() + APPROVAL_TIMEOUT_S * 1000,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestId],
  );

  const [remainingS, setRemainingS] = useState(APPROVAL_TIMEOUT_S);

  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemainingS(left);
      return left;
    };
    tick();
    const timer = window.setInterval(() => {
      if (tick() <= 0) {
        window.clearInterval(timer);
        // 超时：后端已视为拒绝，前端清理弹窗并提示
        const store = useConversationStore.getState();
        store.setPendingApproval(sessionId, null);
        store.addSystemMessage(sessionId, 'warning', '审批请求超时（300s），已按拒绝处理');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline, sessionId]);

  return {
    remainingS,
    warning: remainingS <= APPROVAL_TIMEOUT_S - APPROVAL_WARN_AT_S,
    expired: remainingS <= 0,
  };
}
