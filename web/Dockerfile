# syntax=docker/dockerfile:1
# =============================================================================
# OpenHarness HyperFrames - Frontend image (web)
# Multi-stage: build the Vite/React SPA with Node, then serve the static
# bundle with nginx. nginx also reverse-proxies the backend API so the SPA
# talks to the API same-origin (no CORS, no VITE_API_BASE needed).
# =============================================================================

# ---- Stage 1: build the SPA -------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Install deps first for better layer caching. Fall back to `npm install`
# when there is no lockfile (npm ci requires package-lock.json).
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy the rest of the source and build.
COPY . .

# VITE_API_BASE is intentionally left empty by default: the SPA issues
# same-origin requests (/v1, /healthz) that nginx proxies to the api service.
# Override at build time only if you serve the API from a different origin.
ARG VITE_API_BASE=""
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

# ---- Stage 2: serve with nginx ---------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Replace the default site config with our SPA + reverse-proxy config.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/app.conf

# Copy the built static assets.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Basic container healthcheck against the SPA entrypoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
