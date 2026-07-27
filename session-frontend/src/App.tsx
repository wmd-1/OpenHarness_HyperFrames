// 顶层应用（task 11.1）：apiKey 驱动的欢迎页 / 主应用切换；
// 启动时从 localStorage 缓存的会话 ID 恢复会话详情（design D8）。

import { useEffect } from 'react';
import { getSession } from './api/sessions';
import { loadCachedSessionIds, useSessionStore } from './store/sessionStore';
import { useAuthStore } from './store/authStore';
import { AppShell } from './components/Layout/AppShell';
import { SessionWorkspace } from './components/Session/SessionWorkspace';
import { WelcomeScreen } from './components/Welcome/WelcomeScreen';

/** 启动恢复：逐个 GET 缓存会话；404/410 的静默丢弃。 */
async function restoreSessions(): Promise<void> {
  const ids = loadCachedSessionIds();
  if (ids.length === 0) return;
  const store = useSessionStore.getState();
  store.setLoading(true);
  try {
    const results = await Promise.allSettled(ids.map((id) => getSession(id)));
    for (const result of results) {
      // rejected（404/网络错误）静默丢弃；缓存在下次写入时自然清理
      if (result.status === 'fulfilled') {
        useSessionStore.getState().updateSession(result.value);
      }
    }
    // 自动选中最近的会话
    const { order, currentId } = useSessionStore.getState();
    if (!currentId && order.length > 0) {
      useSessionStore.getState().selectSession(order[0]);
    }
  } finally {
    useSessionStore.getState().setLoading(false);
  }
}

function MainApp() {
  const apiKey = useAuthStore((s) => s.apiKey);

  useEffect(() => {
    if (apiKey) void restoreSessions();
  }, [apiKey]);

  return (
    <AppShell>
      <SessionWorkspace />
    </AppShell>
  );
}

export function App() {
  const apiKey = useAuthStore((s) => s.apiKey);
  return apiKey ? <MainApp /> : <WelcomeScreen />;
}
