// 顶栏（task 7.3）：Logo + 健康徽章 + 模式切换 + 设置按钮 + 移动端菜单。

import { Menu, Settings } from 'lucide-react';
import { useHealth } from '../../hooks/useHealth';
import { useUiStore } from '../../store/uiStore';
import { HealthBadge } from '../Common/HealthBadge';
import { ModeSwitcher } from './ModeSwitcher';

export function TopBar() {
  const { health } = useHealth();
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);

  return (
    <header className="border-line bg-surface flex h-14 shrink-0 items-center gap-3 border-b px-4">
      {/* 移动端抽屉开关 */}
      <button
        type="button"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="打开会话列表"
        className="text-muted hover:text-fg rounded p-1 md:hidden"
      >
        <Menu size={20} />
      </button>
      <div className="flex items-center gap-2">
        <span className="bg-accent text-accent-fg flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold">
          S
        </span>
        <span className="text-fg hidden text-sm font-semibold sm:inline">Session Console</span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <HealthBadge health={health} />
        <ModeSwitcher />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="设置"
          className="text-muted hover:text-fg hover:bg-raised rounded-lg p-2"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}
