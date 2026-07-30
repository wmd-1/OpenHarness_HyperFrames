#!/usr/bin/env bash
# =============================================================================
# Session live-acceptance entry point (session-acceptance-hardening P1-4).
#
# Codifies the 2026-07-30 manual acceptance run into repeatable automation:
#   1. bring up session (+frontend) in STUB mode via the compose override
#      (existing images only, source mounted -- no image rebuild)
#   2. wait for healthz, verify the stub override actually took effect
#   3. issue two throwaway tenant API keys (A/B) inside the container
#   4. run the assertion sub-scripts: rest.sh -> ws.sh -> frontend.sh
#      (each standalone-runnable; parameters passed via env vars)
#   5. aggregate exit codes into a PASS/FAIL summary + report file
#   6. trap cleanup: revoke the temp keys, close leftover test sessions
#
# Usage:
#   bash e2e/run-session-live-acceptance.sh
#   E2E_REPORT=/tmp/report.txt bash e2e/run-session-live-acceptance.sh
#
# NOTE: leaves the session container in STUB mode; restore the real backend
# afterwards with:  docker compose up -d session
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.stub.yml)
BASE_URL="${BASE_URL:-http://127.0.0.1:8001}"
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:5174}"
export E2E_REPORT="${E2E_REPORT:-/tmp/session-live-acceptance-$(date +%Y%m%d-%H%M%S).txt}"

echo "Session live-acceptance $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${E2E_REPORT}"
echo "report: ${E2E_REPORT}"

# 随机后缀的临时租户，避免与真实租户冲突（spec: 验收数据清理）。
SUFFIX="$(date +%s)-${RANDOM}"
TENANT_A="acceptance-a-${SUFFIX}"
TENANT_B="acceptance-b-${SUFFIX}"
KEY_ID_A=""
KEY_ID_B=""
API_KEY=""
API_KEY_B=""

cleanup() {
  echo "== cleanup =="
  # Close any leftover test sessions (sub-scripts normally delete their own).
  for key in "${API_KEY}" "${API_KEY_B}"; do
    [ -n "${key}" ] || continue
    for sid in $(curl -fsS "${BASE_URL}/v1/sessions" -H "X-API-Key: ${key}" 2>/dev/null \
        | grep -oE '"session_id":"[0-9a-f-]+"' | cut -d'"' -f4); do
      curl -fsS -X DELETE "${BASE_URL}/v1/sessions/${sid}" -H "X-API-Key: ${key}" >/dev/null 2>&1 || true
    done
  done
  # Revoke the throwaway keys (effective within OH_APIKEY_CACHE_TTL).
  for kid in "${KEY_ID_A}" "${KEY_ID_B}"; do
    [ -n "${kid}" ] || continue
    "${COMPOSE[@]}" exec -T session python scripts/manage_api_keys.py revoke "${kid}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

echo "=============================================="
echo " [1/5] Bring up session in stub mode"
echo "=============================================="
"${COMPOSE[@]}" up -d session
# session was recreated -> restart the frontend so nginx re-resolves the
# upstream (guards the "stale upstream IP" failure mode from the manual run).
"${COMPOSE[@]}" restart session-frontend >/dev/null 2>&1 || true

for i in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 60 ]; then
    echo "!! session healthz did not become ready" | tee -a "${E2E_REPORT}"
    exit 1
  fi
  sleep 2
done

HEALTH="$(curl -fsS "${BASE_URL}/healthz")"
echo "healthz: ${HEALTH}" | tee -a "${E2E_REPORT}"
# healthz 的 oh_bin 可观测字段（P1-3）直接证明 stub override 生效、无配置漂移。
if ! echo "${HEALTH}" | grep -q 'oh_backend_stub'; then
  echo "!! stub override NOT active (healthz oh_bin is not the stub) - aborting" | tee -a "${E2E_REPORT}"
  exit 1
fi

echo "=============================================="
echo " [2/5] Issue throwaway tenant keys (A/B)"
echo "=============================================="
issue_key() { # <tenant> -> prints "key_id api_key"
  local out
  out="$("${COMPOSE[@]}" exec -T session python scripts/manage_api_keys.py \
    create --tenant "$1" --label "live-acceptance")" || return 1
  echo "$(echo "${out}" | awk '/^key_id:/{print $2}') $(echo "${out}" | awk '/^api_key:/{print $2}')"
}
read -r KEY_ID_A API_KEY <<<"$(issue_key "${TENANT_A}")"
read -r KEY_ID_B API_KEY_B <<<"$(issue_key "${TENANT_B}")"
if [ -z "${API_KEY}" ] || [ -z "${API_KEY_B}" ]; then
  echo "!! failed to issue tenant keys" | tee -a "${E2E_REPORT}"
  exit 1
fi
echo "tenants: ${TENANT_A} / ${TENANT_B} (keys issued)" | tee -a "${E2E_REPORT}"

export BASE_URL FRONTEND_URL API_KEY API_KEY_B

declare -A RESULTS
OVERALL=0
run_group() { # <name> <script>
  echo "=============================================="
  echo " ${1}"
  echo "=============================================="
  if bash "${2}"; then
    RESULTS["${1}"]="PASS"
  else
    RESULTS["${1}"]="FAIL"
    OVERALL=1
  fi
}

echo " [3/5] REST assertions"
run_group "rest" "${REPO_ROOT}/e2e/session-acceptance/rest.sh"
echo " [4/5] WS lifecycle assertions"
run_group "ws" "${REPO_ROOT}/e2e/session-acceptance/ws.sh"
echo " [5/5] Frontend proxy smoke"
run_group "frontend" "${REPO_ROOT}/e2e/session-acceptance/frontend.sh"

echo "=============================================="
echo " Summary"
echo "=============================================="
{
  echo "== overall =="
  for name in rest ws frontend; do
    echo "  ${name}: ${RESULTS[${name}]:-SKIPPED}"
  done
} | tee -a "${E2E_REPORT}"

if [ "${OVERALL}" -eq 0 ]; then
  echo "LIVE ACCEPTANCE PASSED (report: ${E2E_REPORT})"
else
  echo "LIVE ACCEPTANCE FAILED (report: ${E2E_REPORT})" >&2
fi
exit "${OVERALL}"
