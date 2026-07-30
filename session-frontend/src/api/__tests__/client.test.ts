// api/client 拦截器测试（task 2.5）：mock 全局 fetch，
// 验证 401/403（配额 vs 权限）/429/503 分支与结构化 detail 提取。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  extractErrorCode,
  extractErrorDetail,
  extractRetryAfter,
  NoApiKeyError,
  parseRetryAfter,
} from '../client';
import { useAuthStore } from '../../store/authStore';
import { useUiStore } from '../../store/uiStore';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** stub fetch 固定返回一个响应。 */
function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

/** 测试环境无 document base URL，ky 需绝对地址。 */
const URL_BASE = 'http://api.test';

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ apiKey: 'test-key', authExpired: false });
  useUiStore.setState({ banner: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api 拦截器', () => {
  it('未配置 API Key 时直接拦截并标记认证过期', async () => {
    useAuthStore.setState({ apiKey: null });
    await expect(api.get(`${URL_BASE}/v1/sessions/s1`)).rejects.toThrow(NoApiKeyError);
    expect(useAuthStore.getState().authExpired).toBe(true);
  });

  it('请求自动注入 X-API-Key 头', async () => {
    let captured: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) => {
        captured = input;
        return jsonResponse(200, {});
      }),
    );
    await api.get(`${URL_BASE}/v1/sessions/s1`);
    expect(captured?.headers.get('X-API-Key')).toBe('test-key');
  });

  it('401 清除 Key 并标记认证过期', async () => {
    stubFetch(jsonResponse(401, { detail: 'invalid api key' }));
    await expect(api.get(`${URL_BASE}/v1/sessions/s1`)).rejects.toThrow();
    expect(useAuthStore.getState()).toMatchObject({ apiKey: null, authExpired: true });
  });

  it('配额类 403（code=daily_quota_exceeded）弹不可关闭 fatal 横幅', async () => {
    stubFetch(
      jsonResponse(403, {
        detail: { code: 'daily_quota_exceeded', message: 'Daily session quota exceeded' },
      }),
    );
    await expect(api.post(`${URL_BASE}/v1/sessions`)).rejects.toThrow();
    expect(useUiStore.getState().banner).toEqual({
      level: 'fatal',
      text: '今日会话配额已用完，请明天再试',
      closable: false,
    });
  });

  it('权限类 403 走普通错误提示（展示后端 detail 文本）', async () => {
    stubFetch(jsonResponse(403, { detail: 'tenant mismatch' }));
    await expect(api.get(`${URL_BASE}/v1/sessions/s1`)).rejects.toThrow();
    expect(useUiStore.getState().banner).toMatchObject({
      level: 'error',
      text: 'tenant mismatch',
      closable: true,
    });
  });

  it('403 无 detail 时使用默认权限文案', async () => {
    stubFetch(new Response(null, { status: 403 }));
    await expect(api.get(`${URL_BASE}/v1/sessions/s1`)).rejects.toThrow();
    expect(useUiStore.getState().banner).toMatchObject({
      level: 'error',
      text: '无权访问该资源',
    });
  });

  it('429 弹限流警告横幅', async () => {
    stubFetch(jsonResponse(429, { detail: 'rate limited' }));
    await expect(api.get(`${URL_BASE}/v1/sessions/s1`)).rejects.toThrow();
    expect(useUiStore.getState().banner).toMatchObject({
      level: 'warning',
      text: '请求过于频繁，请稍后再试',
    });
  });

  it('429 带 Retry-After 头时横幅拼入等待时间（E2）', async () => {
    stubFetch(
      new Response(JSON.stringify({ detail: 'rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '30' },
      }),
    );
    await expect(api.get(`${URL_BASE}/v1/sessions/s1`)).rejects.toThrow();
    expect(useUiStore.getState().banner).toMatchObject({
      level: 'warning',
      text: '请求过于频繁，请约 30 秒后重试',
    });
  });

  it('创建会话的 429 不弹全局横幅（由 CreateDialog 就地提示，E3）', async () => {
    stubFetch(jsonResponse(429, { detail: 'concurrent limit' }));
    await expect(api.post(`${URL_BASE}/v1/sessions`)).rejects.toThrow();
    expect(useUiStore.getState().banner).toBeNull();
  });

  it('503 弹容量已满 fatal 横幅', async () => {
    stubFetch(jsonResponse(503, { detail: 'at capacity' }));
    await expect(api.get(`${URL_BASE}/v1/sessions/s1`)).rejects.toThrow();
    expect(useUiStore.getState().banner).toEqual({
      level: 'fatal',
      text: '服务暂不可用，节点容量已满',
      closable: false,
    });
  });
});

describe('extractErrorDetail', () => {
  it('提取纯文本 detail', async () => {
    const error = { response: jsonResponse(404, { detail: 'session not found' }) };
    expect(await extractErrorDetail(error)).toBe('session not found');
  });

  it('提取结构化 detail 的 message', async () => {
    const error = {
      response: jsonResponse(403, {
        detail: { code: 'daily_quota_exceeded', message: 'Daily session quota exceeded' },
      }),
    };
    expect(await extractErrorDetail(error)).toBe('Daily session quota exceeded');
  });

  it('非 JSON 响应体回退 HTTP 状态码文本', async () => {
    const error = { response: new Response('oops', { status: 500 }) };
    expect(await extractErrorDetail(error)).toBe('HTTP 500');
  });

  it('普通 Error 返回 message', async () => {
    expect(await extractErrorDetail(new Error('boom'))).toBe('boom');
  });
});

describe('parseRetryAfter', () => {
  it('纯秒数直接解析', () => {
    expect(parseRetryAfter('45')).toBe(45);
  });

  it('HTTP 日期换算为等待秒数', () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    const waitS = parseRetryAfter(future);
    expect(waitS).toBeGreaterThanOrEqual(88);
    expect(waitS).toBeLessThanOrEqual(90);
  });

  it('无法解析时返回 null', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('not-a-date')).toBeNull();
  });
});

describe('extractRetryAfter', () => {
  it('从 HTTPError 响应头提取等待秒数', () => {
    const error = {
      response: new Response(null, { status: 503, headers: { 'Retry-After': '120' } }),
    };
    expect(extractRetryAfter(error)).toBe(120);
  });

  it('无 Retry-After 头返回 null', () => {
    const error = { response: new Response(null, { status: 503 }) };
    expect(extractRetryAfter(error)).toBeNull();
  });

  it('非 HTTP 错误返回 null', () => {
    expect(extractRetryAfter(new Error('boom'))).toBeNull();
    expect(extractRetryAfter(null)).toBeNull();
  });
});

describe('extractErrorCode', () => {
  it('提取结构化 detail 的 code', async () => {
    const error = {
      response: jsonResponse(403, {
        detail: { code: 'daily_quota_exceeded', message: 'quota' },
      }),
    };
    expect(await extractErrorCode(error)).toBe('daily_quota_exceeded');
  });

  it('纯文本 detail / 非 HTTP 错误返回 null', async () => {
    const error = { response: jsonResponse(404, { detail: 'not found' }) };
    expect(await extractErrorCode(error)).toBeNull();
    expect(await extractErrorCode(new Error('boom'))).toBeNull();
  });
});
