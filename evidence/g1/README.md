# Target 4 evidence — the Unitree G1 walking policy (`tb-g1-envelope-1`)

Everything in this directory was produced by `sim/tailbazaar_sim/g1/cli.py` in the pinned
environment recorded in `environment-fingerprint.json` (MuJoCo 3.13.0, torch 2.14.0 CPU, numpy
2.5.3, Python 3.14.4, Darwin-arm64, one torch thread, `uv.lock` sha256 `ffe70628…`). The files are
canonical JSON (`tb-cjson-1`), so every hash below can be recomputed from the bytes.

## 1. What is under test, and where it comes from

Unitree's own pretrained G1 walking policy, `deploy/pre_train/g1/motion.pt`, from
`unitreerobotics/unitree_rl_gym` at commit `276801e46c5d433564f24658bac64f254b7d2d4b`, BSD-3-Clause,
run under Unitree's own 12-dof MuJoCo model (`g1_12dof.xml`, 32.107 kg) with Unitree's own
deployment configuration (`deploy_mujoco/configs/g1.yaml`: 0.002 s physics, 50 Hz control, the PD
gains, default angles, scales and the 0.5 m/s forward command). The control loop is a line-by-line
port of the publisher's `deploy_mujoco.py`; the file list, digests and licence are in
`sim/tailbazaar_sim/g1/PROVENANCE.md`. Policy file sha256
`cf668f75b90d1abf73d2b87612a6e76bccc61ff7e083b63582d3f6aaa3c1759d` — **this is what a listing is
bound to.**

## 2. The failure predicate is ours, and it says so

Unitree's runner has no notion of a fall. So `FELL` here is this project's predicate, stated in every
run document (`fall_predicate`): the pelvis height drops below **0.462 m** (0.6 × the measured
nominal standing height of 0.77 m — the mean pelvis height of the nominal run between 2 s and 6 s
was 0.7697 m) **or** the pelvis tilts past **60°** from vertical (arccos of the projected gravity the
policy itself observes), whichever first, checked at the end of every 20 ms control tick. The run
records which condition fired (`detected_by`) and when. Severity is `pelvis_impact_speed_mps`: the
pelvis body's world-frame speed at the first floor contact of a geom that does not belong to a foot,
looked for only after the predicate fired. Kinematics, never a damage estimate.

## 3. The nominal run (must not fall) — `nominal-suite.json`, `runs/baseline-nominal.json`

| case | outcome | survived | walked | min pelvis z | max tilt |
|---|---|---|---|---|---|
| published-conditions (the deployment configuration) | SURVIVED | 15.00 s | 6.92 m (0.461 m/s against a 0.5 m/s command) | 0.763 m | 4.1° |
| one-tick-latency (20 ms) | SURVIVED | 15.00 s | 7.34 m | 0.757 m | 3.8° |
| grippier-floor (μ 1.2) | SURVIVED | 15.00 s | 6.91 m | 0.763 m | 4.1° |
| lighter-body (×0.95) | SURVIVED | 15.00 s | 6.91 m | 0.766 m | 4.3° |
| light-shove (4 N·s from behind) | SURVIVED | 15.00 s | 6.82 m | 0.763 m | 4.1° |
| slow-walk (0.3 m/s) | SURVIVED | 15.00 s | 4.27 m | 0.766 m | 4.0° |
| brisk-walk (0.8 m/s) | SURVIVED | 15.00 s | 10.91 m | 0.757 m | 5.2° |

Gate `published_conditions_all_passed: true` (walks the full episode and covers more than half the
commanded distance); `benign_perturbations_all_passed: true`. Baseline trajectory hash
`0x1b6fc308c45f6029ecc690d0201fe190557fcfb8fa1683adc77e0054803bacf6`.

## 4. The hunts — `hunt-grid-push.json`, `hunt-grid-systems.json`, `hunt-grid-terrain.json`

| hunt | simulations | fell | boundary |
|---|---|---|---|
| push impulse 0–40 N·s × 8 headings | 88 | 8 | every shove up to 24 N·s survives from every heading; **28 N·s from the side (90°) is the mildest fall**; 36 N·s from the front, 32 N·s from the side |
| latency 0–100 ms × noise 0–0.3 | 42 | 15 | up to 60 ms (3 ticks) survives at every noise level; **80 ms (4 ticks) falls even with no noise**; 100 ms falls |
| friction 0.4–1.4 × mass ×0.8–1.25 | 36 | 0 | the whole grid survives: friction and mass alone do not fell this policy inside the envelope |

Total 166 simulations, 1.13 M physics steps, 55 s wall. Compare the Gymnasium humanoid (target 2),
which one 15 ms tick of latency puts on the floor and which an 8 N·s shove topples: the G1 policy
tolerates four control ticks and a shove three and a half times harder.

## 5. The findings — `runs/finding-push-28ns.json`, `runs/finding-latency-80ms.json`

| finding | scenario | fell at | which condition | at the fall | first ground contact | pelvis impact speed | peak pelvis accel |
|---|---|---|---|---|---|---|---|
| push-28ns | 28 N·s on the pelvis, heading 90°, at 3.0 s for 0.1 s; everything else nominal | **4.32 s** (1.32 s after the push) | pelvis height **and** tilt | pelvis 0.4588 m, tilt 65.9°, moving 4.25 m/s | right hand (`pelvis/right_wrist_roll_rubber_hand`) at 4.40 s | **2.740 m/s** (band: medium) | 139 m/s² |
| latency-80ms | 80 ms of control latency (4 ticks), no push | **3.28 s** | tilt | pelvis 0.481 m, tilt 63.1° | left knee at 3.36 s | **2.224 m/s** (band: medium) | — see the file |

Frame-level check, done by `web/src/server/__tests__/envelope-g1.test.ts` on `finding-push-28ns`:
at every recorded frame before 4.32 s the pelvis is above the 0.462 m line; at 4.32 s the frame's
pelvis height is 0.4588 m, the event's 0.458771 m (frames are rounded to 4 decimals), below the line.
(Frames are recorded from the same instant the predicate reads: after each control period's ten
physics steps the pose, COM velocities and contact list are recomputed from the state, because
MuJoCo's `mj_step` leaves those one step stale.)

## 6. Determinism — `repeatability-5171384e.json`, `repeatability-533f6789.json`

Each finding was run twice more in one process and once in a fresh subprocess; all three runs
matched on the trajectory hash (keccak256 over the canonical replay frames), the state hash (sha256
over the raw float64 qpos/qvel at every control tick) and every metric:

| finding | trajectory hash | state hash | identical |
|---|---|---|---|
| push-28ns | `0x4724e8b29caa89a23ab04a5799a3019807f90888a262fe01755618764c00d536` | `sha256:cbab41859ad62d5ab98cd3b24de3f4099ed98a040dd86eea0eea37b0b8a2a634` | 2 in-process + 1 subprocess: **true** |
| latency-80ms | `0x2027d044dbd6d0b9866ae73439399619d0509cf0e3883772a22b0d04d5f16c41` | `sha256:9f307e69fe10e90f55b88fe86238189f92d9e3a6eeaa4c080745793121221f75` | 2 in-process + 1 subprocess: **true** |

What makes the TorchScript policy repeatable: one CPU thread, `inference_mode`, no sampling or
dropout in the graph, and the LSTM's hidden/cell buffers reset to zero at the start of every run
(`reset_memory()`, the exporter's own method) — without that reset the second run in a process would
start with the first run's memory. The claim is scoped to this pinned environment, as for every
other target; on another machine the verifier abstains (INCONCLUSIVE) rather than certifying.

## 7. The marketplace run — `../local-g1/`

`PORT=3188 npm run demo -- --target g1` against the local anvil, with a copy of the demonstration
database: the seller's grid-push hunt, two listings verified VALID by re-run in the verifier's own
environment, funded, delivered, retrieved by signed challenge and settled on chain; receipts and
public summaries are in `../local-g1/`, the order page render in `../ui/g1-fall.png`.
