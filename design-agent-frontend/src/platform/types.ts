// 平台抽象层四域契约（spec: design-agent-platform §四域抽象接口）。
// 呈现层只消费本文件的接口；真实 session-service / demo 内存模拟的差异
// 由 sessionServiceAdapter / demoAdapter 吸收，禁止组件直接触碰 REST/WS。

import type { ComponentType } from 'react';
import type { ApprovalReply } from '../types/ws';

// ---- 会话域 ----

/** 会话摘要（平台层视图；与 types/session.ts::Session 字段兼容）。 */
export interface SessionSummary {
  session_id: string;
  status: string;
  turn_count: number;
  created_at: string;
  last_active_at: string;
  title?: string | null;
  resumable?: boolean;
  read_only?: boolean;
}

export interface TurnRecord {
  turn_index: number;
  user_text: string | null;
  assistant_text: string | null;
  finished_at?: string | null;
  has_artifact?: boolean;
  interrupted?: boolean;
}

export interface CreateSessionOptions {
  title?: string;
  /** OpenHarness 主 agent 模型（建会话时注入 extra_oh_args `--model`）。 */
  model?: string;
  extraOhArgs?: string[];
  permissionPolicy?: 'full_auto' | 'interactive';
}

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

export interface TurnPage {
  turns: TurnRecord[];
  total: number;
}

/** 会话域 provider：list/create/get/close/listTurns/openChannel。 */
export interface SessionProvider {
  list(params?: { limit?: number; offset?: number }): Promise<SessionPage>;
  create(opts?: CreateSessionOptions): Promise<SessionSummary>;
  get(sessionId: string): Promise<SessionSummary>;
  close(sessionId: string): Promise<void>;
  listTurns(
    sessionId: string,
    params?: { after_index?: number; limit?: number },
  ): Promise<TurnPage>;
  /** 打开对话通道（demo 为内存模拟，真实为 WS）。 */
  openChannel(sessionId: string): TurnStream;
}

// ---- 对话域（TurnStream）----

/**
 * TurnStream 事件模型（spec：demo 与真实通道 MUST 同构）：
 * ready/delta/tool/todo/approval/complete/error/closed。
 */
export type TurnStreamEvent =
  | { type: 'ready'; sessionId?: string }
  | {
      type: 'delta';
      turnIndex: number;
      text: string;
      final: boolean;
      /** final 帧的权威全文（覆盖语义，非追加）。 */
      fullText?: string;
    }
  | {
      type: 'tool';
      phase: 'start' | 'end';
      turnIndex: number;
      toolName: string | null;
      toolInput?: Record<string, unknown> | null;
      output?: string | null;
      isError?: boolean;
    }
  | { type: 'todo'; turnIndex: number; markdown: string | null }
  | {
      type: 'approval';
      turnIndex: number;
      requestId: string | null;
      modal: Record<string, unknown> | null;
    }
  | {
      type: 'complete';
      turnIndex: number;
      assistantText?: string | null;
      hasArtifact: boolean;
      interrupted: boolean;
    }
  | { type: 'error'; message: string; code?: string; turnIndex?: number; fatal: boolean }
  | { type: 'closed'; code: number; reason?: string };

/** TurnStream 事件类型集合（契约测试比对 demo/真实通道同构性）。 */
export const TURN_STREAM_EVENT_TYPES = [
  'ready',
  'delta',
  'tool',
  'todo',
  'approval',
  'complete',
  'error',
  'closed',
] as const;

export type TurnStreamEventType = (typeof TURN_STREAM_EVENT_TYPES)[number];

/** 通道连接状态（demo 通道恒 ready 直至 close）。 */
export type ChannelState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'closed';

/** 对话通道：submit/interrupt/approve/on/close/state。 */
export interface TurnStream {
  submit(text: string): boolean;
  interrupt(): boolean;
  approve(requestId: string, allowed: boolean, reply?: ApprovalReply, answer?: string): boolean;
  on(handler: (event: TurnStreamEvent) => void): () => void;
  onState(handler: (state: ChannelState) => void): () => void;
  close(): void;
  readonly state: ChannelState;
}

// ---- 产物域 ----

export interface ArtifactRef {
  sessionId: string;
  turnIndex: number;
  /** 展示名（文件名或标题）。 */
  name: string;
  mediaType: string;
  finishedAt?: string | null;
  /** 演示数据标识（maturity!==ga 的能力域 MUST 为 true）。 */
  demo?: boolean;
}

export interface AggregateOptions {
  /** 并发拉取上限（默认 4）。 */
  concurrency?: number;
  signal?: AbortSignal;
}

/** 产物域 provider：listBySession/aggregate/streamUrl/downloadUrl。 */
export interface ArtifactProvider {
  listBySession(sessionId: string): Promise<ArtifactRef[]>;
  /** 跨会话聚合（个人空间 tab 数据源；finished_at 倒序）。 */
  aggregate(opts?: AggregateOptions): Promise<ArtifactRef[]>;
  /** 内嵌播放/预览 URL（真实域走 mode=stream；demo 域可返回 null）。 */
  streamUrl(ref: ArtifactRef): string | null;
  /** 下载直链（demo 域可返回 null → UI 呈现占位下载）。 */
  downloadUrl(ref: ArtifactRef): string | null;
}

// ---- 工作区域 ----

export interface WorkspaceFile {
  path: string;
  size: number;
  modified_at?: string | null;
}

export interface WorkspaceFilePage {
  files: WorkspaceFile[];
  next_page_token?: string | null;
}

/** 工作区域 provider：listFiles/fileUrl。 */
export interface WorkspaceProvider {
  listFiles(
    sessionId: string,
    params?: { limit?: number; page_token?: string; prefix?: string },
  ): Promise<WorkspaceFilePage>;
  fileUrl(sessionId: string, path: string): string | null;
}

// ---- 能力域描述符（AgentRegistry）----

export type AgentMaturity = 'ga' | 'demo' | 'stub';

export interface AgentTheme {
  /** 模块卡片图标区渐变（demo module-card-icon 的 icon-* class）。 */
  iconClass: string;
}

export interface AgentCapabilities {
  /** 是否支持 OpenHarness 主 agent 模型切换。 */
  modelSwitch: boolean;
  /** 是否有 Terminal 模式。 */
  terminalMode: boolean;
  /** 是否有审批流。 */
  approvals: boolean;
  /** 是否支持文件上传（false → UI 呈现「暂不支持」）。 */
  upload: boolean;
}

export interface AgentProviders {
  session: SessionProvider;
  artifacts: ArtifactProvider;
  workspace?: WorkspaceProvider;
}

export interface AgentDescriptor {
  /** 能力域唯一 id（video-generation / ui-prototype / drawio-diagram）。 */
  id: string;
  /** 模块名（主页卡片标题 / 面包屑 / 个人空间 tab 名）。 */
  title: string;
  /** 卡片副标题。 */
  subtitle: string;
  /** 卡片描述。 */
  description: string;
  maturity: AgentMaturity;
  /** 路由路径（/video、/ui、/drawio）。 */
  route: string;
  theme: AgentTheme;
  /** 该域产物媒体类型（个人空间 tab 过滤依据）。 */
  artifactMediaTypes: string[];
  capabilities: AgentCapabilities;
  providers: AgentProviders;
  /** 模块页组件（懒加载入口，路由表派生用）。 */
  page: ComponentType;
  /** 个人空间 tab 图标（可选，SpacePage 派生用）。 */
  spaceTabLabel?: string;
}
