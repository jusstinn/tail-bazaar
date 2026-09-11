# `vla/` — a pi0 vision-language-action policy as a Tail Bazaar target

A feasibility spike. A real Physical Intelligence **pi0** policy (openpi) drives a simulated
bimanual **ALOHA** arm pair in MuJoCo on the transfer-cube task, and we perturb the world along a
GUARD-shaped envelope until the policy fails.

**Findings, numbers and caveats live in [`../evidence/vla/README.md`](../evidence/vla/README.md).**
Read that first — in particular the reproducibility section, which is a negative result.

Two things to know before using any of this:

- **This is ALOHA sim standing in for YAM.** openpi contains no YAM / I2RT config, checkpoint or
  MuJoCo model at commit `215abfb`. YAM is hardware; it cannot be simulated without a model.
- **The target is stochastic.** Same seed, same config, run twice, gives different outcomes. Nothing
  produced here is a reproducible single-episode failure.

Nothing is trained or fine-tuned. The published checkpoint is used as-is, under Apache-2.0.

## Layout

```
vla_bazaar/episode.py     one perturbed episode: perturbation, rollout, outcome, traces
vla_bazaar/run_suite.py   CLI: nominal | probe | search | determinism
envelope-vla.yaml         GUARD-shaped envelope (name, low, high, nominal, marginal, scale, units, group)
make_filmstrip.py         success-vs-failure image for the evidence directory
```

This package is the **client** half. It is deliberately light — numpy, gymnasium, gym-aloha,
imageio. openpi's heavy dependencies (JAX, CUDA, the 11.2 GiB checkpoint) live only in openpi's own
venv on the GPU host and are **not** added to `sim/pyproject.toml` or anywhere else in this repo.

## Running it

Needs an NVIDIA GPU; pi0 occupies ~19.5 GB, so a 24 GB card is the practical floor. It was measured
on a Lambda Cloud A10.

```bash
# 1. openpi and its own venv
git clone --recurse-submodules https://github.com/Physical-Intelligence/openpi.git
cd openpi && git checkout 215abfb217dbac7d5f1273282331b9b1866c0479
uv sync

# 2. the sim client venv (python 3.10 — gym-aloha pins dm-control 1.0.14)
uv venv --python 3.10 examples/aloha_sim/.venv
source examples/aloha_sim/.venv/bin/activate
uv pip sync examples/aloha_sim/requirements.txt
uv pip install -e packages/openpi-client "imageio[ffmpeg]"

# 3. policy server (downloads the 11.2 GiB checkpoint on first run)
XLA_PYTHON_CLIENT_MEM_FRACTION=0.85 uv run scripts/serve_policy.py --env ALOHA_SIM
```

Then, in the client venv, with this directory on `PYTHONPATH`:

```bash
# baseline. ~26 s per episode; needed before any search
MUJOCO_GL=egl python -m vla_bazaar.run_suite nominal --episodes 6 --video

# paired search: only seeds that SUCCEED at nominal count as controls
MUJOCO_GL=egl python -m vla_bazaar.run_suite search --axes action_noise --min-failures 4 --stop-on-first

# the same seed and config twice — see the evidence README for why this matters
MUJOCO_GL=egl python -m vla_bazaar.run_suite determinism --seed 1

# one episode anywhere in the envelope
MUJOCO_GL=egl python -m vla_bazaar.run_suite probe --seed 1 --action-noise 0.05 --video f.mp4
```

`MUJOCO_GL=egl` is required for headless rendering. Mesa's software EGL is enough; the rendered
frame is 480x640 and costs ~20 ms.

## How a failure is decided

**Success is the environment's own signal, never one we invented.** `gym_aloha`'s
`TransferCubeTask.get_reward` defines `max_reward = 4` (cube held by the left gripper, clear of the
table) and `AlohaEnv.step` sets `terminated = is_success = (reward == 4)`.

One mechanical predicate is added on top, only to separate a drop from a policy that never picked
the cube up: `DROPPED` requires the cube to have been genuinely lifted (the task's own reward >= 2)
and then for geom `red_box` to re-contact geom `table` while touching neither gripper finger.

Outcomes: `SUCCESS`, `DROPPED`, `NOT_COMPLETED`, `INCONCLUSIVE`. Severity is measured, not scored —
cube impact speed (m/s) at that contact, recorded with drop height.

### The search is paired, and has to be

pi0 succeeds at only **4/6** unperturbed episodes. A failure at a perturbed point is therefore not
by itself evidence of anything. `search` reads a nominal baseline, takes the seeds that reached
success as its control set, and counts a failure only when such a seed flips. With a 67% baseline,
four control seeds all failing has a ~1.2% chance of happening anyway — which is the strongest claim
this target currently supports.

## Perturbation axes

All eight are implemented in `episode.py` and specified in `envelope-vla.yaml`; only `action_noise`
was searched to a boundary inside the time box.

| Axis | Group | How it is applied |
| --- | --- | --- |
| `box_mass_scale` | physical | scales the cube's 0.05 kg body mass, inertia scaled with it |
| `box_friction_scale` | physical | scales the `red_box` sliding friction coefficient |
| `box_pos_dx` / `box_pos_dy` | physical | offsets the cube pose via gym-aloha's own `sample_box_pose` hook |
| `cam_dz` | visual | raises/lowers the `top` observation camera |
| `light_scale` | visual | scales every light's diffuse component |
| `action_noise` | systems | Gaussian noise on each of the 14 joint commands, per tick |
| `latency_steps` | systems | holds a stale action for N control ticks (1 tick = 20 ms) |

Model-level axes are applied after `reset()` and before stepping — dm-control's `Physics.reset()`
restores `data`, not `model`, so the edits survive the episode. The cube-pose axes patch
`gym_aloha.env.sample_box_pose`, which is the environment's own randomization path (the task reads a
module-global `BOX_POSE` that the docstring says is "to be changed from outside"), not a way around
it.

## Replay

Every episode records world transforms for both arms, both grippers' fingers and the cube, decimated
to 10 Hz, under `replay.frames` as `{position, quaternion}` per body. That is the shape the existing
Three.js viewer consumes, so a recorded episode can be replayed without re-running the policy. The
wiring to the viewer was not built.
