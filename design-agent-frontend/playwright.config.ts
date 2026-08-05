import { defineConfig, devices } from '@playwright/test';

/**
 * 真实后端 E2E 配置。
 *
 * 关键变更（相对旧版）：
 * - 移除 `node e2e/mock-backend.mjs` 假后端自动启动。本配置假定**真实 session-service 栈**
 *   已由编排脚本 `e2e/run-design-frontend-real-backend-tests.sh` 通过
 *   `docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session` 拉起。
 * - 前端经 `npm run dev`（vite）在 :3001 提供，其 `server.proxy` 将 `/v1` 反代到
 *   `localhost:8001`（真实后端）。Playwright 容器以 `--network host` 运行，使容器内
 *   `localhost:8001` 指向宿主机上真实栈的 session 服务，从而走真实 REST/WS 通道。
 * - 所有用例必须在既有 `oh-e2e-test:latest` 叠加镜像（`openharness-design-frontend:e2e`）
 *   内执行，宿主机只负责起栈与编排。
 */
// 端口由编排脚本通过 E2E_PORT 注入（避免 --network host 下固定端口被占用）。
const PORT = Number(process.env.E2E_PORT) || 3001;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './playwright-report' }],
  ],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // 浏览器模式（test-infra 控制，仅改运行模式、其余变量保持一致）：
    //  - 默认：镜像内置 chrome-headless-shell（old headless），executablePath 指定。
    //  - PW_USE_NEW_HEADLESS=1：完整 chromium + new headless（headless:true）。
    //  - PW_HEADED=1：完整 chromium + 真实有头模式（headless:false），需配合 xvfb-run
    //    提供虚拟显示；用于 BFCache 对照——仅翻转 headless/headed，二进制与 --no-sandbox 不变。
    //  - E2E_BFCACHE=1：移除 Playwright 默认注入的 `--disable-back-forward-cache`，
    //    让 chromium 真正启用 BFCache（test-infra 2026-08-05 推进确认其为 BF3 未命中的根因）。
    //    默认关闭，避免影响其余 E2E 用例（冻结页会干扰 Playwright 的 reload/inspect）。
    ...(process.env.PW_USE_NEW_HEADLESS === '1' || process.env.PW_HEADED === '1'
      ? {
          channel: 'chromium',
          headless: process.env.PW_HEADED !== '1',
          launchOptions: {
            args: ['--no-sandbox'],
            ...(process.env.E2E_BFCACHE === '1'
              ? { ignoreDefaultArgs: ['--disable-back-forward-cache'] }
              : {}),
          },
        }
      : {
          launchOptions: {
            executablePath: process.env.PW_CHROMIUM_PATH || undefined,
            args: ['--no-sandbox'],
            ...(process.env.E2E_BFCACHE === '1'
              ? { ignoreDefaultArgs: ['--disable-back-forward-cache'] }
              : {}),
          },
        }),
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // 仅启动前端 dev server；真实后端由编排脚本预先拉起。
  webServer: {
    command: `npm run dev -- --port ${PORT} --host`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
