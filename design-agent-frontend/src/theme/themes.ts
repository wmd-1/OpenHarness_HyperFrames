// 5 个内置主题定义（default/dark/minimal/cyberpunk/solarized）。
// 每个主题是一组 CSS 变量值（由 ThemeProvider 写入 documentElement），
// Terminal Mode 的 xterm ITheme 映射见 components/Terminal/TerminalTheme.ts。

export type ThemeName = 'default' | 'dark' | 'minimal' | 'cyberpunk' | 'solarized';

export interface ThemeDefinition {
  name: ThemeName;
  label: string;
  /** CSS 变量集（不带 -- 前缀的 key）。 */
  cssVars: Record<string, string>;
  /** 终端 ANSI 基色（TerminalTheme 用）。 */
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
  };
}

const vars = (v: {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentFg: string;
  success: string;
  warning: string;
  error: string;
  userBubble?: string;
  userBubbleFg?: string;
  assistantBubble?: string;
}): Record<string, string> => ({
  'app-bg': v.bg,
  'app-surface': v.surface,
  'app-surface-alt': v.surfaceAlt,
  'app-border': v.border,
  'app-text': v.text,
  'app-text-muted': v.textMuted,
  'app-accent': v.accent,
  'app-accent-fg': v.accentFg,
  'app-success': v.success,
  'app-warning': v.warning,
  'app-error': v.error,
  'app-user-bubble': v.userBubble ?? v.accent,
  'app-user-bubble-fg': v.userBubbleFg ?? v.accentFg,
  'app-assistant-bubble': v.assistantBubble ?? v.surface,
});

export const THEMES: Record<ThemeName, ThemeDefinition> = {
  default: {
    name: 'default',
    label: 'Default',
    // demo 亮色令牌（design D5：与 src/styles/demo.css :root 一致）
    cssVars: vars({
      bg: '#eef1f5',
      surface: '#ffffff',
      surfaceAlt: '#f5f7fa',
      border: '#e2e6ec',
      text: '#1f2937',
      textMuted: '#6b7280',
      accent: '#1a56db',
      accentFg: '#ffffff',
      success: '#16a34a',
      warning: '#d97706',
      error: '#dc2626',
    }),
    terminal: {
      background: '#ffffff',
      foreground: '#1f2937',
      cursor: '#1a56db',
      selectionBackground: '#e8f0fe',
      black: '#1f2937',
      red: '#dc2626',
      green: '#16a34a',
      yellow: '#d97706',
      blue: '#1a56db',
      magenta: '#9333ea',
      cyan: '#0891b2',
      white: '#f5f7fa',
      brightBlack: '#6b7280',
    },
  },
  dark: {
    name: 'dark',
    label: 'Dark',
    cssVars: vars({
      bg: '#0b1120',
      surface: '#111827',
      surfaceAlt: '#1f2937',
      border: '#2d3748',
      text: '#e5e7eb',
      textMuted: '#9ca3af',
      accent: '#3b82f6',
      accentFg: '#ffffff',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
      assistantBubble: '#1f2937',
    }),
    terminal: {
      background: '#0b1120',
      foreground: '#e5e7eb',
      cursor: '#3b82f6',
      selectionBackground: '#1e3a8a',
      black: '#111827',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#f59e0b',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#06b6d4',
      white: '#e5e7eb',
      brightBlack: '#6b7280',
    },
  },
  minimal: {
    name: 'minimal',
    label: 'Minimal',
    cssVars: vars({
      bg: '#ffffff',
      surface: '#ffffff',
      surfaceAlt: '#fafafa',
      border: '#e5e5e5',
      text: '#171717',
      textMuted: '#737373',
      accent: '#171717',
      accentFg: '#ffffff',
      success: '#15803d',
      warning: '#a16207',
      error: '#b91c1c',
      userBubble: '#171717',
      assistantBubble: '#fafafa',
    }),
    terminal: {
      background: '#ffffff',
      foreground: '#171717',
      cursor: '#171717',
      selectionBackground: '#e5e5e5',
      black: '#171717',
      red: '#b91c1c',
      green: '#15803d',
      yellow: '#a16207',
      blue: '#1d4ed8',
      magenta: '#7e22ce',
      cyan: '#0e7490',
      white: '#fafafa',
      brightBlack: '#737373',
    },
  },
  cyberpunk: {
    name: 'cyberpunk',
    label: 'Cyberpunk',
    cssVars: vars({
      bg: '#0a0014',
      surface: '#140a24',
      surfaceAlt: '#1e1233',
      border: '#3b2a5e',
      text: '#e0d7ff',
      textMuted: '#8b7bb8',
      accent: '#ff2ea6',
      accentFg: '#0a0014',
      success: '#00ffa3',
      warning: '#ffd60a',
      error: '#ff4d6d',
      userBubble: '#ff2ea6',
      userBubbleFg: '#0a0014',
      assistantBubble: '#1e1233',
    }),
    terminal: {
      background: '#0a0014',
      foreground: '#e0d7ff',
      cursor: '#ff2ea6',
      selectionBackground: '#3b2a5e',
      black: '#140a24',
      red: '#ff4d6d',
      green: '#00ffa3',
      yellow: '#ffd60a',
      blue: '#00b3ff',
      magenta: '#ff2ea6',
      cyan: '#00f0ff',
      white: '#e0d7ff',
      brightBlack: '#8b7bb8',
    },
  },
  solarized: {
    name: 'solarized',
    label: 'Solarized',
    cssVars: vars({
      bg: '#fdf6e3',
      surface: '#eee8d5',
      surfaceAlt: '#f5efdc',
      border: '#d9d2c0',
      text: '#657b83',
      textMuted: '#93a1a1',
      accent: '#268bd2',
      accentFg: '#fdf6e3',
      success: '#859900',
      warning: '#b58900',
      error: '#dc322f',
      assistantBubble: '#eee8d5',
    }),
    terminal: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#268bd2',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#93a1a1',
    },
  },
};

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export function isThemeName(value: string | null | undefined): value is ThemeName {
  return value != null && value in THEMES;
}
