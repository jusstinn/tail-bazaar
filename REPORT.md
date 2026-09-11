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
(Superseded by the polish pass below: hosting was blocked by the open reveal route, and that is now
closed — see P1.)

---

# Polish pass (P1–P4)

Four scoped changes on top of the build above. Nothing was redesigned, no contract was changed, and
the Base Sepolia deployment and its 14 recorded receipts stand unchanged.

## P1 — hosted mode: private data is no longer public (BLOCKER, closed)

`GET /api/orders/:id/reveal` was gated only by `DEMO_BUYER_CONSOLE`, so on a public URL any visitor
could read the paid evidence of any already-retrieved order. Setting **`PUBLIC_BASE_URL`** now means
hosted mode, and in hosted mode every route that can return private package bytes, private scenario
parameters, private trajectories or salts requires an `Authorization: Bearer` token. **Mechanism (a)
was chosen: the same signed-challenge buyer session used by the retrieval route** — a successful
`POST /api/retrieve` returns a session token (`x-tb-session`, 1 h, bound to that order); the optional
`OPERATOR_TOKEN` is accepted as a second path and is the only key to the pipeline trigger. Unset
`PUBLIC_BASE_URL` keeps local demonstration mode byte-for-byte as it was.

Audit of every route in `web/src/server/index.ts`: `/api/orders/:id/reveal` (package bytes) and
`/api/runs/baseline` (a full recorded trajectory) are the two that could return private data; both are
now behind `privateAccess()`. `POST /api/demo/run` is operator-only in hosted mode because it spends
the operator's test ETH, and `GET /api/demo/status` keeps its run id and status public but serves the
pipeline **log** only to the operator: the log carries no parameters, bytes or salts, but it prints a
finding's exact impact speed and trajectory hash, which is finer-grained than the public summary.
Everything else returns public projections only (`publicListing` /
`publicOrder` / the verifier's public summary / the published envelope), which the integration suite
asserts. Verified against a running server, not only in tests:

| Request (hosted mode, `CHAIN_MODE=local`) | Result |
|---|---|
| `GET /api/status` | `hosted_mode: true`, `private_routes_require_auth: true` |
| `GET /api/orders/<id>/reveal` (no header) | **401**, body carries no package bytes |
| `GET /api/runs/baseline` (no header) | **401** |
| `POST /api/demo/run` (no header) | **401** |
| `GET /api/demo/status` (no header) | 200 with `log_redacted: true`, empty log |
| `GET /api/orders/<id>/reveal` with the operator token | **200**, 125 038 bytes |
| `GET /api/listings` | 0 occurrences of `sensor_delay_ms`, `floor_friction`, `salt_hex` |

UI capture of the locked state: `evidence/ui/hosted-reveal-locked.png`.

## P2 — the verifier binds evidence to what it actually re-ran

Two holes: the claimed controller id/hash was never compared with the controller the verifier re-ran,
and the declared trajectory hash was compared instead of recomputed from the delivered replay frames.
Both are closed, at listing time and again at delivery: `claimed-controller-is-the-one-re-run`,
`package-controller-is-the-one-re-run`, `package-frames-hash-to-declared-trajectory`,
`package-frames-reproduce-verified-trajectory`, `delivered-frames-hash-to-verified-trajectory`,
`delivered-controller-is-the-one-re-run`. Under the `metrics-tolerance` method the frames are bound to
the trajectory hash the verifier accepted at listing time, since the two environments differ by
construction (this also fixes a latent false-INVALID in the delivery check for that method).

Three tests drive the real verifier against a real MuJoCo re-run with a throwaway database
(`web/src/server/__tests__/verifier-binding.test.ts`): a package declaring
`stop-before-obstacle-v2` / a fabricated hash is REJECTED with "claimed controller … is not the
controller the verifier re-ran"; a package whose frames were altered (one chassis coordinate moved,
last frame dropped) while its declared trajectory hash was left intact is REJECTED with "replay frames
do not hash to its declared trajectory hash" — and the test asserts that the pre-existing declared-hash
check still passed, i.e. only the new recomputation caught it; the honest package still verifies
VALID by `exact-trajectory-hash`.

## P3 — the buyer's real question, framed honestly

The controller documents a tuned range of sensor latency ≤ 40 ms, actuator latency ≤ 20 ms, floor
friction ≥ 0.6, payload 20 kg; the demo's sold failure sits at 200 ms and 0.3, outside it. The tuned
range and the searched envelope are now published side by side, with the question "can this controller
be deployed in a wider operating range than it was tuned for, and where exactly does it stop working?",
in the README, the marketplace page, the order page, the listing's public summary and a new public
`GET /api/envelope`. The revealed finding adds a per-axis "where this failure sits" table stating that
the failure is outside the tuned range on `sensor_delay_ms` and `floor_friction`, inside the searched
envelope on every axis, and therefore a measured boundary rather than a defect report. The
pre-purchase summary carries the two ranges as prose only — no parameter names, no values from this
scenario, no per-listing positioning — so it still reveals nothing about the hidden scenario; the leak
test and the summary-allowlist test both cover it. `controller.py` was not edited (its SHA-256 is the
controller version id in every recorded evidence document); the machine-readable mirrors live in
`envelope.py`, `envelope.ts` and `sim/envelope.yaml`, and a unit test fails if they drift from the
docstring.

## P4 — Loop / GUARD alignment

- `sim/envelope.yaml`: the four axes in GUARD's `configs/guard_theta.yaml` shape (`name, low, high,
  nominal, marginal, scale, units, group`; groups `physical` / `systems`), served as JSON by
  `GET /api/envelope`. `marginal` and `scale` are present and **null**: Tail Bazaar runs a bounded
  deterministic grid search and states no distribution D, and inventing one would be a fabrication.
- Field names: the ledger export carries `limit_state_margin_m` (GUARD's g(θ), = the recorded
  `min_range_m`), `impact_speed_mps`, `impact_kinetic_energy_j`, `total_mass_kg`. No tier, no dollar
  value; GUARD's ISO/TS 15066 numbers are PLACEHOLDER_UNVERIFIED there and were not imported.
- Verdict vocabulary: `VALID` / `INVALID` / `INCONCLUSIVE` on every verification and delivery, next to
  the status names already recorded on chain (VERIFIED ≡ VALID, REJECTED ≡ INVALID); INCONCLUSIVE
  never pays. The recorded Base Sepolia summaries keep the wording whose terms hash is on chain.
- Provenance (`web/src/server/provenance.ts`): `git_sha`, `git_dirty`, `envelope_config_hash` and a
  deterministic `run_id` (stage + resolved config → same id), reported by `GET /api/status`, logged by
  every pipeline run and stamped on every ledger row.
- Failure ledger (`web/src/server/ledger.ts`, `npm run ledger`, also written by the pipeline into its
  evidence directory): header with `n_nominal_runs` (6, sourced from `evidence/milestone/
  nominal-suite.json`), `n_search_runs` (144), verdict counts, both ranges, the product question and
  six explicit `placeholder_warnings`; one row per finding with controller id + hash, envelope id, θ,
  per-axis in/out of the tuned range, limit-state margin (0.001628 m), impact speed (0.414745 m/s) and
  energy (4.558 J), verdict and delivery verdict, `source` ("bounded grid search"), `search_cost`,
  `run_id`, provenance, environment pins, trajectory hash, commitment and the on-chain settlement.
  It contains θ — the product — so **no HTTP route serves it**; it is an operator/Loop artifact.

## Commands run in this pass and actual results

| Command | Result |
|---|---|
| `cd contracts && forge test` | **22 passed, 0 failed** (unchanged; no contract source was touched) |
| `cd web && npm test` | **23 passed, 0 failed** (7 pre-existing + 8 hosted-mode access control + 3 verifier evidence binding + 3 published-range/YAML anti-drift + 2 cleanup) |
| `cd web && CHAIN_MODE=local npm run test:integration` | **7 passed, 0 failed** (5 pre-existing + hosted-mode reveal end to end + the published envelope endpoint) |
| `cd web && npm run demo -- --reset --evidence ../evidence/local` | 144 sims, 43 collisions; order 1 VERIFIED/VALID → seller paid (all six binding checks ok); order 2 tampered → COMMITMENT MISMATCH → recheck → INVALID → buyer refunded; `ledger.json` written (2 findings, VALID 2; delivery verdicts VALID and INVALID) |
| `npm run ledger` | 2 findings over 144 search simulations, written to `evidence/local/ledger.json` |
| hosted-mode curl matrix against a running server | see the P1 table above |
| `cast code` vs `forge inspect FailureEscrow deployedBytecode` | identical except the three immutables (verifier address, 3600 s, 7200 s) — `evidence/testnet/bytecode-match.md` |

**Base Sepolia was not re-run and did not need to be.** P1–P4 are entirely off-chain; `contracts/` has
not changed since commit `8c9056d`, which predates the deployment. The deployed runtime bytecode at
`0xfadf11662C46c0214B0A40938a26FB8f0CD785A3` still matches the repository source (checked byte by
byte, above), and all 14 recorded receipts remain valid as recorded.

## Factual limitations

- Simplified cart physics in an illustrative envelope; adversarially selected failures do not estimate
  real-world failure frequency; severity is an uncalibrated impact-speed proxy; simulation needs
  calibration against physical robots before any underwriting use.
- The named verifier adjudicates correctness; the contract cannot check semantic validity. No audit,
  no Sybil resistance, no seller bond (deferred), not production-ready.
- Local demonstration mode: all three role keys are server-side test keys, and the buyer-console reveal
  endpoint shows purchased packages to anyone who can reach the UI. **On a public URL that is closed:
  setting `PUBLIC_BASE_URL` requires a buyer session or the operator token for it** (P1;
  `DEMO_BUYER_CONSOLE=0` removes the route entirely). What hosted mode does *not* change: the
  operator/verifier still sees every payload and a buyer can still redistribute what it bought — TLS
  plus trusted server storage remains the whole confidentiality model.
- Bit-identical reproduction is claimed only for the pinned environment (macOS arm64 here); the
  metrics-tolerance path exists for other environments but was not exercised across machines. The
  delivery-time binding of frames under that method is therefore covered by tests and code review, not
  by a cross-machine run.
- `uv sync` on Linux x86_64 was not executed in this pass (the lock contains manylinux wheels).
- The tampered delivery is a labeled demonstration switch, not an observed dishonest seller; the same
  is true of the two evidence-binding attacks, which exist as tests, not as observed seller behaviour.
- The buyer session is a server-side bearer token (SQLite `sessions`, 1 h, bound to one order). It is
  not a signed-per-request scheme, so anyone who obtains the token can re-read that one order's
  package until it expires; a multi-user deployment should bind it to a browser wallet session.
- `n_nominal_runs` in the ledger export is read from `evidence/milestone/nominal-suite.json`, the
  milestone artifact, because the demo pipeline does not run the nominal suite; the export names its
  source rather than presenting the number as something it measured.

## Running state left on this machine

anvil (pid in `.local/anvil.pid`) and the web server (pid in `.local/server.pid`,
http://127.0.0.1:3100) are left running for review; `scripts/server-stop.sh`, `scripts/anvil-stop.sh`.
After the polish pass the server runs in **local** chain mode against the regenerated demo database,
in local demonstration mode (no `PUBLIC_BASE_URL`), so the reveal view works without a token. To see
the hosted behaviour: `scripts/server-stop.sh`, then
`PUBLIC_BASE_URL=https://example.test node web/dist/server/index.js` — the same order page then shows
"authentication required" and the reveal route answers 401. To browse the Base Sepolia orders again:
`CHAIN_MODE=testnet scripts/server-start.sh`.
