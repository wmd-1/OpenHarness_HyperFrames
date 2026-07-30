#!/usr/bin/env bash
# =============================================================================
# lib.sh - shared assertion / report helpers for the session live-acceptance
# sub-scripts (session-acceptance-hardening P1-4). Sourced, never executed.
#
# Contract:
#   - E2E_REPORT   : report file every PASS/FAIL/WARN line is appended to
#                    (default /tmp/session-live-acceptance.txt)
#   - PASS/FAIL/WARN counters are per-sourcing-script
#   - finish <name>: prints the summary line and returns non-zero when any
#                    assertion failed (sub-scripts exit with this code)
# Host-side only curl is used, per the image-based-testing rule.
# =============================================================================

: "${E2E_REPORT:=/tmp/session-live-acceptance.txt}"

PASS=0
FAIL=0
WARN=0

_log() {
  echo "$*"
  echo "$*" >>"${E2E_REPORT}"
}

ok() { PASS=$((PASS + 1)); _log "PASS: $*"; }
ko() { FAIL=$((FAIL + 1)); _log "FAIL: $*"; }
wa() { WARN=$((WARN + 1)); _log "WARN: $*"; }

assert_eq() { # <desc> <got> <want>
  if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 (got=$2 want=$3)"; fi
}

assert_contains() { # <desc> <haystack> <needle>
  if echo "$2" | grep -q "$3"; then ok "$1"; else ko "$1 (missing: $3)"; fi
}

assert_not_contains() { # <desc> <haystack> <needle>
  if echo "$2" | grep -q "$3"; then ko "$1 (unexpected: $3)"; else ok "$1"; fi
}

# http <METHOD> <URL> [extra curl args...]
# Sets HTTP_CODE / HTTP_BODY. --path-as-is keeps traversal probes intact.
http() {
  local method="$1" url="$2" out
  shift 2
  out="$(curl -sS --path-as-is -X "${method}" "${url}" -w $'\n%{http_code}' "$@" 2>/dev/null)" || true
  HTTP_CODE="${out##*$'\n'}"
  HTTP_BODY="${out%$'\n'*}"
}

# json_field <body> <field> -> best-effort string/uuid extraction without jq.
json_field() {
  echo "$1" | grep -oE "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
}

finish() { # <sub-script name>
  _log "== $1: ${PASS} passed, ${FAIL} failed, ${WARN} warned =="
  [ "${FAIL}" -eq 0 ]
}
