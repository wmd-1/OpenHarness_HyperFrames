#!/usr/bin/env bash
# =============================================================================
# rest.sh - REST acceptance assertion group (P1-4).
#
# Standalone-runnable (environment must already be up in stub mode and the
# api_keys table non-empty, otherwise open mode defeats the 401 assertion;
# the stub must run with OH_STUB_TURN_SECONDS>=3 -- the 429 assertion relies
# on that busy window, see docker-compose.stub.yml):
#   BASE_URL=http://127.0.0.1:8001 API_KEY=sk-oh-... [API_KEY_B=sk-oh-...] \
#     bash e2e/session-acceptance/rest.sh
#
# Covers (spec session-live-acceptance / REST 验收断言组):
#   401 / create 201 / list / REST turn + has_artifact / assistant_text 无重复
#   turns 列表 / artifact 200 + Range 206 / 穿越 400 / 404 / 422 / 跨租户 404 /
#   并发配额 429，最后 DELETE 清理自建会话。
# =============================================================================
set -uo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${LIB_DIR}/lib.sh"

BASE_URL="${BASE_URL:-http://127.0.0.1:8001}"
: "${API_KEY:?API_KEY is required (tenant A key)}"
API_KEY_B="${API_KEY_B:-}"

AUTH_A=(-H "X-API-Key: ${API_KEY}")
SID=""

_log "-- rest.sh against ${BASE_URL} --"

# 1) no key -> 401 (multi-key rows exist, so open mode is off)
http GET "${BASE_URL}/v1/sessions"
assert_eq "no-key list rejected 401" "${HTTP_CODE}" "401"

# 2) create -> 201
http POST "${BASE_URL}/v1/sessions" "${AUTH_A[@]}" \
  -H 'Content-Type: application/json' -d '{"permission_policy":"full_auto"}'
assert_eq "create session 201" "${HTTP_CODE}" "201"
SID="$(json_field "${HTTP_BODY}" session_id)"
if [ -z "${SID}" ]; then
  ko "create response carries session_id"
  finish "rest.sh"
  exit 1
fi
ok "create response carries session_id (${SID})"

# 3) REST turn launched in the BACKGROUND: the stub holds the turn busy for
#    OH_STUB_TURN_SECONDS, giving us a deterministic window for the 429
#    assertion below. An idle (non-busy, no-WS) session would instead be
#    evicted to COLD by the tenant-quota hook (session-history-switch D2/D4)
#    and the second create would legitimately get 201.
PROMPT="acceptance hello"
TURN_OUT="$(mktemp)"
curl -sS -X POST "${BASE_URL}/v1/sessions/${SID}/turns" "${AUTH_A[@]}" \
  -H 'Content-Type: application/json' -d "{\"text\":\"${PROMPT}\"}" \
  -w $'\n%{http_code}' >"${TURN_OUT}" 2>/dev/null &
TURN_PID=$!
sleep 1  # let the turn register busy before probing the quota

# 4) concurrent quota: second create while the first session holds its live
#    slot AND is busy (busy sessions are not evictable) -> 429
http POST "${BASE_URL}/v1/sessions" "${AUTH_A[@]}" \
  -H 'Content-Type: application/json' -d '{"permission_policy":"full_auto"}'
assert_eq "second concurrent create -> 429" "${HTTP_CODE}" "429"

# 5) collect the background turn -> completed + has_artifact
wait "${TURN_PID}" || true
TURN_RAW="$(cat "${TURN_OUT}")" && rm -f "${TURN_OUT}"
HTTP_CODE="${TURN_RAW##*$'\n'}"
HTTP_BODY="${TURN_RAW%$'\n'*}"
assert_eq "REST turn 200" "${HTTP_CODE}" "200"
assert_contains "turn status completed" "${HTTP_BODY}" '"status":"completed"'
assert_contains "turn has_artifact true" "${HTTP_BODY}" '"has_artifact":true'

# 6) assistant_text 无重复（P0-1 回归锚点）：stub 全文恰出现一次。
#    双发缺陷会拼出 "Stub reply to: XStub reply to: X"（marker 出现两次）。
DUP_COUNT="$(echo "${HTTP_BODY}" | grep -o 'Stub reply to:' | wc -l | tr -d ' ')"
assert_eq "assistant_text carries the stub reply exactly once" "${DUP_COUNT}" "1"

# 7) list contains the new session
http GET "${BASE_URL}/v1/sessions" "${AUTH_A[@]}"
assert_eq "list sessions 200" "${HTTP_CODE}" "200"
assert_contains "list contains the new session" "${HTTP_BODY}" "${SID}"

# 8) turns list readable
http GET "${BASE_URL}/v1/sessions/${SID}/turns" "${AUTH_A[@]}"
assert_eq "turns list 200" "${HTTP_CODE}" "200"
assert_contains "turns list has turn_index 0" "${HTTP_BODY}" '"turn_index":0'

# 9) artifact download -> 200 video/mp4 (GET with dumped headers, body discarded)
ART_HEADERS="$(curl -sS -o /dev/null -D - "${BASE_URL}/v1/sessions/${SID}/turns/0/artifact" "${AUTH_A[@]}" 2>/dev/null || true)"
assert_contains "artifact download 200" "${ART_HEADERS}" ' 200'
assert_contains "artifact content-type video/mp4" "${ART_HEADERS}" 'video/mp4'

# 10) Range request -> 206
http GET "${BASE_URL}/v1/sessions/${SID}/turns/0/artifact" "${AUTH_A[@]}" -H 'Range: bytes=0-99' -o /dev/null
assert_eq "artifact Range bytes=0-99 -> 206" "${HTTP_CODE}" "206"

# 11) path traversal -> 400 (relative ..%2f and absolute %2f forms)
http GET "${BASE_URL}/v1/sessions/${SID}/workspace/files/..%2fetc%2fpasswd" "${AUTH_A[@]}"
assert_eq "workspace traversal ..%2f -> 400" "${HTTP_CODE}" "400"
http GET "${BASE_URL}/v1/sessions/${SID}/workspace/files/%2fetc%2fpasswd" "${AUTH_A[@]}"
assert_eq "workspace absolute path -> 400" "${HTTP_CODE}" "400"

# 12) nonexistent sid -> 404
http GET "${BASE_URL}/v1/sessions/00000000-0000-0000-0000-000000000000" "${AUTH_A[@]}"
assert_eq "nonexistent session -> 404" "${HTTP_CODE}" "404"

# 13) empty text -> 422
http POST "${BASE_URL}/v1/sessions/${SID}/turns" "${AUTH_A[@]}" \
  -H 'Content-Type: application/json' -d '{"text":""}'
assert_eq "empty turn text -> 422" "${HTTP_CODE}" "422"

# 14) cross-tenant isolation (requires API_KEY_B)
if [ -n "${API_KEY_B}" ]; then
  AUTH_B=(-H "X-API-Key: ${API_KEY_B}")
  http GET "${BASE_URL}/v1/sessions/${SID}" "${AUTH_B[@]}"
  assert_eq "tenant B reads tenant A session -> 404" "${HTTP_CODE}" "404"
  http GET "${BASE_URL}/v1/sessions" "${AUTH_B[@]}"
  assert_eq "tenant B list 200" "${HTTP_CODE}" "200"
  assert_not_contains "tenant B list hides tenant A session" "${HTTP_BODY}" "${SID}"
else
  wa "API_KEY_B not provided - cross-tenant assertions skipped"
fi

# 15) cleanup: DELETE own session (soft close; frees the concurrent slot for
#     the ws.sh run that follows under the same tenant)
http DELETE "${BASE_URL}/v1/sessions/${SID}" "${AUTH_A[@]}"
assert_eq "DELETE session 200" "${HTTP_CODE}" "200"
assert_contains "DELETE leaves session closed" "${HTTP_BODY}" '"status":"closed"'

finish "rest.sh"
