#!/usr/bin/env bash
#
# 设计智能体前端：真实后端 E2E 编排脚本。
#
# 关键约定（必须与 .qoder/rules/test-on-existing-images.md 一致）：
#   1. 后端真实启动：以 `docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session`
#      拉起真实 session-service 栈（FastAPI + Postgres + Redis + WS + stub oh，确定性、无需 LLM key）。
#   2. 所有 E2E 在既有镜像 `openharness-design-frontend:e2e`（FROM `oh-e2e-test:latest`）内执行；
#      宿主机只负责起栈与编排，绝不宿主机直跑 `npx playwright test`。
#   3. Playwright 容器以 `--network host` 运行，使容器内 `localhost:8001` 指向宿主机上真实栈的
#      session 服务，从而走真实 REST/WS 通道。
#
# 用法：
#   ./e2e/run-design-frontend-real-backend-tests.sh [playwright-filter]
#   KEEP=1 ./e2e/run-design-frontend-real-backend-tests.sh        # 跑完保留栈
#   ./e2e/run-design-frontend-real-backend-tests.sh real-journey   # 只跑某个文件
#   PW_USE_NEW_HEADLESS=1 ./e2e/run-design-frontend-real-backend-tests.sh real-bfcache-reconnect  # BFCache 验证（完整 chromium + new headless）
#   OH_E2E_429_PROFILE=1  ./e2e/run-design-frontend-real-backend-tests.sh real-tenant-429          # 并发 429 验证（独立低并发 profile，默认 12 不改）
#
set -euo pipefail
cd "$(dirname "$0")/.."

# 启动失败早检测 hook（test-infra change 2026-08-04-test-infra-startup-failure-hook）
source "$(dirname "$0")/startup-failure-hook.sh"

# 默认 stub profile 保持 OH_TENANT_MAX_CONCURRENT=12 不变；429 专用验证通过
# 独立覆盖文件 docker-compose.stub.429.yml（limit=2）+ OH_E2E_429_PROFILE=1 启用。
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.stub.yml)
if [ "${OH_E2E_429_PROFILE:-}" = "1" ]; then
  COMPOSE_FILES+=(-f docker-compose.stub.429.yml)
fi
COMPOSE="docker compose ${COMPOSE_FILES[*]}"
SESSION_IMG="openharness-design-frontend:e2e"
CHROME="/opt/chrome-headless-shell-linux64/chrome-headless-shell"
FILTER="${1:-}"
KEEP="${KEEP:-}"

# BFCache 验证（test-infra change 2026-08-04-e2e-chromium-new-headless-bfcache）：
# PW_USE_NEW_HEADLESS=1 时在既有基础镜像之上构建含完整 chromium 的 e2e 镜像变体，
# 不改动默认 headless-shell 镜像。
if [ "${PW_USE_NEW_HEADLESS:-}" = "1" ]; then
  if [ "${SKIP_BUILD:-}" != "1" ] || ! docker image inspect openharness-design-frontend:e2e-chromium >/dev/null 2>&1; then
    echo "==> 构建 new-headless e2e 镜像（完整 chromium，支持 BFCache）"
    docker build --target e2e --build-arg INSTALL_FULL_CHROMIUM=1 \
      -t openharness-design-frontend:e2e-chromium "design-agent-frontend"
  else
    echo "==> 复用已构建的 new-headless e2e 镜像（SKIP_BUILD=1）"
  fi
  SESSION_IMG="openharness-design-frontend:e2e-chromium"
fi

echo "==> [1/5] 拉起真实 session-service 栈（stub oh，无需 LLM key）"
$COMPOSE up -d session

echo "==> [2/5] 等待 session:8001/healthz（含启动失败早检测）"
if ! wait_for_backend_ready session "http://127.0.0.1:8001/healthz" 8001 \
     docker compose "${COMPOSE_FILES[@]}"; then
  echo "错误：session 后端启动失败，已打印诊断，终止。" >&2
  $COMPOSE down >/dev/null 2>&1 || true
  exit 1
fi

echo "==> [3/5] 校验 stub override 生效（防配置漂移回真实 oh）"
if ! curl -fs http://127.0.0.1:8001/healthz | grep -q oh_backend_stub; then
  echo "错误：stub oh 未生效（配置漂移？请检查 compose -f 组合）" >&2
  $COMPOSE down >/dev/null 2>&1 || true
  exit 1
fi

echo "==> [3.5/5] 签发临时租户 key"
KEY_JSON=$($COMPOSE exec -T session python scripts/manage_api_keys.py create --tenant e2e-design --label "design-e2e")
KEY_ID=$(echo "$KEY_JSON" | awk '/^key_id:/{print $2}')
API_KEY=$(echo "$KEY_JSON" | awk '/^api_key:/{print $2}')
export E2E_API_KEY="$API_KEY"
echo "    key_id=$KEY_ID"

cleanup() {
  echo "==> [清理] revoke key + 关闭栈"
  if [ -n "${KEY_ID:-}" ]; then
    $COMPOSE exec -T session python scripts/manage_api_keys.py revoke --key-id "$KEY_ID" >/dev/null 2>&1 || true
  fi
  if [ -z "$KEEP" ]; then
    $COMPOSE down >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> [4/5] 选取空闲端口并运行 Playwright（真实浏览器 + 真实后端）"
FREE_PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('',0));print(s.getsockname()[1]);s.close()")
export E2E_PORT="$FREE_PORT"
echo "    使用端口 E2E_PORT=$FREE_PORT"
if [ "${PW_USE_NEW_HEADLESS:-}" = "1" ]; then
  PW_ENV_ARGS=(-e "PW_USE_NEW_HEADLESS=1")
else
  PW_ENV_ARGS=(-e "PW_CHROMIUM_PATH=$CHROME")
fi
# 429 profile：把开关透传进容器，供 real-tenant-429.spec.ts 的 gate 使用
if [ "${OH_E2E_429_PROFILE:-}" = "1" ]; then
  PW_ENV_ARGS+=(-e "OH_E2E_429_PROFILE=1")
fi
docker run --rm --network host \
  -e "E2E_API_KEY=$API_KEY" \
  "${PW_ENV_ARGS[@]}" \
  -e "E2E_PORT=$FREE_PORT" \
  -e "CI=${CI:-}" \
  -v "$(pwd)/design-agent-frontend/src:/app/src" \
  -v "$(pwd)/design-agent-frontend/e2e:/app/e2e" \
  -v "$(pwd)/design-agent-frontend/playwright.config.ts:/app/playwright.config.ts" \
  -v "$(pwd)/design-agent-frontend/vite.config.ts:/app/vite.config.ts" \
  -w /app \
  "$SESSION_IMG" \
  npx playwright test $FILTER
