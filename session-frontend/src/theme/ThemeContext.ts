// 主题 Context（与 Provider 分离，满足 react-refresh 只导出组件的约束）。

import { createContext } from 'react';
import type { ThemeName } from './themes';

export interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (name: ThemeName) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: 'default',
  setTheme: () => {},
});
