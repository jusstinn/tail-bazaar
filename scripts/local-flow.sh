#!/usr/bin/env bash
# Drive the whole escrow state machine on the LOCAL anvil chain with cast, before any web code:
#   register (verifier) -> fund (buyer) -> markDelivered (seller) -> settle valid (verifier) -> withdraw (seller)
#   register (verifier) -> fund (buyer) -> markDelivered (seller, wrong hash) -> settle invalid -> withdraw (buyer)
# Every transaction here is LOCAL (chain id 31337). No explorer links exist for these hashes.
. "$(dirname "$0")/env.sh"
require_keys
RPC="$LOCAL_RPC_URL"
ADDR="${ESCROW_ADDRESS_LOCAL:?run scripts/local-deploy.sh first}"
PRICE=1000000000000000  # 0.001 ETH (local test ether)
send() { # send <key> <extra cast args...>; prints tx hash
  local key="$1"; shift
  cast send --rpc-url "$RPC" --private-key "$key" --json "$@" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.status!=="0x1"){console.error("tx reverted",r.transactionHash);process.exit(1)}console.log(r.transactionHash)})'
}
status_of() { cast call --rpc-url "$RPC" "$ADDR" "getListing(bytes32)((address,address,uint256,bytes32,bytes32,bytes32,uint64,uint64,uint64,uint8))" "$1"; }

L1="$(cast keccak "local-flow-listing-valid-$(date +%s)")"
C1="$(cast keccak "private package bytes with salt")"
T1="$(cast keccak "public summary bytes")"
echo "== valid purchase on LOCAL anvil =="
echo "register   tx $(send "$VERIFIER_PRIVATE_KEY" "$ADDR" 'registerListing(bytes32,address,uint256,bytes32,bytes32)' "$L1" "$SELLER_ADDRESS" "$PRICE" "$C1" "$T1")"
echo "fund       tx $(send "$BUYER_PRIVATE_KEY" --value "$PRICE" "$ADDR" 'fund(bytes32)' "$L1")"
echo "delivered  tx $(send "$SELLER_PRIVATE_KEY" "$ADDR" 'markDelivered(bytes32,bytes32)' "$L1" "$C1")"
echo "settle(ok) tx $(send "$VERIFIER_PRIVATE_KEY" "$ADDR" 'settle(bytes32,bool)' "$L1" true)"
BAL="$(cast call --rpc-url "$RPC" "$ADDR" 'balances(address)(uint256)' "$SELLER_ADDRESS")"
echo "seller withdrawable: $BAL wei (expected $PRICE)"
echo "withdraw   tx $(send "$SELLER_PRIVATE_KEY" "$ADDR" 'withdraw()')"
echo "seller settled orders: $(cast call --rpc-url "$RPC" "$ADDR" 'settledOrders(address)(uint256)' "$SELLER_ADDRESS")"
echo "listing: $(status_of "$L1")"

L2="$(cast keccak "local-flow-listing-invalid-$(date +%s)")"
C2="$(cast keccak "another private package")"
echo "== invalid delivery on LOCAL anvil =="
echo "register   tx $(send "$VERIFIER_PRIVATE_KEY" "$ADDR" 'registerListing(bytes32,address,uint256,bytes32,bytes32)' "$L2" "$SELLER_ADDRESS" "$PRICE" "$C2" "$T1")"
echo "fund       tx $(send "$BUYER_PRIVATE_KEY" --value "$PRICE" "$ADDR" 'fund(bytes32)' "$L2")"
echo "delivered  tx $(send "$SELLER_PRIVATE_KEY" "$ADDR" 'markDelivered(bytes32,bytes32)' "$L2" "$(cast keccak tampered)")"
echo "settle(no) tx $(send "$VERIFIER_PRIVATE_KEY" "$ADDR" 'settle(bytes32,bool)' "$L2" false)"
BAL="$(cast call --rpc-url "$RPC" "$ADDR" 'balances(address)(uint256)' "$BUYER_ADDRESS")"
echo "buyer withdrawable: $BAL wei (expected $PRICE)"
echo "withdraw   tx $(send "$BUYER_PRIVATE_KEY" "$ADDR" 'withdraw()')"
echo "listing: $(status_of "$L2")"
echo "escrow balance after both flows: $(cast balance --rpc-url "$RPC" "$ADDR") wei (expected 0)"
