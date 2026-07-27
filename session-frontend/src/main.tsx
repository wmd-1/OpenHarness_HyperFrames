// 应用入口（task 11.2）：ThemeProvider → App。
// 不启用 StrictMode：避免开发态双挂载导致 WS 重复建连/断开噪音。

import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './theme/ThemeProvider';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

createRoot(container).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
