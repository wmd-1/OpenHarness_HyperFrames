// 顶层应用（task 11.1）：apiKey 驱动的欢迎页 / 主应用切换；
// 启动时从 localStorage 缓存的会话 ID 恢复会话详情（design D8）。

import { useEffect } from 'react';
import { getSession } from './api/sessions';
import { errorStatus } from './api/client';
import { loadCachedSessionIds, pruneCachedSessionIds, useSessionStore } from './store/sessionStore';
import { useAuthStore } from './store/authStore';
import { AppShell } from './components/Layout/AppShell';
import { SessionWorkspace } from './components/Session/SessionWorkspace';
import { WelcomeScreen } from './components/Welcome/WelcomeScreen';

/** 启动恢复的并发批大小，避免大量缓存 ID 时瞬时打满后端（A10）。 */
const RESTORE_BATCH_SIZE = 10;

/** 启动恢复：分批 GET 缓存会话；404 的即时从缓存剔除。 */
async function restoreSessions(): Promise<void> {
  const ids = loadCachedSessionIds();
  if (ids.length === 0) return;
  const store = useSessionStore.getState();
  store.setLoading(true);
  try {
    for (let i = 0; i < ids.length; i += RESTORE_BATCH_SIZE) {
      const batch = ids.slice(i, i + RESTORE_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map((id) => getSession(id)));
      const staleIds: string[] = [];
      results.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          useSessionStore.getState().updateSession(result.value);
        } else if (errorStatus(result.reason) === 404) {
          // 已过期/被清理的会话：即时剔除缓存，其余失败（网络等）保留待下次重试
          staleIds.push(batch[idx]);
        }
      });
      pruneCachedSessionIds(staleIds);
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
