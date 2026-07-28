// InputBar 键盘状态机测试（F5）：Enter 提交/Shift+Enter 换行、
// `/` 补全导航（上下箭头 + Tab/Enter 补全）、历史导航与草稿恢复、中断按钮。

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputBar } from '../InputBar';
import { SLASH_COMMANDS } from '../../../utils/slashCommands';

const onSubmit = vi.fn<(text: string) => boolean>();
const onInterrupt = vi.fn();

function renderBar(props: Partial<Parameters<typeof InputBar>[0]> = {}) {
  return render(
    <InputBar
      disabled={false}
      turnActive={false}
      history={[]}
      onSubmit={onSubmit}
      onInterrupt={onInterrupt}
      {...props}
    />,
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText('消息输入');
}

function type(value: string) {
  fireEvent.change(textarea(), { target: { value } });
}

beforeEach(() => {
  onSubmit.mockReset().mockReturnValue(true);
  onInterrupt.mockReset();
});

describe('InputBar 提交行为', () => {
  it('Enter 提交 trim 后文本，onSubmit 返回 true 时清空输入', () => {
    renderBar();
    type('  hello  ');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(textarea().value).toBe('');
  });

  it('onSubmit 返回 false 时保留输入（发送失败可重试）', () => {
    onSubmit.mockReturnValue(false);
    renderBar();
    type('hello');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(textarea().value).toBe('hello');
  });

  it('Shift+Enter 不提交（换行）', () => {
    renderBar();
    type('hello');
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('空白文本不提交', () => {
    renderBar();
    type('   ');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('InputBar `/` 命令补全', () => {
  it('输入 `/` 展示全部候选，含空格后隐藏', () => {
    renderBar();
    type('/');
    const listbox = screen.getByRole('listbox', { name: '命令补全' });
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(SLASH_COMMANDS.length);
    type('/clear now');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('上下箭头循环选中候选，Tab 补全为选中命令', () => {
    renderBar();
    type('/c'); // 匹配 /clear、/chat、/close
    const options = () => screen.getAllByRole('option');
    expect(options()).toHaveLength(3);
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    // ArrowUp 回绕
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    expect(options()[2]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(textarea(), { key: 'Tab' });
    expect(textarea().value).toBe('/close');
  });

  it('有候选且文本未补全时 Enter 先补全不提交，再 Enter 才提交', () => {
    renderBar();
    type('/cle');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea().value).toBe('/clear');

    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('/clear');
  });
});

describe('InputBar 历史导航', () => {
  const history = ['first', 'second', 'third'];

  it('ArrowUp 从最新历史开始回溯，ArrowDown 返回并恢复草稿', () => {
    renderBar({ history });
    type('draft');
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    expect(textarea().value).toBe('third');
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    expect(textarea().value).toBe('second');

    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
    expect(textarea().value).toBe('third');
    // 越过最新一条 → 恢复进入历史前的草稿
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
    expect(textarea().value).toBe('draft');
  });

  it('回溯到最早一条后 ArrowUp 停留不越界', () => {
    renderBar({ history });
    for (let i = 0; i < 5; i += 1) {
      fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    }
    expect(textarea().value).toBe('first');
  });

  it('提交历史中的条目后清空并退出历史导航', () => {
    renderBar({ history });
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('third');
    expect(textarea().value).toBe('');
  });
});

describe('InputBar 中断按钮', () => {
  it('turnActive 时显示中断按钮并触发 onInterrupt', () => {
    renderBar({ turnActive: true });
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '中断当前轮次' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('非执行中显示发送按钮，空文本时禁用', () => {
    renderBar();
    const sendBtn = screen.getByRole('button', { name: '发送' });
    expect(sendBtn).toBeDisabled();
    type('hi');
    expect(sendBtn).toBeEnabled();
    fireEvent.click(sendBtn);
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });
});
