#!/usr/bin/env bash
# Base Sepolia (chain id 84532) deployment + demonstration flow. PUBLIC TESTNET, test ETH only.
#
#   1. checks the verifier/deployer balance; if unfunded prints the three public addresses and
#      exits 2 without deploying or fabricating anything
#   2. deploys FailureEscrow with `forge create --broadcast` (reuses an existing deployment
#      recorded in evidence/testnet/deployment.json if code is still present at that address)
#   3. verifies source via Sourcify and Blockscout (keyless); Basescan too if ETHERSCAN_API_KEY is set
#   4. tops up the seller and buyer wallets from the verifier wallet with `cast send`
#   5. runs the marketplace pipeline in testnet mode: one valid purchase to settlement and one
#      tampered delivery to refund (real transactions, receipts saved under evidence/testnet/)
#   6. writes evidence/testnet/TESTNET.md with explorer links taken from the saved receipts
# Re-runnable: every step is idempotent or appends new orders.
. "$(dirname "$0")/env.sh"
require_keys
export EV="$ROOT/evidence/testnet"; mkdir -p "$EV/receipts"
EXPLORER="https://sepolia.basescan.org"
SELLER_TOPUP_WEI=300000000000000    # 0.0003 ETH (gas for markDelivered + withdraw)
BUYER_TOPUP_WEI=800000000000000     # 0.0008 ETH (two purchases at 0.0002 ETH + gas)

pick_rpc() {
  for u in "$BASE_SEPOLIA_RPC_URL" "$BASE_SEPOLIA_RPC_FALLBACK"; do
    if [ "$(cast chain-id --rpc-url "$u" 2>/dev/null)" = "$BASE_SEPOLIA_CHAIN_ID" ]; then echo "$u"; return 0; fi
  done
  echo "no Base Sepolia RPC reachable" >&2; return 1
}
RPC="$(pick_rpc)"
echo "Base Sepolia RPC: $RPC (chain id $BASE_SEPOLIA_CHAIN_ID)"

VB="$(cast balance --rpc-url "$RPC" "$VERIFIER_ADDRESS")"
echo "verifier/deployer $VERIFIER_ADDRESS balance: $VB wei ($(cast from-wei "$VB") ETH)"
# Requirement computed from what is still left to do: deployment gas (if not deployed), the top-ups
# that have not happened yet, and a gas margin for the verifier's own transactions.
DEPLOY_GAS_WEI=700000000000000     # 0.0007 ETH allowance for ~1.05M gas (generous at Base Sepolia prices)
GAS_MARGIN_WEI=100000000000000     # 0.0001 ETH for registerListing x2 + settle x2 (+ margin)
NEED="$GAS_MARGIN_WEI"
DEPLOYED=0
if [ -f "$EV/deployment.json" ]; then
  EXISTING="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).address||"")' "$EV/deployment.json")"
  if [ -n "$EXISTING" ] && [ "$(cast code --rpc-url "$RPC" "$EXISTING")" != "0x" ]; then DEPLOYED=1; fi
fi
[ "$DEPLOYED" = "1" ] || NEED="$(node -e 'console.log((BigInt(process.argv[1])+BigInt(process.argv[2])).toString())' "$NEED" "$DEPLOY_GAS_WEI")"
for pair in "$SELLER_ADDRESS:$SELLER_TOPUP_WEI" "$BUYER_ADDRESS:$BUYER_TOPUP_WEI"; do
  a="${pair%%:*}"; w="${pair##*:}"; b="$(cast balance --rpc-url "$RPC" "$a")"
  if [ "$(node -e 'console.log(BigInt(process.argv[1]) < BigInt(process.argv[2]) ? 1 : 0)' "$b" "$w")" = "1" ]; then
    NEED="$(node -e 'console.log((BigInt(process.argv[1])+BigInt(process.argv[2])).toString())' "$NEED" "$w")"
  fi
done
echo "still required in the verifier wallet: $NEED wei ($(cast from-wei "$NEED") ETH)"
if [ "$(node -e 'console.log(BigInt(process.argv[1]) < BigInt(process.argv[2]) ? 1 : 0)' "$VB" "$NEED")" = "1" ]; then
  cat <<MSG
UNFUNDED: the verifier/deployer wallet holds less than $(cast from-wei "$NEED") ETH on Base Sepolia.
Nothing was deployed. Send Base Sepolia test ETH (about 0.003 ETH total is enough) to:
  verifier/deployer  $VERIFIER_ADDRESS   (deploys, registers listings, settles, tops up the other two)
  seller             $SELLER_ADDRESS   (funded automatically by this script from the verifier wallet)
  buyer              $BUYER_ADDRESS   (funded automatically by this script from the verifier wallet)
Then re-run: scripts/testnet-deploy.sh
MSG
  exit 2
fi

# ---- deploy (or reuse) --------------------------------------------------------------------
ADDR=""
if [ -f "$EV/deployment.json" ]; then
  ADDR="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).address||"")' "$EV/deployment.json")"
  if [ -n "$ADDR" ] && [ "$(cast code --rpc-url "$RPC" "$ADDR")" != "0x" ]; then
    echo "reusing existing Base Sepolia deployment at $ADDR"
  else
    ADDR=""
  fi
fi
if [ -z "$ADDR" ]; then
  cd "$ROOT/contracts"
  OUT="$(forge create src/FailureEscrow.sol:FailureEscrow --broadcast --rpc-url "$RPC" --private-key "$VERIFIER_PRIVATE_KEY" \
        --json --constructor-args "$VERIFIER_ADDRESS" "$DELIVERY_WINDOW_S" "$SETTLEMENT_WINDOW_S")"
  ADDR="$(node -e 'console.log(JSON.parse(process.argv[1]).deployedTo)' "$OUT")"
  TX="$(node -e 'console.log(JSON.parse(process.argv[1]).transactionHash)' "$OUT")"
  cast receipt --rpc-url "$RPC" --json "$TX" > "$EV/receipts/deploy.json"
  BLOCK="$(node -e 'console.log(parseInt(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).blockNumber,16))' "$EV/receipts/deploy.json")"
  node -e '
const fs=require("fs");const [addr,tx,block,verifier,dw,sw]=process.argv.slice(1);
fs.writeFileSync(process.env.EV+"/deployment.json", JSON.stringify({
  chain:"base-sepolia", chain_id:84532, address:addr, deploy_tx:tx, block:Number(block), verifier,
  delivery_window_s:Number(dw), settlement_window_s:Number(sw), deployed_at:new Date().toISOString(),
  explorer_contract:"https://sepolia.basescan.org/address/"+addr, explorer_tx:"https://sepolia.basescan.org/tx/"+tx,
  verification:{}
},null,2)+"\n");' "$ADDR" "$TX" "$BLOCK" "$VERIFIER_ADDRESS" "$DELIVERY_WINDOW_S" "$SETTLEMENT_WINDOW_S"
  echo "DEPLOYED to Base Sepolia: $ADDR (tx $TX, block $BLOCK)"
  cd "$ROOT"
fi
if grep -q '^ESCROW_ADDRESS_BASE_SEPOLIA=' "$ROOT/.env"; then
  sed -i.bak "s|^ESCROW_ADDRESS_BASE_SEPOLIA=.*|ESCROW_ADDRESS_BASE_SEPOLIA=$ADDR|" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
else
  echo "ESCROW_ADDRESS_BASE_SEPOLIA=$ADDR" >> "$ROOT/.env"
fi
export ESCROW_ADDRESS_BASE_SEPOLIA="$ADDR"

# ---- source verification (keyless first) ----------------------------------------------------
CTOR="$(cast abi-encode 'constructor(address,uint64,uint64)' "$VERIFIER_ADDRESS" "$DELIVERY_WINDOW_S" "$SETTLEMENT_WINDOW_S")"
verify_with() { # verify_with <label> <args...>
  local label="$1"; shift
  local log="$EV/verify-$label.log"
  if (cd "$ROOT/contracts" && forge verify-contract --chain 84532 --constructor-args "$CTOR" "$@" "$ADDR" src/FailureEscrow.sol:FailureEscrow) > "$log" 2>&1; then
    echo "verification ($label): submitted/ok (see $log)"; echo "ok"
  else
    echo "verification ($label): failed (see $log)"; echo "failed"
  fi
}
SOURCIFY="$(verify_with sourcify --verifier sourcify | tail -1)"
BLOCKSCOUT="$(verify_with blockscout --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api/ | tail -1)"
BASESCAN="skipped (no ETHERSCAN_API_KEY)"
if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  BASESCAN="$(verify_with basescan --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY" --watch | tail -1)"
fi
node -e '
const fs=require("fs");const p=process.env.EV+"/deployment.json";const d=JSON.parse(fs.readFileSync(p,"utf8"));
d.verification={sourcify:process.argv[1],blockscout:process.argv[2],basescan:process.argv[3],
  sourcify_url:"https://repo.sourcify.dev/contracts/full_match/84532/"+d.address+"/",
  blockscout_url:"https://base-sepolia.blockscout.com/address/"+d.address+"?tab=contract"};
fs.writeFileSync(p, JSON.stringify(d,null,2)+"\n");' "$SOURCIFY" "$BLOCKSCOUT" "$BASESCAN"

# ---- top up seller and buyer from the verifier wallet ---------------------------------------
topup() { # topup <label> <addr> <wei>
  local bal; bal="$(cast balance --rpc-url "$RPC" "$2")"
  if [ "$(node -e 'console.log(BigInt(process.argv[1]) < BigInt(process.argv[2]) ? 1 : 0)' "$bal" "$3")" = "1" ]; then
    local tx; tx="$(cast send --rpc-url "$RPC" --private-key "$VERIFIER_PRIVATE_KEY" --value "$3" --json "$2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).transactionHash))')"
    cast receipt --rpc-url "$RPC" --json "$tx" > "$EV/receipts/topup-$1.json"
    echo "topped up $1 $2 with $3 wei (tx $tx)"
  else
    echo "$1 $2 already holds $bal wei"
  fi
}
topup seller "$SELLER_ADDRESS" "$SELLER_TOPUP_WEI"
topup buyer "$BUYER_ADDRESS" "$BUYER_TOPUP_WEI"

# ---- marketplace pipeline on testnet ------------------------------------------------------
cd "$ROOT/web"
[ -d node_modules ] || npm ci
[ -f dist/server/cli.js ] || npm run build
CHAIN_MODE=testnet node dist/server/cli.js demo --evidence "$EV"
echo "wrote $EV/TESTNET.md"
