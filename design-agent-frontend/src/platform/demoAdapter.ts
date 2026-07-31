// DemoAdapter（spec: design-agent-platform §TurnStream 事件模型同构）：
// 内存 SessionProvider + 固定延迟模拟回复的 TurnStream + 静态 ArtifactProvider。
// 事件类型集合与 SessionServiceAdapter 完全一致，能力域 demo→GA 时呈现层零改动。

import type {
  ArtifactProvider,
  ArtifactRef,
  ChannelState,
  CreateSessionOptions,
  SessionPage,
  SessionProvider,
  SessionSummary,
  TurnPage,
  TurnRecord,
  TurnStream,
  TurnStreamEvent,
} from './types';

/** demo 模拟 AI 回复延迟（对齐 demo HTML 的 800ms）。 */
export const DEMO_REPLY_DELAY_MS = 800;

export interface DemoSessionSeed {
  title: string;
  /** demo 展示用相对时间文案（如「今天 14:32」），存入 created_at 前缀。 */
  time: string;
  /** 选中该会话时回放的预置消息（user/assistant 成对）。 */
  turns?: Array<{ user: string; assistant: string }>;
}

export interface DemoArtifactSeed {
  name: string;
  time: string;
  type: string;
}

export interface DemoAdapterConfig {
  /** 能力域 id（生成 session_id 前缀）。 */
  agentId: string;
  sessions: DemoSessionSeed[];
  artifacts: DemoArtifactSeed[];
  artifactMediaType: string;
  /** 生成模拟回复文本（默认通用文案）。 */
  reply?: (userText: string, turnIndex: number) => string;
}

function defaultReply(userText: string): string {
  return (
    '已收到您的需求，正在为您生成设计方案（演示数据）：\n\n' +
    `> ${userText}\n\n` +
    '您可以在右侧预览面板查看效果。本模块为演示能力域，接口已预留，后续将接入真实服务。'
  );
}

let demoSeq = 0;

class DemoTurnStream implements TurnStream {
  private handlers = new Set<(event: TurnStreamEvent) => void>();
  private stateHandlers = new Set<(state: ChannelState) => void>();
  private _state: ChannelState = 'connecting';
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private busy = false;

  constructor(
    private readonly session: DemoSessionRecord,
    private readonly reply: (userText: string, turnIndex: number) => string,
    private readonly replyDelayMs: number,
  ) {
    // 模拟建连：微任务后进入 ready（与真实通道的 connecting→ready 同构）
    const t = setTimeout(() => {
      this.setState('ready');
      this.emit({ type: 'ready', sessionId: this.session.summary.session_id });
    }, 0);
    this.timers.add(t);
  }

  get state(): ChannelState {
    return this._state;
  }

  submit(text: string): boolean {
    if (this._state !== 'ready' || this.busy) return false;
    this.busy = true;
    const turnIndex = this.session.turns.length;
    const turn: TurnRecord = {
      turn_index: turnIndex,
      user_text: text,
      assistant_text: null,
      finished_at: null,
    };
    this.session.turns.push(turn);
    this.session.summary.turn_count = this.session.turns.length;

    const t = setTimeout(() => {
      const full = this.reply(text, turnIndex);
      turn.assistant_text = full;
      turn.finished_at = new Date().toISOString();
      // final delta 携带权威全文（覆盖语义，与真实协议 P0-1 对齐）
      this.emit({ type: 'delta', turnIndex, text: full, final: true, fullText: full });
      this.emit({
        type: 'complete',
        turnIndex,
        assistantText: full,
        hasArtifact: false,
        interrupted: false,
      });
      this.busy = false;
    }, this.replyDelayMs);
    this.timers.add(t);
    return true;
  }

  interrupt(): boolean {
    if (!this.busy) return false;
    this.clearTimers();
    const turnIndex = this.session.turns.length - 1;
    this.emit({
      type: 'complete',
      turnIndex,
      assistantText: null,
      hasArtifact: false,
      interrupted: true,
    });
    this.busy = false;
    return true;
  }

  approve(): boolean {
    // demo 能力域无审批流；保持接口同构，恒返回 false
    return false;
  }

  on(handler: (event: TurnStreamEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onState(handler: (state: ChannelState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  close(): void {
    this.clearTimers();
    this.setState('closed');
    this.emit({ type: 'closed', code: 1000, reason: 'demo channel closed' });
    this.handlers.clear();
    this.stateHandlers.clear();
  }

  private emit(event: TurnStreamEvent): void {
    for (const h of this.handlers) h(event);
  }

  private setState(state: ChannelState): void {
    this._state = state;
    for (const h of this.stateHandlers) h(state);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

interface DemoSessionRecord {
  summary: SessionSummary;
  turns: TurnRecord[];
}

class DemoSessionProvider implements SessionProvider {
  private records = new Map<string, DemoSessionRecord>();
  private order: string[] = [];

  constructor(private readonly config: DemoAdapterConfig) {
    // 预置静态历史会话（demo HTML 的 12 条列表）
    config.sessions.forEach((seed, i) => {
      const sid = `${config.agentId}-demo-${i}`;
      const turns: TurnRecord[] = (seed.turns ?? []).map((t, idx) => ({
        turn_index: idx,
        user_text: t.user,
        assistant_text: t.assistant,
        finished_at: null,
      }));
      this.records.set(sid, {
        summary: {
          session_id: sid,
          status: 'live',
          turn_count: turns.length,
          created_at: seed.time,
          last_active_at: seed.time,
          title: seed.title,
          resumable: true,
          read_only: false,
        },
        turns,
      });
      this.order.push(sid);
    });
  }

  async list(params?: { limit?: number; offset?: number }): Promise<SessionPage> {
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? this.order.length;
    const ids = this.order.slice(offset, offset + limit);
    return {
      sessions: ids.map((id) => ({ ...this.records.get(id)!.summary })),
      total: this.order.length,
    };
  }

  async create(opts?: CreateSessionOptions): Promise<SessionSummary> {
    const sid = `${this.config.agentId}-new-${Date.now()}-${demoSeq++}`;
    const now = new Date().toISOString();
    const record: DemoSessionRecord = {
      summary: {
        session_id: sid,
        status: 'live',
        turn_count: 0,
        created_at: now,
        last_active_at: now,
        title: opts?.title ?? '新建会话',
        resumable: true,
        read_only: false,
      },
      turns: [],
    };
    this.records.set(sid, record);
    this.order.unshift(sid);
    return { ...record.summary };
  }

  async get(sessionId: string): Promise<SessionSummary> {
    const record = this.records.get(sessionId);
    if (!record) throw new Error(`demo session not found: ${sessionId}`);
    return { ...record.summary };
  }

  async close(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.summary.status = 'closed';
    record.summary.resumable = false;
    record.summary.read_only = true;
  }

  async listTurns(
    sessionId: string,
    params?: { after_index?: number; limit?: number },
  ): Promise<TurnPage> {
    const record = this.records.get(sessionId);
    if (!record) throw new Error(`demo session not found: ${sessionId}`);
    const after = params?.after_index ?? -1;
    let turns = record.turns.filter((t) => t.turn_index > after);
    if (params?.limit !== undefined) turns = turns.slice(0, params.limit);
    return { turns, total: record.turns.length };
  }

  openChannel(sessionId: string): TurnStream {
    const record = this.records.get(sessionId);
    if (!record) throw new Error(`demo session not found: ${sessionId}`);
    return new DemoTurnStream(record, this.config.reply ?? defaultReply, DEMO_REPLY_DELAY_MS);
  }
}

class DemoArtifactProvider implements ArtifactProvider {
  private readonly refs: ArtifactRef[];

  constructor(config: DemoAdapterConfig) {
    this.refs = config.artifacts.map((a, i) => ({
      sessionId: `${config.agentId}-demo-${i}`,
      turnIndex: 0,
      name: a.name,
      mediaType: config.artifactMediaType,
      finishedAt: a.time,
      demo: true, // maturity!==ga 的数据 MUST 携带演示标识
    }));
  }

  async listBySession(sessionId: string): Promise<ArtifactRef[]> {
    return this.refs.filter((r) => r.sessionId === sessionId);
  }

  async aggregate(): Promise<ArtifactRef[]> {
    return [...this.refs];
  }

  streamUrl(): string | null {
    return null; // demo 域无真实产物流
  }

  downloadUrl(): string | null {
    return null; // UI 呈现占位下载
  }
}

export interface DemoAdapter {
  session: SessionProvider;
  artifacts: ArtifactProvider;
}

export function createDemoAdapter(config: DemoAdapterConfig): DemoAdapter {
  return {
    session: new DemoSessionProvider(config),
    artifacts: new DemoArtifactProvider(config),
  };
}
