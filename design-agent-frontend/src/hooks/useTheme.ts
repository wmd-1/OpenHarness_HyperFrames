// 主题切换 Hook：读取 ThemeContext，暴露当前主题定义 + 切换函数。

import { useContext } from 'react';
import { ThemeContext } from '../theme/ThemeContext';
import { THEMES } from '../theme/themes';
import type { ThemeDefinition, ThemeName } from '../theme/themes';

export interface UseThemeResult {
  theme: ThemeName;
  definition: ThemeDefinition;
  setTheme: (name: ThemeName) => void;
}

export function useTheme(): UseThemeResult {
  const { theme, setTheme } = useContext(ThemeContext);
  return { theme, definition: THEMES[theme], setTheme };
}
