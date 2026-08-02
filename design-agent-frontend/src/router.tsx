// 路由表（spec: design-agent-platform）：能力域路由派生自 AgentRegistry，
// 平台级页面（主页 / 个人空间）单独声明。布局层承载 AppHeader + 设置面板 + 错误横幅。

import { Suspense, lazy } from 'react';
import { BrowserRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ErrorBanner } from './components/Common/ErrorBanner';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { HomePage } from './modules/home/HomePage';
import { listAgents } from './platform/registry';
import { AppHeader } from './shared/AppHeader';

const SpacePage = lazy(() =>
  import('./modules/space/SpacePage').then((m) => ({ default: m.SpacePage })),
);

function PageFallback() {
  return (
    <div className="flex flex-1 items-center justify-center text-muted min-h-[240px]">
      加载中…
    </div>
  );
}

function PlatformLayout() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppHeader />
      <ErrorBanner />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </div>
      <SettingsPanel />
    </div>
  );
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<PlatformLayout />}>
          <Route path="/" element={<HomePage />} />
          {/* 能力域路由：注册表派生，新增能力域零路由改动 */}
          {listAgents().map((agent) => (
            <Route key={agent.id} path={agent.route} element={<agent.page />} />
          ))}
          <Route path="/space" element={<SpacePage />} />
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
