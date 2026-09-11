"""The target under test: Unitree's PRETRAINED G1 walking policy, `deploy/pre_train/g1/motion.pt`.

Nothing here trains anything. The policy is the publisher's own TorchScript export and Tail
Bazaar treats it exactly the way it treats the other targets' artefacts: as a fixed file pinned
by hash, never edited, whose operating range is the product question.

Provenance (checked at load time, not just recorded; see PROVENANCE.md)
----------------------------------------------------------------------
  repo      unitreerobotics/unitree_rl_gym @ 276801e46c5d433564f24658bac64f254b7d2d4b
  file      deploy/pre_train/g1/motion.pt, 145 745 bytes, sha256 cf668f75...1759d
  licence   BSD-3-Clause (vendored as assets/LICENSE.unitree_rl_gym)
  config    deploy/deploy_mujoco/configs/g1.yaml — the constants below are transcribed from it
            and the vendored copy is re-read and compared at load time

What the file is
----------------
`PolicyExporterLSTM`: an LSTM memory (47 -> 64, one layer) whose output feeds a Linear(64, 32) /
ELU / Linear(32, 12) actor. The LSTM's hidden and cell states are BUFFERS inside the module
(`hidden_state`, `cell_state`, shape 1x1x64) and the exported `forward` writes the new state back
into them, so the module is stateful across calls and the exporter provides `reset_memory()` to
zero it. This wrapper calls `reset_memory()` at the start of every run; without that, the second
run in a process would start with the first run's memory and two identical scenarios would not
produce identical trajectories.

How it is evaluated here
------------------------
`torch.jit.load`, `eval()`, CPU, `torch.set_num_threads(1)`, under `torch.inference_mode()`, with
float32 inputs built exactly as the publisher's `deploy_mujoco.py` builds them. There is no
sampling, no dropout and no data-dependent branching in the graph, so repeated evaluation of the
same observation sequence from a reset memory is bit-identical on one machine; the repeat command
proves it rather than assuming it.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import numpy as np

POLICY_ID = "unitree-rl-gym-g1-motion-pt"
POLICY_FRAMEWORK = "torchscript"
REPO = "unitreerobotics/unitree_rl_gym"
REPO_COMMIT = "276801e46c5d433564f24658bac64f254b7d2d4b"
REPO_URL = f"https://github.com/{REPO}/tree/{REPO_COMMIT}"
LICENCE_SPDX = "BSD-3-Clause"
LICENCE_HOLDER = "HangZhou YuShu TECHNOLOGY CO.,LTD. (Unitree Robotics), 2016-2023"

ASSETS = Path(__file__).resolve().parent / "assets"
POLICY_FILE = ASSETS / "policy" / "motion.pt"
POLICY_SOURCE_PATH = "deploy/pre_train/g1/motion.pt"
POLICY_SHA256 = "cf668f75b90d1abf73d2b87612a6e76bccc61ff7e083b63582d3f6aaa3c1759d"
POLICY_BYTES = 145745
CONFIG_FILE = ASSETS / "policy" / "g1.yaml"
CONFIG_SOURCE_PATH = "deploy/deploy_mujoco/configs/g1.yaml"
CONFIG_SHA256 = "73044e7d355c61915695c16d6e09eb3efef46eec1e3d708fd3eb9157dfe3bbbb"

# ---- transcribed from configs/g1.yaml (re-read and compared in load_policy) ----------------
SIMULATION_DT_S = 0.002
CONTROL_DECIMATION = 10
KPS = np.array([100, 100, 100, 150, 40, 40, 100, 100, 100, 150, 40, 40], dtype=np.float32)
KDS = np.array([2, 2, 2, 4, 2, 2, 2, 2, 2, 4, 2, 2], dtype=np.float32)
DEFAULT_ANGLES = np.array([-0.1, 0.0, 0.0, 0.3, -0.2, 0.0, -0.1, 0.0, 0.0, 0.3, -0.2, 0.0], dtype=np.float32)
ANG_VEL_SCALE = 0.25
DOF_POS_SCALE = 1.0
DOF_VEL_SCALE = 0.05
ACTION_SCALE = 0.25
CMD_SCALE = np.array([2.0, 2.0, 0.25], dtype=np.float32)
NUM_ACTIONS = 12
NUM_OBS = 47
CMD_INIT = np.array([0.5, 0.0, 0.0], dtype=np.float32)   # walk forward at 0.5 m/s, no lateral, no yaw
GAIT_PERIOD_S = 0.8                                       # hard-coded in deploy_mujoco.py, not in the yaml

LICENCE_NOTE = {
    "declared_spdx": LICENCE_SPDX,
    "holder": LICENCE_HOLDER,
    "source": "LICENSE file at the root of the repository, vendored as assets/LICENSE.unitree_rl_gym",
    "what_this_project_does": (
        "the policy file, the deployment configuration, the 12-dof MJCF and the 27 meshes it references are "
        "vendored verbatim with the licence text; nothing is modified; the sha256 of every file is checked at load "
        "time and published in every run document"
    ),
}


def _sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def gravity_orientation(quat_wxyz: np.ndarray) -> np.ndarray:
    """Projected gravity in the pelvis frame, exactly as deploy_mujoco.get_gravity_orientation."""
    qw, qx, qy, qz = (float(x) for x in quat_wxyz)
    return np.array([
        2 * (-qz * qx + qw * qy),
        -2 * (qz * qy + qw * qx),
        1 - 2 * (qw * qw + qz * qz),
    ], dtype=np.float64)


def pd_torque(target_q: np.ndarray, q: np.ndarray, dq: np.ndarray) -> np.ndarray:
    """deploy_mujoco.pd_control with target_dq = 0: (target - q) * kp + (0 - dq) * kd."""
    return (target_q - q) * KPS + (0.0 - dq) * KDS


class G1Policy:
    """The pinned TorchScript module, evaluated deterministically on one CPU thread."""

    def __init__(self, module: Any, digests: dict[str, str]) -> None:
        self.module = module
        self.digests = digests
        params = list(module.named_parameters())
        self.n_parameters = int(sum(p.numel() for _, p in params))
        self.parameter_names = [n for n, _ in params]
        self.buffer_names = [n for n, _ in module.named_buffers()]

    def reset(self) -> None:
        """Zero the LSTM memory. Called at the start of every run."""
        self.module.reset_memory()

    def action(self, obs: np.ndarray) -> np.ndarray:
        import torch

        x = torch.from_numpy(np.ascontiguousarray(obs, dtype=np.float32)).unsqueeze(0)
        with torch.inference_mode():
            out = self.module(x)
        return out.detach().numpy().reshape(-1).astype(np.float32).copy()

    def identity(self) -> dict[str, Any]:
        """The pinned target identity that goes into every run document."""
        import torch

        return {
            "policy_id": POLICY_ID,
            "framework": POLICY_FRAMEWORK,
            "torch_version": torch.__version__,
            "repo": REPO,
            "repo_commit": REPO_COMMIT,
            "repo_url": REPO_URL,
            "policy_source_path": POLICY_SOURCE_PATH,
            "policy_file": POLICY_FILE.name,
            "policy_file_sha256": "sha256:" + self.digests["file"],
            "policy_bytes": POLICY_BYTES,
            "policy_tensor_sha256": "sha256:" + self.digests["tensors"],
            "config_source_path": CONFIG_SOURCE_PATH,
            "config_sha256": "sha256:" + self.digests["config"],
            "architecture": "PolicyExporterLSTM: LSTM(47->64) memory, Linear(64,32)/ELU/Linear(32,12) actor; stateful hidden/cell buffers reset per run",
            "obs_dim": NUM_OBS,
            "action_dim": NUM_ACTIONS,
            "n_parameters": self.n_parameters,
            "parameter_names": self.parameter_names,
            "control": {
                "simulation_dt_s": SIMULATION_DT_S,
                "control_decimation": CONTROL_DECIMATION,
                "kps": [float(x) for x in KPS],
                "kds": [float(x) for x in KDS],
                "default_angles_rad": [float(x) for x in DEFAULT_ANGLES],
                "ang_vel_scale": ANG_VEL_SCALE,
                "dof_pos_scale": DOF_POS_SCALE,
                "dof_vel_scale": DOF_VEL_SCALE,
                "action_scale": ACTION_SCALE,
                "cmd_scale": [float(x) for x in CMD_SCALE],
                "cmd_init": [float(x) for x in CMD_INIT],
                "gait_period_s": GAIT_PERIOD_S,
            },
            "evaluation": "torch.jit.load, eval(), CPU, one thread, inference_mode, float32; no sampling, no dropout",
            "published_performance": "none stated by the publisher; the deployment configuration is the only published operating point",
            "licence": LICENCE_NOTE,
        }


_LOADED: G1Policy | None = None


def load_policy() -> G1Policy:
    """Verify every pinned hash, load the module once per process, pin torch to one thread."""
    global _LOADED
    if _LOADED is not None:
        return _LOADED
    import torch
    import yaml

    raw = POLICY_FILE.read_bytes()
    file_digest = _sha256(raw)
    if file_digest != POLICY_SHA256 or len(raw) != POLICY_BYTES:
        raise ValueError(f"{POLICY_FILE.name} sha256 {file_digest} ({len(raw)} B) != pinned {POLICY_SHA256} ({POLICY_BYTES} B); refusing to run")
    cfg_raw = CONFIG_FILE.read_bytes()
    cfg_digest = _sha256(cfg_raw)
    if cfg_digest != CONFIG_SHA256:
        raise ValueError(f"{CONFIG_FILE.name} sha256 {cfg_digest} != pinned {CONFIG_SHA256}")
    cfg = yaml.safe_load(cfg_raw)
    expect = {
        "simulation_dt": SIMULATION_DT_S, "control_decimation": CONTROL_DECIMATION,
        "kps": [float(x) for x in KPS], "kds": [float(x) for x in KDS],
        "default_angles": [float(x) for x in DEFAULT_ANGLES], "ang_vel_scale": ANG_VEL_SCALE,
        "dof_pos_scale": DOF_POS_SCALE, "dof_vel_scale": DOF_VEL_SCALE, "action_scale": ACTION_SCALE,
        "cmd_scale": [float(x) for x in CMD_SCALE], "num_actions": NUM_ACTIONS, "num_obs": NUM_OBS,
        "cmd_init": [float(x) for x in CMD_INIT],
    }
    for k, v in expect.items():
        got = cfg.get(k)
        got = [float(x) for x in got] if isinstance(got, list) else got
        # The constants are float32 (as the publisher's runner casts them); compare numerically.
        same = np.allclose(np.asarray(got, dtype=np.float64), np.asarray(v, dtype=np.float64), rtol=1e-6, atol=1e-7) if isinstance(got, (list, int, float)) else got == v
        if not same:
            raise ValueError(f"g1.yaml {k}={got!r} differs from the transcribed constant {v!r}")

    torch.set_num_threads(1)
    torch.manual_seed(0)
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)  # torch.jit.load on Python 3.14 warns; it works
        module = torch.jit.load(str(POLICY_FILE), map_location="cpu")
    module.eval()
    h = hashlib.sha256()
    for name, p in module.named_parameters():
        arr = np.ascontiguousarray(p.detach().cpu().numpy(), dtype=np.float32)
        h.update(name.encode())
        h.update(str(arr.shape).encode())
        h.update(arr.tobytes())
    _LOADED = G1Policy(module, {"file": file_digest, "tensors": h.hexdigest(), "config": cfg_digest})
    return _LOADED
