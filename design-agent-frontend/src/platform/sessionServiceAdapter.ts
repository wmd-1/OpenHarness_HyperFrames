// SessionServiceAdapter（spec: design-agent-platform §四域抽象接口）：
// 将久经验证的 api/ws 移植层封装为平台 provider 实现。
// TurnStream 包装 WebSocketClient，把 ServerFrame 映射为同构事件模型；
// 视频模块内部继续使用 useConversation 等 hooks（同一 api/ws 层的组合），
// 本适配层保证呈现层可经 provider 接口访问真实后端且与 DemoAdapter 同构。

import {
  artifactStreamUrl,
  artifactUrl,
  closeSession,
  createSession,
  getSession,
  listSessions,
  listTurns,
  listWorkspaceFiles,
  workspaceFileUrl,
} from '../api/sessions';
import { useAuthStore } from '../store/authStore';
import type { ServerFrame, WsStatus } from '../types/ws';
import { WebSocketClient } from '../ws/WebSocketClient';
import type {
  AggregateOptions,
  ArtifactProvider,
  ArtifactRef,
  ChannelState,
  CreateSessionOptions,
  SessionPage,
  SessionProvider,
  SessionSummary,
  TurnPage,
  TurnStream,
  TurnStreamEvent,
  WorkspaceFilePage,
  WorkspaceProvider,
} from './types';

/** 个人空间聚合默认并发（design D4）。 */
export const AGGREGATE_DEFAULT_CONCURRENCY = 4;

// ---- ServerFrame → TurnStreamEvent 映射 ----

export function mapServerFrame(frame: ServerFrame): TurnStreamEvent | null {
  switch (frame.type) {
    case 'session_ready':
      return { type: 'ready', sessionId: frame.session_id };
    case 'delta':
      return {
        type: 'delta',
        turnIndex: frame.turn_index,
        text: frame.text,
        final: frame.final === true,
        fullText: frame.full_text,
      };
    case 'tool_start':
      return {
        type: 'tool',
        phase: 'start',
        turnIndex: frame.turn_index,
        toolName: frame.tool_name,
        toolInput: frame.tool_input,
      };
    case 'tool_end':
      return {
        type: 'tool',
        phase: 'end',
        turnIndex: frame.turn_index,
        toolName: frame.tool_name,
        output: frame.output,
        isError: frame.is_error ?? false,
      };
    case 'todo':
      return { type: 'todo', turnIndex: frame.turn_index, markdown: frame.todo_markdown };
    case 'approval_request':
      return {
        type: 'approval',
        turnIndex: frame.turn_index,
        requestId: frame.request_id,
        modal: frame.modal,
      };
    case 'turn_complete':
      return {
        type: 'complete',
        turnIndex: frame.turn_index,
        assistantText: frame.assistant_text,
        hasArtifact: frame.has_artifact === true,
        interrupted: frame.interrupted === true,
      };
    case 'error':
      // 准入失败类 error 帧随后 close，标记 fatal
      return { type: 'error', message: frame.message, code: frame.code, fatal: true };
    case 'turn_error':
      return {
        type: 'error',
        message: frame.message,
        code: frame.code,
        turnIndex: frame.turn_index,
        fatal: false,
      };
    case 'busy':
    case 'pong':
    case 'event':
      return null; // 心跳/透传帧不进入呈现层事件模型
  }
}

function mapWsStatus(status: WsStatus): ChannelState {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return 'connecting';
    case 'ready':
      return 'ready';
    case 'reconnecting':
    case 'rate_limited':
      return 'reconnecting';
    case 'auth_failed':
    case 'session_not_found':
    case 'quota_exceeded':
    case 'failed':
      return 'failed';
    case 'session_closed':
    case 'closed':
      return 'closed';
  }
}

class WsTurnStream implements TurnStream {
  private readonly client: WebSocketClient;
  private handlers = new Set<(event: TurnStreamEvent) => void>();
  private stateHandlers = new Set<(state: ChannelState) => void>();
  private _state: ChannelState = 'idle';
  private lastTurnIndex: number | null = null;

  constructor(sessionId: string) {
    this.client = new WebSocketClient({
      sessionId,
      getApiKey: () => useAuthStore.getState().apiKey,
      getLastTurnIndex: () => this.lastTurnIndex,
      onFrame: (frame) => this.handleFrame(frame),
      onStatus: (status, detail) => {
        const next = mapWsStatus(status);
        if (next !== this._state) {
          this._state = next;
          for (const h of this.stateHandlers) h(next);
        }
        if (next === 'closed' || next === 'failed') {
          this.emit({ type: 'closed', code: detail?.closeCode ?? 1000 });
        }
      },
    });
    this._state = 'connecting';
    this.client.connect();
  }

  get state(): ChannelState {
    return this._state;
  }

  submit(text: string): boolean {
    return this.client.submit(text);
  }

  interrupt(): boolean {
    return this.client.interrupt();
  }

  approve(
    requestId: string,
    allowed: boolean,
    reply?: 'once' | 'always' | 'reject',
    answer?: string,
  ): boolean {
    return this.client.approve(requestId, allowed, reply, answer);
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
    this.client.dispose();
    this._state = 'closed';
    this.handlers.clear();
    this.stateHandlers.clear();
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.type === 'turn_complete') {
      this.lastTurnIndex = frame.turn_index; // 断线重连补发游标
    }
    const event = mapServerFrame(frame);
    if (event) this.emit(event);
  }

  private emit(event: TurnStreamEvent): void {
    for (const h of this.handlers) h(event);
  }
}

class RealSessionProvider implements SessionProvider {
  async list(params?: { limit?: number; offset?: number }): Promise<SessionPage> {
    const res = await listSessions(params);
    return { sessions: res.items, total: res.total };
  }

  async create(opts?: CreateSessionOptions): Promise<SessionSummary> {
    const extraArgs = [...(opts?.extraOhArgs ?? [])];
    // 模型切换双通道之一：建会话注入 --model（design D3）
    if (opts?.model) extraArgs.push('--model', opts.model);
    return createSession({
      permission_policy: opts?.permissionPolicy ?? 'full_auto',
      extra_oh_args: extraArgs,
    });
  }

  async get(sessionId: string): Promise<SessionSummary> {
    return getSession(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    await closeSession(sessionId);
  }

  async listTurns(
    sessionId: string,
    params?: { after_index?: number; limit?: number },
  ): Promise<TurnPage> {
    const res = await listTurns(sessionId, params);
    return {
      turns: res.items.map((t) => ({
        turn_index: t.turn_index,
        user_text: t.prompt,
        assistant_text: t.assistant_text,
        finished_at: t.finished_at,
        has_artifact: t.has_artifact,
      })),
      total: res.total,
    };
  }

  openChannel(sessionId: string): TurnStream {
    return new WsTurnStream(sessionId);
  }
}

/** 聚合缓存项：sid+turn_count 未变则复用（design D4，避免重复拉 turns）。 */
interface AggregateCacheEntry {
  turnCount: number;
  refs: ArtifactRef[];
}

class RealArtifactProvider implements ArtifactProvider {
  private cache = new Map<string, AggregateCacheEntry>();

  constructor(private readonly mediaType: string) {}

  async listBySession(sessionId: string): Promise<ArtifactRef[]> {
    const res = await listTurns(sessionId);
    return res.items
      .filter((t) => t.has_artifact === true)
      .map((t) => this.toRef(sessionId, t.turn_index, t.finished_at ?? null));
  }

  async aggregate(opts?: AggregateOptions): Promise<ArtifactRef[]> {
    const concurrency = opts?.concurrency ?? AGGREGATE_DEFAULT_CONCURRENCY;
    const { items } = await listSessions({ limit: 100 });
    const queue = [...items];
    const results: ArtifactRef[] = [];

    const worker = async (): Promise<void> => {
      for (;;) {
        if (opts?.signal?.aborted) return;
        const session = queue.shift();
        if (!session) return;
        const cached = this.cache.get(session.session_id);
        if (cached && cached.turnCount === session.turn_count) {
          results.push(...cached.refs);
          continue;
        }
        try {
          const refs = await this.listBySession(session.session_id);
          this.cache.set(session.session_id, {
            turnCount: session.turn_count,
            refs,
          });
          results.push(...refs);
        } catch {
          // 单会话失败不阻塞聚合（骨架屏之后尽力呈现）
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
    );

    // finished_at 倒序（缺失时间的排最后）
    return results.sort((a, b) => {
      const ta = a.finishedAt ? Date.parse(a.finishedAt) : 0;
      const tb = b.finishedAt ? Date.parse(b.finishedAt) : 0;
      return tb - ta;
    });
  }

  streamUrl(ref: ArtifactRef): string {
    return artifactStreamUrl(ref.sessionId, ref.turnIndex);
  }

  downloadUrl(ref: ArtifactRef): string {
    return artifactUrl(ref.sessionId, ref.turnIndex);
  }

  private toRef(sessionId: string, turnIndex: number, finishedAt: string | null): ArtifactRef {
    return {
      sessionId,
      turnIndex,
      name: `${sessionId.slice(0, 8)}_turn${turnIndex}.mp4`,
      mediaType: this.mediaType,
      finishedAt,
    };
  }
}

class RealWorkspaceProvider implements WorkspaceProvider {
  async listFiles(
    sessionId: string,
    params?: { limit?: number; page_token?: string; prefix?: string },
  ): Promise<WorkspaceFilePage> {
    const res = await listWorkspaceFiles(sessionId, params);
    return {
      files: res.files.map((f) => ({ path: f.path, size: f.size, modified_at: f.mtime })),
      next_page_token: res.next_page_token,
    };
  }

  fileUrl(sessionId: string, path: string): string {
    return workspaceFileUrl(sessionId, path);
  }
}

export interface SessionServiceAdapter {
  session: SessionProvider;
  artifacts: ArtifactProvider;
  workspace: WorkspaceProvider;
}

export function createSessionServiceAdapter(
  opts: { artifactMediaType?: string } = {},
): SessionServiceAdapter {
  return {
    session: new RealSessionProvider(),
    artifacts: new RealArtifactProvider(opts.artifactMediaType ?? 'video/mp4'),
    workspace: new RealWorkspaceProvider(),
  };
}
