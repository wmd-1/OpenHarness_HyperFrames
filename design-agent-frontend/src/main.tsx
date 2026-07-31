// 应用入口（task 11.2）：StrictMode → ThemeProvider → App。
// StrictMode 开发态双挂载可提前暴露 effect 清理缺陷（D1）；
// useWebSocket 的 effect 清理会 dispose 旧连接，不会产生双活 WS。

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './theme/ThemeProvider';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
