# Tail Bazaar — three-minute demo script

Recorded against the **local server** (`http://127.0.0.1:3100`), with the Base Sepolia order pages
open in a second tab so the explorer links on screen are real transactions. One target per beat;
**every beat has a failure visibly on screen**, never only described.

## Before recording

```bash
export PATH="$HOME/.foundry/bin:$PATH"
scripts/anvil-start.sh && scripts/local-deploy.sh
(cd sim && uv run python -m tailbazaar_sim.humanoid.cli policy && \
           uv run python -m tailbazaar_sim.arm.cli policy)          # warms sim/.cache; no network later
(cd web && npm run build && npm run demo -- --reset --evidence ../evidence/local)
scripts/server-start.sh                                             # http://127.0.0.1:3100
```

That takes about four minutes and leaves **eight listings across four robots and eight settled
orders**, one of them deliberately refunded. Open these six tabs:

| # | Tab | URL |
|---|---|---|
| 1 | Marketplace | `http://127.0.0.1:3100/#/` |
| 2 | Cart finding, valid | `#/orders/<cart order that SETTLED_VALID>` |
| 3 | Cart finding, refunded | `#/orders/<cart order that SETTLED_INVALID>` |
| 4 | Humanoid finding | `#/orders/<humanoid order>` |
| 5 | Arm finding | `#/orders/<the arm order whose severity band is high>` |
| 5b | G1 finding | `#/orders/<the g1 order>` — on this machine `#/orders/0x4a426a67cd7ed3a088b871f1eec5a3e2933c5563ed20eb056291361620dc16bf` |
| 6 | Base Sepolia | `https://sepolia.basescan.org/address/0xfadf11662C46c0214B0A40938a26FB8f0CD785A3` |

`curl -s localhost:3100/api/listings | jq -r '.[] | "\(.target_id) \(.public_summary.severity.band) \(.status) \(.listing_id)"'`
prints the ids and bands; `curl -s localhost:3100/api/orders | jq -r '.[] | "\(.status) \(.order_id)"'`
maps them to orders. Browser at 1440 px wide, zoom 100 %. Nothing needs to be clicked twice: each
finding page autoplays through its own failure when it loads.

---

## 0:00 — the sentence (tab 1, top of the marketplace)

The hero reads **"Every robot has a breaking point."** next to the animated humanoid; let it wave once, then say:

> "Someone finds the conditions where a robot controller fails. You buy the recipe sealed, and an
> independent verifier re-runs it before any money moves."

Scroll to **"Three robots. Three different meanings of 'it failed'."** Read the three cards, slowly
enough that each lands:

> "A warehouse cart that is supposed to stop short of an obstacle — failure is the simulator's own
> contact flag. A pretrained humanoid balance policy that is supposed to keep walking — failure is
> Gymnasium's own health predicate, the torso leaving the height band the environment calls healthy.
> And a pretrained arm that is supposed to place a part on a goal — *not placed* is Gymnasium-Robotics'
> own success flag, and *dropped* is the one predicate we wrote ourselves, because the environment
> scores placement and not custody. The card says so, in the same place as the other two."

Point at the hero counter: **304 simulations run by hunters, 3 sweeps.**

## 0:20 — target 1, the cart (tab 2) — *the collision on screen*

Open the valid cart finding. It opens 0.6 s before impact and plays through once.

> "The nominal run stops short of the obstacle — that's the grey ghost, one lane over. The purchased
> run does not. Same controller, different conditions."

Let the contact ring and the `COLLISION · 0.381 m/s` callout land. Say the search number out loud
from the **"What this finding cost to find"** panel:

> "The hunter ran 144 simulations over the published range; 42 of them collided. This is the mildest
> one — the least you have to change before it stops working."

Scroll to **"What was different"**: sensor delay 200 ms, floor friction 0.3.

## 0:45 — the sealed claim (tab 2, scroll up to stage 1)

> "Here is everything the buyer was allowed to see *before* paying: which robot, which failure class
> and who decides it, the controller's version hash, the verifier's verdict, a coarse severity band,
> and how many orders this seller has settled. What it does not contain: the conditions, the
> trajectory, the replay frames, or the hunt that found them."

Open **"Show the sealed summary and its hashes"** for one second — the commitment and terms hash.

## 1:00 — the purchase and the settlement (tab 2, stages 2, 4 and 5)

> "The buyer's agent funded the escrow with the exact price, before seeing any of it. Two deadlines
> were fixed at that moment. If either the seller or the verifier goes quiet, anyone can call
> `claimTimeout` and the buyer is refunded in full."

Switch to **tab 6** for two seconds: the contract on Base Sepolia, real transactions. Back on tab 2,
open **"Show the verifier's checks"**:

> "The verifier re-ran the scenario itself, recomputed the trajectory hash from the bytes it was
> handed, checked that those frames are a physically possible trajectory of this scene, and compared
> all of it with its own run. Then it settled valid and the seller withdrew."

Scroll to the **range bars** on the way past:

> "The marker sits outside the tuned range on two axes and inside the searched envelope on every axis.
> So this is not 'the controller is broken'. It is a measured boundary of how far the operating range
> can be widened before it stops working."

## 1:30 — the refund path (tab 3) — *the commitment mismatch on screen*

> "The second cart listing was delivered tampered — the seller moved one axis back to nominal after
> the commitment was registered and still asserted the original hash."

Point at the red **COMMITMENT MISMATCH** line and the refund in the story:

> "The bytes did not hash to the commitment on chain. Settled invalid, the buyer withdrew a full
> refund, the seller was paid nothing. The buyer does not get the package either."

## 1:50 — target 2, the humanoid (tab 4) — *the fall on screen*

Let it autoplay. The ghost keeps walking; the purchased run goes down.

> "Same marketplace, same escrow, same verifier — a different robot. A pretrained policy somebody
> else trained and published, pinned by the hash of its weights. At the published conditions it walks
> for the full fifteen seconds — that's the ghost. One eight-newton-second shove inside the published
> envelope, and the torso drops out of the healthy band at 2.8 seconds and hits the ground at
> 4.8 metres per second."

Point at the HUD: **torso 0.50 m, healthy ≥ 1.00 m.**

> "That verdict is the environment's own health predicate, not ours. The verifier re-ran it with the
> humanoid's own simulator — same binding rules, its own plausibility ceiling derived from its own
> envelope. 88 simulations, 53 falls."

## 2:15 — target 3, the arm (tab 5) — *the dropped part on screen*

Let it autoplay, then press **"Side by side"**. Left: the part held at the goal. Right: the part on
the floor.

> "Third robot, same machinery. A published pick-and-place policy that places the block in about ten
> control steps, every episode. One axis moved — grip friction from the shipped 1.0 down to 0.25 —
> and it lifts the part, carries it to within five point three centimetres of the goal, and lets go
> fifteen centimetres above the table. The block clears the table edge and hits the *floor* at
> 3.15 metres per second."

Point at the HUD on the right panel: **not held · on the floor · 0.68 m from the goal**, and at the
two scrubber marks, *the release* and *impact*.

> "Two marks, because they are two different instants: the release is when both gripper pads lost
> contact while the part was airborne and away from the goal, and it is only confirmed as a drop if
> the grasp is not regained over the next three control ticks. Without that window an earlier sweep
> would have sold a part that was still firmly pinched as a dropped part. Seventy-two simulations
> here: four drops, four not-placed."

If time allows, the honest negative — it is the most persuasive thing on the page:

> "And what *doesn't* break it: making the part ten times heavier placed it forty-eight times out of
> forty-eight. Moving it five centimetres, twenty-five out of twenty-five. Latency and noise cost this
> policy the placement, not the part — not one drop in that whole grid. What loses the part is a
> combination nobody sweeps for by hand. That is in the README as a measured negative, not buried."

## 2:40 — target 4, the Unitree G1 (tab 5b) — *a real robot, a real policy, our own predicate*

Open the G1 finding. The replay opens before the shove and plays through the fall.

> "This is a Unitree G1 under Unitree's own pretrained walking policy, in Unitree's own MuJoCo model,
> drawn from its own meshes. Unitree's runner has no notion of a fall, so the predicate is ours and
> the card says so: the pelvis drops below 0.46 m or tilts past 60 degrees. It survives every shove up
> to 24 newton-seconds from any direction; 28 from the side is the mildest fall the hunter found, and
> 80 milliseconds of control latency puts it down with no noise at all. Compare the Gymnasium
> mannequin: one tick of latency, an 8 newton-second shove. Same market, two very different robots,
> and the market prices exactly that difference."

## 3:00 — buy one yourself (tab 1, marketplace) — *the market, live*

Click **List a new finding** under the warehouse cart. The live panel shows the hunter searching, the
verifier re-running the finding and the listing being registered on chain (about 30 s on anvil).

> "A seller's hunter just found a new failure. The verifier reproduced it in its own simulator and
> registered the sealed claim on chain. Nobody has paid anything yet."

When the new card appears, click **Buy for 0.001 ETH**. The page moves to the order and walks through
each step as its transaction lands: funding the escrow, the seller delivering the sealed package, the
buyer retrieving it with a signed challenge, the verifier checking the bytes against the seal, the
escrow settling and the seller withdrawing (about 15 s on anvil).

> "Every one of those was a real transaction. The money left the buyer's wallet before it saw anything,
> and reached the seller only after the verifier confirmed the bytes matched the seal."

## 3:50 — close (tab 1, the limits band)

> "Why a market at all? The team that tuned a controller for 40 milliseconds of sensor delay is the
> team that never tests 200. The team that would test payload mass is the team that finds 48 out of
> 48. Tail search cost explodes past a handful of axes, and hunters build a prior buyers cannot.
>
> And the honest limits: these failures are adversarially selected, so they are not failure
> frequencies. The physics needs calibration against real robots. There is one verifier and it is
> trusted. Nothing here is audited. Neither pretrained policy declares a licence, and we do not
> assert one for them. And there was a fourth target — a vision-language-action policy — that ran,
> produced findings, and is deliberately *not* listed, because it is nondeterministic and this
> verifier certifies only what it can bind by an exact hash. That is in the README with the numbers
> and with what a reproduction-rate market would need instead."

---

## Backup answers

- **"Is the chain real?"** Yes — Base Sepolia, contract `0xfadf1166…0CD785A3`, 14 confirmed receipts
  in `evidence/testnet/`. The demo runs on local anvil so it is repeatable on camera; the UI labels
  every local transaction "LOCAL ANVIL" and shows explorer links only for real testnet hashes.
- **"Could the seller fake the replay?"** Three things have to hold at once: the bytes hash to the
  commitment registered before payment, the trajectory hash recomputed from those frames equals the
  verifier's own re-run, and the frames are a physically possible trajectory of that scene. An
  external reviewer broke an earlier version by rewriting the frames, recomputing every hash, and
  forcing an environment mismatch; that attack is now a test on all three targets.
- **"What if the environments differ?"** INCONCLUSIVE, and nothing is paid. That is not hypothetical:
  the same scenario on macOS arm64 and on Linux x86_64 gives identical outcomes and *different*
  trajectory hashes on all three robots. Metrics that agree across two environments say something
  about the scenario and nothing about which frames were delivered, so the verifier abstains and the
  hosted pipeline runs hunter and verifier on the same host.
- **"Is the arm's drop detector a fudge?"** It is the one predicate in this project that is ours, and
  the marketplace card says so next to the two that are not. It is mechanical — MuJoCo's own contact
  list, both finger pads, a fixed 0.03 m airborne margin, and the environment's own success flag — and
  the three-tick confirmation window exists because the first sweep produced a "drop" of a part that
  was rising steadily at a constant 0.67 m/s and still pinched. Withdrawn proposals stay in the run
  document and on the scrubber.
- **"How hard was the third robot?"** One entry in `web/src/server/targets.ts`, one envelope mirror
  and one replay renderer. No agent, route, ledger row or page has a per-robot special case.
- **"Can I just read this on the hosted URL?"** Yes for the orders the host publishes: a short
  `DEMO_PUBLIC_ORDERS` list is served without a token, badged **"DEMONSTRATION FIXTURE, published in
  the repository, not a secret"**. Every other order still returns 401.
