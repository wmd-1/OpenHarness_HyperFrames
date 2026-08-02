// 主题 Context Provider：切换主题时把 CSS 变量写入 <html>，
// 并持久化到 localStorage（key: sf.theme）。
// 增强（change: design-frontend-theme-unify-and-layout-tokens D3）：
// - 无 localStorage 偏好时跟随系统 prefers-color-scheme；
// - applyTheme 同步 color-scheme，让原生 scrollbar/<select>/autofill 跟随主题。

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { STORAGE_KEYS } from '../utils/constants';
import { ThemeContext } from './ThemeContext';
import { isThemeName, THEMES } from './themes';
import type { ThemeName } from './themes';

/** 归为深色 color-scheme 的主题（其余为 light）。 */
const DARK_COLOR_SCHEME_THEMES: ReadonlySet<ThemeName> = new Set<ThemeName>(['dark', 'cyberpunk']);

function applyTheme(name: ThemeName): void {
  const def = THEMES[name];
  const root = document.documentElement;
  root.setAttribute('data-theme', name);
  for (const [key, value] of Object.entries(def.cssVars)) {
    root.style.setProperty(`--${key}`, value);
  }
  // 同步原生 color-scheme，让 scrollbar/<select>/autofill 跟随主题（D3）
  root.style.colorScheme = DARK_COLOR_SCHEME_THEMES.has(name) ? 'dark' : 'light';
}

function loadInitialTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    if (isThemeName(saved)) return saved;
  } catch {
    // localStorage 不可用时回退默认主题
  }
  // 无显式偏好时跟随系统 prefers-color-scheme（D3）
  try {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    // matchMedia 不可用时回退默认主题
  }
  return 'default';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(loadInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((name: ThemeName) => {
    setThemeState(name);
    try {
      localStorage.setItem(STORAGE_KEYS.theme, name);
    } catch {
      // 忽略持久化失败
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
