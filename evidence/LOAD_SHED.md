# LOAD_SHED — a second failure class for `stop-before-obstacle-v1`

Everything below was produced by `sim/` on 2026-09-11 with MuJoCo 3.13.0, numpy 2.5.3, Python 3.12.13,
`uv.lock` sha256 `2211952077d8411f…`, single thread, physics 500 Hz / control 50 Hz. Evidence lives in
`evidence/load-shed/`. **`sim/tailbazaar_sim/controller.py` was not edited**: its SHA-256 is still
`sha256:7620971c1ea6d527fbe9b91c026a921b7f23abee8cb274ea136022c60d169760` and the controller id is
still `stop-before-obstacle-v1`, so every existing listing that references it stays valid.

## 1. What changed in the scene

The load used to be a geom welded to the chassis. It is now a **separate rigid body with its own free
joint**, seated on the deck at exactly zero contact distance and held there only by Coulomb friction
in an explicit MuJoCo `<pair>` between `chassis_geom` and `load_geom`. The pair is declared explicitly
so its sliding coefficient is exactly the scenario value and not the pairwise maximum MuJoCo would
otherwise take from the two geoms (both of which carry the floor coefficient by default).

`scene.py` records this as `SCENE_REVISION = 2`; run documents carry `scene.scene_revision` and
`scene.load_attachment`. Adding a free body adds 7 qpos / 6 qvel, so **scene revision 2 cannot
reproduce the trajectory hashes of scene revision 1** — see §7.

New scene hash: `sha256:19e841d1da662c0d052992e45152845b617a00eb0503ace042fc708031b2574e`
(was `sha256:497a4ce69e302b49fe0bc28d27dafa6365e4c0f2e71c9beb193176a13de44b88`).

## 2. The new envelope axis

| field | value |
|---|---|
| name | `load_friction` |
| meaning | sliding friction coefficient of the chassis-deck/load contact pair |
| unit | dimensionless Coulomb mu (SI: N/N) |
| bounds | 0.10 – 1.00 |
| nominal | 0.60 |
| quantization | 3 decimal places |
| GUARD group | `physical` |
| tuned range | **not stated** — see below |

0.10 is a smooth wet deck against a plastic tote; 1.00 a rubber-faced deck. Both are illustrative
assumptions, like every other bound in this envelope; neither is measured on a physical robot.

`controller.py` documents nothing about how the load is secured, so **no tuned range can be
transcribed for this axis**. `in_tuned_range()` reports it as `None` (unknown) rather than inventing a
bound, and `CONTROLLER_TUNED_RANGE` is left with exactly its original four entries. What *can* be
derived from the controller without editing it is the grip its own braking set points demand of a load
held only by friction — `mu = a / g`, `g = 9.81 m/s²`:

| controller constant | deceleration | deck grip demanded |
|---|---|---|
| `A_TRIGGER` (the planned stop it aims for) | 3.0 m/s² | **0.306** |
| `A_FULL` (what it assumes a full brake delivers) | 6.0 m/s² | **0.612** |

So the nominal deck grip 0.6 carries roughly a 2× margin on a planned stop and sits right at the edge
of a saturated one. These are arithmetic on published constants, not thresholds anyone chose, and
§5 shows the measured boundary landing on the first of them.

`envelope_id` is deliberately **not** bumped: the four original axes, their ranges, the admissibility
rules and the duplicate metric are unchanged, the verifier keys on that id, and an old four-axis
scenario is still admissible (`load_friction` is optional and is read at its nominal value). The
addition is recorded as `envelope_revision: tb-envelope-1.1`, published in `sim/envelope.yaml` and in
every run document.

## 3. How LOAD_SHED is detected

Never assigned; read out of MuJoCo contacts and body state **every physics step (2 ms)**, in the
chassis frame, with slip measured from the load's seated position. Three alternative criteria; the
first to fire is the one recorded.

| criterion | threshold | where the number comes from |
|---|---|---|
| `slip` | planar displacement from the seat > **0.15 m** | pure geometry: `CHASSIS_HALF[0] − LOAD_HALF[0] = 0.40 − 0.25`, the deck margin ahead of (and behind) the seated load. At exactly that displacement the load's leading face has reached the deck's leading face; beyond it the load overhangs the deck. |
| `separation` | no `chassis_geom`/`load_geom` contact for **0.10 s** after at least one has been seen | five control ticks — longer than a bounce during a hard stop, shorter than a sixth of a stop |
| `footprint` | load centre of mass leaves the **0.40 × 0.25 m** deck rectangle | chassis half extents |

Honest notes on the criteria:

- The lateral deck margin is only 0.05 m, and the `slip` threshold applies the along-travel margin
  (0.15 m) to the planar magnitude. Motion in this scene is along x — there is no steering — so this
  asymmetry never bites, but it is a simplification, not a derivation.
- `footprint` is **strictly looser** than `slip` at this geometry (0.40 > 0.15), so for any in-plane
  departure `slip` fires first. It is a backstop, not an independent trigger. Every finding below
  fired on `slip`.
- The load cannot topple in this scene and it was not made to. A box 0.50 m long with its centre of
  mass 0.15 m above the deck tips only above `g·0.25/0.15 = 16.4 m/s²`, and the highest deceleration
  the brake can deliver on the best floor is about 6 m/s². Sliding is the only reachable mode here.
  The renders show the load rotating only *after* it has slid off the deck edge and fallen.

Recorded at the event: time, criterion, slip vector, direction (forward / rearward / lateral),
controller phase, the load's speed **relative to the chassis** (the severity proxy), its world speed,
and `0.5 · payload_kg · rel_speed²` in joules. Run maxima `load_slip_max_m` and
`load_rel_speed_max_mps` are also recorded, because the proxy is sampled at the moment the criterion
first fires and that is not always the worst moment of the run (see the compound finding in §6).
**No monetary damage is estimated anywhere.**

## 4. Nominal suite — ACTUAL results, 8/8 PASS

Every case must end `SUCCESS`, must not touch the obstacle, must **not** shed its load, and must stop
within ±0.15 m of the 0.40 m target clearance. The six original cases now also assert no-shed at the
nominal deck grip; two cases were added at deck grip **0.5** — 1.63× the 0.306 a planned stop demands,
and below the 0.6 nominal, i.e. a slightly worn deck during an ordinary stop.

| case | outcome | clearance (m) | clearance before (m) | Δ (m) | shed | max slip (m) |
|---|---|---|---|---|---|---|
| nominal | SUCCESS | 0.377693 | 0.377907 | −0.000214 | no | 0.001041 |
| no-latency-dry-floor | SUCCESS | 0.392182 | 0.392329 | −0.000147 | no | 0.001040 |
| design-limit-latency | SUCCESS | 0.358177 | 0.358405 | −0.000228 | no | 0.001042 |
| design-limit-friction | SUCCESS | 0.377692 | 0.377908 | −0.000216 | no | 0.001041 |
| light-payload | SUCCESS | 0.394335 | 0.394359 | −0.000024 | no | 0.000767 |
| heavy-payload | SUCCESS | 0.317578 | 0.317703 | −0.000125 | no | 0.001415 |
| **worn-deck** (mu_load 0.5) | SUCCESS | 0.377687 | — | new | no | 0.000958 |
| **heavy-payload-worn-deck** (40 kg, mu_load 0.5) | SUCCESS | 0.317641 | — | new | no | 0.001304 |

`all_passed: true`. No threshold was adjusted at any point to reach this: the suite was run once with
the thresholds as documented above and it passed. The "before" column is the scene-revision-1 run of
the same six cases, captured before any edit. **The shift is at most 0.23 mm** and is one-signed
(every case stops a hair shorter), which is what a compliant contact under the load does compared with
a rigid weld. The ≤ 1.4 mm "max slip" in every passing case is contact compliance, not sliding.

Evidence: `evidence/load-shed/nominal-suite.json` (suite id `nominal-v2`).

## 5. Bounded hunt over the extended envelope — ACTUAL results

New mode `grid-load`: a fixed grid over the two physical axes that govern whether a carried load stays
on the deck — `load_friction` 0.10…1.00 in steps of 0.05 (19 values) × `floor_friction` 0.2…1.0 in
steps of 0.1 (9 values), both delays and the payload held at nominal.

**Search cost: 171 simulations, 393 840 physics steps, 17.4 s wall (single thread).**

| | count |
|---|---|
| SUCCESS | 138 |
| LOAD_SHED (any) | 33 |
| LOAD_SHED only (chassis stopped correctly) | 23 |
| COLLISION and LOAD_SHED | 10 |
| COLLISION | 10 |
| inconclusive (TIMEOUT / DIVERGED) | 0 |
| distinct after the class-aware duplicate rule | 33 (23 `LOAD_SHED` + 10 `COLLISION+LOAD_SHED`) |
| near-duplicates | 0 |

The measured shed boundary, per floor friction (grid resolution 0.05):

| floor friction | sheds at deck grip ≤ | holds from |
|---|---|---|
| 0.2 | 0.15 | 0.20 |
| 0.3 | 0.20 | 0.25 |
| 0.4 – 1.0 | **0.25** | **0.30** |

On any floor the wheels can actually grip, the boundary sits between 0.25 and 0.30 — i.e. **on the
0.306 that the controller's own `A_TRIGGER` demands**, computed independently in §2 from constants in
`controller.py`. On the two slipperiest floors the tyres slip before the deck does, the cart
decelerates less, and the load survives to a lower grip. Nothing was tuned to make those two numbers
agree.

The legacy `grid` mode (sensor delay × floor friction, deck grip at nominal 0.6) was re-run for
comparison: 144 simulations, 336 070 steps, 15.1 s — 102 SUCCESS, **42 COLLISION** (was 43 under scene
revision 1), 3 of those also LOAD_SHED, 0 inconclusive. The single scenario that flipped is
`sensor_delay_ms 180, floor_friction 0.3`, which previously stopped **0.347 mm** into the obstacle and
now stops **0.216 mm** short of it. It is the marginal point of that sweep and the sub-millimetre
shift of §4 moved it across. The demo's sold failure (`sensor_delay_ms 200, floor_friction 0.3`) is
still a collision. The 3 legacy-grid sheds are all **post-impact** — they occur at t = 4.306 / 4.264 /
4.248 s against first contacts at 4.134 / 4.126 / 4.120 s, in controller phase `PARKED`, at crash
decelerations of 36 / 61 / 73 m/s². A deck grip of 0.6 holds nothing at 36 m/s², which is the same
arithmetic as §2 read in the other direction.

## 6. The selected finding

The hunter's deterministic rule (mildest conditions first inside a class group, ties by severity
proxy) selected, out of the 23 distinct `LOAD_SHED`-only findings:

```
{"sensor_delay_ms":20,"actuator_delay_ms":20,"floor_friction":0.8,"payload_kg":20.0,"load_friction":0.25}
```

Everything is at nominal **except the deck grip**. Distance to nominal 0.3889 (on that one axis).

| | |
|---|---|
| `outcome` | `LOAD_SHED` |
| `chassis_outcome` | `SUCCESS` — the cart did its job: it stopped at 0.369 m clearance, 31 mm short of the 0.40 m target |
| `failure_classes` | `["LOAD_SHED"]` |
| brake onset | t = 3.28 s at 1.808 m/s |
| **shed event** | **t = 3.826 s**, criterion `slip`, direction `forward`, controller phase `BRAKE` |
| slip at the event | 0.150085 m (x only; y = 0) |
| **severity proxy: load speed relative to the chassis** | **0.359019 m/s** (world speed 0.476592 m/s, chassis 0.117595 m/s) |
| relative kinetic energy | 1.289 J (`0.5 · 20 kg · 0.359²`) |
| max slip over the run | 0.180085 m — the load ends **30 mm over the deck's leading edge**, still resting on it |
| deck contact lost | 0.088 s total |
| peak deceleration | 3.900 m/s² → grip demanded 0.398, grip available 0.25, **margin −0.148** |
| trajectory hash | `0x135f78fc6378e285265638795aea14c4b5cd016b9a1f2deaaed41be4810d55a7` |
| mjcf hash | `sha256:75c943777905e33ca1100b659047330a1a388ae14586ad07a70990de50c56953` |

Stated plainly: at this operating point the controller **stops correctly and still loses its load**.
That is the whole point of the second class — it is not reachable through the collision metric at all,
and a buyer reading `min_range_m` would see a clean run.

Paired baseline, identical except `load_friction: 0.6`: `SUCCESS`, clearance 0.377693 m, max slip
0.001 m, no shed. One axis, one failure.

A second, more severe run was recorded because the selected finding's load stays on the deck:
`load_friction: 0.15`, everything else nominal → `COLLISION` + `LOAD_SHED`. The load breaks loose
**rearward at t = 0.754 s while the cart is still accelerating** (drive needs only 0.23 of grip and
0.15 is less), then slides forward under braking to 0.546 m, **falls off the deck onto the floor**
(relative z −0.067 m, 0.444 s with no deck contact) and touches the obstacle at t = 4.434 s — the
recorded `first_contact` names `load_geom`, not the chassis. The cart itself stopped 0.443 m short.
Its severity proxy is only 0.146 m/s because the criterion fired early, during the rearward break-away;
this is exactly why the run maxima are recorded alongside.

Files: `runs/load-shed-finding.json`, `runs/load-shed-baseline.json`, `runs/load-shed-severe.json`,
`load-shed-finding.gif`, `load-shed-severe.gif`, `load-shed-side-by-side.png`,
`load-shed-severe-side-by-side.png`, `*-metrics.png`.

### Repeatability

`evidence/load-shed/repeatability-9b1ef160.json`: 3 in-process runs plus 1 fresh subprocess run of the
selected scenario, **all four byte-identical** — same trajectory hash
`0x135f78fc…810d55a7` and identical metrics including `load_shed_t_s`, `load_shed_criterion` and
`load_rel_speed_at_shed_mps`. As before, this is a claim about the pinned environment only (same
MuJoCo build, same CPU architecture, single thread), not about other machines or engine versions.

## 7. Run schema `tb-run-1` → `tb-run-2`

Every `tb-run-1` field is still present with its original meaning. One field changed value space and
its old value is still published under a new name:

- `outcome` gained the value `LOAD_SHED`. Precedence is
  `DIVERGED > COLLISION > LOAD_SHED > SUCCESS > TIMEOUT`, so **a run that hits the obstacle still
  reads `COLLISION` exactly as it did before**.
- `chassis_outcome` — the stop-before-obstacle result on its own, using exactly the `tb-run-1`
  vocabulary. Never `LOAD_SHED`.

Added, all explicit and clearly named:

| field | where | type |
|---|---|---|
| `failure_classes` | top level and in hunt rows | sorted array, `[]` / `["COLLISION"]` / `["LOAD_SHED"]` / `["COLLISION","LOAD_SHED"]` — **authoritative** |
| `primary_failure_class` | top level, `metrics` | `"NONE"` / `"COLLISION"` / `"LOAD_SHED"` |
| `metrics.failure_class_set` | `metrics` | the same set as a string, `"COLLISION+LOAD_SHED"` / `"NONE"` (kept scalar so `metrics` stays `number\|string\|null\|boolean`) |
| `load_shed_event` | top level | object or `null`; carries the vector quantities |
| `load_shed_rules` | top level | the published thresholds and their derivations, in every run |
| `envelope_revision` | top level | `"tb-envelope-1.1"` |
| `scene.scene_revision`, `scene.load_attachment`, `scene.load_seat_local_m`, `scene.deck_margin_{x,y}_m` | `scene` | |
| `metrics.load_*`, `metrics.deck_*` | `metrics` | scalars only |
| `ticks[].load_slip_m`, `ticks[].load_rel_speed_mps`, `ticks[].load_shed` | per control tick | |
| `termination_rules.post_shed_s` | | 1.0 s, so the replay shows the load leaving |

`frames` is byte-compatible: the body list and layout are unchanged (`load` was already recorded), so
existing replay code renders the slide without modification.

**Not backwards compatible, and unavoidable:** scene revision 2 adds a free body, so trajectory hashes
differ from scene revision 1. Evidence recorded under revision 1 (`evidence/milestone/`,
`evidence/local/`, `evidence/testnet/`) remains valid *as recorded* — those runs happened, and the
Base Sepolia settlements are historical fact — but re-running those scenarios today produces different
hashes. `scene_hash` in each document says which revision produced it.

## 8. Duplicate rule

`scenario_distance` and `is_duplicate` keep their published definitions exactly (normalized
L-infinity < 0.05 over the envelope ranges; the new axis simply participates, and a missing axis is
read at nominal so an old four-key scenario still compares correctly). The class rule is added on top,
in `finding_distance` / `is_duplicate_finding`:

> two findings are approximate duplicates when they carry **the same set of failure classes** AND their
> scenarios are closer than 0.05 in normalized L-infinity distance; **findings of different classes are
> never duplicates of each other.**

The hunter groups findings by their exact class set before ranking and deduplicating, so no
cross-class comparison is ever made. `selected` in a hunt document keeps its old COLLISION-only
meaning and ordering; `selected_by_class` is the complete structure.

## 9. What is NOT claimed

- This is simplified cart physics in an illustrative envelope. No bound here is measured on a physical
  robot, and neither is the deck grip of any real pallet on any real deck.
- LOAD_SHED means *the load left its seat by more than the deck margin* (or lost contact, or left the
  footprint). It does not mean "the load was destroyed", and no damage, cost or injury is estimated.
  `load_rel_speed_at_shed_mps` is an uncalibrated proxy, exactly like `impact_speed_mps`.
- The selected finding's load ends overhanging the deck by 30 mm, still supported. Only the lower-grip
  runs put it on the floor. Both are reported above.
- Adversarially selected failures are not failure frequencies. No distribution over the envelope is
  stated or estimated, here or anywhere else in this repository.
- Bitwise repeatability is verified only inside the pinned environment.

## 10. What the web layer still has to mirror

The simulator is authoritative and these Python-side changes are done; the TypeScript mirrors in
`web/` were **not touched** by this pass and still describe four axes and one failure class. Needed
there, in `web/src/server/envelope.ts` unless noted:

1. `PARAM_ORDER`, `Scenario`, `ENVELOPE` and `ENVELOPE_AXES` need the `load_friction` entry
   (0.1–1.0, nominal 0.6, 3 places, group `physical`, units `coefficient`, `tuned_range: "not stated"`).
   Without it `checkAdmissible` rejects a five-key scenario as an unknown parameter, and the
   `sim/envelope.yaml` anti-drift test in `web/src/server/__tests__/envelope.test.ts` fails its
   one-block-per-axis assertion (it now sees five blocks).
2. `CONTROLLER_TUNED_RANGE` should stay exactly as it is — four entries — because `controller.py` is
   unchanged and states nothing about deck grip. The existing `assert.deepEqual` on it still passes.
3. To sell a `LOAD_SHED` finding, `web/src/server/agents/verifier.ts` needs its `claims-collision`,
   `verifier-run-conclusive` and `reproduces-collision` checks generalised to the claimed failure
   class, and `severityBand` needs a band definition for `load_rel_speed_at_shed_mps`. Until then a
   `LOAD_SHED` submission is rejected; `COLLISION` submissions are entirely unaffected.
4. `ENVELOPE_ID` must **not** change.
