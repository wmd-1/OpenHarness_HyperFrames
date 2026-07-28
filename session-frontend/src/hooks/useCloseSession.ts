// 关闭会话统一入口（task 3.2 A5）：确认对话框 → 乐观置 closed → DELETE 失败回滚 + 错误横幅。
// 替代此前 Sidebar / ChatView / TerminalView 三处 `.catch(() => undefined)` 吞错写法。

import { useCallback, useState } from 'react';
import { closeSession } from '../api/sessions';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';

export interface UseCloseSessionResult {
  /** 待确认关闭的会话 ID（非 null 时渲染 ConfirmDialog）。 */
  pendingSid: string | null;
  /** 请求关闭：打开确认对话框。 */
  requestClose: (sid: string) => void;
  /** 用户确认关闭：执行乐观关闭。 */
  confirmClose: () => void;
  /** 取消关闭。 */
  cancelClose: () => void;
}

/** 乐观置 closed，DELETE 失败回滚原状态并提示（导出便于单测）。 */
export async function closeWithRollback(sid: string): Promise<void> {
  const prevStatus = useSessionStore.getState().sessions[sid]?.status;
  useSessionStore.getState().patchSession(sid, { status: 'closed' });
  try {
    await closeSession(sid);
  } catch {
    // 回滚原状态；全局横幅明确告知失败（client.ts 拦截器可能已按状态码提示，这里兜底覆盖）
    if (prevStatus !== undefined) {
      useSessionStore.getState().patchSession(sid, { status: prevStatus });
    }
    useUiStore.getState().showBanner('error', '关闭会话失败，请重试');
  }
}

export function useCloseSession(): UseCloseSessionResult {
  const [pendingSid, setPendingSid] = useState<string | null>(null);

  const requestClose = useCallback((sid: string) => setPendingSid(sid), []);
  const cancelClose = useCallback(() => setPendingSid(null), []);
  // 不在 setState updater 内做副作用：StrictMode 下 updater 会执行两次（避免重复 DELETE）
  const confirmClose = useCallback(() => {
    if (pendingSid) void closeWithRollback(pendingSid);
    setPendingSid(null);
  }, [pendingSid]);

  return { pendingSid, requestClose, confirmClose, cancelClose };
}
