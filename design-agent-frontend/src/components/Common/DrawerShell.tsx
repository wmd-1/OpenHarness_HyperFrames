// DrawerShell — 右抽屉公共原语（change: design-frontend-overlay-primitives）。
// 统一 overlay + aside 容器 + useFocusTrap + overlay onClick + role/aria + z-index 令牌化。
// 实现期约束（评审 2026-08-03 确认）：严格限定已定义 props，不新增 variant/slot/as 多态。

import { type ReactNode, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export interface DrawerShellProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** 抽屉侧（当前仅 right，预留扩展，不实现 left/top/bottom 多态）。 */
  side?: 'right';
  /** 容器宽度类：默认 max-w-sm；WorkspaceFilesPanel 用 sm:w-96。 */
  widthClass?: string;
  /** 透传到容器的 data-testid（保既有测试钩子）。 */
  dataTestId?: string;
  children: ReactNode;
}

export function DrawerShell({
  open,
  onClose,
  ariaLabel,
  side = 'right',
  widthClass = 'max-w-sm',
  dataTestId,
  children,
}: DrawerShellProps) {
  const asideRef = useRef<HTMLElement>(null);
  useFocusTrap(asideRef, { active: open, onEscape: onClose });
  if (!open) return null;
  const sideClass = side === 'right' ? 'top-0 right-0 h-full border-l' : 'top-0 right-0 h-full border-l';
  return (
    <div
      className={`fixed inset-0 z-[var(--z-modal)] bg-black/40`}
      role="presentation"
      onClick={onClose}
    >
      <aside
        ref={asideRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={dataTestId}
        className={`absolute ${sideClass} border-line bg-surface w-full ${widthClass} shadow-xl flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </aside>
    </div>
  );
}
