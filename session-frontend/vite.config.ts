import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server proxies /v1 + health endpoints to the session-service backend
// (localhost:8001). `ws: true` lets the /v1/sessions/{sid}/ws upgrade pass.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3001,
    proxy: {
      '/v1': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        ws: true,
      },
      '/healthz': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/readyz': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Terminal Mode deps stay in their own async chunk (R3).
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
        },
      },
    },
  },
});
