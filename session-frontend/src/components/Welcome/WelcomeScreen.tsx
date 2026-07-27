// 欢迎界面（task 11.3）：API Key 输入 + 服务健康检查。
// 保存 Key 后 App 自动切换到主应用（authStore.apiKey 驱动路由）。

import { TerminalSquare } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useHealth } from '../../hooks/useHealth';
import { HealthBadge } from '../Common/HealthBadge';
import { ApiKeyInput } from '../Settings/ApiKeyInput';

export function WelcomeScreen() {
  const authExpired = useAuthStore((s) => s.authExpired);
  const { health } = useHealth();

  return (
    <div className="bg-base text-fg flex h-full items-center justify-center p-4">
      <div className="bg-surface border-line w-full max-w-md rounded-2xl border p-8 shadow-xl">
        <div className="flex flex-col items-center text-center">
          <span className="bg-accent/15 text-accent rounded-2xl p-3">
            <TerminalSquare size={32} />
          </span>
          <h1 className="text-fg mt-4 text-xl font-semibold">OpenHarness Session</h1>
          <p className="text-muted mt-1 text-sm">与远程 Agent 会话对话，生成视频与产物</p>
          <div className="mt-3">
            <HealthBadge health={health} />
          </div>
        </div>

        {authExpired && (
          <p
            className="bg-warn/10 text-warn mt-6 rounded-lg px-3 py-2 text-sm"
            role="alert"
            data-testid="auth-expired-notice"
          >
            认证已失效，请重新输入 API Key
          </p>
        )}

        <div className="mt-6">
          <ApiKeyInput />
        </div>
        <p className="text-muted mt-3 text-xs">
          API Key 仅保存在浏览器 localStorage，用于 REST 请求头与 WebSocket 握手。
        </p>
        {health === 'unhealthy' && (
          <p className="text-err mt-2 text-xs" role="alert">
            服务当前不可用，保存 Key 后仍可进入，恢复后自动重连。
          </p>
        )}
      </div>
    </div>
  );
}
