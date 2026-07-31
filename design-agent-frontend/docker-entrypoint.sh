#!/bin/sh
# =============================================================================
# OpenHarness Session Frontend - container entrypoint.
# Renders the nginx template with configurable session-service coordinates,
# then runs nginx. This makes the frontend image fully standalone: it can be
# pointed at any session-service (compose service, remote host, k8s Service,
# ...) WITHOUT rebuilding the image.
# =============================================================================
set -e

# Defaults so the image works out-of-the-box inside docker-compose,
# where the backend service is named `session` and listens on 8001.
export SESSION_HOST="${SESSION_HOST:-session}"
export SESSION_PORT="${SESSION_PORT:-8001}"

# Substitute ONLY our vars; nginx's own $variables ($host, $http_upgrade, ...)
# must stay literal, so we pass an explicit variable list to envsubst.
envsubst '${SESSION_HOST} ${SESSION_PORT}' \
    < /etc/nginx/templates/app.conf.template \
    > /etc/nginx/conf.d/app.conf

# Fail fast on a bad rendered config.
nginx -t

exec nginx -g 'daemon off;'
