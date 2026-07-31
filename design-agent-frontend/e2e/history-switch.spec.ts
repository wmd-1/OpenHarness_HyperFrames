// E2E（tasks 7.2）：历史会话切换 / 只读回看 / WS 准入失败（4430 配额、4503 容量）。
// 场景数据经 mock-backend 的 POST /__mock/seed 预置；会话卡片标题为「会话 <sid8>」。

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API_KEY = process.env.MOCK_API_KEY ?? 'test-key';
// /__mock/* 不经 vite 代理，直连 mock 后端（镜像内 webServer 同机 :8001）
const MOCK_URL = process.env.MOCK_BACKEND_URL ?? 'http://127.0.0.1:8001';

/** 预置一个历史会话（状态/轮次/文件/WS 准入场景开关）。 */
async function seedSession(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ session_id: string }> {
  const resp = await request.post(`${MOCK_URL}/__mock/seed`, {
    headers: { 'X-API-Key': API_KEY },
    data: body,
  });
  expect(resp.status()).toBe(201);
  return resp.json();
}

// 每例前清空 mock 会话：sid 形如 mock-000N，「会话 <sid8>」标题在累积后会碰撞，
// 隔离后每例仅一个会话，卡片定位唯一。
test.beforeEach(async ({ request }) => {
  const resp = await request.post(`${MOCK_URL}/__mock/reset`, {
    headers: { 'X-API-Key': API_KEY },
  });
  expect(resp.status()).toBe(200);
});

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('API Key', { exact: true }).fill(API_KEY);
  await page.getByRole('button', { name: '保存' }).click();
}

/** 进入视频能力域（主页卡片导航）。 */
async function enterVideo(page: Page) {
  await page.getByRole('button', { name: /文本生成视频/ }).click();
  await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible();
}

/** 侧栏会话卡片：定位 history-item 卡片本体（排除内部「关闭会话」按钮）。 */
function sessionCard(page: Page, sid: string) {
  return page.locator('.history-item').filter({ hasText: `会话 ${sid.slice(0, 8)}` });
}

test('只读回看：closed 会话历史可见、输入禁用、不建连', async ({ page, request }) => {
  const { session_id } = await seedSession(request, { status: 'closed', turn_count: 2 });
  await login(page);
  await enterVideo(page);

  await sessionCard(page, session_id).click();
  // 历史照常回显
  await expect(page.getByText('历史回答 2', { exact: true })).toBeVisible({ timeout: 10_000 });
  // 输入栏禁用并提示只读
  const input = page.getByLabel('消息输入');
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute('placeholder', /只读/);
  await expect(page.getByText('会话已关闭，不可再对话', { exact: false })).toBeVisible();
  // 不发起 WS 连接（能力域根节点连接态保持 idle）
  await expect(page.locator('[data-ws-status="idle"]')).toBeVisible();
});

test('切换回显：cold 会话历史回显 + WS 唤醒就绪 + 补发去重', async ({ page, request }) => {
  const { session_id } = await seedSession(request, { status: 'cold', turn_count: 3 });
  await login(page);
  await enterVideo(page);

  await sessionCard(page, session_id).click();
  // 三步串行：先历史回显，后 WS 建连就绪
  await expect(page.getByText('历史消息 1', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('历史回答 3', { exact: true })).toBeVisible();
  await expect(page.locator('[data-ws-status="ready"]')).toBeVisible({ timeout: 10_000 });
  // 补发去重：同 turn_index 不重复建消息
  await expect(page.getByText('历史回答 1', { exact: true })).toHaveCount(1);
  await expect(page.getByText('历史回答 3', { exact: true })).toHaveCount(1);

  // 唤醒后续聊追加在历史之后
  await page.getByLabel('消息输入').fill('继续');
  await page.getByLabel('发送').click();
  await expect(page.getByText('Echo: 继续')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('历史回答 3', { exact: true })).toHaveCount(1);
});

test('4430 准入失败：提示并发配额已满且无自动重连', async ({ page, request }) => {
  const { session_id } = await seedSession(request, {
    status: 'cold',
    turn_count: 1,
    ws_scenario: 'quota_4430',
  });
  await login(page);
  await enterVideo(page);

  await sessionCard(page, session_id).click();
  // error 帧(code) 映射中文文案落系统消息；状态机置 quota_exceeded
  await expect(page.locator('[data-ws-status="quota_exceeded"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/并发配额已满/)).toBeVisible();

  // 无自动重连：静置后仍为 quota_exceeded，未进入 connecting/reconnecting
  await page.waitForTimeout(3_000);
  await expect(page.locator('[data-ws-status="quota_exceeded"]')).toBeVisible();
  await expect(page.locator('[data-ws-status="reconnecting"]')).toHaveCount(0);
  await expect(page.locator('[data-ws-status="connecting"]')).toHaveCount(0);
});

test('4503 容量已满：进入有界重连（15s 固定间隔）', async ({ page, request }) => {
  const { session_id } = await seedSession(request, {
    status: 'cold',
    turn_count: 1,
    ws_scenario: 'capacity_4503',
  });
  await login(page);
  await enterVideo(page);

  await sessionCard(page, session_id).click();
  // 4503 不同于 4430：进入固定 15s 有界重试（reconnecting），非即时终态
  await expect(page.locator('[data-ws-status="reconnecting"]')).toBeVisible({ timeout: 10_000 });
});
