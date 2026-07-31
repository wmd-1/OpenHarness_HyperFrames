// API Key 输入 / 脱敏展示 / 清除组件（设置面板 + 欢迎界面复用）。

import { useState } from 'react';
import { Eye, EyeOff, KeyRound, Trash2 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useSessionStore } from '../../store/sessionStore';
import { maskApiKey } from '../../utils/sanitize';

export function ApiKeyInput() {
  const apiKey = useAuthStore((s) => s.apiKey);
  const setApiKey = useAuthStore((s) => s.setApiKey);
  const clearApiKey = useAuthStore((s) => s.clearApiKey);
  const resetSessions = useSessionStore((s) => s.reset);
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setApiKey(trimmed);
    setDraft('');
  };

  const handleClear = () => {
    // 清除 Key：断开所有会话（WS 由 useWebSocket 因 apiKey 变化自动断开）
    clearApiKey();
    resetSessions();
  };

  if (apiKey) {
    return (
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-muted shrink-0" />
        <code className="bg-raised border-line flex-1 rounded border px-2 py-1 text-sm">
          {maskApiKey(apiKey)}
        </code>
        <button
          type="button"
          onClick={handleClear}
          className="text-err hover:bg-raised flex items-center gap-1 rounded px-2 py-1 text-sm"
        >
          <Trash2 size={14} />
          清除 API Key
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <input
          type={visible ? 'text' : 'password'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          placeholder="输入 API Key"
          aria-label="API Key"
          className="border-line bg-surface focus:border-accent w-full rounded border px-3 py-2 pr-9 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? '隐藏 API Key' : '显示 API Key'}
          className="text-muted absolute top-1/2 right-2 -translate-y-1/2"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <button
        type="button"
        onClick={handleSave}
        disabled={!draft.trim()}
        className="bg-accent text-accent-fg rounded px-3 py-2 text-sm disabled:opacity-50"
      >
        保存
      </button>
    </div>
  );
}
