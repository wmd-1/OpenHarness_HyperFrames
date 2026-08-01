import { expect, type Page } from '@playwright/test';

/**
 * 真实后端 E2E 共享工具。
 *
 * 所有后端交互（创建/查询会话、工作区文件）直接走真实 session-service（:8001），
 * 由编排脚本 `e2e/run-design-frontend-real-backend-tests.sh` 拉起。前端 UI 经 :3001
 * dev server 反代 /v1 -> 真实后端。严禁使用 mock-backend。
 */
export const API_KEY = process.env.E2E_API_KEY || 'test-key';
export const FRONTEND_URL = `http://localhost:${process.env.E2E_PORT || 3001}`;
export const SESSION_BASE = 'http://localhost:8001';
export const AUTH_STORAGE_KEY = 'da.apiKey';
export const CURRENT_SESSION_KEY = 'da.currentSessionId';

type Json = Record<string, any>;

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${SESSION_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/** 真实创建会话（走真实后端）。返回 session_id 与 ws_url。 */
export async function createSessionViaApi(title = 'e2e-real'): Promise<Json> {
  const { status, data } = await api('POST', '/v1/sessions', {
    title,
    permission_policy: 'full_auto',
  });
  if (status !== 201) {
    throw new Error(`createSessionViaApi failed: ${status} ${JSON.stringify(data)}`);
  }
  return data;
}

/** 指定权限策略创建会话（A1 审批流需 interactive）。 */
export async function createSessionViaApiWithPolicy(
  title = 'e2e-real',
  policy: string = 'full_auto',
): Promise<Json> {
  const { status, data } = await api('POST', '/v1/sessions', {
    title,
    permission_policy: policy,
  });
  if (status !== 201) {
    throw new Error(`createSessionViaApiWithPolicy failed: ${status} ${JSON.stringify(data)}`);
  }
  return data;
}

/** 不抛异常的创建（带查询参数，用于故障注入 ?fault=403/503）。 */
export async function tryCreateWithFault(
  fault: string,
  policy: string = 'full_auto',
): Promise<{ status: number; data: any }> {
  return api('POST', `/v1/sessions?fault=${fault}`, {
    title: `e2e-fault-${fault}`,
    permission_policy: policy,
  });
}

/** 不抛异常的创建：返回 { status, session_id? }，用于并发配额断言。 */
export async function tryCreateSessionViaApi(title = 'e2e-real'): Promise<{
  status: number;
  session_id?: string;
}> {
  const { status, data } = await api('POST', '/v1/sessions', {
    title,
    permission_policy: 'full_auto',
  });
  return { status, session_id: data?.session_id };
}

export async function getSessionViaApi(sessionId: string): Promise<Json> {
  const { status, data } = await api('GET', `/v1/sessions/${sessionId}`);
  if (status !== 200) throw new Error(`getSession ${sessionId}: ${status}`);
  return data;
}

/** 真实轮次历史（走真实后端 /v1/sessions/{id}/turns；响应体为 { items: [...] }）。 */
export async function listTurnsViaApi(sessionId: string): Promise<Json[]> {
  const { status, data } = await api('GET', `/v1/sessions/${sessionId}/turns`);
  if (status !== 200) throw new Error(`listTurns ${sessionId}: ${status}`);
  return (data?.items as Json[]) || [];
}

export async function listSessionsViaApi(): Promise<Json[]> {
  const { status, data } = await api('GET', '/v1/sessions');
  if (status !== 200) throw new Error(`listSessions: ${status}`);
  return (data?.sessions as Json[]) || [];
}

export async function workspaceFilesViaApi(sessionId: string): Promise<Json[]> {
  const { status, data } = await api('GET', `/v1/sessions/${sessionId}/workspace/files`);
  if (status !== 200) throw new Error(`workspaceFiles ${sessionId}: ${status}`);
  return (data?.files as Json[]) || [];
}

/** 产物流式直链（真实后端 /v1/sessions/{sid}/turns/{turnIndex}/artifact?mode=stream）。 */
export function artifactUrl(sessionId: string, turnIndex: number): string {
  return `${FRONTEND_URL}/v1/sessions/${sessionId}/turns/${turnIndex}/artifact?api_key=${API_KEY}&mode=stream`;
}

/** 预置 API Key 到 localStorage，使页面直接进入主应用（跳过手动登录）。 */
export async function preauth(page: Page, key: string = API_KEY): Promise<void> {
  await page.addInitScript(
    ([k]) => localStorage.setItem('da.apiKey', k),
    [key],
  );
}

/** 真实登录流程：在欢迎页输入 API Key 并点击「保存」进入主应用（落地到首页能力域卡片）。 */
export async function loginFlow(page: Page, key: string = API_KEY): Promise<void> {
  await page.goto('/');
  const input = page.locator('input[aria-label="API Key"]');
  await input.waitFor({ state: 'visible' });
  await input.fill(key);
  await page.getByRole('button', { name: '保存' }).click();
  // 登录后落在首页（模块卡片），而非视频模块。
  await page.getByText('文本生成视频').waitFor({ state: 'visible' });
}

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.panel-history, .btn-new-session').first().waitFor({ state: 'visible' });
}

/** 通过 UI 创建会话（真实 POST）。等待视频区与 WS 就绪。 */
export async function createSessionUi(page: Page): Promise<void> {
  // preauth 仅写入 localStorage，未导航；此处先进入视频模块（新建会话按钮所在页）再点击。
  await page.goto('/video');
  await page.locator('.btn-new-session').first().click();
  const dialog = page.getByRole('dialog', { name: '创建会话' });
  await dialog.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await waitForVideoReady(page);
}

/** 跳转到指定会话（真实 ?session_id=），等待视频区与 WS 连接。 */
export async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/video?session_id=${sessionId}`);
  await waitForVideoReady(page);
}

export async function waitForVideoReady(page: Page): Promise<void> {
  const section = page.locator('section.video-layout').first();
  await section.waitFor({ state: 'visible' });
  // 等待 WS 进入 ready/connected（stub 后端应快速连上；实际属性值为 ready）。
  await expect(section).toHaveAttribute('data-ws-status', /^(ready|connected)$/, { timeout: 30_000 });
}

/** 发送一条消息并等待 stub 真实回复（turn_complete）。 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.locator('textarea[aria-label="消息输入"]');
  await input.waitFor({ state: 'visible' });
  await input.fill(text);
  await page.locator('button[aria-label="发送"]').click();
  // 等待真实助手回复出现（stub 确定性文案）。
  await page.getByText(/Stub reply to:/).first().waitFor({ state: 'visible', timeout: 40_000 });
}

/** 全局错误横幅（排除对话框内的内联提示）。 */
export function banner(page: Page) {
  return page.getByRole('alert').filter({ hasNot: page.locator('[role="dialog"]') });
}

/** 历史面板中某个会话项。 */
export function historyItem(page: Page, sessionId: string) {
  return page.locator('.panel-history').getByText(sessionId.slice(0, 8), { exact: false }).first();
}

/** 轮询真实轮次历史，直到出现至少 `min` 条（克服 WS→REST 落库延迟）。 */
export async function waitForTurns(
  sessionId: string,
  timeout = 12_000,
  min = 1,
): Promise<Json[]> {
  const start = Date.now();
  let last: Json[] = [];
  while (Date.now() - start < timeout) {
    last = await listTurnsViaApi(sessionId);
    if (last.length >= min) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/** 关闭当前活跃会话（二次确认）：用 /close 命令触发，避开历史卡片关闭按钮的歧义。真实 DELETE -> read_only。 */
export async function closeActiveSession(page: Page): Promise<void> {
  const input = page.locator('textarea[aria-label="消息输入"]');
  await input.fill('/close');
  await page.locator('button[aria-label="发送"]').click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭会话' }).click();
  await expect(input).toBeDisabled();
}
