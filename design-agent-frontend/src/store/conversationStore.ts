// 对话状态：按会话维度存放消息列表、轮次状态、TODO、待处理审批。
// 流式 delta 的批量 flush 缓冲由 ws/useWebSocket 的 StreamBuffer 处理，
// flush 时调用这里的 appendAssistantText。

import { create } from 'zustand';
import type { TurnResponse } from '../types/api';
import type { ApprovalRequestFrame } from '../types/ws';
import type { Message, ToolCall } from '../types/conversation';

/** 待处理审批：附首次收到时刻，供倒计时基准（A7）。 */
export type PendingApproval = ApprovalRequestFrame & { receivedAt: number };

export interface ConversationState {
  messages: Message[];
  /** 当前是否有轮次执行中（禁用/启用输入栏）。 */
  turnActive: boolean;
  todoMarkdown: string;
  pendingApproval: PendingApproval | null;
  /** 输入历史（上下箭头导航，chat 与 terminal 共享）。 */
  inputHistory: string[];
  /** 历史回显完成时刻（F2.1：切走再切回不重复拉）；null 表示未 hydrate 过。 */
  hydratedAt: number | null;
}

const emptyConversation = (): ConversationState => ({
  messages: [],
  turnActive: false,
  todoMarkdown: '',
  pendingApproval: null,
  inputHistory: [],
  hydratedAt: null,
});

let messageSeq = 0;
const nextMessageId = () => `m${Date.now().toString(36)}-${++messageSeq}`;

interface ConversationStoreState {
  /** session_id -> ConversationState */
  conversations: Record<string, ConversationState>;
  addUserMessage: (sid: string, text: string) => void;
  /** 追加流式文本到当前轮次的助手消息（无则创建）。 */
  appendAssistantText: (sid: string, turnIndex: number, text: string) => void;
  /** 用权威全文整体替换当前轮次助手消息（assistant_complete 覆盖语义，P0-1）。 */
  replaceAssistantText: (sid: string, turnIndex: number, text: string) => void;
  /** 轮次完成：结束流式状态；replayed 补发时若无消息则用 assistant_text 创建。 */
  completeTurn: (
    sid: string,
    turnIndex: number,
    opts?: { interrupted?: boolean; replayedText?: string | null; hasArtifact?: boolean },
  ) => void;
  addToolStart: (sid: string, turnIndex: number, toolName: string, input: Record<string, unknown> | null) => void;
  addToolEnd: (sid: string, turnIndex: number, toolName: string, output: string | null, isError: boolean) => void;
  setTodo: (sid: string, markdown: string) => void;
  setPendingApproval: (sid: string, frame: ApprovalRequestFrame | null) => void;
  addSystemMessage: (sid: string, level: 'info' | 'warning' | 'error', text: string) => void;
  /** 轮次历史回显（F2.3）：整体替换 messages（前提本地为空）并打 hydratedAt 标记。 */
  hydrateHistory: (sid: string, turns: TurnResponse[]) => void;
  setTurnActive: (sid: string, active: boolean) => void;
  pushInputHistory: (sid: string, text: string) => void;
  clearMessages: (sid: string) => void;
  removeConversation: (sid: string) => void;
}

function withConversation(
  state: ConversationStoreState,
  sid: string,
  mutate: (conv: ConversationState) => ConversationState,
): Pick<ConversationStoreState, 'conversations'> {
  const conv = state.conversations[sid] ?? emptyConversation();
  return { conversations: { ...state.conversations, [sid]: mutate(conv) } };
}

export const useConversationStore = create<ConversationStoreState>((set) => ({
  conversations: {},

  addUserMessage: (sid, text) =>
    set((state) =>
      withConversation(state, sid, (conv) => ({
        ...conv,
        turnActive: true,
        messages: [
          ...conv.messages,
          {
            kind: 'user',
            id: nextMessageId(),
            text,
            turnIndex: -1,
            createdAt: Date.now(),
          },
        ],
      })),
    ),

  // TODO(C3, won't-fix-now): 每次 flush 复制全量消息数组 + 尾部线性扫描，
  // 消息数千条时 O(n)×20 次/秒；虚拟滚动已隔离渲染成本，当前量级无感知。
  // 若未来支持超长会话，可把「流式中的最后一条助手消息」拆到独立字段，
  // 完成时再并入 messages。详见 CODE_REVIEW_REPORT.md C3。
  appendAssistantText: (sid, turnIndex, text) =>
    set((state) =>
      withConversation(state, sid, (conv) => {
        const messages = [...conv.messages];
        // 找当前轮次仍在流式的助手消息（从尾部找）
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.kind === 'assistant' && m.turnIndex === turnIndex && m.streaming) {
            messages[i] = { ...m, text: m.text + text };
            return { ...conv, messages, turnActive: true };
          }
        }
        messages.push({
          kind: 'assistant',
          id: nextMessageId(),
          text,
          streaming: true,
          hasArtifact: false,
          turnIndex,
          createdAt: Date.now(),
        });
        return { ...conv, messages, turnActive: true };
      }),
    ),

  // assistant_complete 最终覆盖：全文替换而非拼接，抗 WS 丢帧/重发重复
  replaceAssistantText: (sid, turnIndex, text) =>
    set((state) =>
      withConversation(state, sid, (conv) => {
        const messages = [...conv.messages];
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.kind === 'assistant' && m.turnIndex === turnIndex && m.streaming) {
            messages[i] = { ...m, text };
            return { ...conv, messages, turnActive: true };
          }
        }
        messages.push({
          kind: 'assistant',
          id: nextMessageId(),
          text,
          streaming: true,
          hasArtifact: false,
          turnIndex,
          createdAt: Date.now(),
        });
        return { ...conv, messages, turnActive: true };
      }),
    ),

  completeTurn: (sid, turnIndex, opts) =>
    set((state) =>
      withConversation(state, sid, (conv) => {
        const messages = [...conv.messages];
        let found = false;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.kind === 'assistant' && m.turnIndex === turnIndex) {
            messages[i] = {
              ...m,
              streaming: false,
              hasArtifact: opts?.hasArtifact ?? m.hasArtifact,
            };
            found = true;
            break;
          }
        }
        // 断线补发的 turn_complete 带 assistant_text，本地没有对应消息时补建
        if (!found && opts?.replayedText) {
          messages.push({
            kind: 'assistant',
            id: nextMessageId(),
            text: opts.replayedText,
            streaming: false,
            hasArtifact: opts?.hasArtifact ?? false,
            turnIndex,
            createdAt: Date.now(),
          });
        }
        if (opts?.interrupted) {
          messages.push({
            kind: 'system',
            id: nextMessageId(),
            level: 'warning',
            text: '轮次已中断',
            turnIndex,
            createdAt: Date.now(),
          });
        }
        return { ...conv, messages, turnActive: false, pendingApproval: null };
      }),
    ),

  addToolStart: (sid, turnIndex, toolName, input) =>
    set((state) =>
      withConversation(state, sid, (conv) => {
        const toolCall: ToolCall = {
          id: nextMessageId(),
          toolName,
          input,
          output: null,
          status: 'running',
          turnIndex,
          startedAt: Date.now(),
        };
        return {
          ...conv,
          messages: [
            ...conv.messages,
            { kind: 'tool', id: toolCall.id, toolCall, turnIndex, createdAt: Date.now() },
          ],
        };
      }),
    ),

  addToolEnd: (sid, turnIndex, toolName, output, isError) =>
    set((state) =>
      withConversation(state, sid, (conv) => {
        const messages = [...conv.messages];
        // 匹配同轮次同名的 running 工具卡片
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (
            m.kind === 'tool' &&
            m.turnIndex === turnIndex &&
            m.toolCall.status === 'running' &&
            m.toolCall.toolName === toolName
          ) {
            messages[i] = {
              ...m,
              toolCall: { ...m.toolCall, output, status: isError ? 'error' : 'success' },
            };
            return { ...conv, messages };
          }
        }
        return conv;
      }),
    ),

  setTodo: (sid, markdown) =>
    set((state) => withConversation(state, sid, (conv) => ({ ...conv, todoMarkdown: markdown }))),

  setPendingApproval: (sid, frame) =>
    set((state) =>
      withConversation(state, sid, (conv) => ({
        ...conv,
        // 同一 request_id 重连补发时保留首次收到时刻，倒计时不重置（A7）
        pendingApproval: frame
          ? {
              ...frame,
              receivedAt:
                conv.pendingApproval?.request_id === frame.request_id
                  ? conv.pendingApproval.receivedAt
                  : Date.now(),
            }
          : null,
      })),
    ),

  addSystemMessage: (sid, level, text) =>
    set((state) =>
      withConversation(state, sid, (conv) => ({
        ...conv,
        messages: [
          ...conv.messages,
          { kind: 'system', id: nextMessageId(), level, text, turnIndex: -1, createdAt: Date.now() },
        ],
      })),
    ),

  setTurnActive: (sid, active) =>
    set((state) => withConversation(state, sid, (conv) => ({ ...conv, turnActive: active }))),

  hydrateHistory: (sid, turns) =>
    set((state) =>
      withConversation(state, sid, (conv) => {
        const messages: Message[] = [];
        for (const turn of turns) {
          const startedAt = Date.parse(turn.started_at) || Date.now();
          const finishedAt = turn.finished_at ? Date.parse(turn.finished_at) : startedAt;
          messages.push({
            kind: 'user',
            id: nextMessageId(),
            text: turn.prompt,
            turnIndex: turn.turn_index,
            createdAt: startedAt,
          });
          if (turn.assistant_text) {
            messages.push({
              kind: 'assistant',
              id: nextMessageId(),
              text: turn.assistant_text,
              streaming: false,
              hasArtifact: turn.has_artifact ?? false,
              turnIndex: turn.turn_index,
              createdAt: finishedAt,
            });
          }
          if (turn.status === 'interrupted') {
            messages.push({
              kind: 'system',
              id: nextMessageId(),
              level: 'warning',
              text: '轮次已中断',
              turnIndex: turn.turn_index,
              createdAt: finishedAt,
            });
          }
          if (turn.error_message) {
            messages.push({
              kind: 'system',
              id: nextMessageId(),
              level: 'error',
              text: turn.error_message,
              turnIndex: turn.turn_index,
              createdAt: finishedAt,
            });
          }
        }
        // 整体替换（F2.1 保证此时本地为空），不做插入合并
        return { ...conv, messages, hydratedAt: Date.now() };
      }),
    ),

  pushInputHistory: (sid, text) =>
    set((state) =>
      withConversation(state, sid, (conv) => ({
        ...conv,
        inputHistory:
          conv.inputHistory[conv.inputHistory.length - 1] === text
            ? conv.inputHistory
            : [...conv.inputHistory, text].slice(-100),
      })),
    ),

  clearMessages: (sid) =>
    set((state) =>
      withConversation(state, sid, (conv) => ({ ...conv, messages: [], todoMarkdown: '' })),
    ),

  removeConversation: (sid) =>
    set((state) => {
      const conversations = { ...state.conversations };
      delete conversations[sid];
      return { conversations };
    }),
}));

export function getConversation(
  conversations: Record<string, ConversationState>,
  sid: string | null,
): ConversationState {
  return (sid && conversations[sid]) || emptyConversation();
}
