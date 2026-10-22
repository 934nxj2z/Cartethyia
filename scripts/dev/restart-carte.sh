#!/bin/sh
# Restart the dev stack so a fresh backend picks up committed changes.
# `--hot` reloads the entry module, but provider modules reached through the
# lazy registry are cached, so a quota collector edit can stay live in a process
# that has been running for a while.
set -e
PID=$(netstat -ano | grep ':12800.*LISTENING' | awk 'NR==1{print $NF}')
if [ -n "$PID" ]; then
  taskkill //PID "$PID" //F 2>/dev/null || taskkill /PID "$PID" /F || true
fi
cd "$(dirname "$0")/../.."
exec bun run dev
