// 主题 Context Provider：切换主题时把 CSS 变量写入 <html>，
// 并持久化到 localStorage（key: sf.theme）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { STORAGE_KEYS } from '../utils/constants';
import { ThemeContext } from './ThemeContext';
import { isThemeName, THEMES } from './themes';
import type { ThemeName } from './themes';

function applyTheme(name: ThemeName): void {
  const def = THEMES[name];
  const root = document.documentElement;
  root.setAttribute('data-theme', name);
  for (const [key, value] of Object.entries(def.cssVars)) {
    root.style.setProperty(`--${key}`, value);
  }
}

function loadInitialTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    if (isThemeName(saved)) return saved;
  } catch {
    // localStorage 不可用时回退默认主题
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
