// `/` 命令统一分发表（D3）：Chat / Terminal 双视图共享同一命令定义，
// 视图差异（清屏方式、帮助输出位置等）通过 SlashCommandContext 注入；
// 补全候选 SLASH_COMMANDS 由同一张表生成，避免两处定义漂移。

import type { AppMode } from '../store/uiStore';

/** 视图注入的命令执行上下文（差异项）。 */
export interface SlashCommandContext {
  interrupt: () => void;
  /** 清空当前视图：Chat 清消息列表；Terminal 清屏。 */
  clearView: () => void;
  openSettings: () => void;
  setMode: (mode: AppMode) => void;
  requestClose: () => void;
  /** 展示帮助文本：Chat 写系统消息；Terminal 直接打印。 */
  showHelp: (text: string) => void;
}

interface SlashCommandDef {
  command: string;
  description: string;
  run: (ctx: SlashCommandContext) => void;
}

const COMMAND_DEFS: readonly SlashCommandDef[] = [
  { command: '/interrupt', description: '中断当前轮次', run: (ctx) => ctx.interrupt() },
  { command: '/clear', description: '清空当前对话视图（仅本地）', run: (ctx) => ctx.clearView() },
  { command: '/theme', description: '打开主题选择器', run: (ctx) => ctx.openSettings() },
  { command: '/terminal', description: '切换到 Terminal Mode', run: (ctx) => ctx.setMode('terminal') },
  { command: '/chat', description: '切换到 Chat Mode', run: (ctx) => ctx.setMode('chat') },
  { command: '/close', description: '关闭当前会话', run: (ctx) => ctx.requestClose() },
  { command: '/help', description: '显示可用命令', run: (ctx) => ctx.showHelp(slashHelpText()) },
];

/** `/` 命令补全候选（与分发表同源生成）。 */
export const SLASH_COMMANDS: readonly { command: string; description: string }[] =
  COMMAND_DEFS.map(({ command, description }) => ({ command, description }));

/** /help 的帮助文本（两个视图一致）。 */
export function slashHelpText(): string {
  return `可用命令：${COMMAND_DEFS.map((c) => `${c.command}（${c.description}）`).join('、')}`;
}

/**
 * 分发一条 `/` 命令；返回 true 表示已本地消费。
 * 未知命令返回 false，由调用方决定回退行为（按普通文本发送）。
 */
export function dispatchSlashCommand(text: string, ctx: SlashCommandContext): boolean {
  const [command] = text.split(/\s+/);
  const def = COMMAND_DEFS.find((c) => c.command === command);
  if (!def) return false;
  def.run(ctx);
  return true;
}
