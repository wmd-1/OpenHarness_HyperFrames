// 设置面板（task 7.12）：API Key 管理 + 主题选择器，右侧滑出抽屉。
// 焦点圈定 + Escape 关闭统一走 useFocusTrap（task 5.10 D5）。

import { useRef } from 'react';
import { X } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ApiKeyInput } from './ApiKeyInput';
import { ThemeSelector } from './ThemeSelector';

export function SettingsPanel() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const panelRef = useRef<HTMLElement>(null);

  // 焦点圈定 + Escape 关闭（D5）
  useFocusTrap(panelRef, { active: open, onEscape: () => setOpen(false) });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40"
      onClick={() => setOpen(false)}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      role="presentation"
    >
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border-line absolute top-0 right-0 flex h-full w-full max-w-sm flex-col border-l shadow-xl"
      >
        <div className="border-line flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-fg text-base font-semibold">设置</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="关闭设置"
            className="text-muted hover:text-fg rounded p-1"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <section>
            <h3 className="text-fg mb-2 text-sm font-medium">API Key</h3>
            <ApiKeyInput />
          </section>
          <section>
            <h3 className="text-fg mb-2 text-sm font-medium">主题</h3>
            <ThemeSelector />
          </section>
        </div>
      </aside>
    </div>
  );
}
