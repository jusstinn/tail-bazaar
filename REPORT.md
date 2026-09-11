# Tail Bazaar — build report (Agent A, complete candidate)

Date: 2026-09-10/11 (local). Repository: private `jusstinn/tail-bazaar`, all work pushed to `origin/main`.
This report continues `STATUS.md` (simulator milestone); nothing from that milestone was redone.

## What was built, in order

1. **Contract** `contracts/src/FailureEscrow.sol` (Solidity 0.8.28, Foundry 1.8.1, no external Solidity
   dependency; the test file declares its own minimal `Vm` interface). State machine: None → Listed
   (verifier only) → Funded (exact price, not the seller) → Delivered (seller, ≤ delivery deadline) →
   SettledValid | SettledInvalid (verifier, ≤ settlement deadline); Funded/Delivered → Refunded via
   `claimTimeout` strictly after the relevant deadline; `requestRecheck` (buyer) emits only; pull
   `withdraw`; `settledOrders[seller]` counter. Buyer advantage documented.
2. **Local chain flow before any web code**: `scripts/anvil-start.sh`, `scripts/local-deploy.sh`,
   `scripts/local-flow.sh` drove register → fund → deliver → settle(true) → withdraw and the invalid
   variant with `cast`; escrow drained to 0 wei both times.
3. **Testnet script** `scripts/testnet-deploy.sh` (balance gate, deploy/reuse, Sourcify + Blockscout +
   Basescan verification, top-ups, pipeline, `TESTNET.md`).
4. **Server** `web/` (TypeScript, Hono, `node:sqlite`, viem, esbuild): public listings/orders API that
   never returns private packages; `POST /api/challenges` + `POST /api/retrieve` (single-use, 300 s,
   bound to order/buyer/chain/domain, EIP-191 signature, on-chain buyer + status check); buyer console
   reveal for purchased orders; demo trigger; seller / verifier / buyer agents; pipeline; CLI.
5. **UI** `web/src/client/`: Three.js dual viewport driven by recorded transforms only (baseline vs
   failure, synchronized, scrubber, jump-to-event, HUD from recorded ticks), listings, order timeline
   with real transaction status, checks, changed-conditions explanation, metrics, hashes, reproduction.
6. **Docs**: `README.md`, `DEMO_SCRIPT.md`, `deploy/start.sh` + `deploy/README.md` (systemd + Caddy),
   `.env.example`, `LICENSE` (MIT), `ATTRIBUTION.md`.

## Commands run and actual results

| Command | Result |
|---|---|
| `cd contracts && forge test` | 22 passed, 0 failed (success, invalid delivery, both deadline boundaries at t = deadline and t = deadline + 1, unauthorized verifier, wrong buyer, seller self-funding, second buyer, repeated settlement, settle without delivery, wrong payment ×3, unknown listing, commitment mismatch recorded, withdraw nothing, withdraw to rejecting receiver, constructor/registration zero checks) |
| `scripts/local-flow.sh` (anvil 31337) | valid: seller withdrawable 1e15 wei then 0, settledOrders 1; invalid: buyer refunded; escrow balance 0 |
| `cd web && npm test` | 7 passed (canonical number rules; recursive key sorting; byte-identical re-serialization of Python-written `baseline.json` and `failure.json` and reproduction of their trajectory hashes; keccak vector; admissibility; duplicate rule; severity bands) |
| `cd web && npm run demo -- --reset --evidence ../evidence/local` | 144 sims, 43 collisions; listing 1 VERIFIED (exact trajectory hash) → VALID → seller paid; listing 2 tampered → COMMITMENT MISMATCH → recheck event → INVALID → buyer refunded |
| `cd web && CHAIN_MODE=local npm run test:integration` | 5 passed (no private fields on any public endpoint; summary field allowlist; wrong signer 403, wrong binding 403, correct buyer 200 with keccak = commitment, nonce replay 401, cross-order nonce 401, expiry rejected; refunded order not retrievable; tampered order recorded mismatch + refund) |
| `scripts/testnet-deploy.sh` (Base Sepolia 84532) | see below |

## Base Sepolia (real public testnet transactions, test ETH only)

- `FailureEscrow` at `0xfadf11662C46c0214B0A40938a26FB8f0CD785A3`, deploy tx
  `0x1bbee5a525cdeb642cb7058c3b26b4d1662fbd2549d22ea161c81394f84fbc7d`, block 46669937, 1,045,016 gas
  at 0.006 gwei. Source verified: Basescan ("Pass - Verified"), Sourcify and Blockscout (submitted OK);
  logs in `evidence/testnet/verify-*.log`.
- Two listings registered, order 1 valid (5 txs) and order 2 tampered → refund (6 txs incl.
  `requestRecheck`). Final state read back with `cast`: statuses SettledValid / SettledInvalid,
  `balances` 0/0, `settledOrders(seller)` = 1, escrow ETH 0. All 14 receipts in
  `evidence/testnet/receipts/`; `evidence/testnet/TESTNET.md` has every hash with explorer links.
- Wallets after the run: verifier 0.00089 ETH, seller 0.0005 ETH, buyer 0.0006 ETH (test ETH).
- Incident, fixed: the first run deployed successfully but aborted before writing `deployment.json`
  (an unexported shell variable). The address/tx were recovered from the deployer's nonce-0
  transaction and recorded by hand; the script now exports the variable, reuses deployments, computes
  the funding requirement from the remaining steps, and the chain layer retries reads/simulations
  against lagging public RPC backends.

## Artifacts

`evidence/milestone/` (simulator milestone), `evidence/local/` (local demo: hunt, public summaries,
order timelines, local receipts), `evidence/testnet/` (deployment, receipts, verification logs,
TESTNET.md), `evidence/ui/` (headless-Chrome captures of the marketplace and both order pages in
local and testnet mode), `web/abi/FailureEscrow.json`.

## Blockers

None open. Public hosting and the demo video were out of scope for this pass; `deploy/` is ready.

## Factual limitations

- Simplified cart physics in an illustrative envelope; adversarially selected failures do not estimate
  real-world failure frequency; severity is an uncalibrated impact-speed proxy; simulation needs
  calibration against physical robots before any underwriting use.
- The named verifier adjudicates correctness; the contract cannot check semantic validity. No audit,
  no Sybil resistance, no seller bond (deferred), not production-ready.
- Local demonstration mode: all three role keys are server-side test keys; the buyer-console reveal
  endpoint shows purchased packages to anyone who can reach the UI (disable with `DEMO_BUYER_CONSOLE=0`).
  The operator/verifier sees payloads; buyers can redistribute them.
- Bit-identical reproduction is claimed only for the pinned environment (macOS arm64 here); the
  metrics-tolerance path exists for other environments but was not exercised across machines.
- `uv sync` on Linux x86_64 was not executed in this pass (the lock contains manylinux wheels).
- The tampered delivery is a labeled demonstration switch, not an observed dishonest seller.

## Running state left on this machine

anvil (pid in `.local/anvil.pid`) and the web server in testnet mode (pid in `.local/server.pid`,
http://127.0.0.1:3100) were left running for review; `scripts/server-stop.sh`, `scripts/anvil-stop.sh`.
