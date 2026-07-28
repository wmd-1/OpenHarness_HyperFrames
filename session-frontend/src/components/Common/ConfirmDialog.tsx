// 通用确认对话框（task 3.2 A5）：危险操作（如关闭会话）需二次确认。
// 焦点圈定 + Escape 取消统一走 useFocusTrap（task 5.10 D5）。

import { useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // 焦点圈定 + Escape 取消（初始焦点落在取消按钮，避免误触确认）
  useFocusTrap(dialogRef, { active: open, onEscape: onCancel });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      data-testid="confirm-dialog"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-surface border-line w-full max-w-sm rounded-xl border p-5 shadow-xl"
      >
        <h2 className="text-fg text-base font-semibold">{title}</h2>
        <p className="text-muted mt-2 text-sm">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border-line text-fg hover:border-muted rounded-lg border px-4 py-2 text-sm"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-err rounded-lg px-4 py-2 text-sm text-white hover:opacity-90"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
