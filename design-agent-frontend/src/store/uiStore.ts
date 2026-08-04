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

/** 瞬时 toast（区别于常驻横幅）：用于连接重连中 / 已恢复 / 后端错误等信号。 */
export type ToastLevel = 'info' | 'success' | 'error' | 'warning';

export interface ToastInput {
  level: ToastLevel;
  message: string;
  detail?: string;
  /** 常驻（不自动消失），直到被显式 dismiss 或同 id 覆盖。 */
  sticky?: boolean;
  /** 自动消失时长（ms），sticky 时忽略。 */
  duration?: number;
  /** 是否显示加载指示（如重连中）。 */
  spinner?: boolean;
  /** 稳定 id：相同 id 的新 toast 会原地替换而非堆叠（重连 toast 复用同一 id）。 */
  id?: string;
}

export interface Toast extends Required<Pick<ToastInput, 'level' | 'message'>> {
  id: string;
  detail?: string;
  sticky: boolean;
  duration: number;
  spinner: boolean;
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
  /** 当前显示的瞬时 toast 列表。 */
  toasts: Toast[];
  setMode: (mode: AppMode) => void;
  showBanner: (level: BannerLevel, text: string, closable?: boolean) => void;
  dismissBanner: () => void;
  showToast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
  setCreateDialogOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSelectedModel: (model: string | null) => void;
}

function genId(): string {
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  toasts: [],
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
  showToast: (input) => {
    const id = input.id ?? genId();
    const toast: Toast = {
      id,
      level: input.level,
      message: input.message,
      detail: input.detail,
      sticky: input.sticky ?? false,
      duration: input.duration ?? 4000,
      spinner: input.spinner ?? false,
    };
    set((s) => {
      const idx = s.toasts.findIndex((t) => t.id === id);
      if (idx >= 0) {
        const next = s.toasts.slice();
        next[idx] = toast;
        return { toasts: next };
      }
      return { toasts: [...s.toasts, toast] };
    });
    // 测试可观测性钩子：记录所有 toast 事件，供 Playwright 断言（无需竞争时序）。
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __toastLog?: Array<{ id: string; level: string; message: string }> };
      w.__toastLog ??= [];
      w.__toastLog.push({ id, level: toast.level, message: toast.message });
    }
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearToasts: () => set({ toasts: [] }),
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
