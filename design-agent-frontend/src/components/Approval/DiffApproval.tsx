// edit_diff 审批弹窗（task 10.3）：diff 视图 + 审批选项。

import { Check, FileDiff, X } from 'lucide-react';
import type { ApprovalModal } from '../../types/ws';
import type { ApprovalDecision } from './approvalTypes';

export interface DiffApprovalProps {
  modal: ApprovalModal;
  onDecide: ApprovalDecision;
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted';
  if (line.startsWith('@@')) return 'text-accent';
  if (line.startsWith('+')) return 'text-ok';
  if (line.startsWith('-')) return 'text-err';
  return 'text-fg';
}

export function DiffApproval({ modal, onDecide }: DiffApprovalProps) {
  const diffLines = (modal.diff ?? '').split('\n');

  return (
    <div>
      <div className="flex items-start gap-3">
        <FileDiff size={20} className="text-warn mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-fg text-sm font-medium">请求修改文件</p>
          <p className="text-muted mt-0.5 break-all font-mono text-xs">{modal.path ?? '未知路径'}</p>
          <p className="mt-1 text-xs">
            <span className="text-ok">+{modal.added ?? 0}</span>{' '}
            <span className="text-err">-{modal.removed ?? 0}</span>
          </p>
        </div>
      </div>

      {/* diff 内容（滚动区域） */}
      <pre
        className="bg-base border-line mt-3 max-h-64 overflow-auto rounded-lg border p-3 text-xs leading-5"
        data-testid="diff-content"
      >
        {diffLines.map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line || ' '}
          </div>
        ))}
      </pre>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
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
          允许本次修改
        </button>
      </div>
    </div>
  );
}
