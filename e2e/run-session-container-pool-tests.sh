#!/usr/bin/env bash
# =============================================================================
# WS-C/WS-D container-runtime + pool e2e (session-container-pool-multitenancy,
# tasks 3.8 + 4.5).
#
# Everything runs against EXISTING images (test-on-existing-images rule):
#   * gateway  = compose `session` service (main image + mounted source),
#     flipped to OH_SESSION_RUNTIME=container for the duration of the run;
#   * per-session backends = disposable sibling containers of the SAME main
#     image (OH_SESSION_IMAGE), spawned by the gateway over /var/run/docker.sock;
#   * `oh` inside those containers = scripts/oh_backend_stub.py (OHJSON
#     protocol stub — no LLM key needed), staged onto the shared /workspaces
#     volume so both gateway and backends see the same path.
#
# Coverage:
#   Q2  Chrome cap probe: headless-shell under CapDrop=ALL + no-new-privileges
#   A   create -> sibling container up (labels + security baseline inspected)
#   B   multi-turn REST + artifact download
#   C   WS detach -> IDLE -> COLD eviction -> backend container force-removed
#   D   WS reconnect -> rehydrate (--resume, fresh container) -> turn 3
#   E   docker kill -9 backend -> gateway crash path -> COLD -> resume again
#   F   gateway restart -> orphan_scan reclaims leftover labeled containers
#   G   DELETE while live -> container force-removed, session closed
#   H   pool admission (WS-D, tiny capacity): eviction -> queue-full 503 ->
#       freed-slot wakes queue head -> queue timeout 503+Retry-After ->
#       tenant quota 429 -> pool metrics -> restart reclaims held containers
#   I   two-tenant memory isolation re-verified end-to-end via MinIO
#
# Usage:  bash e2e/run-session-container-pool-tests.sh
# Env:    OH_SESSION_IMAGE (default = compose main image tag)
# =============================================================================
set -u

cd "$(dirname "$0")/.."            # -> repo root
COMPOSE="docker compose"
REPORT="${E2E_REPORT:-/tmp/session_container_e2e_report.txt}"
: > "$REPORT"

IMAGE="${OH_SESSION_IMAGE:-openharness_hyperframes_qwen-tts_pptx:${OH_VERSION_HYPERFRAMES_VERSION:-v0.1.9_v0.7.77_v1.5_v2.1}}"
STUB_BIN=/workspaces/.e2e/oh_backend_stub.py
IDLE_GRACE=5
VENV_PY=/root/.openharness-venv/bin/python
BASE="http://localhost:8001"

pass=0; fail=0
log()  { echo "$*" | tee -a "$REPORT"; }
ok()   { log "PASS | $1"; pass=$((pass+1)); }
bad()  { log "FAIL | $1"; fail=$((fail+1)); }

# Recreate the gateway in container-runtime mode (env baked at up-time).
# --force-recreate: the mounted source may have changed since the container
# started, and `up -d` alone won't restart it when the env is already equal.
# Extra VAR=val args (e.g. tiny pool sizing for TEST H) are passed through.
up_container_mode() {
  OH_SESSION_RUNTIME=container OH_OH_BIN="$STUB_BIN" OH_IDLE_GRACE_SECONDS=$IDLE_GRACE \
    env "$@" $COMPOSE up -d --force-recreate session 2>&1 | tail -2
}
wait_healthz() {
  local t=0
  while [ $t -lt 90 ]; do
    c=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/healthz" 2>/dev/null || echo 000)
    [ "$c" = "200" ] && return 0
    sleep 3; t=$((t+3))
  done
  return 1
}
sexec() { $COMPOSE exec -T session "$@"; }
json_field() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -1; }
# All docker ps checks are scoped by the oh.sid label the runtime stamps (D6).
cids_for() { docker ps -aq --filter "label=oh.sid=$1"; }
running_for() { docker ps -q --filter "label=oh.sid=$1"; }
get_status() { curl -s -m 10 -H "X-API-Key: $KEY" "$BASE/v1/sessions/$1" | json_field status; }
wait_session_status() { # sid target timeout
  local t=0
  while [ $t -lt "$3" ]; do
    [ "$(get_status "$1")" = "$2" ] && return 0
    sleep 2; t=$((t+2))
  done
  return 1
}
# Key-aware variants (TEST H/I span several tenants, one key each).
mint_key() { sexec $VENV_PY scripts/manage_api_keys.py create --tenant "$1" | sed -n 's/^api_key: *//p'; }
create_sess() { curl -s -m 60 -H "X-API-Key: $1" -H 'Content-Type: application/json' -d '{}' "$BASE/v1/sessions"; }
get_status_k() { curl -s -m 10 -H "X-API-Key: $1" "$BASE/v1/sessions/$2" | json_field status; }
wait_status_k() { # key sid target timeout
  local t=0
  while [ $t -lt "$4" ]; do
    [ "$(get_status_k "$1" "$2")" = "$3" ] && return 0
    sleep 2; t=$((t+2))
  done
  return 1
}
hold_ws() { # sid key secs — keep a WS attached so the session is non-evictable
  $COMPOSE exec -dT session $VENV_PY scripts/ws_e2e_driver.py hold "$1" "$2" "$3" 2>/dev/null \
    || sexec bash -c "nohup $VENV_PY scripts/ws_e2e_driver.py hold $1 $2 $3 >/dev/null 2>&1 &"
}

log "===== session container-runtime e2e  $(date -u +%FT%TZ) ====="

# --- 0. preflight ------------------------------------------------------------
[ -S /var/run/docker.sock ] || { bad "host docker.sock missing"; cat "$REPORT"; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { bad "image $IMAGE not present (rule: reuse, never rebuild)"; exit 1; }
ok "preflight: docker.sock + existing image $IMAGE"

# --- Q2: Chrome minimal-cap probe on the SAME security baseline ---------------
log "--- Q2: chrome-headless-shell under CapDrop=ALL ---"
DOM=$(docker run --rm --entrypoint "" \
  --cap-drop ALL --security-opt no-new-privileges:true --shm-size 1g --pids-limit 512 \
  "$IMAGE" /opt/chrome-headless-shell-linux64/chrome-headless-shell \
  --headless --no-sandbox --disable-gpu --dump-dom about:blank 2>/dev/null)
if echo "$DOM" | grep -qi "<html"; then
  ok "Q2: CapDrop=ALL + no-new-privileges suffices for headless-shell (--no-sandbox); minimal extra caps = NONE"
else
  bad "Q2: headless-shell failed under CapDrop=ALL — container_cap_drop default needs revisiting"
fi

# --- bring up stack in container mode -----------------------------------------
log "--- gateway up (OH_SESSION_RUNTIME=container, stub oh) ---"
up_container_mode
wait_healthz && ok "gateway /healthz 200 (container mode)" || { bad "gateway not healthy"; cat "$REPORT"; exit 1; }

# Stage the OHJSON stub onto the shared /workspaces volume (visible to the
# gateway AND every spawned backend container at the same path).
sexec bash -c "mkdir -p /workspaces/.e2e && cp /opt/oh-session-service/scripts/oh_backend_stub.py $STUB_BIN && chmod +x $STUB_BIN" \
  && ok "stub staged at $STUB_BIN" || bad "stub staging failed"

# Tenant API key (WS-A path; also drives WS-B stage-in for a fresh tenant).
TEN="e2e-cp-$RANDOM"
KEY=$(sexec $VENV_PY scripts/manage_api_keys.py create --tenant "$TEN" --label "container e2e" | json_field api_key)
[ -z "$KEY" ] && KEY=$(sexec $VENV_PY scripts/manage_api_keys.py create --tenant "$TEN" | sed -n 's/^api_key: *//p')
[ -n "$KEY" ] && ok "api key minted for tenant $TEN" || { bad "api key creation failed"; exit 1; }

# --- TEST A: create -> sibling backend container ------------------------------
log "--- TEST A: create session -> disposable sibling container ---"
RESP=$(curl -s -m 60 -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}' "$BASE/v1/sessions")
SID=$(echo "$RESP" | json_field session_id)
[ -n "$SID" ] && ok "session created: $SID" || { bad "create failed: $RESP"; cat "$REPORT"; exit 1; }
CID=$(running_for "$SID")
[ -n "$CID" ] && ok "backend container running (label oh.sid=$SID)" || bad "no container labeled oh.sid=$SID"
if [ -n "$CID" ]; then
  INSPECT=$(docker inspect "$CID")
  echo "$INSPECT" | grep -q '"oh.tenant": "'"$TEN"'"' && ok "oh.tenant label correct" || bad "oh.tenant label wrong"
  echo "$INSPECT" | grep -q '"CapDrop": *\[' && echo "$INSPECT" | grep -A2 '"CapDrop"' | grep -q '"ALL"' \
    && ok "live container has CapDrop=ALL" || bad "live container missing CapDrop=ALL"
  echo "$INSPECT" | grep -q 'no-new-privileges:true' && ok "no-new-privileges applied" || bad "no-new-privileges missing"
  echo "$INSPECT" | grep -q '"PidsLimit": *512' && ok "PidsLimit=512 applied" || bad "PidsLimit missing"
  [ -z "$(docker port "$CID")" ] && ok "no published ports (stdio-only)" || bad "unexpected published ports: $(docker port "$CID")"
fi

# --- TEST B: multi-turn REST + artifact ---------------------------------------
log "--- TEST B: two REST turns + artifact download ---"
for i in 0 1; do
  T=$(curl -s -m 120 -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
      -d "{\"text\":\"e2e turn $i\"}" "$BASE/v1/sessions/$SID/turns")
  echo "$T" | grep -q '"status": *"completed"' && ok "turn $i completed" || bad "turn $i failed: $T"
  echo "$T" | grep -q '"has_artifact": *true' && ok "turn $i registered artifact" || bad "turn $i missing artifact"
done
AC=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$BASE/v1/sessions/$SID/turns/1/artifact?api_key=$KEY")
[ "$AC" = "200" ] && ok "artifact download HTTP 200" || bad "artifact download code=$AC"

# --- TEST C: WS detach -> IDLE -> COLD -> container removed --------------------
log "--- TEST C: idle eviction disposes the container ---"
sexec $VENV_PY scripts/ws_e2e_driver.py touch "$SID" "$KEY" && log "  WS attached+detached (idle timer armed)"
wait_session_status "$SID" cold $((IDLE_GRACE + 25)) && ok "session evicted to COLD" || bad "session not COLD (status=$(get_status "$SID"))"
sleep 2
[ -z "$(cids_for "$SID")" ] && ok "disposable container force-removed on eviction" || bad "container survived eviction"

# --- TEST D: rehydrate (--resume) spawns a fresh container ---------------------
log "--- TEST D: COLD -> WS reconnect -> resume turn ---"
TC=$(sexec $VENV_PY scripts/ws_e2e_driver.py turn "$SID" "$KEY" "e2e resume turn")
echo "$TC" | grep -q '"type": *"turn_complete"' && ok "rehydrated turn completed over WS" || bad "resume turn failed: $TC"
NEW_CID=$(running_for "$SID")
if [ -n "$NEW_CID" ]; then
  [ "$NEW_CID" != "$CID" ] && ok "resume used a FRESH container (disposable semantics)" || bad "container id reused after resume"
else
  # driver already detached; eviction may have raced us — check via turn count
  log "  (container already evicted post-turn — verified via turn_complete)"
fi

# --- TEST E: docker kill -9 backend -> crash path -> COLD -> resume ------------
log "--- TEST E: SIGKILL backend container -> crash recovery ---"
# Keep the session LIVE with a holder WS (detached exec stays attached ~40s).
$COMPOSE exec -dT session $VENV_PY scripts/ws_e2e_driver.py hold "$SID" "$KEY" 40 2>/dev/null \
  || sexec bash -c "nohup $VENV_PY scripts/ws_e2e_driver.py hold $SID $KEY 40 >/dev/null 2>&1 &"
sleep 2
KCID=$(running_for "$SID")
if [ -n "$KCID" ]; then
  docker kill -s SIGKILL "$KCID" >/dev/null && log "  killed backend container $KCID"
  # Crash surfaces on the NEXT submit (same semantics as the process runtime):
  # the EOF sentinel fails the turn with "exited unexpectedly" -> FAILED -> COLD.
  CR=$(sexec $VENV_PY scripts/ws_e2e_driver.py turn "$SID" "$KEY" "turn into dead backend" 2>&1)
  echo "$CR" | grep -q 'exited unexpectedly' && ok "crash surfaced as turn_error (EOF sentinel)" || bad "unexpected crash frame: $CR"
  wait_session_status "$SID" cold 30 && ok "crash -> COLD persisted" || bad "no COLD after SIGKILL (status=$(get_status "$SID"))"
  TC=$(sexec $VENV_PY scripts/ws_e2e_driver.py turn "$SID" "$KEY" "post crash turn")
  echo "$TC" | grep -q '"type": *"turn_complete"' && ok "post-crash resume turn completed" || bad "post-crash resume failed: $TC"
else
  bad "no running container to SIGKILL (status=$(get_status "$SID"))"
fi

# --- TEST F: gateway restart -> orphan_scan reclaims labeled leftovers ---------
log "--- TEST F: orphan reclaim on gateway restart ---"
# Fresh tenant: tenant_max_concurrent=1 and the TEST E session is LIVE again.
KEY2=$(sexec $VENV_PY scripts/manage_api_keys.py create --tenant "$TEN-f" | sed -n 's/^api_key: *//p')
R2=$(curl -s -m 60 -H "X-API-Key: $KEY2" -H 'Content-Type: application/json' -d '{}' "$BASE/v1/sessions")
SID2=$(echo "$R2" | json_field session_id)
[ -n "$(running_for "$SID2")" ] && log "  orphan candidate container up (sid=$SID2)" \
  || bad "second session has no container (resp=$R2; ps=$(docker ps -a --filter "label=oh.sid=$SID2" --format '{{.Status}}' | tr '\n' ';'))"
$COMPOSE restart session >/dev/null 2>&1
wait_healthz || bad "gateway unhealthy after restart"
t=0; while [ $t -lt 45 ]; do
  [ -z "$(cids_for "$SID2")" ] && break; sleep 3; t=$((t+3))
done
[ -z "$(cids_for "$SID2")" ] && ok "orphan container reclaimed after restart (oh.node label scan)" \
  || bad "orphan container NOT reclaimed"
# any dead leftover from TEST E must be gone too
[ -z "$(cids_for "$SID")" ] && ok "crashed leftover reclaimed too" || bad "crashed leftover still present"

# --- TEST G: DELETE while live -> container removed, session closed ------------
log "--- TEST G: destroy live session ---"
# Fresh tenant again (concurrent quota, see TEST F).
KEY3=$(sexec $VENV_PY scripts/manage_api_keys.py create --tenant "$TEN-g" | sed -n 's/^api_key: *//p')
R3=$(curl -s -m 60 -H "X-API-Key: $KEY3" -H 'Content-Type: application/json' -d '{}' "$BASE/v1/sessions")
SID3=$(echo "$R3" | json_field session_id)
[ -n "$(running_for "$SID3")" ] || bad "third session has no container"
D=$(curl -s -m 60 -X DELETE -H "X-API-Key: $KEY3" "$BASE/v1/sessions/$SID3")
echo "$D" | grep -q '"status": *"closed"' && ok "DELETE -> closed" || bad "DELETE unexpected: $D"
sleep 3
[ -z "$(cids_for "$SID3")" ] && ok "container force-removed on destroy" || bad "container survived destroy"

# --- TEST H: WS-D pool admission under tiny capacity ---------------------------
# Recreate the gateway with capacity=2 / queue=1 / timeout=8s so eviction,
# queue-full, wake-on-release, queue-timeout and tenant-quota are all reachable
# with a handful of sessions. Fresh tenants throughout (quota=1 per tenant).
log "--- TEST H: pool admission (OH_MAX_LIVE_SESSIONS=2, queue=1, timeout=8s) ---"
up_container_mode OH_MAX_LIVE_SESSIONS=2 OH_POOL_QUEUE_SIZE=1 OH_POOL_QUEUE_TIMEOUT=8
wait_healthz && log "  gateway healthy (tiny pool)" || bad "H: gateway not healthy in tiny-pool mode"
KH1=$(mint_key "$TEN-h1"); KH2=$(mint_key "$TEN-h2"); KH3=$(mint_key "$TEN-h3")
KH4=$(mint_key "$TEN-h4"); KH5=$(mint_key "$TEN-h5"); KH6=$(mint_key "$TEN-h6")
H1=$(create_sess "$KH1" | json_field session_id)
H2=$(create_sess "$KH2" | json_field session_id)
[ -n "$H1" ] && [ -n "$H2" ] && ok "H: two sessions fill the 2-slot node" || bad "H: baseline creates failed (H1=$H1 H2=$H2)"
# Pin H2 with a WS (non-evictable); H1 stays idle -> the eviction candidate.
hold_ws "$H2" "$KH2" 120
sleep 2
R3=$(create_sess "$KH3"); H3=$(echo "$R3" | json_field session_id)
[ -n "$H3" ] && ok "H: 3rd create admitted (idle session evicted for its slot)" || bad "H: 3rd create failed: $R3"
wait_status_k "$KH1" "$H1" cold 20 && ok "H: longest-idle session went COLD (pool eviction)" \
  || bad "H: H1 not COLD (status=$(get_status_k "$KH1" "$H1"))"
# Pin H3 too: both slots now non-evictable -> stage 4 (queue) territory.
hold_ws "$H3" "$KH3" 120
sleep 2
# Queue head: this create parks in the FIFO queue (queue_size=1).
HQ=/tmp/h4_create.$$
(curl -s -m 30 -o "$HQ.body" -w '%{http_code}' -H "X-API-Key: $KH4" \
   -H 'Content-Type: application/json' -d '{}' "$BASE/v1/sessions" > "$HQ.code") &
HQ_PID=$!
sleep 2
# Queue now full: the next create must be rejected IMMEDIATELY (no wait).
T0=$(date +%s)
C5=$(curl -s -m 20 -o /tmp/h5_body.$$ -D /tmp/h5_hdr.$$ -w '%{http_code}' -H "X-API-Key: $KH5" \
     -H 'Content-Type: application/json' -d '{}' "$BASE/v1/sessions")
EL=$(( $(date +%s) - T0 ))
[ "$C5" = "503" ] && [ $EL -le 3 ] && ok "H: queue-full -> fast 503 (${EL}s)" \
  || bad "H: queue-full expected fast 503, got $C5 after ${EL}s: $(cat /tmp/h5_body.$$)"
grep -qi '^retry-after:' /tmp/h5_hdr.$$ && ok "H: queue-full response carries Retry-After" || bad "H: queue-full missing Retry-After"
# Free a slot while H4 waits: destroy H3 -> freed slot must wake the queue head.
curl -s -m 60 -X DELETE -H "X-API-Key: $KH3" "$BASE/v1/sessions/$H3" >/dev/null
wait $HQ_PID
HC=$(cat "$HQ.code")
[ "$HC" = "201" ] && ok "H: freed slot admitted the queue head (201)" \
  || bad "H: queued create expected 201, got $HC: $(cat "$HQ.body")"
H4=$(json_field session_id < "$HQ.body")
# Queue timeout: both slots pinned, queue empty -> wait ~8s then 503.
hold_ws "$H4" "$KH4" 90
sleep 2
T0=$(date +%s)
C6=$(curl -s -m 25 -o /tmp/h6_body.$$ -D /tmp/h6_hdr.$$ -w '%{http_code}' -H "X-API-Key: $KH6" \
     -H 'Content-Type: application/json' -d '{}' "$BASE/v1/sessions")
EL=$(( $(date +%s) - T0 ))
[ "$C6" = "503" ] && [ $EL -ge 6 ] && ok "H: queue timeout -> 503 after ${EL}s (~8s budget)" \
  || bad "H: queue-timeout expected 503 >=6s, got $C6 after ${EL}s: $(cat /tmp/h6_body.$$)"
grep -qi '^retry-after:' /tmp/h6_hdr.$$ && ok "H: queue-timeout response carries Retry-After" || bad "H: queue-timeout missing Retry-After"
# Tenant quota (pool stage 1): same tenant, second create -> immediate 429.
C2=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "X-API-Key: $KH2" \
     -H 'Content-Type: application/json' -d '{}' "$BASE/v1/sessions")
[ "$C2" = "429" ] && ok "H: same-tenant second create -> 429" || bad "H: tenant quota expected 429, got $C2"
# Pool metrics (scrape BEFORE the recreate below resets the process).
M=$(curl -s -m 10 "$BASE/metrics")
echo "$M" | grep -E '^oh_pool_evictions_total ' | grep -qv ' 0\.0$' \
  && ok "H: oh_pool_evictions_total incremented" || bad "H: evictions metric not incremented"
for R in queue_full queue_timeout tenant_quota; do
  echo "$M" | grep -E "^oh_pool_admission_rejected_total\{reason=\"$R\"\} " | grep -qv ' 0\.0$' \
    && ok "H: rejected_total{reason=\"$R\"} incremented" || bad "H: rejected_total{reason=\"$R\"} missing/zero"
done
echo "$M" | grep -q '^oh_pool_backends_live 2\.0$' && ok "H: oh_pool_backends_live == 2 (slots accounted)" \
  || bad "H: backends_live gauge unexpected: $(echo "$M" | grep '^oh_pool_backends_live' | tr '\n' ' ')"
# Restart with default sizing: orphan scan must reclaim the pinned backend
# containers (F re-verified under WS-D pool wiring).
up_container_mode
wait_healthz || bad "H: gateway unhealthy after pool restore"
t=0; while [ $t -lt 45 ]; do
  [ -z "$(cids_for "$H2")$(cids_for "$H4")" ] && break; sleep 3; t=$((t+3))
done
[ -z "$(cids_for "$H2")$(cids_for "$H4")" ] && ok "H: restart reclaimed held pool containers" \
  || bad "H: leftover pool containers not reclaimed"
rm -f "$HQ.body" "$HQ.code" /tmp/h5_body.$$ /tmp/h5_hdr.$$ /tmp/h6_body.$$ /tmp/h6_hdr.$$

# --- TEST I: two-tenant memory isolation via the MinIO round-trip --------------
log "--- TEST I: dual-tenant memory isolation (MinIO round-trip) ---"
KMA=$(mint_key "$TEN-ma"); KMB=$(mint_key "$TEN-mb")
RA=$(create_sess "$KMA"); SA=$(echo "$RA" | json_field session_id)
[ -n "$SA" ] && ok "I: tenant-A session created" || bad "I: tenant-A create failed: $RA"
MARKER="e2e_marker_${RANDOM}.md"
sexec bash -c "mkdir -p /tenants/$TEN-ma/openharness/data/memory && echo 'tenant A private memory' > /tenants/$TEN-ma/openharness/data/memory/$MARKER" \
  && log "  marker staged into tenant-A staging: $MARKER" || bad "I: marker staging failed"
T=$(curl -s -m 120 -H "X-API-Key: $KMA" -H 'Content-Type: application/json' \
    -d '{"text":"memory isolation turn"}' "$BASE/v1/sessions/$SA/turns")
echo "$T" | grep -q '"status": *"completed"' && ok "I: tenant-A turn completed (stage-out hook fired)" || bad "I: tenant-A turn failed: $T"
sleep 2
BL_A=$(sexec $VENV_PY scripts/tenant_bucket_ls.py "tenants/$TEN-ma/")
echo "$BL_A" | grep -q "$MARKER" && ok "I: marker mirrored to tenant-A bucket prefix" \
  || bad "I: marker missing under tenants/$TEN-ma/ (got: $(echo "$BL_A" | tr '\n' ' '))"
RB=$(create_sess "$KMB"); SB=$(echo "$RB" | json_field session_id)
[ -n "$SB" ] && ok "I: tenant-B session created" || bad "I: tenant-B create failed: $RB"
BL_B=$(sexec $VENV_PY scripts/tenant_bucket_ls.py "tenants/$TEN-mb/")
echo "$BL_B" | grep -q "$MARKER" && bad "I: tenant-A marker leaked into tenant-B bucket prefix" \
  || ok "I: tenant-B bucket prefix clean of tenant-A marker"
sexec bash -c "grep -rq 'tenant A private memory' /tenants/$TEN-mb/ 2>/dev/null" \
  && bad "I: tenant-A memory visible in tenant-B staging" || ok "I: tenant-B staging clean of tenant-A memory"
# Cleanup: destroy both (final stage-out + staging/bucket trace removal).
curl -s -m 60 -X DELETE -H "X-API-Key: $KMA" "$BASE/v1/sessions/$SA" >/dev/null
curl -s -m 60 -X DELETE -H "X-API-Key: $KMB" "$BASE/v1/sessions/$SB" >/dev/null

# --- teardown: restore default (process) runtime -------------------------------
log "--- restoring session service to process runtime ---"
$COMPOSE up -d --force-recreate session 2>&1 | tail -1
wait_healthz && log "  gateway healthy (process mode restored)" || log "  WARN: gateway unhealthy after restore"

log "===== SUMMARY: pass=$pass fail=$fail ====="
exit $fail
