// 瞬时 toast 渲染层：连接重连中 / 已恢复 / 后端错误等信号。
// 与常驻横幅（Banner）区分：toast 自动消失或显式关闭，不阻塞主流程。

import { useEffect } from 'react';
import { useUiStore, type Toast, type ToastLevel } from '../../store/uiStore';

const LEVEL_CLASS: Record<ToastLevel, string> = {
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  error: 'border-red-500/40 bg-red-500/10 text-red-200',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
};

function Spinner() {
  return (
    <svg
      className="h-4 w-4 shrink-0 animate-spin text-current"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    if (toast.sticky) return;
    const t = setTimeout(onClose, toast.duration);
    return () => clearTimeout(t);
  }, [toast.sticky, toast.duration, onClose]);

  const ariaLive = toast.level === 'error' ? 'assertive' : 'polite';

  return (
    <div
      data-testid="toast"
      data-toast-id={toast.id}
      data-toast-level={toast.level}
      role="status"
      aria-live={ariaLive}
      className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-sm ${LEVEL_CLASS[toast.level]}`}
    >
      {toast.spinner && <Spinner />}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{toast.message}</div>
        {toast.detail && <div className="mt-0.5 break-words opacity-80">{toast.detail}</div>}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭通知"
        className="shrink-0 rounded-md px-1 text-current/70 hover:text-current"
      >
        ✕
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  return (
    <div
      data-testid="toaster"
      className="pointer-events-none fixed bottom-4 right-4 z-[var(--z-toast)] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />
      ))}
    </div>
  );
}
