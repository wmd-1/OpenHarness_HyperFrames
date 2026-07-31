// `/` 命令统一分发表测试（D3）。

import { describe, expect, it, vi } from 'vitest';
import {
  SLASH_COMMANDS,
  dispatchSlashCommand,
  slashHelpText,
  type SlashCommandContext,
} from '../slashCommands';

function makeCtx(): SlashCommandContext {
  return {
    interrupt: vi.fn(),
    clearView: vi.fn(),
    openSettings: vi.fn(),
    setMode: vi.fn(),
    requestClose: vi.fn(),
    showHelp: vi.fn(),
  };
}

describe('dispatchSlashCommand', () => {
  it('已知命令分发到对应上下文回调', () => {
    const ctx = makeCtx();
    expect(dispatchSlashCommand('/interrupt', ctx)).toBe(true);
    expect(ctx.interrupt).toHaveBeenCalledOnce();
    expect(dispatchSlashCommand('/clear', ctx)).toBe(true);
    expect(ctx.clearView).toHaveBeenCalledOnce();
    expect(dispatchSlashCommand('/theme', ctx)).toBe(true);
    expect(ctx.openSettings).toHaveBeenCalledOnce();
    expect(dispatchSlashCommand('/close', ctx)).toBe(true);
    expect(ctx.requestClose).toHaveBeenCalledOnce();
  });

  it('/terminal 与 /chat 切换模式', () => {
    const ctx = makeCtx();
    dispatchSlashCommand('/terminal', ctx);
    expect(ctx.setMode).toHaveBeenLastCalledWith('terminal');
    dispatchSlashCommand('/chat', ctx);
    expect(ctx.setMode).toHaveBeenLastCalledWith('chat');
  });

  it('/help 用同一份帮助文本（双视图一致）', () => {
    const ctx = makeCtx();
    expect(dispatchSlashCommand('/help', ctx)).toBe(true);
    expect(ctx.showHelp).toHaveBeenCalledWith(slashHelpText());
    expect(slashHelpText()).toContain('/interrupt');
    expect(slashHelpText()).toContain('/help');
  });

  it('未知命令返回 false 且不触碰任何回调', () => {
    const ctx = makeCtx();
    expect(dispatchSlashCommand('/unknown', ctx)).toBe(false);
    for (const fn of Object.values(ctx)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('命令后附带参数仍能匹配（按首个 token 分发）', () => {
    const ctx = makeCtx();
    expect(dispatchSlashCommand('/clear now', ctx)).toBe(true);
    expect(ctx.clearView).toHaveBeenCalledOnce();
  });
});

describe('SLASH_COMMANDS', () => {
  it('补全候选与分发表同源：每个候选都能被分发', () => {
    for (const { command } of SLASH_COMMANDS) {
      expect(dispatchSlashCommand(command, makeCtx())).toBe(true);
    }
  });

  it('包含全部 7 个命令且描述非空', () => {
    expect(SLASH_COMMANDS).toHaveLength(7);
    for (const { description } of SLASH_COMMANDS) {
      expect(description.length).toBeGreaterThan(0);
    }
  });
});
