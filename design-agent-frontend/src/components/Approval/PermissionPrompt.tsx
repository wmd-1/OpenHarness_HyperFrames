// 权限确认弹窗（task 10.2）：允许一次 / 始终允许 / 拒绝。

import { Check, ShieldCheck, X } from 'lucide-react';
import type { ApprovalModal } from '../../types/ws';
import type { ApprovalDecision } from './approvalTypes';

export interface PermissionPromptProps {
  modal: ApprovalModal;
  onDecide: ApprovalDecision;
}

export function PermissionPrompt({ modal, onDecide }: PermissionPromptProps) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <ShieldCheck size={20} className="text-warn mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-fg text-sm leading-relaxed font-medium">
            工具 <code className="bg-raised rounded px-1.5 py-0.5 font-mono">{modal.tool_name ?? '未知工具'}</code>{' '}
            请求执行权限
          </p>
          {modal.reason && <p className="text-muted mt-2 text-xs leading-relaxed break-words">{modal.reason}</p>}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={() => onDecide(false, 'reject')}
          className="border-line text-err hover:bg-err/10 flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm"
        >
          <X size={14} />
          拒绝
        </button>
        <button
          type="button"
          onClick={() => onDecide(true, 'always')}
          className="border-line text-fg hover:bg-raised rounded-lg border px-4 py-2 text-sm"
        >
          始终允许
        </button>
        <button
          type="button"
          autoFocus
          onClick={() => onDecide(true, 'once')}
          className="bg-accent text-accent-fg flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm"
        >
          <Check size={14} />
          允许一次
        </button>
      </div>
    </div>
  );
}
