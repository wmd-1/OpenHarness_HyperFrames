// WS 事件 → xterm 终端输出桥接（task 9.3）+ 行编辑与快捷键（task 9.6）：
// - delta → 原样文本；tool_start/tool_end → 彩色一行摘要；turn_complete → 提示符
// - Ctrl+C / Escape → 中断；上下箭头 → 历史；Tab → `/` 命令补全；
//   Shift+Enter → 换行续行（在 XtermContainer 用 attachCustomKeyEventHandler 转发）

import type { Terminal } from '@xterm/xterm';
import type { ServerFrame } from '../../types/ws';
import { WS_CLOSE_MESSAGES } from '../../utils/constants';
import { SLASH_COMMANDS } from '../../utils/slashCommands';
import { sanitizeAnsi } from '../../utils/sanitize';

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
  /** 共享输入历史 getter：始终读 store 最新值，不在 bridge 内部副本化（D4）。 */
  getHistory: () => readonly string[];
  /** 提交/本地命令统一写入共享历史（store 负责相邻去重与上限）。 */
  pushHistory: (text: string) => void;
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
  private historyIndex = -1;
  private draftBeforeHistory = '';
  /** 轮次执行中（禁用输入提交，仅允许 Ctrl+C/Escape）。 */
  private busy = false;
  /** 本轮已写入终端的 delta 累计文本（final full_text 补齐/重放判定用，P0-1）。 */
  private turnBuf = '';
  private disposed = false;

  constructor(term: Terminal, cb: TerminalBridgeCallbacks) {
    this.term = term;
    this.cb = cb;
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
        if (frame.final && frame.full_text != null) {
          // 最终覆盖 envelope：不能忽略 full_text，否则 WS 丢帧会让终端内容缺尾
          if (frame.full_text.startsWith(this.turnBuf)) {
            // 已写内容是全文前缀：只补写缺失尾部（无丢帧时尾部为空，零重复）
            const missing = frame.full_text.slice(this.turnBuf.length);
            if (missing) this.term.write(sanitizeAnsi(missing).replace(/\n/g, '\r\n'));
          } else {
            // 乱序/不一致：xterm 无法回擦滚动区，标注后重放全文（确定性纠正）
            this.printLine(`${DIM}[resync]${RESET}`);
            this.term.write(sanitizeAnsi(frame.full_text).replace(/\n/g, '\r\n'));
          }
          this.turnBuf = '';
        } else {
          // delta 文本剥离危险控制序列后输出（B2），\n → \r\n
          this.turnBuf += frame.text;
          this.term.write(sanitizeAnsi(frame.text).replace(/\n/g, '\r\n'));
        }
        break;
      case 'turn_complete':
        this.busy = false;
        this.turnBuf = '';
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
        this.turnBuf = '';
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
      this.cb.pushHistory(text);
      this.drawPrompt();
      return;
    }
    if (this.busy) {
      this.printLine(`${YELLOW}[忙碌] 轮次执行中，Ctrl+C 可中断${RESET}`);
      this.drawPrompt();
      return;
    }
    // 提前写入历史：即使发送失败也可上箭头找回；提交成功时 store 相邻去重（D4）
    this.cb.pushHistory(text);
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
    const history = this.cb.getHistory();
    if (history.length === 0) return;
    if (delta < 0) {
      if (this.historyIndex === -1) {
        this.draftBeforeHistory = this.lines[0];
        this.historyIndex = history.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      }
      this.replaceInput(history[this.historyIndex]);
    } else if (this.historyIndex !== -1) {
      if (this.historyIndex >= history.length - 1) {
        this.historyIndex = -1;
        this.replaceInput(this.draftBeforeHistory);
      } else {
        this.historyIndex += 1;
        this.replaceInput(history[this.historyIndex]);
      }
    }
  }

  private completeSlashCommand(): void {
    if (this.lines.length > 1) return; // 多行输入时禁用补全，避免 replaceInput 折叠先前行（A11）
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
    // 帧文本可能携带服务端控制序列，写入前统一清理（自身 SGR 样式会保留，B2）
    this.term.write(`\r\n${sanitizeAnsi(text).replace(/\n/g, '\r\n')}\r\n`);
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
