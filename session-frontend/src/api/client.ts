// ky HTTP 客户端：API Key 自动注入（X-API-Key 头）+ 统一错误拦截。
// 401 → 清除 Key + 重弹认证；429 → 限流横幅；503 → 容量已满横幅。

import ky from 'ky';
import { useAuthStore } from '../store/authStore';
import { useUiStore } from '../store/uiStore';
import type { ApiErrorBody } from '../types/api';

/** localStorage 无 API Key 时请求直接被拦截。 */
export class NoApiKeyError extends Error {
  constructor() {
    super('API Key 未配置');
    this.name = 'NoApiKeyError';
  }
}

export const api = ky.create({
  // 同源部署（Vite dev proxy / Nginx 反代），无需 prefixUrl
  timeout: 60_000,
  retry: 0,
  hooks: {
    beforeRequest: [
      (request) => {
        const { apiKey } = useAuthStore.getState();
        if (!apiKey) {
          // 未配置 Key：拦截请求并标记需要认证
          useAuthStore.getState().markAuthExpired();
          throw new NoApiKeyError();
        }
        request.headers.set('X-API-Key', apiKey);
      },
    ],
    afterResponse: [
      (_request, _options, response) => {
        const { showBanner } = useUiStore.getState();
        if (response.status === 401) {
          // 认证失效：清 Key、弹重新认证对话框
          useAuthStore.getState().markAuthExpired();
        } else if (response.status === 429) {
          showBanner('warning', '请求过于频繁，请稍后再试');
        } else if (response.status === 503) {
          showBanner('fatal', '服务暂不可用，节点容量已满', false);
        }
        return response;
      },
    ],
  },
});

/** 从 HTTPError 中提取后端 detail 文本。 */
export async function extractErrorDetail(error: unknown): Promise<string | null> {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response: Response }).response;
    try {
      const body = (await response.clone().json()) as ApiErrorBody;
      if (body.detail) return body.detail;
    } catch {
      // 非 JSON 响应体
    }
    return `HTTP ${response.status}`;
  }
  return error instanceof Error ? error.message : null;
}
