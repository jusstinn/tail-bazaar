"""Run one perturbed episode of the openpi pi0 ALOHA-sim transfer-cube task.

The policy is a real pi0 vision-language-action model served over the openpi
websocket protocol (`scripts/serve_policy.py --env ALOHA_SIM`). Nothing here
scripts the arms: every action comes from the policy server.

Success is read from the ENVIRONMENT'S OWN signal. gym_aloha's TransferCubeTask
defines a shaped reward with max_reward = 4:

    1  red_box touches the right gripper finger
    2  ... and no longer touches the table         (lifted)
    3  red_box touches the left gripper finger     (attempted transfer)
    4  ... and no longer touches the table         (SUCCESSFUL TRANSFER)

and gym_aloha.env.AlohaEnv.step sets `terminated = is_success = reward == 4`.
We never invent a success detector; we only add ONE documented mechanical
predicate to tell a drop apart from a policy that never picked the cube up at
all: after the cube has been lifted, geom `red_box` re-contacts geom `table`
while held by neither gripper finger.
"""

from __future__ import annotations

import dataclasses
import time
from typing import Any

import numpy as np

# Geom names used by the task's own reward function.
GEOM_BOX = "red_box"
GEOM_TABLE = "table"
GEOM_LEFT_FINGER = "vx300s_left/10_left_gripper_finger"
GEOM_RIGHT_FINGER = "vx300s_right/10_right_gripper_finger"

# Body names (note: the BODY is `box`, the GEOM is `red_box`).
BODY_BOX = "box"
CAMERA = "top"

CONTROL_HZ = 50  # gym_aloha.constants.DT = 0.02
MAX_STEPS = 300  # max_episode_steps in the gym_aloha registration
TABLE_TOP_Z = 0.05  # cube rest height, from gym_aloha.utils.sample_box_pose z_range

# Bodies whose world transforms we record for replay in the Three.js viewer.
REPLAY_BODIES = (
    "vx300s_left/upper_arm_link",
    "vx300s_left/lower_forearm_link",
    "vx300s_left/wrist_link",
    "vx300s_left/gripper_link",
    "vx300s_left/left_finger_link",
    "vx300s_left/right_finger_link",
    "vx300s_right/upper_arm_link",
    "vx300s_right/lower_forearm_link",
    "vx300s_right/wrist_link",
    "vx300s_right/gripper_link",
    "vx300s_right/left_finger_link",
    "vx300s_right/right_finger_link",
    BODY_BOX,
)


@dataclasses.dataclass(frozen=True)
class Perturbation:
    """A point in the operating envelope. All defaults are the nominal world."""

    box_mass_scale: float = 1.0
    box_friction_scale: float = 1.0
    box_pos_dx: float = 0.0  # metres, added to the sampled cube x
    box_pos_dy: float = 0.0  # metres, added to the sampled cube y
    cam_dz: float = 0.0  # metres, `top` camera raised/lowered
    light_scale: float = 1.0  # multiplies every light's diffuse component
    action_noise: float = 0.0  # std of gaussian noise added to each action
    latency_steps: int = 0  # control ticks the action is held stale

    def as_dict(self) -> dict[str, float]:
        return dataclasses.asdict(self)

    def is_nominal(self) -> bool:
        return self == Perturbation()


@dataclasses.dataclass
class EpisodeResult:
    outcome: str  # SUCCESS | DROPPED | NOT_COMPLETED | INCONCLUSIVE
    max_reward: int
    steps: int
    is_success: bool  # the environment's own info["is_success"]
    lifted: bool
    severity: float  # impact speed (m/s) at the drop, else 0.0
    drop_height: float  # metres the cube fell, else 0.0
    final_box_z: float
    inference_calls: int
    inference_ms_mean: float  # includes call 1, which pays the JAX JIT compile
    inference_ms_p95: float
    inference_ms_first: float  # the JIT compile call, reported separately
    inference_ms_warm_mean: float  # steady state: every call after the first
    inference_ms_warm_median: float
    wall_seconds: float
    seed: int
    perturbation: dict[str, float]
    reward_trace: list[int]
    box_z_trace: list[float]
    replay: dict[str, Any]
    action_digest: str
    obs_digest: str
    note: str = ""


def _contact_pairs(physics) -> list[tuple[str, str]]:
    """Mirror of TransferCubeTask.get_reward's contact extraction."""
    pairs = []
    for i in range(physics.data.ncon):
        c = physics.data.contact[i]
        n1 = physics.model.id2name(c.geom1, "geom")
        n2 = physics.model.id2name(c.geom2, "geom")
        pairs.append((n1, n2))
        pairs.append((n2, n1))
    return pairs


def apply_perturbation(physics, pert: Perturbation) -> None:
    """Apply the model-level axes in place, after reset and before stepping.

    dm_control's Physics.reset() restores `data`, not `model`, so model edits
    made here survive the episode. Inertia is scaled with mass so the cube stays
    physically consistent rather than becoming a heavy body with light inertia.
    """
    nm = physics.named.model
    if pert.box_mass_scale != 1.0:
        nm.body_mass[BODY_BOX] *= pert.box_mass_scale
        nm.body_inertia[BODY_BOX] *= pert.box_mass_scale
    if pert.box_friction_scale != 1.0:
        # index 0 of geom_friction is the sliding coefficient.
        nm.geom_friction[GEOM_BOX, 0] *= pert.box_friction_scale
    if pert.cam_dz != 0.0:
        nm.cam_pos[CAMERA, 2] += pert.cam_dz
    if pert.light_scale != 1.0:
        physics.model.light_diffuse[:] = np.clip(
            physics.model.light_diffuse[:] * pert.light_scale, 0.0, 1.0
        )
    physics.forward()


def make_env(pert: Perturbation):
    """Build the gym_aloha env, patching the documented cube-pose hook.

    gym_aloha.env.reset() calls `sample_box_pose(seed)` and stores the result in
    the module-global BOX_POSE, which TransferCubeTask.initialize_episode reads.
    Patching that call is the env's own randomization path, not a hack around it.
    """
    import gym_aloha  # noqa: F401  (registers the envs)
    import gym_aloha.env as gym_aloha_env
    import gymnasium

    if not hasattr(gym_aloha_env, "_vla_orig_sample_box_pose"):
        gym_aloha_env._vla_orig_sample_box_pose = gym_aloha_env.sample_box_pose

    orig = gym_aloha_env._vla_orig_sample_box_pose

    def patched(seed=None):
        pose = np.array(orig(seed), dtype=np.float64)
        pose[0] += pert.box_pos_dx
        pose[1] += pert.box_pos_dy
        return pose

    gym_aloha_env.sample_box_pose = patched
    return gymnasium.make("gym_aloha/AlohaTransferCube-v0", obs_type="pixels_agent_pos")


def _to_policy_obs(gym_obs: dict) -> dict:
    """Exactly the conversion in openpi examples/aloha_sim/env.py."""
    from openpi_client import image_tools

    img = gym_obs["pixels"]["top"]
    img = image_tools.convert_to_uint8(image_tools.resize_with_pad(img, 224, 224))
    img = np.transpose(img, (2, 0, 1))
    return {"state": gym_obs["agent_pos"], "images": {"cam_high": img}}


def run_episode(
    client,
    seed: int,
    pert: Perturbation,
    *,
    action_horizon: int = 10,
    max_steps: int = MAX_STEPS,
    frame_stride: int = 5,
    video_path: str | None = None,
) -> EpisodeResult:
    import hashlib

    t_start = time.time()
    env = make_env(pert)
    rng = np.random.default_rng(seed)

    try:
        gym_obs, _ = env.reset(seed=seed)
    except Exception as exc:  # pragma: no cover - env construction failure
        return _inconclusive(seed, pert, f"reset failed: {exc}", time.time() - t_start)

    physics = env.unwrapped._env.physics
    apply_perturbation(physics, pert)

    reward_trace: list[int] = []
    box_z_trace: list[float] = []
    frames: list[np.ndarray] = []
    replay_frames: list[dict] = []
    infer_ms: list[float] = []
    action_hash = hashlib.sha256()
    obs_hash = hashlib.sha256()

    chunk: np.ndarray | None = None
    chunk_i = 0
    latency_buf: list[np.ndarray] = []

    max_reward = 0
    lifted = False
    lift_peak_z = TABLE_TOP_Z
    severity = 0.0
    drop_height = 0.0
    drop_recorded = False
    is_success = False
    steps = 0
    note = ""

    for step in range(max_steps):
        obs = _to_policy_obs(gym_obs)
        obs_hash.update(np.ascontiguousarray(obs["state"], dtype=np.float64).tobytes())
        obs_hash.update(np.ascontiguousarray(obs["images"]["cam_high"]).tobytes())

        # Query the policy once per action_horizon ticks (openpi ActionChunkBroker).
        if chunk is None or chunk_i >= action_horizon:
            t0 = time.perf_counter()
            try:
                result = client.infer(obs)
            except Exception as exc:
                return _inconclusive(
                    seed, pert, f"policy server error at step {step}: {exc}", time.time() - t_start
                )
            infer_ms.append((time.perf_counter() - t0) * 1000.0)
            chunk = np.asarray(result["actions"], dtype=np.float64)
            chunk_i = 0

        action = np.array(chunk[chunk_i], dtype=np.float64)
        chunk_i += 1

        if pert.action_noise > 0.0:
            action = action + rng.normal(0.0, pert.action_noise, size=action.shape)

        # Control latency: hold a stale action for `latency_steps` control ticks.
        if pert.latency_steps > 0:
            latency_buf.append(action)
            if len(latency_buf) > pert.latency_steps:
                action = latency_buf.pop(0)
            else:
                action = latency_buf[0]

        action_hash.update(np.ascontiguousarray(action, dtype=np.float64).tobytes())

        gym_obs, reward, terminated, truncated, info = env.step(action.astype(np.float32))
        steps = step + 1
        reward = int(reward)
        max_reward = max(max_reward, reward)

        box_xpos = np.array(physics.named.data.xpos[BODY_BOX])
        box_z = float(box_xpos[2])
        box_vel = np.array(physics.data.qvel[-6:-3])  # free-joint linear velocity
        reward_trace.append(reward)
        box_z_trace.append(box_z)

        pairs = _contact_pairs(physics)
        touch_table = (GEOM_BOX, GEOM_TABLE) in pairs
        touch_left = (GEOM_BOX, GEOM_LEFT_FINGER) in pairs
        touch_right = (GEOM_BOX, GEOM_RIGHT_FINGER) in pairs

        # Mechanical predicate, evaluated only after the cube has genuinely left
        # the table in a gripper (the env's own reward >= 2 condition).
        if reward >= 2:
            lifted = True
            lift_peak_z = max(lift_peak_z, box_z)
        if lifted and not drop_recorded and touch_table and not touch_left and not touch_right:
            severity = float(np.linalg.norm(box_vel))
            drop_height = float(max(0.0, lift_peak_z - box_z))
            drop_recorded = True

        if step % frame_stride == 0:
            replay_frames.append(
                {
                    "t": round(step / CONTROL_HZ, 4),
                    "step": step,
                    "reward": reward,
                    "bodies": {
                        b: {
                            "p": [round(float(v), 5) for v in physics.named.data.xpos[b]],
                            "q": [round(float(v), 5) for v in physics.named.data.xquat[b]],
                        }
                        for b in REPLAY_BODIES
                    },
                }
            )
            if video_path:
                frames.append(env.unwrapped._render())

        if info.get("is_success"):
            is_success = True
        if terminated or truncated:
            break

    env.close()
    wall = time.time() - t_start

    # Outcome. SUCCESS is the environment's own signal and nothing else.
    if is_success or max_reward >= 4:
        outcome = "SUCCESS"
    elif drop_recorded:
        outcome = "DROPPED"
    else:
        outcome = "NOT_COMPLETED"
        if lifted:
            note = "cube was lifted but never transferred and never re-contacted the table"

    if video_path and frames:
        _write_video(video_path, frames)

    return EpisodeResult(
        outcome=outcome,
        max_reward=max_reward,
        steps=steps,
        is_success=is_success,
        lifted=lifted,
        severity=round(severity, 5),
        drop_height=round(drop_height, 5),
        final_box_z=round(box_z_trace[-1] if box_z_trace else TABLE_TOP_Z, 5),
        inference_calls=len(infer_ms),
        inference_ms_mean=round(float(np.mean(infer_ms)), 2) if infer_ms else 0.0,
        inference_ms_p95=round(float(np.percentile(infer_ms, 95)), 2) if infer_ms else 0.0,
        inference_ms_first=round(float(infer_ms[0]), 2) if infer_ms else 0.0,
        inference_ms_warm_mean=round(float(np.mean(infer_ms[1:])), 2) if len(infer_ms) > 1 else 0.0,
        inference_ms_warm_median=(
            round(float(np.median(infer_ms[1:])), 2) if len(infer_ms) > 1 else 0.0
        ),
        wall_seconds=round(wall, 2),
        seed=seed,
        perturbation=pert.as_dict(),
        reward_trace=reward_trace,
        box_z_trace=[round(z, 5) for z in box_z_trace],
        replay={"control_hz": CONTROL_HZ, "frame_stride": frame_stride, "frames": replay_frames},
        action_digest=action_hash.hexdigest(),
        obs_digest=obs_hash.hexdigest(),
        note=note,
    )


def _inconclusive(seed: int, pert: Perturbation, note: str, wall: float) -> EpisodeResult:
    return EpisodeResult(
        outcome="INCONCLUSIVE",
        max_reward=0,
        steps=0,
        is_success=False,
        lifted=False,
        severity=0.0,
        drop_height=0.0,
        final_box_z=TABLE_TOP_Z,
        inference_calls=0,
        inference_ms_mean=0.0,
        inference_ms_p95=0.0,
        inference_ms_first=0.0,
        inference_ms_warm_mean=0.0,
        inference_ms_warm_median=0.0,
        wall_seconds=round(wall, 2),
        seed=seed,
        perturbation=pert.as_dict(),
        reward_trace=[],
        box_z_trace=[],
        replay={"control_hz": CONTROL_HZ, "frame_stride": 0, "frames": []},
        action_digest="",
        obs_digest="",
        note=note,
    )


def _write_video(path: str, frames: list[np.ndarray]) -> None:
    import imageio.v2 as imageio

    imageio.mimwrite(path, frames, fps=10, quality=7)
