// 三段式响应式布局（task 7.1）：顶栏 + 侧栏 + 主区域 + 底部状态栏。
// - 桌面（md 及以上）：固定侧栏 280px
// - 移动端（<md）：侧栏为抽屉（sidebarOpen 控制），主区域全宽

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { ErrorBanner } from '../Common/ErrorBanner';
import { CreateDialog } from '../Session/CreateDialog';
import { SettingsPanel } from '../Settings/SettingsPanel';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';

export function AppShell({ children }: { children: ReactNode }) {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);

  return (
    <div className="bg-base text-fg flex h-full flex-col">
      <TopBar />
      <ErrorBanner />
      <div className="flex min-h-0 flex-1">
        {/* 桌面固定侧栏 */}
        <aside className="border-line bg-surface hidden w-[280px] shrink-0 border-r md:block">
          <Sidebar />
        </aside>

        {/* 移动端抽屉侧栏 */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
            role="presentation"
          >
            <aside
              onClick={(e) => e.stopPropagation()}
              className="bg-surface border-line relative h-full w-[280px] border-r shadow-xl"
              aria-label="会话列表"
            >
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                aria-label="关闭会话列表"
                className="text-muted hover:text-fg absolute top-3 right-3 z-10 rounded p-1"
              >
                <X size={16} />
              </button>
              <Sidebar />
            </aside>
          </div>
        )}

        {/* 主区域 */}
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <StatusBar />

      {/* 全局对话框 */}
      <CreateDialog />
      <SettingsPanel />
    </div>
  );
}
