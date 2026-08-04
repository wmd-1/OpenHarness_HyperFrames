# syntax=docker/dockerfile:1
# =============================================================================
# OpenHarness Design Agent Frontend - image (design-agent-frontend) - STANDALONE
# Multi-stage:
#   build   : compile the Vite/React SPA with Node
#   test    : lint + vitest suite run INSIDE the image (build fails on failure)
#   e2e     : Playwright E2E, based on oh-e2e-test:latest which already ships
#             Node 22 + chrome-headless-shell (no browser download needed)
#   runtime : serve the static bundle with nginx; nginx reverse-proxies the
#             session-service REST + WebSocket API same-origin (no CORS) for the
#             video capability domain. The backend target is configurable via
#             SESSION_HOST/SESSION_PORT (demo domains run fully client-side).
#
# Build standalone:
#   cd design-agent-frontend && docker build -t openharness-design-frontend .
# Run standalone (point at any session-service):
#   docker run -p 5175:80 -e SESSION_HOST=my-host -e SESSION_PORT=8001 \
#     openharness-design-frontend
# =============================================================================

# Global build args (must precede the first FROM to be usable in FROM lines).
# CI can override the E2E base image (e.g. mcr.microsoft.com/playwright) and
# clear PW_CHROMIUM_PATH to use the base image's own browsers instead.
ARG E2E_BASE_IMAGE=oh-e2e-test:latest
ARG PW_CHROMIUM_PATH=/opt/chrome-headless-shell-linux64/chrome-headless-shell

# ---- Stage: build the SPA ---------------------------------------------------
FROM node:22-alpine AS build

# Version stamp build args (P1-3). APP_VERSION's source of truth is
# package.json `version` (used when the arg is left empty); GIT_SHA/BUILD_TIME
# default to "unknown" so a plain local build still emits a complete
# version.json. The e2e pipeline passes real values (git rev-parse / date -u).
ARG APP_VERSION=
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown

WORKDIR /app

# Install deps first for better layer caching. `npm ci` needs a lockfile;
# fall back to `npm install` when one is absent.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy the rest of the source and build.
COPY . .
RUN npm run build

# Emit dist/version.json for runtime version probing (nginx serves it with
# Cache-Control: no-store, see nginx.conf.template).
RUN node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));const out={version:process.env.APP_VERSION||pkg.version||'unknown',git_sha:process.env.GIT_SHA||'unknown',build_time:process.env.BUILD_TIME||'unknown'};fs.writeFileSync('dist/version.json',JSON.stringify(out)+'\n');console.log('version.json:',JSON.stringify(out))"

# ---- Stage: test (lint + unit/integration tests, run INSIDE the image) ------
# All tests are image-based: `docker build --target test .` executes the full
# lint + vitest suite inside the container. The build fails if any test fails.
FROM build AS test
RUN npm run lint && npm run test

# ---- Stage: e2e (Playwright, browser comes from the base image) -------------
# oh-e2e-test:latest ships Node 22 + chrome-headless-shell (Chrome for
# Testing), so no `playwright install` / browser download is required.
FROM ${E2E_BASE_IMAGE} AS e2e
ARG PW_CHROMIUM_PATH
ARG INSTALL_FULL_CHROMIUM=0

WORKDIR /app

# npm ci inside THIS image so native deps (esbuild, rollup) match its libc.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

# BFCache 验证（test-infra change 2026-08-04-e2e-chromium-new-headless-bfcache）：
# 在既有基础镜像之上安装完整 chromium（new headless 支持 BFCache）。默认关闭，
# 不影响既有的 chrome-headless-shell 路径；非从零重建基础镜像。
RUN if [ "${INSTALL_FULL_CHROMIUM}" = "1" ]; then \
      npx playwright install chromium && \
      (npx playwright install-deps chromium || true); \
    fi

RUN npm run build

# playwright.config.ts uses PW_CHROMIUM_PATH as launchOptions.executablePath
# when set; when empty, Playwright resolves its own installed browsers.
ENV PW_CHROMIUM_PATH=${PW_CHROMIUM_PATH}
ENV CI=1

# The oh-e2e-test base image has an `oh-role` entrypoint - override it.
ENTRYPOINT []
CMD ["npx", "playwright", "test"]

# ---- Stage: serve with nginx (standalone) ------------------------------
FROM nginx:1.27-alpine AS runtime

# gettext provides `envsubst` for rendering the configurable upstream.
RUN apk add --no-cache gettext \
    && rm -f /etc/nginx/conf.d/default.conf

# nginx config template (session-service host/port injected at runtime via
# envsubst). Security headers and `server_tokens off` are defined inside the
# template. See nginx.conf.template.
COPY nginx.conf.template /etc/nginx/templates/app.conf.template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Built static assets from the build stage.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Basic container healthcheck against the SPA entrypoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
