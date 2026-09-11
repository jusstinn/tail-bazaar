#!/usr/bin/env bash
. "$(dirname "$0")/env.sh"
if [ -f "$ROOT/.local/server.pid" ]; then kill "$(cat "$ROOT/.local/server.pid")" 2>/dev/null && echo "server stopped"; rm -f "$ROOT/.local/server.pid"; else echo "no server pid file"; fi
