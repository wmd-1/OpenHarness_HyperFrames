// E2E（tasks 7.2）：个人空间聚合（真实视频产物）+ ui/drawio 演示能力域冒烟。
// 演示能力域完全客户端运行（DemoAdapter），无需后端；视频产物经真实 make-video 产出。

import { expect, test, type Page } from '@playwright/test';

const API_KEY = process.env.MOCK_API_KEY ?? 'test-key';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('API Key', { exact: true }).fill(API_KEY);
  await page.getByRole('button', { name: '保存' }).click();
}

async function enterModule(page: Page, title: RegExp) {
  await page.getByRole('button', { name: title }).click();
}

test('个人空间：视频真实产物聚合展示 + 演示域角标', async ({ page }) => {
  await login(page);

  // 先在视频能力域产出一个真实产物（make-video → turn_complete.has_artifact）
  await enterModule(page, /文本生成视频/);
  await page.getByRole('button', { name: '新建会话' }).click();
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('[data-ws-status="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('消息输入').fill('make-video');
  await page.getByLabel('发送').click();
  await expect(page.getByText('Echo: make-video')).toBeVisible({ timeout: 10_000 });

  // 返回主页 → 进入个人空间（默认视频 tab）
  await page.getByLabel('返回主页').click();
  await enterModule(page, /个人空间/);

  // 视频 tab：聚合出至少一个产物卡片 + ?api_key= 下载直链
  await expect(page.locator('.space-card').first()).toBeVisible({ timeout: 10_000 });
  const dl = page.getByRole('link', { name: /下载/ }).first();
  await expect(dl).toBeVisible();
  await expect(dl).toHaveAttribute('href', /api_key=/);

  // 切到原型页面设计（demo 域）：演示数据角标
  await page.getByRole('tab', { name: /原型页面设计/ }).click();
  await expect(page.getByText('演示').first()).toBeVisible({ timeout: 10_000 });
});

test('原型页面设计：演示对话可发送并获得回复', async ({ page }) => {
  await login(page);
  await enterModule(page, /原型页面设计/);

  // demo 能力域带演示角标 + 预览按钮
  await expect(page.getByText('演示').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '预览' })).toBeVisible();

  // DemoAdapter 模拟对话：用户消息回显 + AI 回复气泡
  await page.getByLabel('消息输入').fill('设计一个登录页');
  await page.getByLabel('发送').click();
  await expect(page.locator('.msg-user').last()).toContainText('设计一个登录页');
  await expect(page.locator('.msg-ai').last()).toBeVisible({ timeout: 10_000 });
});

test('Drawio：示例流程图渲染 + 状态栏文件名', async ({ page }) => {
  await login(page);
  await enterModule(page, /Drawio设计/);

  // 演示角标 + 画布 SVG + 状态栏示例图名
  await expect(page.getByText('演示').first()).toBeVisible();
  await expect(page.locator('.drawio-preview svg').first()).toBeVisible();
  await expect(page.getByText('信贷审批流程.drawio')).toBeVisible();
});
