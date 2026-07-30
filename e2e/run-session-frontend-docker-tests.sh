#!/usr/bin/env bash
# =============================================================================
# Session Frontend FULL image-based test pipeline (task 12.9 / 13.x).
#
# All tests run inside Docker images -- nothing executes on the host except
# `docker` and `curl`:
#
#   1. Unit/lint stage : `docker build --target test`  -> lint + vitest (83
#                        tests) INSIDE the node build image; build fails on
#                        any failure (tsc runs as part of `vite build`).
#   2. Runtime image   : build (or reuse) the nginx runtime image.
#   3. Smoke stage     : boot the runtime image and assert HTTP 200 + SPA
#                        entrypoint + security headers via curl.
#   4. E2E stage       : `docker build --target e2e` (base image
#                        oh-e2e-test:latest, ships Node 22 +
#                        chrome-headless-shell), then `docker run` executes
#                        Playwright: mock backend(:8001) + vite preview(:3001)
#                        are started inside the container by playwright's
#                        webServer config.
#
# Usage:
#   bash e2e/run-session-frontend-docker-tests.sh
#     -> builds test stage + fresh runtime image, smoke-tests it, runs E2E.
#
#   SESSION_FRONTEND_IMAGE=openharness_session_frontend:v0.1.0 \
#     bash e2e/run-session-frontend-docker-tests.sh
#     -> unit tests still run in the build image, but the smoke test reuses
#        the EXISTING runtime image (no runtime rebuild).
#
#   SKIP_E2E=1 bash e2e/run-session-frontend-docker-tests.sh
#     -> skip stage 4 (e.g. when oh-e2e-test:latest is unavailable).
#
#   E2E_BASE_IMAGE=mcr.microsoft.com/playwright:v1.50.1-noble \
#   PW_CHROMIUM_PATH= bash e2e/run-session-frontend-docker-tests.sh
#     -> run E2E on a different base image using its own browsers.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/session-frontend"
TEST_IMAGE="openharness-session-frontend:test"
E2E_IMAGE="openharness-session-frontend:e2e"
E2E_BASE_IMAGE="${E2E_BASE_IMAGE:-oh-e2e-test:latest}"
SMOKE_NAME="session-frontend-smoke"
SMOKE_PORT="${SMOKE_PORT:-5199}"

echo "=============================================="
echo " [1/4] Unit tests + lint (inside Docker image)"
echo "=============================================="
docker build --target test -t "${TEST_IMAGE}" "${FRONTEND_DIR}"
echo "==> lint + vitest passed inside ${TEST_IMAGE}"

echo "=============================================="
echo " [2/4] Runtime image"
echo "=============================================="
if [ -n "${SESSION_FRONTEND_IMAGE:-}" ]; then
  echo "==> Reusing existing runtime image: ${SESSION_FRONTEND_IMAGE}"
  REUSED_IMAGE=1
else
  REUSED_IMAGE=""
  # Tag 经 SESSION_FRONTEND_VERSION 参数化（与 docker-compose.yml / .env.example 对齐）。
  SESSION_FRONTEND_IMAGE="openharness_session_frontend:${SESSION_FRONTEND_VERSION:-v0.1.0}"
  # Version stamp for dist/version.json (P1-3): real git sha + UTC build time.
  GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
  BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  docker build --target runtime \
    --build-arg "GIT_SHA=${GIT_SHA}" --build-arg "BUILD_TIME=${BUILD_TIME}" \
    -t "${SESSION_FRONTEND_IMAGE}" "${FRONTEND_DIR}"
  echo "==> Built runtime image: ${SESSION_FRONTEND_IMAGE}"
fi

echo "=============================================="
echo " [3/4] Smoke test (SPA + security headers)"
echo "=============================================="
docker rm -f "${SMOKE_NAME}" >/dev/null 2>&1 || true
# SESSION_HOST is an IP so nginx starts fine without resolving a hostname.
docker run -d --name "${SMOKE_NAME}" \
  -e SESSION_HOST=127.0.0.1 -e SESSION_PORT=9 \
  -p "127.0.0.1:${SMOKE_PORT}:80" \
  "${SESSION_FRONTEND_IMAGE}" >/dev/null
cleanup_smoke() { docker rm -f "${SMOKE_NAME}" >/dev/null 2>&1 || true; }
trap cleanup_smoke EXIT

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${SMOKE_PORT}/" >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 30 ]; then
    echo "!! smoke: container did not become ready"; docker logs "${SMOKE_NAME}"; exit 1
  fi
  sleep 1
done

BODY="$(curl -fsS "http://127.0.0.1:${SMOKE_PORT}/")"
echo "${BODY}" | grep -q '<div id="root">' || { echo "!! smoke: SPA entrypoint missing"; exit 1; }
HEADERS="$(curl -fsSI "http://127.0.0.1:${SMOKE_PORT}/")"
for h in "X-Content-Type-Options: nosniff" "X-Frame-Options: DENY" "Content-Security-Policy:"; do
  echo "${HEADERS}" | grep -qi "${h}" || { echo "!! smoke: missing header ${h}"; exit 1; }
done
# CSP connect-src must be tightened to 'self' only -- no bare ws:/wss: (B4).
# Same-origin WebSocket connectivity itself is exercised by the Playwright E2E.
CSP_LINE="$(echo "${HEADERS}" | grep -i 'Content-Security-Policy')"
echo "${CSP_LINE}" | grep -q "connect-src 'self';" \
  || { echo "!! smoke: CSP connect-src not tightened to 'self'"; exit 1; }
echo "${CSP_LINE}" | grep -qE 'connect-src[^;]*(ws:|wss:)' \
  && { echo "!! smoke: CSP connect-src still allows bare ws:/wss:"; exit 1; }
# SPA fallback: unknown path must still return the app shell (HTTP 200).
curl -fsS "http://127.0.0.1:${SMOKE_PORT}/some/deep/route" | grep -q '<div id="root">' \
  || { echo "!! smoke: SPA fallback broken"; exit 1; }
# Version probe (P1-3): /version.json must carry a complete stamp and be
# served with Cache-Control: no-store (never cached by any layer). Reused
# images may predate version.json -> WARN and skip instead of failing.
VJ_BODY="$(curl -fsS "http://127.0.0.1:${SMOKE_PORT}/version.json" 2>/dev/null || true)"
if [ -n "${VJ_BODY}" ]; then
  for f in version git_sha build_time; do
    echo "${VJ_BODY}" | grep -q "\"${f}\"" \
      || { echo "!! smoke: version.json missing field ${f}"; exit 1; }
  done
  curl -fsSI "http://127.0.0.1:${SMOKE_PORT}/version.json" | grep -qi 'Cache-Control:.*no-store' \
    || { echo "!! smoke: version.json is not Cache-Control: no-store"; exit 1; }
  # Fresh local build: git_sha must match HEAD (skipped in reuse mode).
  if [ -z "${REUSED_IMAGE:-}" ] && [ "${GIT_SHA:-unknown}" != "unknown" ]; then
    echo "${VJ_BODY}" | grep -q "${GIT_SHA}" \
      || { echo "!! smoke: version.json git_sha does not match HEAD (${GIT_SHA})"; exit 1; }
  fi
  echo "==> version.json OK: ${VJ_BODY}"
elif [ -n "${REUSED_IMAGE:-}" ]; then
  echo "WARN: reused image has no /version.json (predates P1-3) - skipping check"
else
  echo "!! smoke: /version.json missing on freshly built image"; exit 1
fi
cleanup_smoke
trap - EXIT
echo "==> Smoke test passed against ${SESSION_FRONTEND_IMAGE}"

echo "=============================================="
echo " [4/4] Playwright E2E (inside Docker image)"
echo "=============================================="
if [ -n "${SKIP_E2E:-}" ]; then
  echo "==> SKIP_E2E set - skipping E2E stage"
elif ! docker image inspect "${E2E_BASE_IMAGE}" >/dev/null 2>&1 \
    && ! docker pull "${E2E_BASE_IMAGE}" >/dev/null 2>&1; then
  echo "!! E2E base image ${E2E_BASE_IMAGE} unavailable" >&2
  exit 1
else
  E2E_BUILD_ARGS=(--build-arg "E2E_BASE_IMAGE=${E2E_BASE_IMAGE}")
  # Forward PW_CHROMIUM_PATH only when explicitly set (empty string clears it
  # so Playwright uses the base image's own browsers).
  if [ -n "${PW_CHROMIUM_PATH+x}" ]; then
    E2E_BUILD_ARGS+=(--build-arg "PW_CHROMIUM_PATH=${PW_CHROMIUM_PATH}")
  fi
  docker build --target e2e "${E2E_BUILD_ARGS[@]}" -t "${E2E_IMAGE}" "${FRONTEND_DIR}"
  docker run --rm "${E2E_IMAGE}"
  echo "==> Playwright E2E passed inside ${E2E_IMAGE}"
fi

if [ -n "${SESSION_FRONTEND_NEW_TAG:-}" ]; then
  docker tag "${SESSION_FRONTEND_IMAGE}" "${SESSION_FRONTEND_NEW_TAG}"
  echo "==> Tagged tested image as ${SESSION_FRONTEND_NEW_TAG}"
fi

echo "ALL IMAGE-BASED TESTS PASSED"
