#!/usr/bin/env bash
# Start a local anvil chain on 127.0.0.1:8545 (chain id 31337) in the background and fund the
# three TEST-ONLY role addresses from anvil's built-in faucet balances. LOCAL ONLY: nothing here
# touches a public network.
. "$(dirname "$0")/env.sh"
require_keys
mkdir -p "$ROOT/.local"
if cast chain-id --rpc-url "$LOCAL_RPC_URL" >/dev/null 2>&1; then
  echo "anvil already listening on $LOCAL_RPC_URL"
else
  nohup anvil --host 127.0.0.1 --port 8545 --chain-id "$LOCAL_CHAIN_ID" --block-time 1 --silent \
    > "$ROOT/.local/anvil.log" 2>&1 &
  echo $! > "$ROOT/.local/anvil.pid"
  for i in $(seq 1 50); do cast chain-id --rpc-url "$LOCAL_RPC_URL" >/dev/null 2>&1 && break; sleep 0.2; done
  echo "anvil started (pid $(cat "$ROOT/.local/anvil.pid"), log .local/anvil.log)"
fi
for a in "$VERIFIER_ADDRESS" "$SELLER_ADDRESS" "$BUYER_ADDRESS"; do
  cast rpc --rpc-url "$LOCAL_RPC_URL" anvil_setBalance "$a" 0x8AC7230489E80000 >/dev/null  # 10 ETH of local test ether
done
echo "funded (local anvil only): verifier=$VERIFIER_ADDRESS seller=$SELLER_ADDRESS buyer=$BUYER_ADDRESS"
