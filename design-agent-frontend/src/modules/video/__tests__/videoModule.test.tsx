// 视频模块单测（tasks 4.6）：模型切换双通道工具、产物轮次派生、
// 播放器时间格式化、ModelSelector 组件交互（通道②受理/拒绝、禁用态）。

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../../store/uiStore';
import type { AssistantMessage, Message } from '../../../types/conversation';
import { modelSwitchCommand, withModelArg } from '../../../utils/model';
import { CONTROLS_HIDE_DELAY_MS, SPEED_OPTIONS, formatPlayerTime } from '../playerFormat';
import { ModelSelector } from '../ModelSelector';
import { extractArtifactTurns } from '../videoArtifacts';

describe('withModelArg（通道①：建会话注入 --model）', () => {
  it('model 非空时追加 --model <name>，且不修改原数组', () => {
    const args = ['--verbose'];
    expect(withModelArg(args, 'sonnet')).toEqual(['--verbose', '--model', 'sonnet']);
    expect(args).toEqual(['--verbose']);
  });

  it('model 为 null 时原样返回', () => {
    const args = ['--verbose'];
    expect(withModelArg(args, null)).toBe(args);
  });

  it('用户已手写 --model 时以用户输入优先，不重复注入', () => {
    const args = ['--model', 'opus'];
    expect(withModelArg(args, 'sonnet')).toBe(args);
  });

  it('空 args + 选中模型 → 只含 --model 对', () => {
    expect(withModelArg([], 'haiku')).toEqual(['--model', 'haiku']);
  });
});

describe('modelSwitchCommand（通道②：运行时 /model 命令）', () => {
  it('返回 /model <name>', () => {
    expect(modelSwitchCommand('sonnet')).toBe('/model sonnet');
    expect(modelSwitchCommand('opus')).toBe('/model opus');
  });
});

function assistantMsg(partial: Partial<AssistantMessage> & { turnIndex: number }): Message {
  return {
    id: `a-${partial.turnIndex}-${Math.random()}`,
    kind: 'assistant',
    text: 'done',
    streaming: false,
    hasArtifact: false,
    createdAt: 0,
    ...partial,
  };
}

describe('extractArtifactTurns（产物轮次派生）', () => {
  it('只统计已完成且携带产物的 assistant 消息，升序去重', () => {
    const messages: Message[] = [
      { id: 'u1', kind: 'user', text: 'hi', turnIndex: 0, createdAt: 0 },
      assistantMsg({ turnIndex: 2, hasArtifact: true }),
      assistantMsg({ turnIndex: 0, hasArtifact: true }),
      assistantMsg({ turnIndex: 0, hasArtifact: true }), // 重复轮次
      assistantMsg({ turnIndex: 1, hasArtifact: false }), // 无产物
    ];
    expect(extractArtifactTurns(messages)).toEqual([0, 2]);
  });

  it('跳过 streaming 中与 turnIndex<0 的消息', () => {
    const messages: Message[] = [
      assistantMsg({ turnIndex: 3, hasArtifact: true, streaming: true }),
      assistantMsg({ turnIndex: -1, hasArtifact: true }),
    ];
    expect(extractArtifactTurns(messages)).toEqual([]);
  });

  it('空列表返回空数组', () => {
    expect(extractArtifactTurns([])).toEqual([]);
  });
});

describe('formatPlayerTime（mm:ss 显示）', () => {
  it('常规取整与补零', () => {
    expect(formatPlayerTime(0)).toBe('0:00');
    expect(formatPlayerTime(5.9)).toBe('0:05');
    expect(formatPlayerTime(75)).toBe('1:15');
  });

  it('分钟可超 60 不进位小时（与 demo 一致）', () => {
    expect(formatPlayerTime(3675)).toBe('61:15');
  });

  it('NaN/Infinity/负数兜底 0:00', () => {
    expect(formatPlayerTime(Number.NaN)).toBe('0:00');
    expect(formatPlayerTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatPlayerTime(-3)).toBe('0:00');
  });
});

describe('播放器常量', () => {
  it('倍速档位 0.5x–2x、自动隐藏 3s（demo 同款）', () => {
    expect(SPEED_OPTIONS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
    expect(CONTROLS_HIDE_DELAY_MS).toBe(3000);
  });
});

describe('ModelSelector 组件', () => {
  beforeEach(() => {
    useUiStore.setState({ selectedModel: null });
  });

  function trigger(): HTMLButtonElement {
    return screen.getByLabelText('模型切换');
  }

  it('点开下拉选择 Sonnet：onRuntimeSwitch 受理后更新 uiStore', () => {
    const onRuntimeSwitch = vi.fn().mockReturnValue(true);
    render(<ModelSelector disabled={false} onRuntimeSwitch={onRuntimeSwitch} />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Sonnet/ }));

    expect(onRuntimeSwitch).toHaveBeenCalledWith('sonnet');
    expect(useUiStore.getState().selectedModel).toBe('sonnet');
  });

  it('onRuntimeSwitch 未受理（返回 false）时不更新显示态', () => {
    const onRuntimeSwitch = vi.fn().mockReturnValue(false);
    render(<ModelSelector disabled={false} onRuntimeSwitch={onRuntimeSwitch} />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Opus/ }));

    expect(onRuntimeSwitch).toHaveBeenCalledWith('opus');
    expect(useUiStore.getState().selectedModel).toBeNull();
  });

  it('无 onRuntimeSwitch（未选中会话）时仅本地持久化', () => {
    render(<ModelSelector disabled={false} />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Haiku/ }));

    expect(useUiStore.getState().selectedModel).toBe('haiku');
  });

  it('切回「默认模型」不经运行时通道，直接落库为 null', () => {
    useUiStore.setState({ selectedModel: 'sonnet' });
    const onRuntimeSwitch = vi.fn().mockReturnValue(true);
    render(<ModelSelector disabled={false} onRuntimeSwitch={onRuntimeSwitch} />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /默认模型/ }));

    expect(onRuntimeSwitch).not.toHaveBeenCalled();
    expect(useUiStore.getState().selectedModel).toBeNull();
  });

  it('选中同一模型不触发任何副作用', () => {
    useUiStore.setState({ selectedModel: 'sonnet' });
    const onRuntimeSwitch = vi.fn().mockReturnValue(true);
    render(<ModelSelector disabled={false} onRuntimeSwitch={onRuntimeSwitch} />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Sonnet/ }));

    expect(onRuntimeSwitch).not.toHaveBeenCalled();
    expect(useUiStore.getState().selectedModel).toBe('sonnet');
  });

  it('disabled（busy/只读）时入口禁用', () => {
    render(<ModelSelector disabled />);
    expect(trigger()).toBeDisabled();
  });

  it('按钮文案跟随选中模型', () => {
    useUiStore.setState({ selectedModel: 'opus' });
    render(<ModelSelector disabled={false} />);
    expect(trigger().textContent).toContain('Opus');
  });
});
