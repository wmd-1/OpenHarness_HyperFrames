// UI 全局状态：当前模式（chat/terminal）、全局错误横幅、对话框可见性、侧栏。

import { create } from 'zustand';
import { STORAGE_KEYS } from '../utils/constants';

export type AppMode = 'chat' | 'terminal';

export type BannerLevel = 'info' | 'warning' | 'error' | 'fatal';

export interface Banner {
  level: BannerLevel;
  text: string;
  /** fatal 级横幅不可手动关闭（如配额耗尽）。 */
  closable: boolean;
}

interface UiState {
  mode: AppMode;
  banner: Banner | null;
  createDialogOpen: boolean;
  settingsOpen: boolean;
  /** 移动端抽屉侧栏是否展开。 */
  sidebarOpen: boolean;
  /** OpenHarness 主 agent 当前选择模型（null=后端默认；`da.model` 持久化）。 */
  selectedModel: string | null;
  setMode: (mode: AppMode) => void;
  showBanner: (level: BannerLevel, text: string, closable?: boolean) => void;
  dismissBanner: () => void;
  setCreateDialogOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSelectedModel: (model: string | null) => void;
}

function loadMode(): AppMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.mode);
    if (saved === 'chat' || saved === 'terminal') return saved;
  } catch {
    // ignore
  }
  return 'chat';
}

function loadModel(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.model);
  } catch {
    return null;
  }
}

export const useUiStore = create<UiState>((set) => ({
  mode: loadMode(),
  banner: null,
  createDialogOpen: false,
  settingsOpen: false,
  sidebarOpen: false,
  selectedModel: loadModel(),
  setMode: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEYS.mode, mode);
    } catch {
      // ignore
    }
    set({ mode });
  },
  showBanner: (level, text, closable = true) => set({ banner: { level, text, closable } }),
  dismissBanner: () => set({ banner: null }),
  setCreateDialogOpen: (open) => set({ createDialogOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSelectedModel: (model) => {
    try {
      if (model) localStorage.setItem(STORAGE_KEYS.model, model);
      else localStorage.removeItem(STORAGE_KEYS.model);
    } catch {
      // ignore
    }
    set({ selectedModel: model });
  },
}));
