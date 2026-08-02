// 设置面板（task 7.12）：API Key 管理 + 主题选择器，右侧滑出抽屉。
// 焦点圈定 + Escape 关闭统一走 DrawerShell→useFocusTrap（task 5.10 D5）。
// change: design-frontend-overlay-primitives — 接入 DrawerShell。

import { X } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { ApiKeyInput } from './ApiKeyInput';
import { ThemeSelector } from './ThemeSelector';
import { DrawerShell } from '../Common/DrawerShell';

export function SettingsPanel() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);

  return (
    <DrawerShell open={open} onClose={() => setOpen(false)} ariaLabel="设置" widthClass="max-w-sm">
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
      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <section>
          <h3 className="text-fg mb-3 text-sm font-medium">API Key</h3>
          <ApiKeyInput />
        </section>
        <section>
          <h3 className="text-fg mb-3 text-sm font-medium">主题</h3>
          <ThemeSelector />
        </section>
      </div>
    </DrawerShell>
  );
}
