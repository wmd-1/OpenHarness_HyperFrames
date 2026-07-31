// 会话列表编排（F1.2/F1.3）：服务端权威列表拉取/分页/事件驱动刷新。
// 五个刷新触发：①认证成功（apiKey 变化）②创建成功 ③关闭成功
// ④session_ready（让位可视化）⑤window focus（≥10s 节流）；手动刷新兜底，不做后台轮询（Q3）。
// 动作为模块级函数（Sidebar 桌面/移动端双实例共用），useSessionList 只挂载触发器。

import { useEffect, useRef } from 'react';
import { errorStatus, NoApiKeyError } from '../api/client';
import { listSessions } from '../api/sessions';
import { useAuthStore } from '../store/authStore';
import { loadPersistedCurrentId, useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';

const PAGE_SIZE = 20;
/** window focus 刷新节流间隔。 */
const FOCUS_REFRESH_THROTTLE_MS = 10_000;

/** 首屏加载后若无选中会话：优先恢复持久化选中项，否则选第一项（F1.7）。 */
function restoreSelection(): void {
  const { currentId, order, selectSession } = useSessionStore.getState();
  if (currentId || order.length === 0) return;
  const persisted = loadPersistedCurrentId();
  selectSession(persisted && order.includes(persisted) ? persisted : order[0]);
}

/** 刷新会话列表（重置到第一页，保序合并已加载页）。 */
export async function refreshSessionList(): Promise<void> {
  const store = useSessionStore.getState();
  if (store.order.length === 0) store.setLoading(true);
  try {
    const resp = await listSessions({ limit: PAGE_SIZE, offset: 0 });
    useSessionStore
      .getState()
      .applyListPage(resp.items, { total: resp.total, offset: 0 }, 'replace');
    restoreSelection();
  } catch (err) {
    if (err instanceof NoApiKeyError) return;
    const status = errorStatus(err);
    if (status === 404 || status === 405) {
      // 旧后端未部署列表接口：降级空列表 + banner，不回退 localStorage 方案
      useUiStore
        .getState()
        .showBanner('warning', '后端版本过旧，暂不支持会话列表，请升级 session-service');
    } else {
      useUiStore.getState().showBanner('error', '获取会话列表失败，请稍后重试');
    }
  } finally {
    useSessionStore.getState().setLoading(false);
  }
}

/** 加载下一页（offset 递增追加）。 */
export async function loadMoreSessions(): Promise<void> {
  const { offset, hasMore, loadingMore, setLoadingMore } = useSessionStore.getState();
  if (!hasMore || loadingMore) return;
  setLoadingMore(true);
  try {
    const resp = await listSessions({ limit: PAGE_SIZE, offset });
    useSessionStore
      .getState()
      .applyListPage(resp.items, { total: resp.total, offset }, 'append');
  } catch (err) {
    if (!(err instanceof NoApiKeyError)) {
      useUiStore.getState().showBanner('error', '加载更多会话失败，请重试');
    }
  } finally {
    useSessionStore.getState().setLoadingMore(false);
  }
}

/** 请求刷新会话列表（创建成功/关闭成功/session_ready 处调用）。 */
export function requestSessionListRefresh(): void {
  void refreshSessionList();
}

/** 挂载列表刷新触发器（App 层调用一次）：认证成功 + window focus 节流。 */
export function useSessionList(): void {
  const apiKey = useAuthStore((s) => s.apiKey);
  const lastFocusRefreshAt = useRef(0);

  // 触发①：认证成功（apiKey 就绪/变化）
  useEffect(() => {
    if (apiKey) void refreshSessionList();
  }, [apiKey]);

  // 触发⑤：window focus（≥10s 节流）
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefreshAt.current < FOCUS_REFRESH_THROTTLE_MS) return;
      lastFocusRefreshAt.current = now;
      void refreshSessionList();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
}
