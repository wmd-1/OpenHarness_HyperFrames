// 顶层应用：apiKey 驱动的欢迎页 / 平台路由切换。
// 会话列表拉取下沉到视频模块（useSessionList 在 VideoModulePage 编排）；
// 启动时清除已废弃的 localStorage 会话 ID 缓存（列表服务端权威化）。

import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { LEGACY_SESSION_IDS_KEY } from './utils/constants';
import { AppRouter } from './router';
import { WelcomeScreen } from './components/Welcome/WelcomeScreen';

/** 启动清理：旧版 localStorage 会话 ID 缓存已废弃（列表服务端权威化）。 */
function clearLegacySessionIds(): void {
  try {
    localStorage.removeItem(LEGACY_SESSION_IDS_KEY);
  } catch {
    // ignore
  }
}

export function App() {
  const apiKey = useAuthStore((s) => s.apiKey);

  useEffect(() => {
    clearLegacySessionIds();
  }, []);

  return apiKey ? <AppRouter /> : <WelcomeScreen />;
}
