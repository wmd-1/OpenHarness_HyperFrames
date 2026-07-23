#!/bin/sh
# =============================================================================
# OpenHarness HyperFrames - frontend container entrypoint.
# Renders the nginx template with configurable backend coordinates, then runs
# nginx. This makes the frontend image fully standalone: it can be pointed at
# any backend (compose service, remote host, k8s Service, ...) WITHOUT
# rebuilding the image.
# =============================================================================
set -e

# Defaults so the image works out-of-the-box inside docker-compose,
# where the backend service is named `api` and listens on 8000.
export API_HOST="${API_HOST:-api}"
export API_PORT="${API_PORT:-8000}"
export SESSION_HOST="${SESSION_HOST:-session}"
export SESSION_PORT="${SESSION_PORT:-8001}"

# Substitute ONLY our vars; nginx's own $variables ($host, $uri, ...)
# must stay literal, so we pass an explicit variable list to envsubst.
envsubst '${API_HOST} ${API_PORT} ${SESSION_HOST} ${SESSION_PORT}' \
    < /etc/nginx/templates/app.conf.template \
    > /etc/nginx/conf.d/app.conf

# Fail fast on a bad rendered config.
nginx -t

exec nginx -g 'daemon off;'
