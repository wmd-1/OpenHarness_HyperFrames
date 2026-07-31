// 底部状态栏（task 7.11）：WS 连接状态 + 会话状态 + 轮次计数 + 权限策略。

import { Bot, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { useSessionStore } from '../../store/sessionStore';
import { useWsStore } from '../../store/wsStore';
import type { WsStatus } from '../../types/ws';

const WS_STATUS_META: Record<WsStatus, { label: string; className: string; live: boolean }> = {
  idle: { label: '未连接', className: 'text-muted', live: false },
  connecting: { label: '连接中…', className: 'text-warn', live: false },
  ready: { label: '已连接', className: 'text-ok', live: true },
  reconnecting: { label: '重连中…', className: 'text-warn', live: false },
  auth_failed: { label: '认证失败', className: 'text-err', live: false },
  session_closed: { label: '会话已关闭', className: 'text-muted', live: false },
  session_not_found: { label: '会话不存在', className: 'text-err', live: false },
  rate_limited: { label: '已限流', className: 'text-warn', live: false },
  quota_exceeded: { label: '并发配额已满', className: 'text-warn', live: false },
  failed: { label: '连接失败', className: 'text-err', live: false },
  closed: { label: '已断开', className: 'text-muted', live: false },
};

export function StatusBar() {
  const currentId = useSessionStore((s) => s.currentId);
  const session = useSessionStore((s) => (s.currentId ? s.sessions[s.currentId] : null));
  const wsStatus = useWsStore((s) =>
    currentId ? (s.status[currentId] ?? 'idle') : 'idle',
  );
  const reconnectAttempt = useWsStore((s) =>
    currentId ? (s.reconnectAttempt[currentId] ?? 0) : 0,
  );

  const meta = WS_STATUS_META[wsStatus];
  const WsIcon = meta.live ? Wifi : WifiOff;

  return (
    <footer className="border-line bg-surface text-muted flex h-7 shrink-0 items-center gap-4 border-t px-4 text-xs">
      <span className={`flex items-center gap-1 ${meta.className}`} data-ws-status={wsStatus}>
        <WsIcon size={12} />
        {meta.label}
        {wsStatus === 'reconnecting' && reconnectAttempt > 0 && `（第 ${reconnectAttempt} 次）`}
      </span>
      {session && (
        <>
          <span>会话 {session.status}</span>
          <span>轮次 {session.turn_count}</span>
          <span className="flex items-center gap-1">
            {session.permission_policy === 'interactive' ? (
              <ShieldCheck size={12} />
            ) : (
              <Bot size={12} />
            )}
            {session.permission_policy === 'interactive' ? '交互审批' : '全自动'}
          </span>
        </>
      )}
    </footer>
  );
}
