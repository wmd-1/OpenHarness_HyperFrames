#!/usr/bin/env bash
# =============================================================================
# ws.sh - WebSocket lifecycle acceptance assertion group (P1-4).
#
# Standalone-runnable (environment must already be up in STUB mode with a
# short idle grace, e.g. via docker-compose.stub.yml OH_IDLE_GRACE_SECONDS=20):
#   BASE_URL=http://127.0.0.1:8001 API_KEY=sk-oh-... \
#     bash e2e/session-acceptance/ws.sh
#
# The WS client driver (scripts/ws_e2e_driver.py) runs INSIDE the session
# container (venv ships `websockets`; the host stays docker/curl-only).
# Override WS_EXEC to change how the driver is invoked.
#
# Covers (spec session-live-acceptance / WS 生命周期验收断言组):
#   WS turn -> turn_complete；detach 后 idle grace 到期 -> cold；cold 下
#   workspace files source=archive；WS 重连 resume（turn_count 连续）；
#   DELETE 软关闭后 turns 仍可读。
# =============================================================================
set -uo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${LIB_DIR}/lib.sh"

BASE_URL="${BASE_URL:-http://127.0.0.1:8001}"
: "${API_KEY:?API_KEY is required (tenant key)}"
WS_EXEC="${WS_EXEC:-docker compose -f docker-compose.yml -f docker-compose.stub.yml exec -T session}"
# COLD eviction polling budget: OH_IDLE_GRACE_SECONDS (stub override: 20s)
# + reaper sweep interval, with headroom.
COLD_WAIT_SECONDS="${COLD_WAIT_SECONDS:-120}"

AUTH=(-H "X-API-Key: ${API_KEY}")

_log "-- ws.sh against ${BASE_URL} (driver: ${WS_EXEC}) --"

# 0) create a session for the lifecycle run
http POST "${BASE_URL}/v1/sessions" "${AUTH[@]}" \
  -H 'Content-Type: application/json' -d '{"permission_policy":"full_auto"}'
assert_eq "ws lifecycle: create session 201" "${HTTP_CODE}" "201"
SID="$(json_field "${HTTP_BODY}" session_id)"
if [ -z "${SID}" ]; then
  ko "ws lifecycle: create response carries session_id"
  finish "ws.sh"
  exit 1
fi

# 1) WS turn -> turn_complete (driver prints the final frame JSON)
FRAME="$(${WS_EXEC} python scripts/ws_e2e_driver.py turn "${SID}" "${API_KEY}" "ws acceptance one" 2>&1)" \
  && WS_RC=0 || WS_RC=$?
assert_eq "WS turn #1 driver exit code" "${WS_RC}" "0"
assert_contains "WS turn #1 yields turn_complete" "${FRAME}" '"type": *"turn_complete"\|"type":"turn_complete"'

# 2) detach happened when the driver exited; wait for IDLE->COLD eviction
COLD=0
for _ in $(seq 1 $((COLD_WAIT_SECONDS / 3))); do
  http GET "${BASE_URL}/v1/sessions/${SID}" "${AUTH[@]}"
  if echo "${HTTP_BODY}" | grep -q '"status":"cold"'; then COLD=1; break; fi
  sleep 3
done
assert_eq "session evicted to cold after idle grace" "${COLD}" "1"

# 3) cold: workspace files served from the archive (MinIO authoritative)
http GET "${BASE_URL}/v1/sessions/${SID}/workspace/files" "${AUTH[@]}"
assert_eq "cold workspace files 200" "${HTTP_CODE}" "200"
assert_contains "cold workspace files source=archive" "${HTTP_BODY}" '"source":"archive"'

# 4) WS reconnect -> rehydrate (resume) -> second turn; turn_count continuous
FRAME2="$(${WS_EXEC} python scripts/ws_e2e_driver.py turn "${SID}" "${API_KEY}" "ws acceptance two" 2>&1)" \
  && WS_RC2=0 || WS_RC2=$?
assert_eq "WS turn #2 (resume from cold) driver exit code" "${WS_RC2}" "0"
assert_contains "WS turn #2 yields turn_complete" "${FRAME2}" '"type": *"turn_complete"\|"type":"turn_complete"'
http GET "${BASE_URL}/v1/sessions/${SID}" "${AUTH[@]}"
assert_contains "turn_count continuous after resume (=2)" "${HTTP_BODY}" '"turn_count":2'

# 5) DELETE soft close -> closed; turns history remains readable
http DELETE "${BASE_URL}/v1/sessions/${SID}" "${AUTH[@]}"
assert_eq "DELETE session 200" "${HTTP_CODE}" "200"
assert_contains "DELETE leaves session closed" "${HTTP_BODY}" '"status":"closed"'
http GET "${BASE_URL}/v1/sessions/${SID}/turns" "${AUTH[@]}"
assert_eq "turns readable after close" "${HTTP_CODE}" "200"
assert_contains "closed history keeps both turns" "${HTTP_BODY}" '"turn_index":1'

finish "ws.sh"
