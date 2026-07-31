// 认证状态管理（task 4.6）：API Key 存取 + 认证失效弹窗状态。
// 未认证 → 欢迎界面；收到 401 → 清除 Key 并重弹认证对话框。

import { create } from 'zustand';
import { STORAGE_KEYS } from '../utils/constants';
import { useUiStore } from './uiStore';

interface AuthState {
  apiKey: string | null;
  /** 401 导致的认证失效（区别于首次未配置），用于重弹对话框提示。 */
  authExpired: boolean;
  setApiKey: (key: string) => void;
  clearApiKey: () => void;
  /** 认证失效：清 Key + 标记过期。 */
  markAuthExpired: () => void;
}

function loadApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.apiKey);
  } catch {
    return null;
  }
}

/** 回到欢迎页前关闭悬浮弹窗，避免重新登录后遮罩残留。 */
function closeOverlays(): void {
  const ui = useUiStore.getState();
  ui.setCreateDialogOpen(false);
  ui.setSettingsOpen(false);
}

export const useAuthStore = create<AuthState>((set) => ({
  apiKey: loadApiKey(),
  authExpired: false,
  setApiKey: (key) => {
    try {
      localStorage.setItem(STORAGE_KEYS.apiKey, key);
    } catch {
      // localStorage 不可用时仅保留内存态
    }
    set({ apiKey: key, authExpired: false });
  },
  clearApiKey: () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.apiKey);
    } catch {
      // ignore
    }
    closeOverlays();
    set({ apiKey: null, authExpired: false });
  },
  markAuthExpired: () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.apiKey);
    } catch {
      // ignore
    }
    closeOverlays();
    set({ apiKey: null, authExpired: true });
  },
}));
