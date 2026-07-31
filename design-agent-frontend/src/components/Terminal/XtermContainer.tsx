// xterm.js 容器（task 9.2）：动态 import 按需加载（vite manualChunks 独立分包），
// FitAddon 自适应尺寸 + WebLinksAddon + Shift+Enter 自定义键处理。

import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useTheme } from '../../hooks/useTheme';
import { toXtermTheme } from './TerminalTheme';

export interface XtermContainerProps {
  /** 终端创建完成回调（返回清理函数可选）。 */
  onReady: (term: Terminal) => void | (() => void);
  /** Shift+Enter 按下（换行续行）。返回 true 表示已消费。 */
  onShiftEnter?: () => boolean;
}

export function XtermContainer({ onReady, onShiftEnter }: XtermContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const { definition } = useTheme();
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onShiftEnterRef = useRef(onShiftEnter);
  onShiftEnterRef.current = onShiftEnter;
  // 主题变化时热更新终端配色
  const themeRef = useRef(definition);
  themeRef.current = definition;

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      // 按需加载 xterm 三件套 + 样式
      const [{ Terminal: XTerm }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
        import('@xterm/xterm/css/xterm.css'),
      ]);
      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
        theme: toXtermTheme(themeRef.current),
        convertEol: false,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());

      // Shift+Enter → 续行（拦截默认 \r 输入）
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
          if (onShiftEnterRef.current?.()) return false;
        }
        return true;
      });

      term.open(containerRef.current);
      fit.fit();
      term.focus();
      termRef.current = term;

      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // 容器隐藏时 fit 可能抛错，忽略
        }
      });
      observer.observe(containerRef.current);

      const readyCleanup = onReadyRef.current(term);
      cleanup = () => {
        if (typeof readyCleanup === 'function') readyCleanup();
        observer.disconnect();
        term.dispose();
        termRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  // 主题切换时更新终端配色
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = toXtermTheme(definition);
  }, [definition]);

  return <div ref={containerRef} className="h-full w-full" data-testid="xterm-container" />;
}
