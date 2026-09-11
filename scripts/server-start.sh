#!/usr/bin/env bash
# Start the built web server in the background (LOCAL use; deploy/start.sh is the hosting entry point).
. "$(dirname "$0")/env.sh"
mkdir -p "$ROOT/.local"
if [ -f "$ROOT/.local/server.pid" ] && kill -0 "$(cat "$ROOT/.local/server.pid")" 2>/dev/null; then echo "server already running (pid $(cat "$ROOT/.local/server.pid"))"; exit 0; fi
cd "$ROOT/web"
nohup node dist/server/index.js > "$ROOT/.local/server.log" 2>&1 &
echo $! > "$ROOT/.local/server.pid"
for i in $(seq 1 50); do curl -fsS "http://127.0.0.1:${PORT:-3100}/api/status" >/dev/null 2>&1 && break; sleep 0.2; done
echo "server pid $(cat "$ROOT/.local/server.pid") on port ${PORT:-3100}; log .local/server.log"
