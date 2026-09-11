# Tail Bazaar — status at the first runnable milestone (simulator feasibility)

Date: 2026-09-10 (local). Scope of this milestone: prove the simulator before building the marketplace. Nothing below involves a chain, a wallet, or a network call; everything ran locally.

## What ran

Environment (pinned in `sim/uv.lock`): MuJoCo 3.13.0, NumPy 2.5.3, Python 3.12.13 (uv), macOS arm64, single thread, `implicitfast` integrator, physics 500 Hz (dt 0.002 s), control 50 Hz.

Commands (from `sim/`, `OUT=../evidence/milestone`):

```
uv run python -m tailbazaar_sim.cli --out $OUT nominal
uv run python -m tailbazaar_sim.cli --out $OUT hunt --mode grid
uv run python -m tailbazaar_sim.cli --out $OUT hunt --mode random --n 40 --seed 7
uv run python -m tailbazaar_sim.cli --out $OUT run --name baseline --render --scenario '{"sensor_delay_ms":20,"actuator_delay_ms":20,"floor_friction":0.8,"payload_kg":20.0}'
uv run python -m tailbazaar_sim.cli --out $OUT run --name failure  --render --scenario '{"sensor_delay_ms":200,"actuator_delay_ms":20,"floor_friction":0.3,"payload_kg":20.0}'
uv run python -m tailbazaar_sim.cli --out $OUT repeat --n 3 --scenario '{...failure...}'
uv run python -m tailbazaar_sim.cli --out $OUT compare --baseline $OUT/runs/baseline.json --failure $OUT/runs/failure.json
```

## Scene, controller, envelope (illustrative assumptions)

- Scene (`sim/tailbazaar_sim/scene.py`): floor plane, static obstacle box (front face at x = 6.0 m), cart chassis 0.8×0.5×0.12 m (25 kg) on four hinge-jointed cylinder wheels (r = 0.10 m, 2 kg each), rigid load block on top (payload mass). Cart starts at rest at the origin heading +x; initial range to obstacle 5.59 m; initial-state check passes (no obstacle contact, no penetration).
- Controller (`sim/tailbazaar_sim/controller.py`, identified by SHA-256 of the file): proportional speed loop toward 2.0 m/s (settles at 1.81 m/s against wheel damping), then when the deceleration required to stop 0.40 m before the obstacle exceeds 3.0 m/s² (half the assumed full-brake capacity of 6.0 m/s²) it brakes with `brake_level = a_req / 6.0` clipped to [0.15, 1], and parks below 0.05 m/s. Explicit brake actuation: wheel torque = −level·8 N·m·clip(ω/5, −1, 1) on all four wheels. Obstacle distance comes from a MuJoCo rangefinder on the front face.
- Delays: sensor delay (rangefinder reading is N control ticks stale) and actuator delay (commands applied N ticks later) are separate scenario parameters, quantized to 20 ms.
- Envelope (`envelope.py`): sensor delay 0–300 ms, actuator delay 0–100 ms, floor friction 0.2–1.0, payload 5–60 kg. Nominal: 20 ms / 20 ms / 0.8 / 20 kg. Duplicate rule: normalized L∞ distance < 0.05.
- Outcomes: SUCCESS, COLLISION, TIMEOUT / DIVERGED / INVALID_INITIAL_STATE / REJECTED_OUT_OF_ENVELOPE (inconclusive or rejected).

## Actual results

Nominal suite (`evidence/milestone/nominal-suite.json`): 6/6 PASS. All SUCCESS, final clearance 0.318–0.394 m (target 0.40 ± 0.15), stopping distance 0.47–0.53 m. Not a safety benchmark.

Grid hunt (`hunt-grid.json`): 144 simulations (16 delays × 9 frictions, actuator delay and payload fixed at nominal), 336,350 physics steps, 8.5 s wall. 101 SUCCESS, 43 COLLISION, 0 inconclusive, 0 near-duplicates (grid spacing 0.067 > 0.05 threshold). Collisions occur at sensor delay ≥ 40 ms on μ = 0.2, at ≥ 200 ms on μ = 0.3, and at 300 ms for every friction (impact 0.81–1.38 m/s). Random hunt seed 7 (`hunt-random-seed7.json`): 40 sims, 2.4 s, 8 collisions.

Selected finding (policy: mildest admissible collision by distance to nominal): sensor delay 200 ms, actuator delay 20 ms, μ 0.3, payload 20 kg. Brake onset t = 3.52 s at 1.811 m/s with the controller seeing 0.89 m of range while the true range was about 0.53 m; first contact t = 4.006 s (chassis geom), impact speed 0.415 m/s, kinetic energy ≈ 4.6 J (proxy only), 0.541 m travelled from brake onset to impact; stopping distance undefined (collision). Baseline under nominal conditions: brake onset 3.28 s, stopped 3.94 s, clearance 0.378 m, stopping distance 0.483 m.

Repeatability (`repeatability-*.json`): identical trajectory hash and metrics across 3 in-process runs + 1 fresh subprocess for the failure (0x0faa25a2…) and 2 + 1 for the baseline (0x2c2398d3…). This is only a claim about this pinned environment.

Evidence and renderings: `evidence/milestone/runs/{baseline,failure}.json` (canonical JSON, per-tick observations/commands and per-tick body positions+quaternions for chassis, load, four wheels; replayable by the web viewer later), `baseline.gif`, `failure.gif`, `*-metrics.png`, `side-by-side.png` (all drawn from recorded transforms, no second physics), `mujoco-offscreen-scene.png` (MuJoCo's own offscreen renderer works on this Mac with `MUJOCO_GL=cgl`).

## Blockers and limitations

- None blocking. No fallback was needed.
- The load is rigidly attached (it cannot shift or tip); the brake is a simplified torque model applied explicitly at physics rate; the cart drives a straight line only; delays are quantized to one control tick; the envelope numbers are illustrative, not measured on any robot.
- The published duplicate rule found no near-duplicates in these searches (grid spacing exceeds the threshold); it will be unit-tested and applied to submissions in the marketplace phase.
- Adversarially selected failures do not estimate real-world failure frequency.

## Test-ETH needed later (Base Sepolia, public addresses only; keys are in the gitignored `.env`)

- Verifier/deployer: `0xe592C7DA96Cc42344952C452377eBCc7Cc0982AE` (deploys contract, registers listings, settles) — about 0.001 ETH.
- Seller: `0x28dAA9F3F9468382fFeD53cc339418403337cDeD` — about 0.0003 ETH.
- Buyer: `0x1B27C90FcD738E960D3D505682EC2732A08c7f99` — listing price (planned 0.001 ETH) plus gas, about 0.002 ETH.

Repository: private, https://github.com/jusstinn/tail-bazaar (pushed).
