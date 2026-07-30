// TerminalBridge 单测（task 4.5 F1）：单行/多行提交、历史导航、
// Tab 补全、replaceInput 重绘。A11 多行 Tab 缺陷已在 task 5.2 修复；
// 历史已改为共享 getter 回调（task 5.9 D4）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { TerminalBridge, type TerminalBridgeCallbacks } from '../TerminalBridge';

/** 最小 xterm Terminal 桩：记录输出、可注入按键数据。 */
class FakeTerminal {
  written = '';
  private dataHandler: ((data: string) => void) | null = null;

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return { dispose: () => undefined };
  }

  write(data: string): void {
    this.written += data;
  }

  clear(): void {
    this.written = '';
  }

  /** 模拟用户按键输入。 */
  input(data: string): void {
    this.dataHandler?.(data);
  }

  /** 逐字符输入可打印文本。 */
  type(text: string): void {
    for (const ch of text) this.input(ch);
  }
}

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';

describe('TerminalBridge', () => {
  let term: FakeTerminal;
  /** 共享输入历史桩（D4：bridge 通过 getter/pusher 访问，不再内部副本）。 */
  let history: string[];
  let cb: {
    submit: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    onLocalCommand: ReturnType<typeof vi.fn>;
    getHistory: () => readonly string[];
    pushHistory: (text: string) => void;
  };

  function createBridge(initialHistory: string[] = []): TerminalBridge {
    history = [...initialHistory];
    return new TerminalBridge(term as unknown as Terminal, cb as unknown as TerminalBridgeCallbacks);
  }

  beforeEach(() => {
    term = new FakeTerminal();
    history = [];
    cb = {
      submit: vi.fn(() => true),
      interrupt: vi.fn(() => true),
      onLocalCommand: vi.fn(() => false),
      getHistory: () => history,
      // 仿 store.pushInputHistory 的相邻去重
      pushHistory: (text: string) => {
        if (history[history.length - 1] !== text) history.push(text);
      },
    };
  });

  it('单行输入 Enter 提交并回显已提交', () => {
    createBridge();
    term.type('hello');
    term.input('\r');
    expect(cb.submit).toHaveBeenCalledWith('hello');
    expect(term.written).toContain('[已提交]');
  });

  it('空输入 Enter 不提交', () => {
    createBridge();
    term.input('\r');
    expect(cb.submit).not.toHaveBeenCalled();
  });

  it('多行输入（Shift+Enter 续行）以 \\n 连接提交', () => {
    const bridge = createBridge();
    term.type('line1');
    bridge.insertNewline();
    term.type('line2');
    term.input('\r');
    expect(cb.submit).toHaveBeenCalledWith('line1\nline2');
  });

  it('/ 命令被 onLocalCommand 消费后不走 submit', () => {
    cb.onLocalCommand.mockReturnValue(true);
    createBridge();
    term.type('/clear');
    term.input('\r');
    expect(cb.onLocalCommand).toHaveBeenCalledWith('/clear');
    expect(cb.submit).not.toHaveBeenCalled();
  });

  it('历史导航：上箭头逐条回溯，下箭头恢复草稿（replaceInput）', () => {
    const bridge = createBridge(['first', 'second']);
    term.type('draft');
    term.input(ARROW_UP); // → second
    term.input(ARROW_UP); // → first
    term.input(ARROW_DOWN); // → second
    term.input('\r');
    expect(cb.submit).toHaveBeenCalledWith('second');

    // 轮次完成解除 busy 后，再下箭头恢复草稿
    bridge.handleFrame({ type: 'turn_complete', turn_index: 0 });
    term.type('draft2');
    term.input(ARROW_UP); // → 最新一条
    term.input(ARROW_DOWN); // → 恢复草稿
    term.input('\r');
    expect(cb.submit).toHaveBeenLastCalledWith('draft2');
  });

  it('多行输入时禁用历史导航', () => {
    const bridge = createBridge(['prev']);
    term.type('a');
    bridge.insertNewline();
    term.type('b');
    term.input(ARROW_UP); // 多行状态：应无效果
    term.input('\r');
    expect(cb.submit).toHaveBeenCalledWith('a\nb');
  });

  it('Tab 补全：单行 / 前缀补全为完整命令', () => {
    cb.onLocalCommand.mockReturnValue(true);
    createBridge();
    term.type('/th');
    term.input('\t');
    term.input('\r');
    expect(cb.onLocalCommand).toHaveBeenCalledWith('/theme');
  });

  it('replaceInput 重绘：历史回溯时退格清除旧输入再写新文本', () => {
    createBridge(['history-item']);
    term.type('abc');
    term.clear();
    term.input(ARROW_UP);
    // 3 个字符 → 3 组 '\b \b' 擦除，再写入历史条目
    expect(term.written).toBe('\b \b'.repeat(3) + 'history-item');
  });

  // A11 修复验证：多行状态下 Tab 补全无效果，先前行内容保留。
  it('多行输入时禁用 Tab 补全（A11）', () => {
    const bridge = createBridge();
    term.type('context line');
    bridge.insertNewline();
    term.type('/th');
    term.input('\t'); // 多行状态：应无效果
    term.input('\r');
    expect(cb.submit).toHaveBeenCalledWith('context line\n/th');
  });

  // P0-1：final full_text 最终覆盖——终端不忽略 full_text，按 turnBuf 前缀判定补齐/重放
  describe('final full_text 替换（P0-1）', () => {
    it('无丢帧：turnBuf 等于全文，final 帧零重复输出', () => {
      const bridge = createBridge();
      bridge.handleFrame({ type: 'delta', text: 'Hello world', turn_index: 0 });
      term.clear();
      bridge.handleFrame({
        type: 'delta',
        text: '',
        turn_index: 0,
        final: true,
        full_text: 'Hello world',
      });
      expect(term.written).toBe('');
    });

    it('丢帧：turnBuf 是全文前缀，只补写缺失尾部', () => {
      const bridge = createBridge();
      bridge.handleFrame({ type: 'delta', text: 'Hello ', turn_index: 0 });
      term.clear();
      bridge.handleFrame({
        type: 'delta',
        text: '',
        turn_index: 0,
        final: true,
        full_text: 'Hello world',
      });
      expect(term.written).toBe('world');
      expect(term.written).not.toContain('[resync]');
    });

    it('乱序/不一致：非前缀时 [resync] 标注后重放全文', () => {
      const bridge = createBridge();
      bridge.handleFrame({ type: 'delta', text: 'wrong chunk', turn_index: 0 });
      term.clear();
      bridge.handleFrame({
        type: 'delta',
        text: '',
        turn_index: 0,
        final: true,
        full_text: 'Hello world',
      });
      expect(term.written).toContain('[resync]');
      expect(term.written).toContain('Hello world');
    });

    it('final 后 turnBuf 重置：下一轮独立判定', () => {
      const bridge = createBridge();
      bridge.handleFrame({ type: 'delta', text: 'turn0', turn_index: 0 });
      bridge.handleFrame({ type: 'delta', text: '', turn_index: 0, final: true, full_text: 'turn0' });
      bridge.handleFrame({ type: 'turn_complete', turn_index: 0 });
      bridge.handleFrame({ type: 'delta', text: 'turn1', turn_index: 1 });
      term.clear();
      bridge.handleFrame({ type: 'delta', text: '', turn_index: 1, final: true, full_text: 'turn1' });
      // 上一轮的 turnBuf 已清空，本轮前缀匹配且无缺失尾部
      expect(term.written).toBe('');
    });

    it('旧后端 final 无 full_text：维持追加行为不变', () => {
      const bridge = createBridge();
      bridge.handleFrame({ type: 'delta', text: 'partial ', turn_index: 0 });
      term.clear();
      bridge.handleFrame({ type: 'delta', text: 'reply', turn_index: 0, final: true });
      expect(term.written).toBe('reply');
    });
  });
});
