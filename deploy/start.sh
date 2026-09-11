#!/usr/bin/env bash
# Hosting entry point (Linux or macOS): builds if needed and starts the server bound to 0.0.0.0.
# Reads PORT (default 3100) and PUBLIC_BASE_URL from the environment / .env. Secrets stay in .env.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export PORT="${PORT:-3100}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:$PORT}"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"   # uv installs itself here on Linux
command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/getting-started/installation/)"; exit 1; }
command -v node >/dev/null || { echo "node >= 22.13 is required"; exit 1; }
( cd sim && uv sync --frozen )                       # MuJoCo + NumPy from the lock file (manylinux wheels on x86_64)
( cd web && { [ -d node_modules ] || npm ci; } && { [ -f dist/server/index.js ] && [ -f dist/client/app.js ] || npm run build; } )
exec node web/dist/server/index.js
