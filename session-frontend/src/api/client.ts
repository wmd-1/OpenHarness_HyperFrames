// ky HTTP 客户端：API Key 自动注入（X-API-Key 头）+ 统一错误拦截。
// 401 → 清除 Key + 重弹认证；403 → 配额 fatal 横幅 / 权限错误提示；
// 429 → 限流横幅（含 Retry-After 等待时间；创建会话由 CreateDialog 就地提示）；
// 503 → 容量已满横幅。

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
      async (request, _options, response) => {
        const { showBanner } = useUiStore.getState();
        if (response.status === 401) {
          // 认证失效：清 Key、弹重新认证对话框
          useAuthStore.getState().markAuthExpired();
        } else if (response.status === 403) {
          // 配额耗尽（detail.code）→ 不可关闭 fatal 横幅；其余 403 走普通错误提示（E1）
          const detail = await readErrorDetail(response);
          if (typeof detail === 'object' && detail?.code === 'daily_quota_exceeded') {
            showBanner('fatal', '今日会话配额已用完，请明天再试', false);
          } else {
            showBanner('error', detailText(detail) ?? '无权访问该资源');
          }
        } else if (response.status === 429) {
          // 创建会话的 429（并发超限）由 CreateDialog 就地提示，抑制全局横幅（E3）
          if (!isCreateSessionRequest(request)) {
            const waitS = parseRetryAfter(response.headers.get('Retry-After'));
            showBanner(
              'warning',
              waitS !== null
                ? `请求过于频繁，请约 ${waitS} 秒后重试`
                : '请求过于频繁，请稍后再试',
            );
          }
        } else if (response.status === 503) {
          showBanner('fatal', '服务暂不可用，节点容量已满', false);
        }
        return response;
      },
    ],
  },
});

/** 创建会话请求（POST /v1/sessions）：429 由 CreateDialog 就地处理。 */
function isCreateSessionRequest(request: Request): boolean {
  try {
    return request.method === 'POST' && new URL(request.url).pathname === '/v1/sessions';
  } catch {
    return false;
  }
}

/** 解析 Retry-After 头（秒数或 HTTP 日期）为等待秒数；无法解析返回 null（E2）。 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number.parseInt(header, 10);
  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

/** 从 HTTPError 中取响应状态码（非 HTTP 错误返回 null）。 */
export function errorStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'response' in error) {
    return (error as { response: Response }).response.status;
  }
  return null;
}

/** 读取响应体的 detail（纯文本或结构化 { code, message }），非 JSON 返回 null。 */
async function readErrorDetail(response: Response): Promise<ApiErrorBody['detail'] | null> {
  try {
    const body = (await response.clone().json()) as ApiErrorBody;
    return body.detail ?? null;
  } catch {
    return null;
  }
}

/** 把 detail 归一化为可展示文本。 */
function detailText(detail: ApiErrorBody['detail'] | null): string | null {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') return detail.message ?? null;
  return null;
}

/** 从 HTTPError 中提取后端 detail 文本（兼容结构化 detail）。 */
export async function extractErrorDetail(error: unknown): Promise<string | null> {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response: Response }).response;
    const text = detailText(await readErrorDetail(response));
    return text ?? `HTTP ${response.status}`;
  }
  return error instanceof Error ? error.message : null;
}
