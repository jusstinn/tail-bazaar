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

# Multi-target pass — the marketplace carries two robots

The redesign pass left a marketplace with one target. This pass made the marketplace **multi-target**
and integrated the finished humanoid balance policy as target 2, applied the 3D materials palette,
and brought the documentation up to what the code now does. No file under `sim/` or `contracts/` was
touched.

## The target registry

Everything a robot needs the marketplace to know lives in one data structure,
`web/src/server/targets.ts`: id, label, the machine in plain language, the envelope YAML and its id,
the **simulator entry point** (Python module + CLI shape), the environment fields that make up its
fingerprint, its failure classes with who detects each one, its severity proxy and units, its
admissibility / distance / duplicate rules, its physical-plausibility derivation, and a replay
renderer id. `TARGETS` is a two-entry map; every agent, route, ledger row and page reads from it.

| | cart | humanoid |
|---|---|---|
| envelope | `tb-envelope-1` (`sim/envelope.yaml`, 5 axes) | `tb-humanoid-envelope-1` (`sim/envelope-humanoid.yaml`, 7 continuous + 1 discrete) |
| simulator | `uv run python -m tailbazaar_sim.cli --out DIR run\|hunt\|nominal …` | `uv run python -m tailbazaar_sim.humanoid.cli --out DIR run\|hunt\|nominal\|repeat …` |
| subject bound by | SHA-256 of `controller.py` | actor-tensor sha256 of the pinned SAC checkpoint |
| failure classes | `COLLISION`, `LOAD_SHED` (simulator contact flag / slip criterion) | `FELL` (Gymnasium's own health predicate) |
| severity proxy | `impact_speed_mps`, bands 0.5 / 1.0 m/s | `torso_impact_speed_mps`, bands anchored to `sqrt(2·g·1.0 m) = 4.43 m/s` — a free fall from the height at which the environment already calls the torso unhealthy |
| plausibility ceiling | `sqrt(2·(1+μ_max)·g·d_max) + sqrt(2·g·h_obstacle)` = **67.0 m/s** | `J_max/(m·s_min) + sqrt(2·(1+μ_max)·g·d_max) + sqrt(2·g·h_stand)` = **78.871 m/s** |
| honest replay peaks at | 2.0 m/s | 8.1–10.0 m/s |
| renderer | `cart-3d` | `humanoid-3d` |

The verifier applies the **same** rules to both: admissibility against that target's envelope, the
duplicate rule within target and subject, a failure class that target actually has, a re-run with that
target's own CLI, the claimed subject digest equal to the one re-run, the trajectory hash **recomputed**
from the delivered frames, the per-target plausibility bound, and — the rule that matters —
**an environment fingerprint that does not match is INCONCLUSIVE, never VALID**. All of it runs again
on the bytes actually delivered.

Also in this pass: buyer policy takes a target filter and a budget (the demo runs one policy per robot
so the filter is visible in the log); `GET /api/envelope` publishes one envelope document per target;
`GET /api/market` publishes aggregate search cost; the `listings` and `ledger` tables gained
`target_id` with an additive migration that reads a null as "cart", which was the only target when
those rows were written.

## Search cost, published where it is safe

Post-purchase, the finding page states the aggregate for the sweep that found it — "the hunter ran 88
simulations in this sweep, and 53 of them produced FELL — 60 % of the sweep" — with the wall time,
physics steps, distinct findings and near-duplicates. The marketplace shows a market-wide counter and
a per-robot total. Neither is a per-listing disclosure of parameters: a count of simulations narrows
no scenario, and the integration suite asserts that no envelope-axis identifier of **either** target
appears in `/api/listings`, `/api/orders` or `/api/market`.

## The humanoid replay renderer

`web/src/client/replay.ts` became a generic engine (camera, timeline, freeze and slow motion through
the moment, ghost overlay, split mode, snapshot, visibility check) with one `SceneRenderer` per
target. The humanoid renderer draws the MJCF primitives the run publishes in `scene.render_bodies` —
one capsule, sphere or box per geom, posed local to a named body — and poses those bodies from the
recorded world transforms. Nothing about the humanoid is hard-coded in the browser. It opens 0.6 s
before the fall, draws the surviving nominal run as a translucent ghost one lane over, marks the fall
**and** the ground impact on the scrubber, and carries the measured torso impact speed in the callout.
It also draws the environment's own healthy-height floor as a thin outline at `healthy_z_range[0]`,
because that line is the failure definition, and turns the HUD's torso height warm-red below it.
No physics runs in the browser, on either target.

Two bugs found and fixed by looking at the rendered result rather than the code: the humanoid's
per-tick array is decimated by the same stride as its frames, so indexing it by the raw 15 ms control
tick read the wrong tick (the HUD claimed a 0.22 m torso height a second before the fall); and a
filled translucent plate at 1 m read as a table the humanoid was standing under, which is the opposite
of what it means.

## 3D palette

`web/src/client/palette.ts` is now the single source for both viewports: charcoal chassis, sand load,
terracotta obstacle, mid-grey wheels, humanoid in a neutral warm stone, off-white floor with a faint
graphite grid. The baseline ghost is a translucent graphite; the single warm red `#B42318` — the same
one the page uses for every piece of failure evidence — is reserved for the contact ring and the
callout and used for nothing else. **There is no blue in any viewport.** The page's legend swatches
are generated from the same constants, so the two cannot drift.

## Commands run in this pass and actual results

| Command | Result |
|---|---|
| `cd web && npm test` | **59 passed, 0 failed** (was 46: + 7 humanoid envelope, registry and plausibility, + 5 humanoid verifier binding, + 1 humanoid failure-class narration from a committed run document) |
| `cd web && CHAIN_MODE=local npm run test:integration` | **11 passed, 0 failed** (was 7: + both targets on the market, + one envelope per target, + aggregate search cost, + target id on every ledger row, + renderer declared equals renderer published) |
| `cd contracts && forge test` | **22 passed, 0 failed** (no contract source was touched) |
| `cd web && npm run demo -- --reset --evidence ../evidence/local` | **4 listings across 2 targets, 4 orders.** Cart grid hunt: 144 sims, 336 070 physics steps, 7.435 s, 102 SUCCESS / 42 COLLISION (3 also LOAD_SHED) / 0 inconclusive, 42 distinct. Humanoid push grid: 88 sims, 240 465 steps, 10.032 s, 35 survived / 53 FELL / 0 inconclusive, 30 distinct, 23 near-duplicates. Findings: cart 0.380667 m/s (low) and 0.597248 m/s (medium); humanoid 4.801319 m/s at t = 2.835 s and 4.549013 m/s at t = 2.985 s (both high). Three settled VALID → seller paid; the tampered cart delivery → COMMITMENT MISMATCH → recheck → INVALID → buyer refunded |
| `npm run ledger` | 4 findings `{"VALID": 4}`, `findings_by_target {"cart": 2, "humanoid": 2}`, over 232 search simulations / 576 535 physics steps |
| hosted-mode matrix on a real order id (`0x7340e290…15131dd71`, humanoid) | anonymous: `/api/orders/<id>/reveal` **401**, `/api/runs/baseline` **401**, `/api/runs/baseline?target=humanoid` **401**, demo log redacted (`log_redacted: true`, 0 lines); public routes still 200. With the operator token: reveal **200** (`x-access-via: operator`), humanoid baseline **200**. Wrong token: **401** |
| pre-purchase leak test (anonymous `/api/listings`, `/api/orders`, `/api/market`) | **PASS** — none of the 17 markers (both targets' axis identifiers, `salt_hex`, `"frames"`, `"ticks"`, `trajectory_hash`, `reproduce`) appears |
| UI captures | `evidence/ui/marketplace.png`, `order-cart-collision.png`, `order-humanoid-fell.png`, `order-invalid-refund.png`, `how-it-works.png`, `hosted-reveal-locked.png`, plus `replay-cart-impact.png` / `replay-humanoid-impact.png` crops of the two viewports at their failure moment |

`window.tbReplay.visibility()` on the humanoid finding reports the torso at NDC (−0.043, −0.259) in
overlay mode and both tracks inside the frame in split mode — the framing check the redesign
introduced now covers the second renderer too.

**Base Sepolia was not re-run and did not need to be.** This pass is entirely off-chain and
`contracts/` is unchanged; the deployment at `0xfadf11662C46c0214B0A40938a26FB8f0CD785A3` and its 14
recorded receipts stand as recorded. The testnet UI captures (`evidence/ui/testnet-*.png`) show the
pre-multi-target interface and are kept as the record of that run.

## Factual limitations added or sharpened in this pass

- **Adversarially selected failures are not failure frequencies.** The search-cost ratio now shown on
  a finding page describes the hunter's sweep, not the field. No distribution D is stated for either
  envelope.
- **Both simulators need calibration.** Target 2 is Gymnasium's 42.116 kg `humanoid.xml` mannequin
  driven by somebody else's research checkpoint: no perception stack, no compliance, no real actuator
  model. Nothing here transfers to hardware.
- **One verifier, trusted.** Unchanged, and now stated as its own limitation rather than buried in the
  trust list.
- **Unaudited.** No contract audit, no Sybil resistance, no meaningful rate limiting.
- **The hosted-mode buyer session is a bearer token.** Bound to one order and issued only to the
  buyer's signature, but not sender-constrained: whoever holds the string has that access until it
  expires.
- **The humanoid policy's licence is undeclared.** The model repository states none; this project
  asserts none on its behalf, vendors nothing and redistributes nothing. See the README's "Target 2"
  and `evidence/humanoid/README.md` §1 — both say what was checked and which alternatives were tried.
- The humanoid's nominal suite keeps a case that **fails** (one 15 ms control tick fells the policy).
  The ledger now reports `all_passed` and `gate_passed` separately so that a finding about the policy
  is not misreported as a broken harness.
- The two humanoid findings the demo lists both land in the `high` severity band, so the buyer's
  band ranking does no discriminating work between them on this run; the 15 ms latency finding, which
  lands in `medium`, comes from the `grid-systems` sweep that the demo does not run.
- `web/src/server/__tests__/failure.test.ts` now reads committed, pipeline-generated run documents
  under `evidence/` instead of whatever the last local demo happened to write into the gitignored
  `web/data/`. Same assertions, same recorded numbers, but `npm test` no longer depends on a demo
  having been run on this machine first.

# Third-target pass — the arm, and published demonstration orders

This pass added the manipulator pick-and-place policy as **target 3** under the same binding rules,
opened a narrow, explicit hole in hosted mode so a cold reader can follow the whole flow, and brought
the documentation up to what the code now does — including the two things this project explored and
decided *not* to ship. No file under `sim/`, `vla/` or `contracts/` was touched.

## What the third target cost

One registry entry, one envelope mirror, one replay renderer, one target view — and no special case
anywhere else. The agents, the routes, the ledger, the escrow, the buyer policy, the range bars, the
five-stage finding page and the market aggregates all picked the arm up from the registry.

| | cart | humanoid | arm |
|---|---|---|---|
| envelope | `tb-envelope-1` (5 axes) | `tb-humanoid-envelope-1` (7 + 1 discrete) | `tb-arm-envelope-1` (7 + 1 discrete) |
| simulator | `tailbazaar_sim.cli` | `tailbazaar_sim.humanoid.cli` | `tailbazaar_sim.arm.cli` |
| subject bound by | SHA-256 of `controller.py` | actor-tensor sha256 of the SAC checkpoint | actor-tensor sha256 of the SAC+HER checkpoint |
| failure classes | `COLLISION`, `LOAD_SHED` | `FELL` | `DROPPED`, `NOT_PLACED` |
| who owns the predicate | the simulator's contact flag / slip criterion | Gymnasium's health predicate | Gymnasium-Robotics' success flag for `NOT_PLACED`; **this project** for `DROPPED` |
| severity proxy | `impact_speed_mps` | `torso_impact_speed_mps`, banded at `sqrt(2·g·1.0 m) = 4.43 m/s` | `object_impact_speed_mps`, banded at `sqrt(2·g·0.4 m) = 2.80 m/s`; `NOT_PLACED` has **none** |
| plausibility ceiling | **67.0 m/s** | **78.871 m/s** | **72.837 m/s** |
| honest replay peaks at | 2.0 m/s | 8.1–10.0 m/s | **2.954 m/s** |
| renderer | `cart-3d` | `humanoid-3d` | `arm-3d` |

Three things were not free, and all three are in the code with the reasoning attached.

**`DROPPED` is the first failure predicate in this marketplace that is ours.** Every other class is
the simulator's or the environment's own flag, and the honest move was to say so in the same field
the other classes use to name their detector — on the marketplace card, in the sealed summary, and in
the README — rather than to let it pass as the environment's verdict. The environment scores
*placement*; custody is not a thing it measures.

**A plausibility ceiling that would have been theatre.** The Fetch scene carries one body MuJoCo
**poses rather than integrates** — the mocap weld target the environment drags the gripper to — and it
is teleported into place on the first recorded tick at an apparent **39.011 m/s**. Against a
72.837 m/s ceiling that is a factor of 1.87, which is not an impossibility line, it is a tolerance
wearing one. `web/src/server/plausibility.ts` now takes a list of bodies the engine poses; it reads
the world bound for them but not a speed, and the list is computed from the **verifier's own re-run
document** (a body every one of whose published primitives collides with nothing), never from the
delivered package, so a seller cannot add to it. The honest peak is then **2.954 m/s against
72.837 m/s**, a factor of 24.7 — the same order of margin the other two targets have.

**The arm simulator names its event field `event`, not `type`.** `failure.ts` now reads whichever the
document uses and normalises it, rather than either assuming one or special-casing a target. A test
asserts on the committed run document that the fixture really does use the other name.

The renderer draws **solid** bodies, which was the point of the brief: the evidence PNGs in
`evidence/arm` are wireframes, and a wireframe cannot answer whether the part is in the hand. It
skips the mocap gizmo by the `role` the run publishes (three 2 m bars that would put a coordinate
cross through every frame), draws mesh links at MuJoCo's own bounding half-extents which the run
itself labels a proxy, and draws the goal — a *site*, not a body, so it is not in `frames` — as an
open cage at the environment's own 5 cm threshold rather than a solid, because a filled box at the
goal reads as an obstacle. The goal position is the one field the generic private package had to
learn (`goal_m`, null for targets that publish none). The ghost is the bench, the part and the
gripper rather than a second translucent arm, because a full ghost robot is a grey blob across half
the frame.

## Published demonstration orders

`DEMO_PUBLIC_ORDERS` is a comma-separated list of order ids whose evidence a hosted instance serves
without a token; `DEMO_PUBLIC_TAMPER_FIXTURES=1` auto-publishes each deliberately tampered order plus
the paired valid order of the same robot. The reason is that a hosted instance is meant to be read,
and a grader who opens the link cold and hits a 401 sees the gate working and not the product.

The shape of the exception is what makes it defensible, and each property has a test:

- **per order id** — a listed order returns 200 with `x-access-via: public-demo-fixture` and an
  `x-tb-demo-fixture` header carrying the badge; every other order still returns 401 with nothing of
  the package in the body;
- **the badge is on the page, not just the header** — "DEMONSTRATION FIXTURE, published in the
  repository, not a secret", because these packages are committed to this repository as evidence and
  the reader should not think they earned access;
- **the baseline route opens only for the robots that have a published fixture**, since that is the
  surviving run their replay draws behind the failure;
- **the sealed summary is untouched** — a test compares its keys with fixtures published and
  unpublished and requires them identical, because those bytes are what the terms hash on chain
  commits to;
- **nothing else widens** — the pipeline log stays operator-only and `POST /api/demo/run` still
  requires the operator token;
- **with the variables unset, hosted mode is what it was.**

## Commands run in this pass and actual results

| Command | Result |
|---|---|
| `cd web && npm test` | **83 passed, 0 failed** (was 59: + 9 arm envelope mirror, registry, claim, severity bands, plausibility and the honest negatives read back off the committed hunt documents, + 6 arm verifier binding, + 7 published-demonstration-order rules, + 2 arm failure-class narration) |
| `cd web && CHAIN_MODE=local npm run test:integration` | **12 passed, 0 failed** (was 11: + a published fixture order opening anonymously while its neighbours do not, on real pipeline data; the three-target and leak assertions were extended in place) |
| `cd contracts && forge test` | **22 passed, 0 failed** (no contract source was touched) |
| `cd web && npm run demo -- --reset --evidence ../evidence/local` | run `run-mtwsb96y`, **149.4 s wall, 6 listings across 3 targets, 6 orders.** Cart grid: 144 sims, 336 070 steps, 7.291 s, 102 SUCCESS / 42 COLLISION (3 also LOAD_SHED) / 0 inconclusive, 42 distinct. Humanoid push grid: 88 sims, 240 465 steps, 10.029 s, 35 survived / 53 FELL / 0 inconclusive, 30 distinct, 23 near-duplicates. Arm grip-friction grid: 72 sims, 72 000 steps, 2.216 s, 64 SUCCESS / 4 DROPPED / 4 NOT_PLACED / 0 inconclusive, 4 distinct, 0 near-duplicates. Findings: cart 0.380667 m/s (low) and 0.597248 m/s (medium); humanoid 4.801319 m/s and 4.549013 m/s (both high); arm 3.150862 m/s onto `floor0` (high, trajectory `0xc34cf117…`, the hash the committed evidence carries) and 0.940892 m/s (low). Five settled VALID → seller paid; the tampered cart delivery → COMMITMENT MISMATCH → recheck → INVALID → buyer refunded |
| `npm run ledger` | 6 findings `{"VALID": 6}`, `findings_by_target {"cart": 2, "humanoid": 2, "arm": 2}`, 304 simulations / 648 535 physics steps, and three `nominal_suites` entries — the arm's reports `all_passed: true`, the humanoid's `all_passed: false` with `gate_passed: true` and `cases_that_failed: ["one-tick-latency"]` |
| hosted-mode matrix on real order ids (published: the arm's high-band order; non-public: a humanoid order) | anonymous — reveal of the non-public order **401** with 0 leak markers in the body, `baseline?target=cart` **401**, `?target=humanoid` **401**, `?target=arm` **200** (the only robot with a published fixture), reveal of the published order **200** with `x-access-via: public-demo-fixture` and `x-tb-demo-fixture: DEMONSTRATION FIXTURE, published in the repository, not a secret`, and its 65 524 bytes keccak to the on-chain commitment. Operator token — non-public reveal **200** (`x-access-via: operator`), humanoid baseline **200**. Wrong token **401**. Demo log `log_redacted: true`, 0 lines; `POST /api/demo/run` **401** |
| leak test, anonymous public projections | **PASS** — 7 routes (`/api/listings`, `/api/orders`, `/api/market`, `/api/status`, `/api/demo/status`, one order, one listing) against **24 markers** including every arm axis (`object_mass_kg`, `grip_friction`, `object_offset_x_m`, `object_offset_y_m`, `action_noise_frac`, `gripper_latency_ms`) and `goal_m`: **zero leaks** |
| UI captures | refreshed against this run: `marketplace.png` (three robot cards), `order-arm-dropped.png`, `replay-arm-drop.png`, `replay-arm-split.png`, `order-cart-collision.png`, `order-humanoid-fell.png`, `order-invalid-refund.png`, `how-it-works.png`, `hosted-reveal-locked.png`, and `hosted-demo-fixture.png` — the anonymous hosted view of a published fixture, badge visible |

`window.tbReplay` on the arm finding reports the part inside the frame in both modes, and the HUD
reads `1.16 s · not held · on the floor · 0.68 m from the goal · 0.04 m/s` at the captured instant.

**Base Sepolia was not re-run and did not need to be.** This pass is entirely off-chain and
`contracts/` is unchanged; the deployment at `0xfadf11662C46c0214B0A40938a26FB8f0CD785A3` and its 14
recorded receipts stand as recorded.

## Factual limitations added or sharpened in this pass

- **The arm's `DROPPED` predicate is this project's own.** It is mechanical and it reads MuJoCo's own
  contact list, but the airborne margin (0.03 m) and the three-tick confirmation window are choices
  this project made. Both are documented where the class is named, so a reader can disagree with them
  on the evidence rather than on trust. The confirmation window is why `grid-grip` reports 4 drops and
  not 7.
- **The arm's policy checkpoint declares no licence**, and neither does any FetchPickAndPlace
  checkpoint found on the hub — six were checked one by one. Weights are fetched at run time, never
  vendored, never redistributed. The scene is MIT.
- **The honest negatives are load-bearing and are stated as measurements, not as caveats.** Payload
  mass alone placed the part 48/48 up to ten times the published mass; placement alone 25/25; the
  whole latency × noise grid produced zero drops. Failure is not monotone in friction and is
  concentrated in the geometry. A single friction threshold would have been a more sellable answer and
  a false one.
- **A fourth target was explored and deliberately not listed.** openpi `pi0` on ALOHA-sim ran, reached
  4/6 nominal, and produced findings — and the same seed run twice diverged at control tick 129
  (SUCCESS, then DROPPED) because `gym-aloha` is registered nondeterministic and `pi0` runs in bf16 on
  a GPU. Under this marketplace's rules every VLA finding would be INCONCLUSIVE, and INCONCLUSIVE
  never pays. The README states what a reproduction-rate market would need instead rather than
  quietly weakening the binding rule for one target.
- **Cross-platform reproduction was measured, not assumed.** The same scenario with the same pinned
  dependency set gives identical **outcomes** and **different trajectory hashes** on macOS arm64 and
  Linux x86_64 on all three robots (cart `0x3445cbf379…` vs `0x2eb8cdbff1…`, humanoid `0xb724…` vs
  `0x3c2a…`, arm `0x8e44…` vs `0xcfa2…`). That is exactly why exact-hash binding is paired with an
  environment fingerprint and why a mismatch is INCONCLUSIVE; the hosted pipeline therefore runs
  hunter and verifier on the same host.
- **The published-fixture exception is real access, deliberately granted.** Anyone who can reach a
  host that sets `DEMO_PUBLIC_ORDERS` can read those orders' scenarios, trajectories, salts and replay
  frames. It is safe only because those exact packages are already committed to this repository as
  evidence; on a host with private findings the variable must stay unset.
- **`.env.example` was not updated** with `DEMO_PUBLIC_ORDERS` and `DEMO_PUBLIC_TAMPER_FIXTURES`: this
  pass owned `web/**` and the three top-level documents only. Both are documented in the README's
  hosted-mode section, and both default to unset.
- **Two arm findings, two different bands** (high and low), so the buyer's severity ranking does
  discriminating work on this target — which it did not on the humanoid, where both demo findings land
  in `high`.

## Running state left on this machine

anvil (pid in `.local/anvil.pid`) and the web server (pid in `.local/server.pid`,
http://127.0.0.1:3100) are left running for review; `scripts/server-stop.sh`, `scripts/anvil-stop.sh`.
After the third-target pass the server runs in **local** chain mode against the regenerated demo
database (6 listings across three robots, 6 orders, one refunded),
in local demonstration mode (no `PUBLIC_BASE_URL`), so the reveal view works without a token. To see
the hosted behaviour: `scripts/server-stop.sh`, then
`PUBLIC_BASE_URL=https://example.test node web/dist/server/index.js` — the same order page then shows
"authentication required" and the reveal route answers 401. Add
`DEMO_PUBLIC_ORDERS=<an order id>` to that command to see the published-fixture path instead: that
one order opens anonymously with the DEMONSTRATION FIXTURE badge and every other one still 401s. To
browse the Base Sepolia orders again: `CHAIN_MODE=testnet scripts/server-start.sh`.

---

# Review round 3 — server-side findings from an independent review

Three server-side defects and one demo-latency issue, reported by an independent reviewer and fixed
under `web/src/server/**` only. `contracts/`, `sim/` and `web/src/client/` are untouched; no existing
test was edited. Each fix has its own test file, listed in `npm test`.

1. **The verifier did not bind the package's run record to its own re-run** (high). Once the delivered
   replay frames hashed to the verifier's re-run, the only remaining content checks were the package
   claim against the SELLER's submission claim (both seller-supplied) and the severity band. The
   package's `scene`, `metrics`, `events`, `ticks`, `claim`, `scenario`, initial state, termination
   rules and environment were never compared with the verifier's own run document, and those fields
   drive the replay HUD, the narrative and the metrics table. Reproduction: a cart package with
   `metrics.impact_speed_mps = 999`, the obstacle moved from 6 m to 100 m in `scene`, or the failure
   class relabelled `FELL` was VERIFIED over authentic poses.
   **What changed** (`agents/verifier.ts`, evidence binding (d)): after the trajectory binding, every
   run-derived section of the package is compared byte-for-byte, after canonicalization, with the
   verifier's own run document, and the claim with `target.claimFromRun(verifier run)`; the first
   mismatch is REJECTED / INVALID by `package-run-record-matches-verifier-rerun`, whose detail names
   the section and the first differing path. The exempt fields are the ones the re-run cannot reproduce
   by construction, listed in `RUN_RECORD_EXEMPT`: `salt_hex`, `seller`, `created_at`, `hunter`,
   `reproduce`, `target_id` (checked separately), `replay.frames` (bound by hash) and
   `scene.mjcf_path` (an absolute venv path; the model itself is bound by `scene.mjcf_hash` and
   `scene.compiled_model_hash`). A package field that is neither compared nor exempt is refused too.
   **Test:** `__tests__/verifier-run-record-binding.test.ts`, 7 cases against the real simulator: the
   three reproductions above (each INVALID with the new check failing and the older checks passing),
   seven further sections plus a foreign top-level field, the exemption list, and the unmodified
   package still VALID.
2. **Reverted transactions were recorded as successes** (high). `chain.ts` `write()` returned
   `{ status: receipt.status }` and never threw on `"reverted"`, so `buyerFund`, `sellerDeliver` and
   the verifier's settle path wrote rows as if the action had happened (a reverted `fund` produced a
   FUNDED order).
   **What changed:** `write()` throws `TxRevertedError` (hash, function name, block on the error and in
   its message) whenever the receipt status is not `"success"`, so no caller updates state. The hash is
   written to a new `pending_txs` table (`db.ts`: hash, function_name, args_json, from_address,
   chain_mode, created_at, updated_at, status pending|confirmed|reverted|timeout, block_number, error)
   BEFORE the receipt wait and resolved when the receipt arrives or the wait throws. `listPendingTxs()`
   and `reconcilePendingTxs()` (re-checks unresolved hashes with `getTransactionReceipt`; reads only)
   are exported, and `GET /api/txs/pending` (`?reconcile=1`; operator-gated in hosted mode) exposes
   them. The viem client pair is injectable through `setChainClientsForTests()`, so the suite stubs
   chain.ts's own seam instead of monkey-patching viem.
   **Test:** `__tests__/chain-reverted.test.ts`, 6 cases: a reverted receipt throws with hash/function/
   block; a success still returns and confirms the row; `buyerFund` against a reverted `fund` leaves no
   orders row, no FUNDED listing and no funded event; the row exists as `pending` while the wait is in
   progress, becomes `timeout` when the wait throws, and reconcile resolves it from the chain; the route
   is operator-gated.
3. **The buyer trusted the database's copy of the advertised terms** (medium). `selectListing()` read
   robot, severity and verification from `listings.public_summary` without recomputing the terms hash
   against `onChain.termsHash`, and never compared the row's seller, price or commitment with the
   chain; an edited summary (band raised low → high) ranked first and was funded.
   **What changed** (`agents/buyer.ts`): `checkTermsBinding()` recomputes the summary's terms hash with
   the registration function itself (`termsHashOf`, now a named export of `agents/verifier.ts` and
   used there for `registerListing`) and compares it, the seller, the price and the commitment with the
   chain. `selectListing()` marks a disagreeing row ineligible with a plain reason (`stored terms are
   not the on-chain terms: terms hash mismatch ...`), and `buyerFund()` re-reads the listing and
   re-checks all four immediately before `fund()`, throwing instead of broadcasting.
   **Test:** `__tests__/buyer-terms-binding.test.ts`, 4 cases: the altered summary is skipped with the
   terms-hash reason and the unaltered one is chosen (the altered one would have out-ranked it);
   each of the four mismatches is named; `buyerFund` refuses an altered or repriced row before any
   broadcast and still funds the honest one.
4. **Demo latency** (low). `GET /api/listings` awaited `getListing` then `settledOrders` for every row
   in sequence, so one slow RPC provider stalled the whole marketplace page.
   **What changed** (`index.ts`): the chain reads are concurrent across rows (`Promise.allSettled`),
   each with a 4 s timeout (`withTimeout` in `chain.ts`), and the on-chain part of a row is cached in
   memory for 10 s keyed by listing id (only complete reads are cached; a failed read is retried on
   the next request). On timeout or error the stored row is served with `on_chain: null`, exactly as
   before; the response shape is unchanged. `/api/status`'s block number gets the same timeout and
   cache. Covered by the existing suites.

**Results in this pass:** `cd web && npm run build` clean; `npm test` **100 passed, 0 failed** (83
before this pass + 17 new); `npm run test:integration` **12 passed, 0 failed** against the local anvil
and the demo database. Not done: no change to `contracts/`, `sim/` or the client; the pending-tx
ledger is wired to nothing but the operator route (no automatic reconcile loop); the delivery-time
check (`verifierCheckDeliveryAndSettle`) was not extended, because the bytes it examines must hash to
the commitment that was run-record-checked at listing time.
