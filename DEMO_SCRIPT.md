# Tail Bazaar — three-minute demo script

Recorded against the **local server** (`http://127.0.0.1:3100`), with the Base Sepolia order pages
open in a second tab so the explorer links on screen are real transactions. One target per beat;
every failure is visibly on screen, never only described.

## Before recording

```bash
export PATH="$HOME/.foundry/bin:$PATH"
scripts/anvil-start.sh && scripts/local-deploy.sh
(cd sim && uv run python -m tailbazaar_sim.humanoid.cli policy)     # warms sim/.cache; no network later
(cd web && npm run build && npm run demo -- --reset --evidence ../evidence/local)
scripts/server-start.sh                                             # http://127.0.0.1:3100
```

That leaves four listings across both robots and four settled orders. Open these five tabs:

| # | Tab | URL |
|---|---|---|
| 1 | Marketplace | `http://127.0.0.1:3100/#/` |
| 2 | Cart finding, valid | `#/orders/<cart order that SETTLED_VALID>` |
| 3 | Cart finding, refunded | `#/orders/<cart order that SETTLED_INVALID>` |
| 4 | Humanoid finding | `#/orders/<humanoid order>` |
| 5 | Base Sepolia | `https://sepolia.basescan.org/address/0xfadf11662C46c0214B0A40938a26FB8f0CD785A3` |

`curl -s localhost:3100/api/listings | jq -r '.[] | "\(.target_id) \(.status) \(.listing_id)"'`
prints the ids. Browser at 1440 px wide, zoom 100 %. Nothing needs to be clicked twice: each finding
page autoplays through its own failure when it loads.

---

## 0:00 — the sentence (tab 1, top of the marketplace)

> "Someone finds the conditions where a robot controller fails. You buy the recipe sealed, and an
> independent verifier re-runs it before any money moves."

Scroll to **"Two robots. Two different meanings of 'it failed'."** Read the two cards, slowly enough
that both land:

> "A warehouse cart that is supposed to stop short of an obstacle — failure is the simulator's own
> contact flag. And a pretrained humanoid balance policy that is supposed to keep walking — failure
> is Gymnasium's own health predicate, the torso leaving the height band the environment calls
> healthy. This project implements no failure detector of its own for either one."

Point at the hero counter: **232 simulations run by hunters, 2 sweeps.**

## 0:20 — target 1, the cart (tab 2)

Open the valid cart finding. It opens 0.6 s before impact and plays through once.

> "The nominal run stops short of the obstacle — that's the grey ghost, one lane over. The purchased
> run does not. Same controller, different conditions."

Let the contact ring and the `COLLISION · 0.381 m/s` callout land. Say the search number out loud
from the **"What this finding cost to find"** panel:

> "The hunter ran 144 simulations over the published range; 42 of them collided. This is the mildest
> one — the least you have to change before it stops working."

Scroll to **"What was different"**: sensor delay 200 ms, floor friction 0.3.

## 0:50 — the sealed claim (tab 2, scroll up to stage 1)

> "Here is everything the buyer was allowed to see *before* paying: which robot, which failure class
> and who decides it, the controller's version hash, the verifier's verdict, a coarse severity band,
> and how many orders this seller has settled. What it does not contain: the conditions, the
> trajectory, the replay frames, or the hunt that found them."

Open **"Show the sealed summary and its hashes"** for one second — the commitment and terms hash.

## 1:05 — the purchase (tab 2, stage 2)

> "The buyer's agent funded the escrow with the exact price, before seeing any of it. Two deadlines
> were fixed at that moment. If either the seller or the verifier goes quiet, anyone can call
> `claimTimeout` and the buyer is refunded in full."

Switch to **tab 5** for two seconds: the contract on Base Sepolia, real transactions.

## 1:20 — reveal and replay (tab 2, stage 3)

Press **"Replay the first contact"**.

> "This is played back from the transforms recorded when it was simulated. Nothing is re-simulated in
> your browser."

Scroll to the **range bars**: the marker sits outside the tuned range on two axes and inside the
searched envelope on every axis.

> "So this is not 'the controller is broken'. It is a measured boundary of how far the operating
> range can be widened before it stops working."

## 1:50 — settlement (tab 2, stages 4 and 5)

Open **"Show the verifier's checks"**.

> "The verifier re-ran the scenario itself, recomputed the trajectory hash from the bytes it was
> handed, checked that those frames are a physically possible trajectory of this scene, and compared
> all of it with its own run. Then it settled valid and the seller withdrew."

## 2:05 — the refund path (tab 3)

> "The second cart listing was delivered tampered — the seller moved one axis back to nominal after
> the commitment was registered and still asserted the original hash."

Point at the red **COMMITMENT MISMATCH** line and the refund in the story:

> "The bytes did not hash to the commitment on chain. Settled invalid, the buyer withdrew a full
> refund, the seller was paid nothing. The buyer does not get the package either."

## 2:25 — target 2, the humanoid (tab 4)

Let it autoplay. The ghost keeps walking; the purchased run goes down.

> "Same marketplace, same escrow, same verifier — a different robot. A pretrained policy somebody
> else trained and published, pinned by the hash of its weights. At the published conditions it walks
> for the full fifteen seconds — that's the ghost. One eight-newton-second shove inside the published
> envelope, and the torso drops out of the healthy band at 2.8 seconds and hits the ground at
> 4.8 metres per second."

Point at the HUD: **torso 0.50 m, healthy ≥ 1.00 m.**

> "That verdict is the environment's own health predicate, not ours. And the verifier re-ran it with
> the humanoid's own simulator — same binding rules, its own physical-plausibility ceiling derived
> from its own envelope."

If time allows, one sentence on the search panel: 88 simulations, 53 falls.

## 2:50 — close (tab 1, the limits band)

> "Why a market at all? The team that tuned a controller for 40 milliseconds of sensor delay is the
> team that never tests 200. Tail search cost explodes past a handful of axes. And hunters build a
> prior buyers cannot.
>
> And the honest limits: these failures are adversarially selected, so they are not failure
> frequencies. The physics needs calibration against real robots. There is one verifier and it is
> trusted. Nothing here is audited. The humanoid's policy checkpoint declares no licence, and we do
> not assert one for it."

---

## Backup answers

- **"Is the chain real?"** Yes — Base Sepolia, contract `0xfadf1166…0CD785A3`, 14 confirmed receipts
  in `evidence/testnet/`. The demo runs on local anvil so it is repeatable on camera; the UI labels
  every local transaction "LOCAL ANVIL" and shows explorer links only for real testnet hashes.
- **"Could the seller fake the replay?"** Three things have to hold at once: the bytes hash to the
  commitment registered before payment, the trajectory hash recomputed from those frames equals the
  verifier's own re-run, and the frames are a physically possible trajectory of that scene. An
  external reviewer broke an earlier version by rewriting the frames, recomputing every hash, and
  forcing an environment mismatch; that attack is now a test on both targets.
- **"What if the environments differ?"** INCONCLUSIVE, and nothing is paid. Metrics that agree across
  two environments say something about the scenario and nothing about which frames were delivered.
- **"How hard is a third robot?"** One entry in `web/src/server/targets.ts` and one replay renderer.
  No agent, route, ledger row or page has a per-robot special case.
