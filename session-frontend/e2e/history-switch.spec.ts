// E2E：session-frontend-history-switch（P5 任务 5.2）。
// 覆盖：切换主流程（历史回显 + 去重 + 侧栏让位刷新）、只读回看与关闭保留
// 四不变量、4430 无自动重连、不可恢复置灰、文件面板（archive+stale+直链）。
// 场景数据经 mock-backend 的 POST /__mock/seed 预置。

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

/** 欢迎页输入 API Key 并进入主应用。 */
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('API Key', { exact: true }).fill(API_KEY);
  await page.getByRole('button', { name: '保存' }).click();
}

/** 侧栏会话卡片（accessible name 含 title 主行）。 */
function sessionCard(page: Page, title: string) {
  return page.getByRole('button', { name: new RegExp(title) });
}

async function sendMessage(page: Page, text: string) {
  await page.getByLabel('消息输入').fill(text);
  await page.getByLabel('发送').click();
}

test('切换主流程：历史回显 + 补发去重 + 侧栏让位刷新', async ({ page, request }) => {
  await seedSession(request, { status: 'live', turn_count: 1, title: 'A-live 会话' });
  await seedSession(request, { status: 'cold', turn_count: 3, title: 'B-cold 会话' });
  await login(page);

  // 点 B（cold, resumable）→ 三步串行：先历史回显，后 WS 建连就绪
  await sessionCard(page, 'B-cold 会话').click();
  await expect(page.getByText('历史消息 1', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('历史回答 3', { exact: true })).toBeVisible();
  await expect(page.locator('[data-ws-status="ready"]')).toBeVisible({ timeout: 10_000 });

  // 补发去重：WS 就绪后历史 3 轮不重复回显（同 turn_index 不重复建消息）
  await expect(page.getByText('历史回答 1', { exact: true })).toHaveCount(1);
  await expect(page.getByText('历史回答 3', { exact: true })).toHaveCount(1);

  // 唤醒后输入可用，续聊轮次追加在历史之后
  await sendMessage(page, '继续');
  await expect(page.getByText('Echo: 继续')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('历史回答 3', { exact: true })).toHaveCount(1);

  // 侧栏让位刷新（F3.5）：B 唤醒后 session_ready 触发列表刷新，A 变休眠
  await expect(
    sessionCard(page, 'A-live 会话').locator('[data-status="cold"]'),
  ).toBeVisible({ timeout: 10_000 });
});

test('只读回看：closed 会话历史可见、输入禁用、不建连', async ({ page, request }) => {
  await seedSession(request, { status: 'closed', turn_count: 2, title: 'C-closed 会话' });
  await login(page);

  await sessionCard(page, 'C-closed 会话').click();
  // 历史照常回显；输入栏禁用并提示只读
  await expect(page.getByText('历史回答 2', { exact: true })).toBeVisible({ timeout: 10_000 });
  const input = page.getByLabel('消息输入');
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute('placeholder', /只读/);
  await expect(page.getByText('会话已关闭，不可再对话', { exact: false })).toBeVisible();
  // 不发起 WS 连接（状态栏保持未连接）
  await expect(page.locator('[data-ws-status="idle"]')).toBeVisible();
  // 卡片只读徽标
  await expect(
    sessionCard(page, 'C-closed 会话').locator('[data-variant="readonly"]'),
  ).toBeVisible();
});

test('关闭保留四不变量：live 会话关闭后留列表、历史不清、不重连、文件面板可开', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: '新建会话' }).click();
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('[data-ws-status="ready"]')).toBeVisible({ timeout: 10_000 });

  await sendMessage(page, '保留测试');
  await expect(page.getByText('Echo: 保留测试')).toBeVisible({ timeout: 10_000 });

  // /close → 确认关闭
  await sendMessage(page, '/close');
  await page.getByTestId('confirm-dialog').getByRole('button', { name: '关闭会话' }).click();

  // ① 会话仍留在侧栏（只读徽标），未被移除
  const card = page.locator('[aria-current="true"]').first();
  await expect(card).toBeVisible();
  await expect(card.locator('[data-variant="readonly"]')).toBeVisible({ timeout: 10_000 });
  // ② 历史消息未清空
  await expect(page.getByText('Echo: 保留测试')).toBeVisible();
  // ③ 不再保持 / 发起 WS 连接，输入栏转只读禁用
  await expect(page.locator('[data-ws-status="ready"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByLabel('消息输入')).toBeDisabled();
  // ④ 文件面板仍可打开（closed 会话回看归档，此处为空态）
  await page.getByRole('button', { name: '文件' }).click();
  await expect(page.getByRole('dialog', { name: '工作区文件' })).toBeVisible();
  await expect(page.getByText('暂无文件归档')).toBeVisible({ timeout: 10_000 });
});

test('4430 准入失败：提示并发配额已满且无自动重连', async ({ page, request }) => {
  await seedSession(request, {
    status: 'cold',
    turn_count: 1,
    title: 'D-quota 会话',
    ws_scenario: 'quota_4430',
  });
  await login(page);

  await sessionCard(page, 'D-quota 会话').click();
  // error 帧(code) 映射中文文案落系统消息；状态机置 quota_exceeded
  await expect(page.locator('[data-ws-status="quota_exceeded"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/并发配额已满：另一会话正在执行任务/)).toBeVisible();

  // 无自动重连：静置后状态仍为 quota_exceeded，未进入 connecting/reconnecting
  await page.waitForTimeout(3_000);
  await expect(page.locator('[data-ws-status="quota_exceeded"]')).toBeVisible();
  await expect(page.locator('[data-ws-status="reconnecting"]')).toHaveCount(0);
  await expect(page.locator('[data-ws-status="connecting"]')).toHaveCount(0);
});

test('不可恢复置灰：resumable=false 且非只读，仅回显历史不建连', async ({ page, request }) => {
  await seedSession(request, {
    status: 'cold',
    turn_count: 1,
    title: 'E-lost 会话',
    resumable: false,
    read_only: false,
  });
  await login(page);

  const card = sessionCard(page, 'E-lost 会话');
  await expect(card.locator('[data-variant="unrecoverable"]')).toBeVisible();

  await card.click();
  // 历史照常回显，但不发起 WS 建连（canConnectSession=false）
  await expect(page.getByText('历史回答 1', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_000);
  await expect(page.locator('[data-ws-status="idle"]')).toBeVisible();
});

test('文件面板：archive 源 + stale 提示 + ?api_key= 直链 + prefix 过滤', async ({
  page,
  request,
}) => {
  await seedSession(request, {
    status: 'closed',
    turn_count: 1,
    title: 'F-files 会话',
    files_source: 'archive',
    files_stale: true,
    files: [
      { path: 'output/final.mp4', size: 2048 },
      { path: 'logs/run.log', size: 100 },
    ],
  });
  await login(page);

  await sessionCard(page, 'F-files 会话').click();
  await page.getByRole('button', { name: '文件' }).click();

  const panel = page.getByRole('dialog', { name: '工作区文件' });
  await expect(panel).toBeVisible();
  // archive 角标 + stale 落后提示（F5.3）
  await expect(panel.getByText(/^归档快照/)).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByText('文件为最近归档快照，可能落后最新一轮')).toBeVisible();
  // 文件列表与 ?api_key= 下载直链（F5.4）
  await expect(panel.getByText('output/final.mp4')).toBeVisible();
  await expect(panel.getByLabel('下载 output/final.mp4')).toHaveAttribute(
    'href',
    /workspace\/files\/output\/final\.mp4\?api_key=/,
  );
  // prefix 过滤（服务端过滤，300ms 防抖后重拉）
  await panel.getByLabel('路径前缀过滤').fill('output/');
  await expect(panel.getByText('logs/run.log')).toHaveCount(0, { timeout: 10_000 });
  await expect(panel.getByText('output/final.mp4')).toBeVisible();
});
