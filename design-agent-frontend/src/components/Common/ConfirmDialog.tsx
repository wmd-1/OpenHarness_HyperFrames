// 通用确认对话框（task 3.2 A5）：危险操作（如关闭会话）需二次确认。
// 焦点圈定 + Escape 取消统一走 ModalShell→useFocusTrap（task 5.10 D5）。
// change: design-frontend-overlay-primitives — 接入 ModalShell，z-50→var(--z-modal)，
// overlay-click 保现（不关闭，closeOnOverlayClick=false），Escape→onCancel 保现。

import { ModalShell } from './ModalShell';

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
  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      ariaLabel={title}
      maxWidthClass="max-w-md"
      closeOnOverlayClick={false}
      dataTestId="confirm-dialog"
    >
      <h2 className="text-fg text-base leading-snug font-semibold">{title}</h2>
      <p className="text-muted mt-3 text-sm leading-relaxed">{message}</p>
      <div className="mt-6 flex justify-end gap-3">
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
    </ModalShell>
  );
}
