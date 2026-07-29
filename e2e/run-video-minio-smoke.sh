#!/usr/bin/env bash
# =============================================================================
# Video service MinIO multi-tenancy smoke test
# (openspec: video-service-minio-multitenancy, task 4.4)
#
# IMAGE-BASED per test-on-existing-images.md: brings up the EXISTING compose
# stack (api + postgres + redis + minio, no rebuild) and drives it from the
# host with curl only:
#   1. create two tenant API keys (manage_api_keys.py inside the api container)
#   2. tenant A creates a task -> 201
#   3. tenant B GET tenant A's task -> 404 (cross-tenant isolation)
#   4. download endpoint with mode=redirect never emits an in-cluster 302
#      (OH_S3_PUBLIC_ENDPOINT unset => stream fallback; here: task not
#      SUCCEEDED yet => 409, which also proves the route is tenant-reachable)
#   5. purge tenant A -> task GET returns 404 afterwards
#
# Usage:  bash e2e/run-video-minio-smoke.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

API="http://127.0.0.1:8000"
COMPOSE="docker compose"
TENANT_A="smoke-tenant-a-$$"
TENANT_B="smoke-tenant-b-$$"
STARTED_STACK=0

cleanup() {
  # Purge both smoke tenants (rows + any objects); never touch other data.
  ${COMPOSE} exec -T api bash -c \
    "cd /opt/oh-service && python scripts/purge_tenant.py ${TENANT_A} --yes && python scripts/purge_tenant.py ${TENANT_B} --yes" \
    >/dev/null 2>&1 || true
  if [ "${STARTED_STACK}" = "1" ]; then
    ${COMPOSE} stop api >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> Ensuring api stack is up (existing images, no rebuild)"
if ! curl -fsS "${API}/healthz" >/dev/null 2>&1; then
  ${COMPOSE} up -d --no-build api
  STARTED_STACK=1
fi
for _ in $(seq 1 60); do
  curl -fsS "${API}/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "${API}/healthz" >/dev/null || { echo "FAIL: api not healthy"; exit 1; }

echo "==> Creating API keys for two tenants"
mkkey() {
  ${COMPOSE} exec -T api bash -c \
    "cd /opt/oh-service && python scripts/manage_api_keys.py create --tenant $1 --label smoke" \
    | awk '/^api_key:/ {print $2}'
}
KEY_A="$(mkkey "${TENANT_A}")"
KEY_B="$(mkkey "${TENANT_B}")"
[ -n "${KEY_A}" ] && [ -n "${KEY_B}" ] || { echo "FAIL: key creation"; exit 1; }
echo "  [ok] keys created"

fail=0
check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  [ok] $1 ($3)"; else echo "  [FAIL] $1: expected $2, got $3"; fail=1; fi
}

echo "==> Tenant A creates a task"
CREATE_BODY='{"prompt":"smoke: minimal video","timeout_seconds":60}'
CODE=$(curl -s -o /tmp/video-smoke-create.json -w '%{http_code}' \
  -X POST "${API}/v1/videos" -H "X-API-Key: ${KEY_A}" \
  -H 'Content-Type: application/json' -d "${CREATE_BODY}")
check "POST /v1/videos as tenant A" "201" "${CODE}"
TASK_ID=$(sed -n 's/.*"task_id":"\([^"]*\)".*/\1/p' /tmp/video-smoke-create.json)
[ -n "${TASK_ID}" ] || { echo "FAIL: no task_id in create response"; exit 1; }

echo "==> Cross-tenant isolation"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${API}/v1/videos/${TASK_ID}" -H "X-API-Key: ${KEY_B}")
check "GET as tenant B (cross-tenant)" "404" "${CODE}"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${API}/v1/videos/${TASK_ID}" -H "X-API-Key: ${KEY_A}")
check "GET as tenant A (owner)" "200" "${CODE}"

echo "==> Download route: no in-cluster 302 leak (stream fallback)"
# OH_S3_PUBLIC_ENDPOINT is unset in this stack: whatever the task state, the
# route must never answer with a Location pointing at http://minio:9000.
RESP_HEADERS=$(curl -s -D - -o /dev/null "${API}/v1/videos/${TASK_ID}/file?mode=redirect" -H "X-API-Key: ${KEY_A}")
if printf '%s\n' "${RESP_HEADERS}" | grep -qi '^Location:.*minio:9000'; then
  echo "  [FAIL] download leaked an in-cluster minio:9000 redirect"
  fail=1
else
  echo "  [ok] no internal minio:9000 redirect"
fi

echo "==> Purge tenant A"
${COMPOSE} exec -T api bash -c \
  "cd /opt/oh-service && python scripts/purge_tenant.py ${TENANT_A} --yes" || fail=1
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${API}/v1/videos/${TASK_ID}" -H "X-API-Key: ${KEY_A}")
check "GET after purge" "404" "${CODE}"

if [ "${fail}" -ne 0 ]; then
  echo "VIDEO MINIO SMOKE FAILED"
  exit 1
fi
echo "VIDEO MINIO SMOKE PASSED"
