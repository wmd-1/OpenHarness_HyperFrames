// 顶层应用（task 11.1）：apiKey 驱动的欢迎页 / 主应用切换；
// 会话列表由 useSessionList 服务端权威拉取（F1.1），启动时清除
// 已废弃的 localStorage 会话 ID 缓存并恢复持久化选中项（F1.7）。

import { useEffect } from 'react';
import { useSessionList } from './hooks/useSessionList';
import { useAuthStore } from './store/authStore';
import { LEGACY_SESSION_IDS_KEY } from './utils/constants';
import { AppShell } from './components/Layout/AppShell';
import { SessionWorkspace } from './components/Session/SessionWorkspace';
import { WelcomeScreen } from './components/Welcome/WelcomeScreen';

/** 启动清理：旧版 localStorage 会话 ID 缓存已废弃（列表服务端权威化）。 */
function clearLegacySessionIds(): void {
  try {
    localStorage.removeItem(LEGACY_SESSION_IDS_KEY);
  } catch {
    // ignore
  }
}

function MainApp() {
  // 列表拉取/分页/刷新触发编排（认证成功后自动拉取，选中恢复在首屏完成后进行）
  useSessionList();

  return (
    <AppShell>
      <SessionWorkspace />
    </AppShell>
  );
}

export function App() {
  const apiKey = useAuthStore((s) => s.apiKey);

  useEffect(() => {
    clearLegacySessionIds();
  }, []);

  return apiKey ? <MainApp /> : <WelcomeScreen />;
}
