// ThemeProvider 单测（change: design-frontend-theme-unify-and-layout-tokens D3）：
// ① 无 localStorage 偏好时跟随系统 prefers-color-scheme；
// ② 显式选择覆盖系统；
// ③ applyTheme 同步 color-scheme（dark/cyberpunk→dark，default/minimal/solarized→light）。

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../ThemeProvider';
import { useTheme } from '../../hooks/useTheme';
import { STORAGE_KEYS } from '../../utils/constants';
import type { ThemeName } from '../themes';

/** 渲染 ThemeProvider 包裹下的 useTheme，返回 hook 结果。 */
function renderWithProvider(initialTheme?: ThemeName) {
  if (initialTheme !== undefined) {
    localStorage.setItem(STORAGE_KEYS.theme, initialTheme);
  }
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ThemeProvider>{children}</ThemeProvider>
  );
  return renderHook(() => useTheme(), { wrapper });
}

/** 安装 matchMedia mock（jsdom 不实现 matchMedia）。 */
function mockMatchMedia(matchesDark: boolean): void {
  const mm: Partial<MediaQueryList> = {
    matches: matchesDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mm));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  vi.unstubAllGlobals();
});

describe('ThemeProvider 初始主题', () => {
  it('无 localStorage 偏好且系统为 dark → 初始化 dark', () => {
    mockMatchMedia(true);
    const { result } = renderWithProvider();
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('无 localStorage 偏好且系统为 light → 初始化 default', () => {
    mockMatchMedia(false);
    const { result } = renderWithProvider();
    expect(result.current.theme).toBe('default');
  });

  it('有 localStorage 显式偏好 → 用之，忽略系统', () => {
    mockMatchMedia(true); // 系统为 dark
    const { result } = renderWithProvider('solarized');
    expect(result.current.theme).toBe('solarized');
  });

  it('localStorage 偏好无效 → 回退系统', () => {
    localStorage.setItem(STORAGE_KEYS.theme, 'nonexistent-theme');
    mockMatchMedia(true);
    const { result } = renderWithProvider();
    expect(result.current.theme).toBe('dark');
  });
});

describe('ThemeProvider color-scheme 同步', () => {
  it.each(['dark', 'cyberpunk'] as const)('主题 %s → color-scheme=dark', (name) => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });
    act(() => result.current.setTheme(name));
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe(name);
  });

  it.each(['default', 'minimal', 'solarized'] as const)(
    '主题 %s → color-scheme=light',
    (name) => {
      mockMatchMedia(true); // 系统为 dark，但显式选择亮色主题
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });
      act(() => result.current.setTheme(name));
      expect(document.documentElement.style.colorScheme).toBe('light');
    },
  );
});

describe('ThemeProvider 显式选择持久化', () => {
  it('setTheme 写入 localStorage，覆盖系统偏好', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });
    act(() => result.current.setTheme('minimal'));
    expect(localStorage.getItem(STORAGE_KEYS.theme)).toBe('minimal');
    expect(result.current.theme).toBe('minimal');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
