#!/bin/sh
# Container entrypoint.
# Hosted platforms (Render, Fly, Railway...) mount the persistent disk owned by root, which the unprivileged "node" user
# cannot write to. So the container starts as root only long enough to fix the ownership of the data folder, then drops
# to "node" before running the app. If it is already started as a non-root user (for example `user: node` in the hardened
# docker-compose.prod.yml) it just runs the command.
set -e
DATA="${HACKCONNECT_DATA_DIR:-/app/.hackconnect}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R node:node "$DATA" 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
