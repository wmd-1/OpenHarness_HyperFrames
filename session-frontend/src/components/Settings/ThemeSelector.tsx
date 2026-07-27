// 主题选择器（task 7.12）：5 个内置主题的色板预览 + 单选。

import { Check } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { THEME_NAMES, THEMES } from '../../theme/themes';

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div role="radiogroup" aria-label="主题" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {THEME_NAMES.map((name) => {
        const def = THEMES[name];
        const active = theme === name;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(name)}
            className={`flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors ${
              active ? 'border-accent ring-accent/30 ring-2' : 'border-line hover:border-muted'
            }`}
            style={{ background: def.cssVars['app-bg'] }}
          >
            <div className="flex items-center gap-1">
              {/* 主题色板预览 */}
              {['app-accent', 'app-success', 'app-warning', 'app-error'].map((v) => (
                <span
                  key={v}
                  className="h-3 w-3 rounded-full"
                  style={{ background: def.cssVars[v] }}
                />
              ))}
            </div>
            <div
              className="flex items-center justify-between text-sm font-medium"
              style={{ color: def.cssVars['app-text'] }}
            >
              {def.label}
              {active && <Check size={14} />}
            </div>
          </button>
        );
      })}
    </div>
  );
}
