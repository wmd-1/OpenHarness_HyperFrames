#!/usr/bin/env bash
# =============================================================================
# startup-failure-hook.sh — 后端启动失败早检测（test-infra change
# 2026-08-04-test-infra-startup-failure-hook）。被 e2e 起栈脚本 source，不单独执行。
#
# 职责：
#   1. 起栈（up -d）之后、跑用例之前，检测后端进程是否真正进入 ready；
#      未 ready 则早失败并输出可操作诊断（容器状态/退出码、日志尾部脱敏、
#      端口占用、最近 healthz 探测）。
#   2. 区分「启动慢」（容器仍 running，grace 内继续等）与「启动失败」
#      （容器 exited/dead，或 grace 内始终未 ready）。
#   3. 与既有 healthz 含 oh_backend_stub 校验共存，不重复该职责。
#
# 用法（在 runner 中）：
#   source "$(dirname "$0")/startup-failure-hook.sh"
#   if ! wait_for_backend_ready session "http://127.0.0.1:8001/healthz" 8001 \
#         docker compose -f docker-compose.yml -f docker-compose.stub.yml; then
#     exit 1
#   fi
#
# 环境变量：
#   STARTUP_READY_TIMEOUT  就绪宽限秒数（默认 120，须 > 单进程冷启动耗时）
#   STARTUP_POLL_INTERVAL  轮询间隔秒数（默认 2）
# =============================================================================

# 脱敏：遮蔽常见密钥形态（*_API_KEY / X-API-Key / Authorization: Bearer / "api_key"）
redact_secrets() {
  sed -E \
    -e 's/([Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]:[[:space:]]*)[^[:space:]"]+/\1<redacted>/g' \
    -e 's/([Aa][Pp][Ii]_?[Kk][Ee][Yy][=:[:space:]]+)[^[:space:]"]+/\1<redacted>/g' \
    -e 's/([Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+)[^[:space:]]+/\1<redacted>/g' \
    -e 's/("api_key"[[:space:]]*:[[:space:]]*")[^"]+(")/\1<redacted>\2/g'
}

# 打印启动失败诊断块。
# 参数：<service> <healthz-url> <host-port> -- 之后为 compose 调用前缀
diagnose_backend_failure() {
  local service="$1" url="$2" port="$3"; shift 3
  local -a compose=("$@")
  local cid status exit_code
  echo "================================================================"
  echo " 启动失败诊断 (startup-failure hook)"
  echo "   service : ${service}"
  echo "   healthz : ${url}"
  echo "   port    : ${port}"
  echo "================================================================"
  cid="$("${compose[@]}" ps -aq "${service}" 2>/dev/null | head -n1)"
  if [ -z "${cid}" ]; then
    echo "[容器] 未找到 '${service}' 容器（可能未创建或已退出移除）"
  else
    read -r status exit_code < <(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "${cid}" 2>/dev/null)
    echo "[容器] cid=${cid} status=${status:-<unknown>} exit_code=${exit_code:-<unknown>}"
    echo "[日志尾部 50 行（已脱敏）]:"
    docker logs --tail 50 "${cid}" 2>&1 | redact_secrets | sed 's/^/    /'
  fi
  echo "[端口占用 :${port}]:"
  ( ss -ltn 2>/dev/null | grep -E "[:.]${port}([[:space:]]|\$)" || echo "    无进程监听 ${port}" ) | sed 's/^/    /'
  echo "[最近 healthz 探测（<=500B）]:"
  ( curl -sS -m 3 "${url}" 2>&1 | head -c 500 || true ) | sed 's/^/    /'
  echo "================================================================"
}

# 等待后端就绪；区分「启动慢」与「启动失败」。
# 参数：<service> <healthz-url> <host-port> -- 之后为 compose 调用前缀
# 返回：0=就绪；1=启动失败（已打印诊断）
wait_for_backend_ready() {
  local service="$1" url="$2" port="$3"; shift 3
  local -a compose=("$@")
  local grace="${STARTUP_READY_TIMEOUT:-120}"
  local interval="${STARTUP_POLL_INTERVAL:-2}"
  local waited=0 cid status exit_code

  echo "==> 启动就绪检测：service=${service} healthz=${url} grace=${grace}s"
  while (( waited < grace )); do
    # 1) 容器是否已进入终态（exited/dead）→ 启动失败，立即诊断早失败
    #    用 -a 确保已退出容器也能被取到（ps -q 对 exited 容器不稳定）
    cid="$("${compose[@]}" ps -aq "${service}" 2>/dev/null | head -n1)"
    if [ -n "${cid}" ]; then
      read -r status exit_code < <(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "${cid}" 2>/dev/null)
      case "${status}" in
        exited|dead|removing)
          echo "!! 容器 '${service}' 已进入终态（status=${status} exit_code=${exit_code}），判定启动失败"
          diagnose_backend_failure "${service}" "${url}" "${port}" "${compose[@]}"
          return 1
          ;;
      esac
    fi

    # 2) healthz 200 → 就绪
    if curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then
      echo "    ${service} 健康检查通过（耗时 ~${waited}s）"
      return 0
    fi

    # 3) 否则仍属「启动中/启动慢」，继续等待（不误判为失败）
    sleep "${interval}"
    waited=$((waited + interval))
    if (( waited < grace )); then
      echo "    ${service} 尚未就绪（已等 ${waited}s），继续…"
    fi
  done

  # 4) 宽限耗尽仍未就绪 → 启动失败
  echo "!! 宽限 ${grace}s 内 '${service}' 始终未通过 healthz，判定启动失败"
  diagnose_backend_failure "${service}" "${url}" "${port}" "${compose[@]}"
  return 1
}

# 自测：验证脱敏逻辑（无需 docker / 后端，可在既有 e2e 镜像内运行）。
run_startup_hook_selftest() {
  local sample rc=0 out
  sample=$'X-API-Key: sk-secret-12345\nAuthorization: Bearer tok-abc\napi_key=ak-xyz\nOH_TENANT_API_KEY=ten-999\nnormal log line\n'
  out="$(printf '%s' "$sample" | redact_secrets)"
  for needle in 'sk-secret-12345' 'tok-abc' 'ak-xyz' 'ten-999'; do
    if printf '%s' "$out" | grep -q "$needle"; then
      echo "SELFTEST FAIL: secret not redacted: $needle"; rc=1
    fi
  done
  if ! printf '%s' "$out" | grep -q 'normal log line'; then
    echo "SELFTEST FAIL: benign line dropped"; rc=1
  fi
  if [ "$rc" -eq 0 ]; then echo "SELFTEST PASS: redact_secrets ok"; fi
  return "$rc"
}

# 直接执行时运行自测（source 时不会触发）。
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  run_startup_hook_selftest
fi
