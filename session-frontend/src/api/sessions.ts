// 会话 REST API：创建 / 查询 / 关闭 / REST 兜底轮次提交 / 产物下载。

import { api } from './client';
import { useAuthStore } from '../store/authStore';
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
