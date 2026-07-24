# syntax=docker/dockerfile:1
# =============================================================================
# OpenHarness HyperFrames - Frontend image (web) - STANDALONE
# Multi-stage: build the Vite/React SPA with Node, then serve the static
# bundle with nginx. nginx reverse-proxies the backend API so the SPA talks
# to the API same-origin (no CORS). The backend target is configurable via
# API_HOST / API_PORT env vars, so this image is deployable on its own
# against ANY backend - it does NOT extend the OpenHarness/backend image.
#
# Build standalone:
#   cd web && docker build -t openharness-web .
# Run standalone (point at any backend):
#   docker run -p 5173:80 -e API_HOST=my-api -e API_PORT=8000 openharness-web
# =============================================================================

# ---- Stage1: build the SPA -------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Install deps first for better layer caching. `npm ci` needs a lockfile;
# fall back to `npm install` when one is absent.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy the rest of the source and build.
COPY . .

# VITE_API_BASE is intentionally left empty by default: the SPA issues
# same-origin requests (/v1, /healthz) that nginx proxies to the backend.
# Override at build time only if you serve the API from a different origin.
ARG VITE_API_BASE=""
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

# ---- Stage: test (lint + unit tests, run INSIDE the image) -----------------
# All tests are image-based: `docker build --target test .` executes the full
# lint + vitest suite inside the container. The build fails if any test fails.
FROM build AS test
RUN npm run lint && npm run test

# ---- Stage2: serve with nginx (standalone) -----------------------------
FROM nginx:1.27-alpine AS runtime

# gettext provides `envsubst` for rendering the configurable upstream.
RUN apk add --no-cache gettext \
    && rm -f /etc/nginx/conf.d/default.conf

# nginx config template (backend host/port injected at runtime via envsubst).
# Security headers (CSP, X-Frame-Options, X-Content-Type-Options, ...) and
# `server_tokens off` are defined inside the template, so they are applied to
# every response when the container starts. See nginx.conf.template.
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
