#!/usr/bin/env bash
# =============================================================================
# Web frontend FULL image-based test pipeline.
#
# All tests run inside Docker images -- nothing executes on the host except
# `docker` and `curl`:
#
#   1. Unit/lint stage : `docker build --target test`  -> lint + vitest run
#                        INSIDE the node build image; build fails on failure.
#   2. Runtime image   : build (or reuse) the nginx runtime image.
#   3. Smoke stage     : boot the runtime image and assert HTTP 200 +
#                        security headers via e2e/run-web-docker-smoke.sh.
#
# Usage:
#   bash e2e/run-web-docker-tests.sh
#     -> builds test stage + fresh runtime image, then smoke-tests it.
#
#   WEB_IMAGE=openharness_hyperframes_web:v0.1.9_v0.7.42_v1.3_v2.0 \
#     bash e2e/run-web-docker-tests.sh
#     -> unit tests still run in the build image, but the smoke test reuses
#        the EXISTING runtime image (no runtime rebuild).
#
#   WEB_NEW_TAG=openharness_hyperframes_web:v0.1.9_v0.7.20_v1.3_v2.1 \
#     bash e2e/run-web-docker-tests.sh
#     -> additionally tags the freshly built (and fully tested) runtime image.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${REPO_ROOT}/web"
TEST_IMAGE="openharness-web:test"

echo "=============================================="
echo " [1/3] Unit tests + lint (inside Docker image)"
echo "=============================================="
docker build --target test -t "${TEST_IMAGE}" "${WEB_DIR}"
echo "==> lint + vitest passed inside ${TEST_IMAGE}"

echo "=============================================="
echo " [2/3] Runtime image"
echo "=============================================="
if [ -n "${WEB_IMAGE:-}" ]; then
  echo "==> Reusing existing runtime image: ${WEB_IMAGE}"
else
  WEB_IMAGE="openharness-web:smoke"
  docker build -t "${WEB_IMAGE}" "${WEB_DIR}"
  echo "==> Built runtime image: ${WEB_IMAGE}"
fi

echo "=============================================="
echo " [3/3] Smoke test (security headers, in-container)"
echo "=============================================="
WEB_IMAGE="${WEB_IMAGE}" bash "${REPO_ROOT}/e2e/run-web-docker-smoke.sh"

if [ -n "${WEB_NEW_TAG:-}" ]; then
  docker tag "${WEB_IMAGE}" "${WEB_NEW_TAG}"
  echo "==> Tagged tested image as ${WEB_NEW_TAG}"
fi

echo "ALL IMAGE-BASED TESTS PASSED"
