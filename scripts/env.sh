#!/usr/bin/env bash
# Shared helpers. Source this; never echo private keys.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
_CM="${CHAIN_MODE:-}"; _PORT="${PORT:-}"
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
[ -n "$_CM" ] && export CHAIN_MODE="$_CM"      # a value given on the command line wins over .env
[ -n "$_PORT" ] && export PORT="$_PORT"
: "${LOCAL_RPC_URL:=http://127.0.0.1:8545}"
: "${LOCAL_CHAIN_ID:=31337}"
: "${BASE_SEPOLIA_RPC_URL:=https://sepolia.base.org}"
: "${BASE_SEPOLIA_RPC_FALLBACK:=https://base-sepolia-rpc.publicnode.com}"
: "${BASE_SEPOLIA_CHAIN_ID:=84532}"
: "${DELIVERY_WINDOW_S:=3600}"
: "${SETTLEMENT_WINDOW_S:=7200}"
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 1; }; }
need cast; need forge
require_keys() {
  for v in VERIFIER_PRIVATE_KEY SELLER_PRIVATE_KEY BUYER_PRIVATE_KEY; do
    if [ -z "${!v:-}" ] || [ "${!v}" = "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
      echo "$v is not set in .env (generate test-only keys with 'cast wallet new')" >&2; exit 1
    fi
  done
  VERIFIER_ADDRESS="$(cast wallet address --private-key "$VERIFIER_PRIVATE_KEY")"
  SELLER_ADDRESS="$(cast wallet address --private-key "$SELLER_PRIVATE_KEY")"
  BUYER_ADDRESS="$(cast wallet address --private-key "$BUYER_PRIVATE_KEY")"
  export VERIFIER_ADDRESS SELLER_ADDRESS BUYER_ADDRESS
}
