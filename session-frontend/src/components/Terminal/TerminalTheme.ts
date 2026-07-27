// 终端主题映射（task 9.4）：主题定义中的 terminal 色板 → xterm.js ITheme。

import type { ITheme } from '@xterm/xterm';
import type { ThemeDefinition } from '../../theme/themes';

export function toXtermTheme(def: ThemeDefinition): ITheme {
  const t = def.terminal;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    selectionBackground: t.selectionBackground,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.red,
    brightGreen: t.green,
    brightYellow: t.yellow,
    brightBlue: t.blue,
    brightMagenta: t.magenta,
    brightCyan: t.cyan,
    brightWhite: t.foreground,
  };
}
