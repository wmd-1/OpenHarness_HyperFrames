// 会话 REST API：创建 / 查询 / 关闭 / REST 兜底轮次提交 / 产物下载。

import { api } from './client';
import type {
  DeleteResponse,
  SessionCreateRequest,
  SessionResponse,
  TurnResponse,
} from '../types/api';

export async function createSession(body: SessionCreateRequest): Promise<SessionResponse> {
  return api.post('v1/sessions', { json: body }).json<SessionResponse>();
}

export async function getSession(sid: string): Promise<SessionResponse> {
  return api.get(`v1/sessions/${sid}`).json<SessionResponse>();
}

export async function closeSession(sid: string): Promise<DeleteResponse> {
  return api.delete(`v1/sessions/${sid}`).json<DeleteResponse>();
}

/** REST 兜底提交轮次（WS 不可用时，阻塞直到轮次完成）。 */
export async function submitTurnRest(sid: string, text: string): Promise<TurnResponse> {
  return api
    .post(`v1/sessions/${sid}/turns`, { json: { text }, timeout: false })
    .json<TurnResponse>();
}

/** 产物下载 URL（浏览器直接导航即可跟随 S3 302 重定向）。 */
export function artifactUrl(sid: string, turnIndex: number): string {
  return `/v1/sessions/${sid}/turns/${turnIndex}/artifact`;
}

/** 视频内嵌播放 URL（mode=stream 走服务端流式，避免 302 CORS，支持 Range）。 */
export function artifactStreamUrl(sid: string, turnIndex: number): string {
  return `${artifactUrl(sid, turnIndex)}?mode=stream`;
}

/**
 * 触发浏览器下载产物：用带认证头的 fetch 拿到 blob 再落地
 * （<a href> 直连无法携带 X-API-Key 头）。
 */
export async function downloadArtifact(
  sid: string,
  turnIndex: number,
  filename?: string,
): Promise<void> {
  const response = await api.get(artifactUrl(sid, turnIndex).slice(1), { timeout: false });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `${sid}_${turnIndex}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
