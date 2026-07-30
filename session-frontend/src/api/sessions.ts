// 会话 REST API：创建 / 查询 / 关闭 / REST 兜底轮次提交 / 产物下载。

import { api } from './client';
import { useAuthStore } from '../store/authStore';
import type {
  DeleteResponse,
  SessionCreateRequest,
  SessionListResponse,
  SessionResponse,
  TurnListResponse,
  TurnResponse,
  WorkspaceFileListResponse,
} from '../types/api';

export async function createSession(body: SessionCreateRequest): Promise<SessionResponse> {
  return api.post('v1/sessions', { json: body }).json<SessionResponse>();
}

/** 服务端权威会话列表（§2.6，limit/offset 分页，按 created_at 倒序）。 */
export async function listSessions(params?: {
  limit?: number;
  offset?: number;
}): Promise<SessionListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
  return api.get('v1/sessions', { searchParams }).json<SessionListResponse>();
}

export async function getSession(sid: string): Promise<SessionResponse> {
  return api.get(`v1/sessions/${sid}`).json<SessionResponse>();
}

/** 轮次历史（§2.7，按 turn_index 升序，after_index 游标分页）。 */
export async function listTurns(
  sid: string,
  params?: { after_index?: number; limit?: number },
): Promise<TurnListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.after_index !== undefined) searchParams.set('after_index', String(params.after_index));
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
  return api.get(`v1/sessions/${sid}/turns`, { searchParams }).json<TurnListResponse>();
}

export async function closeSession(sid: string): Promise<DeleteResponse> {
  return api.delete(`v1/sessions/${sid}`).json<DeleteResponse>();
}

/** 工作区文件列表（§2.8，page_token 游标分页 + prefix 前缀过滤，F5.2）。 */
export async function listWorkspaceFiles(
  sid: string,
  params?: { limit?: number; page_token?: string; prefix?: string },
): Promise<WorkspaceFileListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params?.page_token) searchParams.set('page_token', params.page_token);
  if (params?.prefix) searchParams.set('prefix', params.prefix);
  return api
    .get(`v1/sessions/${sid}/workspace/files`, { searchParams })
    .json<WorkspaceFileListResponse>();
}

/**
 * 工作区单文件下载直链（F5.4，复用产物直链模式）：path 逐段 encode、
 * 保留 / 分隔；<a download> 导航由浏览器跟随后端 presigned 302。
 */
export function workspaceFileUrl(sid: string, path: string): string {
  const apiKey = useAuthStore.getState().apiKey ?? '';
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `/v1/sessions/${sid}/workspace/files/${encodedPath}?api_key=${encodeURIComponent(apiKey)}`;
}

/** REST 兜底提交轮次（WS 不可用时，阻塞直到轮次完成）。 */
export async function submitTurnRest(sid: string, text: string): Promise<TurnResponse> {
  return api
    .post(`v1/sessions/${sid}/turns`, { json: { text }, timeout: false })
    .json<TurnResponse>();
}

/**
 * 产物下载 URL（直链携带 ?api_key= 查询参数认证，A2）：
 * <video>/<a> 无法携带自定义头，后端仅对该路径额外接受查询参数；
 * 浏览器直接导航即可跟随 S3 302 重定向。
 */
export function artifactUrl(sid: string, turnIndex: number): string {
  const apiKey = useAuthStore.getState().apiKey ?? '';
  return `/v1/sessions/${sid}/turns/${turnIndex}/artifact?api_key=${encodeURIComponent(apiKey)}`;
}

/** 视频内嵌播放 URL（mode=stream 走服务端流式，避免 302 CORS，支持 Range）。 */
export function artifactStreamUrl(sid: string, turnIndex: number): string {
  return `${artifactUrl(sid, turnIndex)}&mode=stream`;
}

/**
 * 触发浏览器下载产物：<a download> 直链由浏览器流式落盘
 *（认证走 ?api_key= 查询参数，不再 fetch→blob 全量内存缓冲；A2/C1）。
 */
export function downloadArtifact(sid: string, turnIndex: number, filename?: string): void {
  const a = document.createElement('a');
  a.href = artifactUrl(sid, turnIndex);
  a.download = filename || `${sid}_${turnIndex}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
