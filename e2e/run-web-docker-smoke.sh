#!/usr/bin/env bash
# =============================================================================
# Web frontend Docker smoke test (spec: harden-web-frontend, tasks 6 & 34).
#
# Runs the web image, fetches the SPA entrypoint (`/`) and asserts that the
# response is 200 AND that the hardening security headers (CSP,
# X-Frame-Options, X-Content-Type-Options, ...) are present.
#
# Image selection (all tests are IMAGE-BASED):
#   - WEB_IMAGE=<image:tag>  reuse an existing image without rebuilding, e.g.
#       WEB_IMAGE=openharness_hyperframes_web:v0.1.9_v0.7.20_v1.3_v2.0 \
#         bash e2e/run-web-docker-smoke.sh
#   - unset                  build a fresh image from ./web (default)
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${REPO_ROOT}/web"
IMAGE="${WEB_IMAGE:-openharness-web:smoke}"
HOST_PORT="${WEB_SMOKE_PORT:-5180}"
CONTAINER="web-smoke-$$"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -n "${WEB_IMAGE:-}" ]; then
  echo "==> Using existing web image ${IMAGE} (no rebuild)"
else
  echo "==> Building web image ${IMAGE}"
  docker build -t "${IMAGE}" "${WEB_DIR}"
fi

echo "==> Starting container on host port ${HOST_PORT}"
# nginx resolves `upstream` hosts at startup, so the placeholder backend host
# must be resolvable even though no backend is actually contacted by the test.
docker run -d --name "${CONTAINER}" -p "${HOST_PORT}:80" \
  --add-host "noop:127.0.0.1" \
  -e API_HOST=noop -e API_PORT=8000 \
  -e SESSION_HOST=noop -e SESSION_PORT=8001 \
  "${IMAGE}"

# Wait for nginx to come up (best-effort; the healthcheck matches CI).
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> Fetching / and inspecting headers"
HEADERS="$(curl -fsS -D - -o /tmp/web-smoke-index.html "http://127.0.0.1:${HOST_PORT}/")"

fail=0
expect_header() {
  local name="$1"
  if printf '%s\n' "${HEADERS}" | grep -qi "^${name}:"; then
    echo "  [ok] ${name}"
  else
    echo "  [FAIL] missing header: ${name}"
    fail=1
  fi
}

expect_header "Content-Security-Policy"
expect_header "X-Frame-Options"
expect_header "X-Content-Type-Options"
expect_header "Referrer-Policy"

# server_tokens must be off -> Server header should be exactly "nginx", no version.
if printf '%s\n' "${HEADERS}" | grep -qiE '^Server: nginx/[0-9]'; then
  echo "  [FAIL] server_tokens still leaks nginx version"
  fail=1
else
  echo "  [ok] server_tokens off (no version leak)"
fi

if [ "${fail}" -ne 0 ]; then
  echo "SMOKE TEST FAILED"
  exit 1
fi

echo "SMOKE TEST PASSED"
