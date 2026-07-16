import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the backend API to the running service container
// (docker compose maps the api service to host port 8000). In production
// set VITE_API_BASE to the public API URL and configure OH_CORS_ORIGINS
// on the backend to allow this origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://localhost:8000", changeOrigin: true },
      "/healthz": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
});
