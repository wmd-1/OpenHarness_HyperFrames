// 审批模态框容器（task 10.1）：按 modal.kind 分发到具体弹窗；
// task 10.6 可访问性：焦点圈定（Tab 循环）、Escape 拒绝、初始焦点。
// 数据来源 conversation.pendingApproval，决策经 conversation.approve 提交。

import { useCallback, useEffect, useRef } from 'react';
import { TimerReset } from 'lucide-react';
import { useConversationStore } from '../../store/conversationStore';
import type { ApprovalReply, ApprovalRequestFrame } from '../../types/ws';
import { useApproval } from '../../hooks/useApproval';
import type { ApprovalDecision } from './approvalTypes';
import { DiffApproval } from './DiffApproval';
import { PermissionPrompt } from './PermissionPrompt';
import { QuestionPrompt } from './QuestionPrompt';

export interface ApprovalModalProps {
  sessionId: string;
  approval: ApprovalRequestFrame;
  /** conversation.approve：提交 approval 帧并清除 pendingApproval。 */
  approve: (requestId: string, allowed: boolean, reply?: ApprovalReply, answer?: string) => boolean;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])';

export function ApprovalModal({ sessionId, approval, approve }: ApprovalModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
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

  const reject = useCallback(() => decide(false, 'reject'), [decide]);

  // 焦点圈定 + Escape 拒绝（task 10.6）
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousActive = document.activeElement as HTMLElement | null;
    // 初始焦点：autoFocus 元素或第一个可聚焦元素
    if (!dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        reject();
        return;
      }
      if (e.key !== 'Tab') return;
      // Tab 循环圈定在弹窗内
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousActive?.focus?.();
    };
  }, [reject]);

  const kind = approval.modal?.kind ?? 'permission';
  const modal = approval.modal ?? { kind };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      data-testid="approval-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="审批请求"
        className="bg-surface border-line w-full max-w-lg rounded-xl border p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-fg text-base font-semibold">审批请求</h2>
          <span
            className={`flex items-center gap-1 text-xs tabular-nums ${
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
      </div>
    </div>
  );
}
