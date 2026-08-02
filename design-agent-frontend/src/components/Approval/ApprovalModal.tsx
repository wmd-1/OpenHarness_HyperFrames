// 审批模态框容器（task 10.1）：按 modal.kind 分发到具体弹窗；
// 可访问性（焦点圈定/Escape 拒绝/初始焦点）统一走 ModalShell→useFocusTrap（D5）。
// 数据来源 conversation.pendingApproval，决策经 conversation.approve 提交。
// change: design-frontend-overlay-primitives — 接入 ModalShell，z-50→var(--z-modal)，
// overlay-click 保现（不关闭，closeOnOverlayClick=false），Escape→reject 保现（task 10.6）。

import { useCallback } from 'react';
import { TimerReset } from 'lucide-react';
import { useConversationStore } from '../../store/conversationStore';
import type { PendingApproval } from '../../store/conversationStore';
import type { ApprovalReply } from '../../types/ws';
import { useApproval } from '../../hooks/useApproval';
import type { ApprovalDecision } from './approvalTypes';
import { DiffApproval } from './DiffApproval';
import { PermissionPrompt } from './PermissionPrompt';
import { QuestionPrompt } from './QuestionPrompt';
import { ModalShell } from '../Common/ModalShell';

export interface ApprovalModalProps {
  sessionId: string;
  approval: PendingApproval;
  /** conversation.approve：提交 approval 帧并清除 pendingApproval。 */
  approve: (requestId: string, allowed: boolean, reply?: ApprovalReply, answer?: string) => boolean;
}

export function ApprovalModal({ sessionId, approval, approve }: ApprovalModalProps) {
  const { remainingS, warning } = useApproval(sessionId, approval);
  const requestId = approval.request_id ?? approval.modal?.request_id;

  const decide: ApprovalDecision = useCallback(
    (allowed, reply, answer) => {
      if (!requestId) {
        // 缺失 request_id 无法回复，仅本地关闭
        const store = useConversationStore.getState();
        store.setPendingApproval(sessionId, null);
        store.addSystemMessage(sessionId, 'error', '审批请求缺少 request_id，无法回复');
        return;
      }
      const ok = approve(requestId, allowed, reply, answer);
      if (!ok) {
        useConversationStore
          .getState()
          .addSystemMessage(sessionId, 'error', '审批回复发送失败：连接未就绪，请重试');
      }
    },
    [approve, requestId, sessionId],
  );

  // 关闭=拒绝（task 10.6 业务定义，非历史遗留；保现，分离「关闭/拒绝」需单独 UX change）。
  const reject = useCallback(() => decide(false, 'reject'), [decide]);

  const kind = approval.modal?.kind ?? 'permission';
  const modal = approval.modal ?? { kind };

  return (
    <ModalShell
      open
      onClose={reject}
      ariaLabel="审批请求"
      maxWidthClass="max-w-lg"
      closeOnOverlayClick={false}
      dataTestId="approval-modal"
    >
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-fg text-base leading-snug font-semibold">审批请求</h2>
        <span
          className={`flex items-center gap-1.5 text-xs tabular-nums ${
            warning ? 'text-warn font-medium' : 'text-muted'
          }`}
          aria-live={warning ? 'polite' : 'off'}
        >
          <TimerReset size={13} />
          {Math.floor(remainingS / 60)}:{String(remainingS % 60).padStart(2, '0')}
        </span>
      </div>

      {kind === 'edit_diff' ? (
        <DiffApproval modal={modal} onDecide={decide} />
      ) : kind === 'question' ? (
        <QuestionPrompt modal={modal} onDecide={decide} />
      ) : (
        // permission 及未知类型统一走权限确认（保守默认）
        <PermissionPrompt modal={modal} onDecide={decide} />
      )}
    </ModalShell>
  );
}
