// ModalShell — 居中模态公共原语（change: design-frontend-overlay-primitives）。
// 统一 overlay + container + useFocusTrap + role/aria + z-index 令牌化（var(--z-modal)）。
// 实现期约束（评审 2026-08-03 确认）：严格限定已定义 props，不新增 variant/slot/as 多态；
// 各接入点按保现映射显式传 closeOnOverlayClick，原语不设隐式默认。

import { type CSSProperties, type ReactNode, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export interface ModalShellProps {
  open: boolean;
  /** dismiss 处理器（各 site 映射：reject / onCancel / close / setPreviewRef(null)）。 */
  onClose: () => void;
  ariaLabel: string;
  /** 显式控制 overlay 点击是否触发 onClose（必填，无隐式默认；各接入点保现传值）。 */
  closeOnOverlayClick: boolean;
  /** 容器最大宽度类（Tailwind）：max-w-md / max-w-lg。 */
  maxWidthClass?: string;
  /** 内联容器宽度（如 width:min(960px,100%)），仅当 maxWidthClass 不适用时用。 */
  containerStyle?: CSSProperties;
  /** overlay 遮罩透明度类：默认 bg-black/40；视频预览用 bg-black/60。 */
  overlayDimClass?: string;
  /** overlay 内边距类：默认 p-4；视频预览用 p-8。 */
  overlayPaddingClass?: string;
  /** 容器样式类覆写：默认 `border border-line bg-surface rounded-xl shadow-xl`（dialog 内容）；
   *  SpacePage 视频预览传空串得透明容器（媒体预览，overlay 已提供深色底）。
   *  仅覆盖 4 模态真实需求，不为投机场景扩展 variant/slot（评审 2026-08-03 约束）。 */
  containerClassName?: string;
  /** 透传到容器的 data-testid（保既有测试钩子，如 approval-modal/confirm-dialog）。 */
  dataTestId?: string;
  children: ReactNode;
}

export function ModalShell({
  open,
  onClose,
  ariaLabel,
  closeOnOverlayClick,
  maxWidthClass,
  containerStyle,
  overlayDimClass = 'bg-black/40',
  overlayPaddingClass = 'p-4',
  containerClassName = 'border border-line bg-surface rounded-xl shadow-xl',
  dataTestId,
  children,
}: ModalShellProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // hook 须在早返回前无条件调用；open=false 时 active=false，effect 空跑。
  useFocusTrap(dialogRef, { active: open, onEscape: onClose });
  if (!open) return null;
  return (
    <div
      className={`fixed inset-0 z-[var(--z-modal)] flex items-center justify-center ${overlayDimClass} ${overlayPaddingClass}`}
      role="presentation"
      onClick={closeOnOverlayClick ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={dataTestId}
        className={`w-full ${containerClassName} ${maxWidthClass ?? ''}`}
        style={containerStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
