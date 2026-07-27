// 测试全局 setup：jest-dom 断言 + 每用例后清理 DOM / localStorage。

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
