// Playwright E2E 配置（task 12.1/12.8）。
//
// 两种运行方式：
// 1. 本地/镜像内：自动拉起 mock 后端(:8001) + vite preview(:3001)，
//    preview 继承 vite.config server.proxy，将 /v1、/healthz 代理到 mock。
// 2. Docker E2E（PW_BASE_URL 已设置）：直接打已启动的运行时容器
//    （nginx 反代 mock 后端容器），不再拉起本地服务。

import { defineConfig, devices } from '@playwright/test';

const externalBaseUrl = process.env.PW_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://localhost:3001';

// 镜像内运行时指向镜像自带的 chrome-headless-shell（oh-e2e-test:latest），
// 未设置时由 Playwright 解析自己安装的浏览器。
const chromiumPath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  // mock 后端为单实例共享状态（含 /__mock/reset 隔离）；单 worker 串行执行，
  // 避免多 spec 文件并行时相互清空/污染会话状态。
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalBaseUrl
    ? undefined
    : [
        {
          command: 'node e2e/mock-backend.mjs',
          port: 8001,
          reuseExistingServer: true,
          timeout: 15_000,
        },
        {
          command: 'npm run preview -- --port 3001 --strictPort',
          port: 3001,
          reuseExistingServer: true,
          timeout: 30_000,
        },
      ],
});
