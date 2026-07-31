// E2E（tasks 7.2）：主页导航 + 视频能力域全链路 + 断线重连 + 认证恢复。
// 后端由 e2e/mock-backend.mjs 模拟（协议对齐 session-service）。
// 注意：本平台主页（/）为四模块卡片，视频工作台在 /video；WS 连接态经
// VideoModulePage 根节点的 data-ws-status 暴露（PlatformLayout 无 StatusBar）。

import { expect, test, type Page } from '@playwright/test';

const API_KEY = process.env.MOCK_API_KEY ?? 'test-key';

/** 欢迎页输入 API Key 并进入主应用。 */
async function login(page: Page, apiKey = API_KEY) {
  await page.goto('/');
  await page.getByLabel('API Key', { exact: true }).fill(apiKey);
  await page.getByRole('button', { name: '保存' }).click();
}

/** 主页点模块卡片进入能力域（卡片 accessible name 含标题）。 */
async function enterModule(page: Page, title: RegExp) {
  await page.getByRole('button', { name: title }).click();
}

/** 在视频能力域新建 full_auto 会话并等待 WS 就绪。 */
async function createSession(page: Page) {
  await page.getByRole('button', { name: '新建会话' }).click();
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('[data-ws-status="ready"]')).toBeVisible({ timeout: 10_000 });
}

async function sendMessage(page: Page, text: string) {
  await page.getByLabel('消息输入').fill(text);
  await page.getByLabel('发送').click();
}

test('主页：四模块卡片渲染并可进入视频能力域', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: '设计智能体工作台' })).toBeVisible();
  // 三个能力域 + 平台级「个人空间」共四张卡片
  for (const name of ['原型页面设计', 'Drawio设计', '文本生成视频', '个人空间']) {
    await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  }
  // demo 能力域带「演示」角标（GA 视频域不带）
  await expect(page.getByText('演示').first()).toBeVisible();

  await enterModule(page, /文本生成视频/);
  await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible();
});

test('视频全链路：建会话 → 流式回复 → 产物轮次自动展开预览与下载', async ({ page }) => {
  await login(page);
  await enterModule(page, /文本生成视频/);
  await createSession(page);

  await sendMessage(page, '你好');
  await expect(page.getByText('你好', { exact: true })).toBeVisible();
  await expect(page.getByText('Echo: 你好')).toBeVisible({ timeout: 10_000 });
  // P0-1：final envelope 覆盖语义——恰为单份全文，无重复拼接
  await expect(page.getByText('Echo: 你好Echo: 你好')).toHaveCount(0);
  await expect(page.getByText('Echo: 你好')).toHaveCount(1);

  // make-video 轮次：turn_complete.has_artifact=true
  await sendMessage(page, 'make-video');
  await expect(page.getByText('Echo: make-video')).toBeVisible({ timeout: 10_000 });

  // 气泡内嵌视频 + ?api_key= 直链认证（A2）
  const video = page.locator('video').first();
  await expect(video).toBeVisible({ timeout: 10_000 });
  await expect(video).toHaveAttribute('src', /api_key=/);
  await expect(page.getByRole('button', { name: '下载产物' })).toBeVisible();
  // spec：has_artifact 自动展开右侧预览面板（新增一个预览播放器 <video>）
  await expect(page.locator('video')).toHaveCount(2, { timeout: 10_000 });

  // 普通轮次（无产物）不新增视频
  await sendMessage(page, '续聊');
  await expect(page.getByText('Echo: 续聊')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('video')).toHaveCount(2);
});

test('断线重连：force-drop 掉线后自动恢复并可继续对话', async ({ page }) => {
  await login(page);
  await enterModule(page, /文本生成视频/);
  await createSession(page);

  // 服务端结束轮次后掐断 TCP（1006）→ 先确认掉线，再等指数退避自动重连
  await sendMessage(page, 'force-drop');
  await expect(page.locator('[data-ws-status="reconnecting"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-ws-status="ready"]')).toBeVisible({ timeout: 15_000 });

  await sendMessage(page, '回来了');
  await expect(page.getByText('Echo: 回来了')).toBeVisible({ timeout: 10_000 });
});

test('错误恢复：无效 API Key 触发 401 后回认证页并可重新认证', async ({ page }) => {
  await login(page, 'wrong-key');
  // 进入视频域后才拉取会话列表 → 401 → 清 Key 回欢迎页
  await enterModule(page, /文本生成视频/);
  await expect(page.getByTestId('auth-expired-notice')).toBeVisible({ timeout: 10_000 });

  // 重新认证后回到视频工作台（URL 仍为 /video），可正常对话
  await page.getByLabel('API Key', { exact: true }).fill(API_KEY);
  await page.getByRole('button', { name: '保存' }).click();
  await createSession(page);
  await sendMessage(page, '恢复');
  await expect(page.getByText('Echo: 恢复')).toBeVisible({ timeout: 10_000 });
});
