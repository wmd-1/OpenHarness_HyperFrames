#!/usr/bin/env bash
# =============================================================================
# frontend.sh - session-frontend reverse-proxy smoke assertions (P1-4).
#
# Standalone-runnable:
#   FRONTEND_URL=http://127.0.0.1:5174 bash e2e/session-acceptance/frontend.sh
#
# Asserts (spec session-live-acceptance / 前端反代冒烟断言):
#   - GET /            -> 200 + SPA shell (<div id="root">)
#   - GET /healthz     -> 200 (nginx proxies the CURRENT session container,
#                         i.e. no stale upstream IP after a recreate)
#   - GET /version.json-> reachable with Cache-Control: no-store; a runtime
#                         image predating version.json yields WARN, not FAIL
# =============================================================================
set -uo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${LIB_DIR}/lib.sh"

FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:5174}"

_log "-- frontend.sh against ${FRONTEND_URL} --"

# SPA shell
http GET "${FRONTEND_URL}/"
assert_eq "frontend / returns 200" "${HTTP_CODE}" "200"
assert_contains "frontend / serves the SPA shell" "${HTTP_BODY}" '<div id="root">'

# healthz proxied to the session backend (fails on stale upstream IP)
http GET "${FRONTEND_URL}/healthz"
assert_eq "frontend /healthz proxied 200" "${HTTP_CODE}" "200"
assert_contains "frontend /healthz reports backend status" "${HTTP_BODY}" '"status"'

# version probe: no-store so version detection is never cached
http GET "${FRONTEND_URL}/version.json"
if [ "${HTTP_CODE}" = "200" ]; then
  for f in version git_sha build_time; do
    assert_contains "version.json has field ${f}" "${HTTP_BODY}" "\"${f}\""
  done
  VJ_HEADERS="$(curl -fsSI "${FRONTEND_URL}/version.json" 2>/dev/null || true)"
  assert_contains "version.json Cache-Control: no-store" "${VJ_HEADERS}" 'no-store'
else
  # Allow the acceptance script to land before the version-metadata capability
  # is baked into the running image (spec: WARN, not FAIL).
  wa "running frontend image has no /version.json (HTTP ${HTTP_CODE}) - predates P1-3?"
fi

finish "frontend.sh"
