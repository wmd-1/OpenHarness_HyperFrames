// 焦点圈定 hook（D5，提取自 ApprovalModal task 10.6）：
// 初始焦点、Tab 循环圈定、Escape 回调、卸载时恢复先前焦点。

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])';

export interface UseFocusTrapOptions {
  /** 为 false 时不激活（如对话框关闭）；默认 true。 */
  active?: boolean;
  /** Escape 按下时回调（拒绝/取消/关闭）。 */
  onEscape?: () => void;
}

/**
 * 把焦点圈定在 ref 指向的对话框内：
 * - 挂载时聚焦第一个可聚焦元素（若焦点不在框内）；
 * - Tab/Shift+Tab 在首尾元素间循环；
 * - Escape 触发 onEscape（通过 ref 持有，回调不稳定也不会重挂监听）；
 * - 失活/卸载时恢复先前焦点。
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  { active = true, onEscape }: UseFocusTrapOptions = {},
): void {
  // 回调经 ref 转发，避免每次渲染的新函数导致效果重跑（焦点抖动）
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const dialog = ref.current;
    if (!dialog) return;
    const previousActive = document.activeElement as HTMLElement | null;
    // 初始焦点：autoFocus 元素或第一个可聚焦元素
    if (!dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onEscapeRef.current) {
          e.preventDefault();
          onEscapeRef.current();
        }
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
  }, [ref, active]);
}
