#!/usr/bin/env bash
# Deploy FailureEscrow to the LOCAL anvil chain and record the address in .env (ESCROW_ADDRESS_LOCAL).
. "$(dirname "$0")/env.sh"
require_keys
cd "$ROOT/contracts"
OUT="$(forge create src/FailureEscrow.sol:FailureEscrow --broadcast --rpc-url "$LOCAL_RPC_URL" \
  --private-key "$VERIFIER_PRIVATE_KEY" --json --constructor-args "$VERIFIER_ADDRESS" "$DELIVERY_WINDOW_S" "$SETTLEMENT_WINDOW_S")"
ADDR="$(node -e 'console.log(JSON.parse(process.argv[1]).deployedTo)' "$OUT")"
TX="$(node -e 'console.log(JSON.parse(process.argv[1]).transactionHash)' "$OUT")"
echo "LOCAL anvil deployment: FailureEscrow at $ADDR (tx $TX, chain id $LOCAL_CHAIN_ID)"
if grep -q '^ESCROW_ADDRESS_LOCAL=' "$ROOT/.env"; then
  sed -i.bak "s|^ESCROW_ADDRESS_LOCAL=.*|ESCROW_ADDRESS_LOCAL=$ADDR|" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
else
  echo "ESCROW_ADDRESS_LOCAL=$ADDR" >> "$ROOT/.env"
fi
mkdir -p "$ROOT/.local"
printf '{"chain":"local-anvil","chain_id":%s,"address":"%s","deploy_tx":"%s","verifier":"%s","delivery_window_s":%s,"settlement_window_s":%s}\n' \
  "$LOCAL_CHAIN_ID" "$ADDR" "$TX" "$VERIFIER_ADDRESS" "$DELIVERY_WINDOW_S" "$SETTLEMENT_WINDOW_S" > "$ROOT/.local/deployment-local.json"
