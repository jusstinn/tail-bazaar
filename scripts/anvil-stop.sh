#!/usr/bin/env bash
. "$(dirname "$0")/env.sh"
if [ -f "$ROOT/.local/anvil.pid" ]; then kill "$(cat "$ROOT/.local/anvil.pid")" 2>/dev/null && echo "anvil stopped"; rm -f "$ROOT/.local/anvil.pid"; else echo "no anvil pid file"; fi
