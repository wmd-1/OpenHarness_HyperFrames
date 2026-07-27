// Vitest 配置（task 12.1）：jsdom 环境 + Testing Library。
// 所有测试在 Docker 镜像内运行（Dockerfile test 阶段 / e2e 脚本）。

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
