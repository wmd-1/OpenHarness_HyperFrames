#!/usr/bin/env bash
# WS-B tenant-store test harness (openspec session-container-pool-multitenancy 2.6).
#
# Runs the session-service suite inside the EXISTING oh-session-test image
# (source mounted, per repo rule test-on-existing-images), with the compose
# `minio` service up so the MinIO integration layer executes instead of
# skipping. Usage:  e2e/run-session-minio-tests.sh [extra pytest args]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_IMAGE="${TEST_IMAGE:-oh-session-test:latest}"
NETWORK="${NETWORK:-openharness_hyperframes_default}"

# Authoritative-store instance: official minio image via compose (healthcheck'd).
docker compose -f "${ROOT}/docker-compose.yml" up -d --wait minio

docker run --rm \
  --network "${NETWORK}" \
  -e OH_TEST_MINIO_ENDPOINT=minio:9000 \
  -e OH_TEST_MINIO_ACCESS_KEY="${OH_MINIO_ACCESS_KEY:-ohminio}" \
  -e OH_TEST_MINIO_SECRET_KEY="${OH_MINIO_SECRET_KEY:-ohminio-secret}" \
  -v "${ROOT}/session-service:/opt/oh-session-service" \
  "${TEST_IMAGE}" "${@:--q}"
