// Chat / Terminal 模式切换（task 7.4）：分段按钮组。

import { MessageSquare, TerminalSquare } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import type { AppMode } from '../../store/uiStore';

const MODES: { mode: AppMode; label: string; Icon: typeof MessageSquare }[] = [
  { mode: 'chat', label: 'Chat', Icon: MessageSquare },
  { mode: 'terminal', label: 'Terminal', Icon: TerminalSquare },
];

export function ModeSwitcher() {
  const mode = useUiStore((s) => s.mode);
  const setMode = useUiStore((s) => s.setMode);

  return (
    <div
      role="tablist"
      aria-label="显示模式"
      className="border-line bg-raised flex rounded-lg border p-0.5"
    >
      {MODES.map(({ mode: m, label, Icon }) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => setMode(m)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors ${
            mode === m
              ? 'bg-surface text-fg shadow-sm'
              : 'text-muted hover:text-fg'
          }`}
        >
          <Icon size={14} />
          <span className="hidden md:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
