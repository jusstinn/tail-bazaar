# Provenance of the G1 target's vendored files

Everything under `sim/tailbazaar_sim/g1/assets/` is copied VERBATIM from Unitree's official
repository. Nothing in this project trains, fine-tunes, re-exports or edits the policy or the model.

| | |
|---|---|
| Repository | https://github.com/unitreerobotics/unitree_rl_gym |
| Commit | `276801e46c5d433564f24658bac64f254b7d2d4b` (shallow clone, 2026-09-11) |
| Licence | BSD-3-Clause, copyright (c) 2016-2023 HangZhou YuShu TECHNOLOGY CO.,LTD. ("Unitree Robotics"); the full text is vendored as `assets/LICENSE.unitree_rl_gym` and must travel with every redistribution of these files |
| Local clone | `sim/third_party/unitree_rl_gym/` (git-ignored; only a SOURCE for the copies below) |

## Files copied, with their sha256 digests

| vendored path (under `assets/`) | source path in the repository | sha256 |
|---|---|---|
| `policy/motion.pt` (145 745 B) | `deploy/pre_train/g1/motion.pt` — the pretrained G1 walking policy, TorchScript, class `PolicyExporterLSTM`: LSTM(47 -> 64) memory + Linear(64,32) / ELU / Linear(32,12) actor, with `hidden_state` / `cell_state` buffers and a `reset_memory()` method | `cf668f75b90d1abf73d2b87612a6e76bccc61ff7e083b63582d3f6aaa3c1759d` |
| `policy/g1.yaml` | `deploy/deploy_mujoco/configs/g1.yaml` — the publisher's MuJoCo deployment configuration: PD gains, default joint angles, observation/action scales, control decimation, command velocity | `73044e7d355c61915695c16d6e09eb3efef46eec1e3d708fd3eb9157dfe3bbbb` |
| `policy/deploy_mujoco.py` | `deploy/deploy_mujoco/deploy_mujoco.py` — the publisher's sim2sim runner; `simulate.py` here is a line-by-line port of its control loop and is checked against this file | (reference copy, not executed) |
| `g1_description/scene.xml` | `resources/robots/g1_description/scene.xml` | `482d49902ca2b9fdc49d84ef5d8779fa69d66bc53ef440b4bf50079d1bac9995` |
| `g1_description/g1_12dof.xml` | `resources/robots/g1_description/g1_12dof.xml` — the 12-dof G1 (legs actuated; torso, arms and head are one rigid pelvis body), the model the deployment config names | `747ede40aa726b7352bae8353e95d0d0f908cec2257a27cbd78bc6e5a2d5a314` |
| `g1_description/meshes/*.STL` (27 files, 25 163 718 B) | `resources/robots/g1_description/meshes/` — ONLY the 27 STL files `g1_12dof.xml` references; the other 37 meshes in that directory (hands, 23/29-dof torsos, waist parts) are not copied | manifest hash published in every run document as `scene.mesh_manifest_sha256` |

Copied because their total (24.1 MB) is under the 25 MB vendoring limit this project set for the
target. The web viewer's copies under `web/public/meshes/g1/` are DECIMATED versions of the same
files (see `web/public/meshes/g1/README.txt`); the simulator only ever loads the verbatim ones here.

## What is NOT taken from the repository

- The training code (`legged_gym/`), the Isaac Gym environment, the real-robot deployment code
  (`deploy/deploy_real/`), the H1/H1-2/Go2 models and policies.
- Any claim about the policy's performance. The repository documents no evaluation numbers for
  `motion.pt`; the only published "conditions" are the deployment configuration itself, which is
  what this target's envelope calls the nominal point.

## What the port keeps identical to `deploy_mujoco.py`

physics timestep 0.002 s; control decimation 10 (50 Hz); PD torque
`tau = kp * (target - q) + kd * (0 - dq)` with the gains in `g1.yaml`, applied at every physics step
with `d.ctrl`; the 47-dimensional observation in the same order and with the same scales
(`omega * 0.25`, projected gravity from the pelvis quaternion, `cmd * [2, 2, 0.25]`,
`(q - default) * 1.0`, `dq * 0.05`, last action, `sin/cos` of a 0.8 s gait phase clocked from the
physics step counter); `target = action * 0.25 + default`; the policy is evaluated AFTER the ten
physics steps of each control period, exactly where the runner evaluates it; the initial state is
the model's own `qpos0` (pelvis at z = 0.793 m, every joint at zero), as the runner starts it.
