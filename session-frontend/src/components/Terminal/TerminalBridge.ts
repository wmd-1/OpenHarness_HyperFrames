// WS 事件 → xterm 终端输出桥接（task 9.3）+ 行编辑与快捷键（task 9.6）：
// - delta → 原样文本；tool_start/tool_end → 彩色一行摘要；turn_complete → 提示符
// - Ctrl+C / Escape → 中断；上下箭头 → 历史；Tab → `/` 命令补全；
//   Shift+Enter → 换行续行（在 XtermContainer 用 attachCustomKeyEventHandler 转发）

import type { Terminal } from '@xterm/xterm';
import type { ServerFrame } from '../../types/ws';
import { SLASH_COMMANDS, WS_CLOSE_MESSAGES } from '../../utils/constants';

// ANSI 样式
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

const PROMPT = `${GREEN}❯${RESET} `;
const CONTINUATION = `${DIM}… ${RESET}`;

export interface TerminalBridgeCallbacks {
  submit: (text: string) => boolean;
  interrupt: () => boolean;
  /** 本地命令（/clear 等）处理；返回 true 表示已消费。 */
  onLocalCommand?: (command: string) => boolean;
}

/**
 * 终端桥接：行编辑（本地回显）+ 服务端帧渲染。
 * 输入期间收到服务端输出时，先清行输出内容再重绘输入行。
 */
export class TerminalBridge {
  private term: Terminal;
  private readonly cb: TerminalBridgeCallbacks;
  /** 多行输入缓冲（Shift+Enter 续行）。 */
  private lines: string[] = [''];
  private history: string[] = [];
  private historyIndex = -1;
  private draftBeforeHistory = '';
  /** 轮次执行中（禁用输入提交，仅允许 Ctrl+C/Escape）。 */
  private busy = false;
  private disposed = false;

  constructor(term: Terminal, cb: TerminalBridgeCallbacks, initialHistory: string[] = []) {
    this.term = term;
    this.cb = cb;
    this.history = [...initialHistory];
    term.onData((data) => this.handleData(data));
    this.writeWelcome();
    this.drawPrompt();
  }

  dispose(): void {
    this.disposed = true;
  }

  // ---- 服务端帧渲染 ----

  handleFrame(frame: ServerFrame): void {
    if (this.disposed) return;
    switch (frame.type) {
      case 'session_ready':
        this.printLine(`${DIM}[已连接]${RESET}`);
        break;
      case 'delta':
        this.busy = true;
        // delta 文本原样输出（\n → \r\n）
        this.term.write(frame.text.replace(/\n/g, '\r\n'));
        break;
      case 'turn_complete':
        this.busy = false;
        if (frame.replayed && frame.assistant_text) {
          this.printLine(`${DIM}[补发轮次 ${frame.turn_index}]${RESET}`);
          this.printLine(frame.assistant_text);
        }
        if (frame.interrupted) {
          this.printLine(`${YELLOW}[轮次已中断]${RESET}`);
        }
        this.term.write('\r\n');
        this.drawPrompt();
        break;
      case 'tool_start':
        this.printLine(`${CYAN}⚙ ${frame.tool_name ?? 'tool'}${RESET} ${DIM}running…${RESET}`);
        break;
      case 'tool_end':
        this.printLine(
          frame.is_error
            ? `${RED}✗ ${frame.tool_name ?? 'tool'} failed${RESET}`
            : `${GREEN}✓ ${frame.tool_name ?? 'tool'} done${RESET}`,
        );
        break;
      case 'todo':
        if (frame.todo_markdown) {
          this.printLine(`${MAGENTA}[TODO]${RESET}`);
          this.printLine(`${DIM}${frame.todo_markdown}${RESET}`);
        }
        break;
      case 'approval_request':
        this.printLine(`${YELLOW}[审批请求] 请在弹窗中处理${RESET}`);
        break;
      case 'busy':
        this.printLine(`${YELLOW}[忙碌] 当前有轮次正在执行${RESET}`);
        break;
      case 'error':
      case 'turn_error':
        this.busy = false;
        this.printLine(`${RED}[错误] ${frame.message}${RESET}`);
        this.drawPrompt();
        break;
      case 'pong':
      case 'event':
        break;
    }
  }

  notifyClose(code: number): void {
    const message = WS_CLOSE_MESSAGES[code] ?? `连接已断开（${code}）`;
    this.printLine(`${RED}[连接] ${message}${RESET}`);
  }

  /** Shift+Enter：插入续行（由 XtermContainer 的自定义键处理器调用）。 */
  insertNewline(): void {
    this.lines.push('');
    this.term.write(`\r\n${CONTINUATION}`);
  }

  // ---- 输入处理（task 9.6）----

  private handleData(data: string): void {
    if (this.disposed) return;
    switch (data) {
      case '\x03': // Ctrl+C
        this.cb.interrupt();
        this.term.write('^C\r\n');
        this.resetInput();
        this.drawPrompt();
        return;
      case '\x1b': // Escape
        if (this.busy) this.cb.interrupt();
        return;
      case '\r': // Enter → 提交
        this.submitInput();
        return;
      case '\x7f': // Backspace
        this.backspace();
        return;
      case '\x1b[A': // ArrowUp
        this.navigateHistory(-1);
        return;
      case '\x1b[B': // ArrowDown
        this.navigateHistory(1);
        return;
      case '\t': // Tab → `/` 命令补全
        this.completeSlashCommand();
        return;
      default:
        break;
    }
    // 忽略其他控制序列（左右箭头等暂不支持行内编辑）
    if (data.startsWith('\x1b')) return;
    // 可打印字符 / 粘贴文本
    const clean = data.replace(/\r\n?/g, '\n');
    const parts = clean.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) this.insertNewline();
      this.lines[this.lines.length - 1] += parts[i];
      this.term.write(parts[i]);
    }
  }

  private submitInput(): void {
    const text = this.lines.join('\n').trim();
    this.term.write('\r\n');
    this.resetInput();
    if (!text) {
      this.drawPrompt();
      return;
    }
    if (text.startsWith('/') && this.cb.onLocalCommand?.(text)) {
      this.history.push(text);
      this.drawPrompt();
      return;
    }
    if (this.busy) {
      this.printLine(`${YELLOW}[忙碌] 轮次执行中，Ctrl+C 可中断${RESET}`);
      this.drawPrompt();
      return;
    }
    this.history.push(text);
    this.historyIndex = -1;
    if (this.cb.submit(text)) {
      this.busy = true;
      this.printLine(`${DIM}[已提交]${RESET}`);
    } else {
      this.printLine(`${RED}[发送失败] 连接未就绪${RESET}`);
      this.drawPrompt();
    }
  }

  private backspace(): void {
    const current = this.lines[this.lines.length - 1];
    if (current.length === 0) return; // 不允许跨行删除
    this.lines[this.lines.length - 1] = current.slice(0, -1);
    this.term.write('\b \b');
  }

  private navigateHistory(delta: number): void {
    if (this.lines.length > 1) return; // 多行输入时禁用历史
    if (this.history.length === 0) return;
    if (delta < 0) {
      if (this.historyIndex === -1) {
        this.draftBeforeHistory = this.lines[0];
        this.historyIndex = this.history.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      }
      this.replaceInput(this.history[this.historyIndex]);
    } else if (this.historyIndex !== -1) {
      if (this.historyIndex >= this.history.length - 1) {
        this.historyIndex = -1;
        this.replaceInput(this.draftBeforeHistory);
      } else {
        this.historyIndex += 1;
        this.replaceInput(this.history[this.historyIndex]);
      }
    }
  }

  private completeSlashCommand(): void {
    const current = this.lines[this.lines.length - 1];
    if (!current.startsWith('/')) return;
    const match = SLASH_COMMANDS.find((c) => c.command.startsWith(current));
    if (match) this.replaceInput(match.command);
  }

  private replaceInput(text: string): void {
    // 清除当前输入行并重写
    const current = this.lines[this.lines.length - 1];
    this.term.write('\b \b'.repeat(current.length));
    this.lines = [text];
    this.term.write(text);
  }

  private resetInput(): void {
    this.lines = [''];
    this.historyIndex = -1;
  }

  private printLine(text: string): void {
    this.term.write(`\r\n${text.replace(/\n/g, '\r\n')}\r\n`);
  }

  private drawPrompt(): void {
    this.term.write(PROMPT);
  }

  private writeWelcome(): void {
    this.term.write(
      `${BOLD}Session Terminal${RESET}\r\n` +
        `${DIM}Enter 发送 · Shift+Enter 换行 · Ctrl+C/Esc 中断 · ↑↓ 历史 · Tab 补全 /命令${RESET}\r\n\r\n`,
    );
  }
}
