// OpenHarness 主 agent 模型切换（spec design-agent-video：双通道）。
// 候选列表由前端常量维护（对齐 OpenHarness CLAUDE_MODEL_ALIAS_OPTIONS 中
// 可通过 extra_oh_args 白名单校验的别名；[1m] 变体含 shell 元字符被排除）。

export interface ModelOption {
  /** oh --model 的 alias 或完整模型 ID；null 表示后端默认。 */
  value: string | null;
  label: string;
  description: string;
}

export const DEFAULT_MODEL_LABEL = '默认模型';

export const OH_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: null, label: DEFAULT_MODEL_LABEL, description: '使用后端配置的默认模型' },
  { value: 'sonnet', label: 'Sonnet', description: '日常编码与生成任务' },
  { value: 'opus', label: 'Opus', description: '复杂推理与长流程任务' },
  { value: 'haiku', label: 'Haiku', description: '最快响应速度' },
];

/**
 * 通道①（建会话）：向 extra_oh_args 注入 `--model <name>`。
 * 用户已在高级参数中手写 --model 时以用户输入优先，不重复注入。
 */
export function withModelArg(args: string[], model: string | null): string[] {
  if (!model || args.includes('--model')) return args;
  return [...args, '--model', model];
}

/** 通道②（运行时切模）：经 WS submit 提交的斜杠命令文本。 */
export function modelSwitchCommand(model: string): string {
  return `/model ${model}`;
}
