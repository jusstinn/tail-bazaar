"""Run one G1 scenario and record everything needed to verify and replay it.

Units: metres, seconds, kilograms, newtons, radians. Physics at 500 Hz (MuJoCo timestep 0.002 s),
control at 50 Hz (decimation 10), both the publisher's numbers (deploy_mujoco/configs/g1.yaml).

The control loop is a line-by-line port of Unitree's `deploy_mujoco.py` (vendored beside the policy
for comparison): at every physics step the PD torque `kp*(target - q) - kd*dq` is written to
`d.ctrl` and the simulator stepped; after every 10 steps the 47-dimensional observation is built
(base angular velocity * 0.25, projected gravity, command * [2, 2, 0.25], joint positions minus the
default angles, joint velocities * 0.05, the previous action, sin/cos of a 0.8 s gait phase clocked
from the physics-step counter), the TorchScript policy is evaluated once, and the new joint target
is `action * 0.25 + default`. The run starts from the model's own qpos0 (pelvis at 0.793 m, every
joint at zero), exactly as the publisher's runner starts it, and the LSTM memory is reset first.

What the scenario does to the run
---------------------------------
  push          a constant world-frame force of push_impulse_ns / PUSH_DURATION_S newtons, pointing
                at push_heading_deg in the horizontal plane, is written into `data.xfrc_applied`
                on the pelvis for the PUSH_DURATION_S window (5 control ticks) that starts at
                push_time_s. Applied at the body's centre of mass: a pure shove, no artificial
                torque. Outside the window the entry is zero.
  latency       the joint target computed at tick k is applied from tick k + latency/20 ms. Until
                the first target arrives the PD loop holds the publisher's default joint angles.
  actuator noise  zero-mean Gaussian noise added to each applied joint target, standard deviation
                actuator_noise_frac * 0.25 rad (0.25 rad = the policy's own action scale), drawn
                once per control tick from a generator seeded by the scenario's own commitment, so
                a scenario always replays identically. The policy's "last action" observation is
                its own clean output: the policy does not observe the injected noise or the delay,
                just as a real controller would not.
  cmd_vx_mps    the forward velocity command; lateral and yaw commands stay at 0.
  floor_friction / body_mass_scale   applied to the compiled model; see scene.py.

THE FAILURE PREDICATE IS THIS PROJECT'S — stated, because the publisher has none
------------------------------------------------------------------------------
Unitree's runner has no notion of a fall: it steps until the clock runs out. So, unlike the
Gymnasium humanoid target (whose FELL is the environment's own health flag), FELL here is a
predicate written by this project, and every run document says so:

  FELL when, at the end of any control tick,
      pelvis height  data.qpos[2]  <  FALL_HEIGHT_FRACTION * NOMINAL_PELVIS_Z_M   (0.6 * 0.77 m)
   or pelvis tilt from vertical, arccos(-g_z) with g the projected gravity the policy itself
      observes,                   >  FALL_TILT_DEG                                 (60 deg),
  whichever first. NOMINAL_PELVIS_Z_M is the MEASURED mean pelvis height of the nominal run
  between 2 s and 6 s (0.7697 m, rounded to 0.77); the fractions are choices, stated once.

The run records WHICH condition fired (`detected_by`: "pelvis_height", "tilt" or both) and when,
as the `fall_predicate_fired` event, and the thresholds themselves in `fall_predicate`.

After the predicate fires the simulation KEEPS RUNNING for POST_FALL_S so the ground impact can be
measured and the replay shows the fall. The policy keeps acting throughout; nothing is frozen.

Severity proxy (directly measured, never a damage or injury estimate)
--------------------------------------------------------------------
  pelvis_impact_speed_mps  the magnitude of the pelvis body's world-frame linear velocity at the
                           first contact between the floor and a geom that does not belong to a
                           foot body, looked for only AFTER the predicate has fired. Read with
                           `mujoco.mj_objectVelocity`, exactly as the humanoid target reads it.
  peak_pelvis_accel_mps2   the largest control-tick finite difference of that velocity after the
                           predicate fired.

Termination (first that applies): DIVERGED (non-finite state, bad-acceleration warning, |position|
> 100 m); FELL (predicate fired; continues POST_FALL_S then stops); SURVIVED (T_MAX_S = 15 s
elapsed with the predicate never firing). A run whose initial state already satisfies the predicate
or already has a non-foot geom on the floor is INVALID_INITIAL_STATE and is not executed.
"""

from __future__ import annotations

import hashlib
import math
import platform
import sys
import time
from collections import deque
from typing import Any

import mujoco
import numpy as np

from .. import canonical
from . import policy as policy_mod
from . import scene as scene_mod
from .envelope import (
    DT_CTRL_MS,
    ENVELOPE_ID,
    ENVELOPE_REVISION,
    PUSH_DURATION_S,
    TARGET_ID,
    check_admissible,
    in_published_conditions,
    normalize,
    normalize_failure_classes,
)

RUN_SCHEMA = "tb-g1-run-1"
TARGET_KIND = "pretrained_policy"
TARGET_LABEL = "Unitree G1 walking policy (unitree_rl_gym motion.pt, 12-dof MuJoCo G1)"

T_MAX_S = 15.0
POST_FALL_S = 1.2
DT_CTRL_S = DT_CTRL_MS / 1000.0
MAX_TICKS = int(round(T_MAX_S / DT_CTRL_S))          # 750
POST_FALL_TICKS = int(round(POST_FALL_S / DT_CTRL_S))  # 60
DECIMATION = scene_mod.CONTROL_DECIMATION
PHYSICS_DT_S = scene_mod.PHYSICS_TIMESTEP_S

# ---- the predicate (ours; see the module docstring) ---------------------------------------
NOMINAL_PELVIS_Z_M = 0.77
FALL_HEIGHT_FRACTION = 0.6
FALL_Z_M = round(FALL_HEIGHT_FRACTION * NOMINAL_PELVIS_Z_M, 6)  # 0.462
FALL_TILT_DEG = 60.0

# Frames are recorded at EVERY control tick (50 Hz): a 15 s episode is 751 rows of 13 bodies.
FRAME_STRIDE = 1
FRAME_PLACES = 4
FRAME_DT_S = DT_CTRL_S * FRAME_STRIDE

FAILURE_CLASS = "FELL"
SEVERITY_PROXY = "pelvis_impact_speed_mps"


def engine_info() -> dict[str, Any]:
    import torch

    return {
        "engine": "mujoco",
        "engine_version": mujoco.__version__,
        "torch_version": torch.__version__,
        "numpy_version": np.__version__,
        "python_version": sys.version.split()[0],
        "platform": f"{platform.system()}-{platform.machine()}",
        "physics_timestep_s": PHYSICS_DT_S,
        "control_dt_s": DT_CTRL_S,
        "control_decimation": DECIMATION,
        "threads": 1,
        "policy_backend": "torchscript-cpu",
    }


def fall_predicate() -> dict[str, Any]:
    """The published FELL detection rule, recorded in every run document."""
    return {
        "class": FAILURE_CLASS,
        "owner": "tail-bazaar (this project)",
        "why_ours": "Unitree's deploy_mujoco.py runner has no failure or health flag of its own; it steps until the clock runs out",
        "rule": f"FELL when pelvis height data.qpos[2] < {FALL_Z_M} m (= {FALL_HEIGHT_FRACTION} x the measured nominal standing height {NOMINAL_PELVIS_Z_M} m) OR pelvis tilt from vertical > {FALL_TILT_DEG} deg, whichever first, checked at the end of every 20 ms control tick",
        "quantities": {"pelvis_height": "the free joint's z coordinate", "tilt": "arccos(-g_z) with g the projected gravity in the pelvis frame, the same quantity the policy observes"},
        "nominal_pelvis_z_m": NOMINAL_PELVIS_Z_M,
        "nominal_pelvis_z_source": "mean pelvis height of the nominal run between 2 s and 6 s, measured once (0.7697 m) and rounded",
        "fall_height_fraction": FALL_HEIGHT_FRACTION,
        "fall_z_m": FALL_Z_M,
        "fall_tilt_deg": FALL_TILT_DEG,
        "sample_rate_hz": round(1.0 / DT_CTRL_S, 4),
        "severity_proxy": {
            "primary": SEVERITY_PROXY,
            "definition": "magnitude of the pelvis body's world-frame linear velocity at the first contact between the floor and a geom that does not belong to a foot body, after the predicate has fired",
            "secondary": "peak_pelvis_accel_mps2",
            "secondary_definition": "largest control-tick finite difference of that velocity after the predicate fired",
            "not_a_damage_estimate": True,
        },
    }


def _push_force(impulse_ns: float, heading_deg: float) -> np.ndarray:
    theta = math.radians(heading_deg)
    magnitude = impulse_ns / PUSH_DURATION_S
    return np.array([math.cos(theta) * magnitude, math.sin(theta) * magnitude, 0.0])


def _body_linvel(model, data, body_id: int) -> np.ndarray:
    res = np.zeros(6)
    mujoco.mj_objectVelocity(model, data, mujoco.mjtObj.mjOBJ_BODY, body_id, res, 0)
    return res[3:6].copy()


def _tilt_deg(quat_wxyz: np.ndarray) -> tuple[float, np.ndarray]:
    g = policy_mod.gravity_orientation(quat_wxyz)
    return math.degrees(math.acos(max(-1.0, min(1.0, -float(g[2]))))), g


def _empty_tail(result: dict[str, Any], started: float, bodies: list[str]) -> dict[str, Any]:
    result["metrics"] = {}
    result["events"] = []
    result["ticks"] = []
    result["failure_classes"] = []
    result["primary_failure_class"] = "NONE"
    result["failure_event"] = None
    result["severity"] = None
    result["frames"] = {"dt_s": FRAME_DT_S, "source_dt_s": DT_CTRL_S, "stride": FRAME_STRIDE, "places": FRAME_PLACES, "bodies": bodies, "quat_order": "wxyz", "data": []}
    result["trajectory_hash"] = canonical.commitment(result["frames"])
    result["state_hash"] = "sha256:" + hashlib.sha256(b"").hexdigest()
    result["wall_time_s"] = round(time.perf_counter() - started, 4)
    return result


def run_scenario(scenario: dict[str, Any], record_frames: bool = True) -> dict[str, Any]:
    problems = check_admissible(scenario)
    scn = normalize(scenario) if not problems else dict(scenario)
    started = time.perf_counter()

    pol = policy_mod.load_policy()
    result: dict[str, Any] = {
        "schema": RUN_SCHEMA,
        "target_id": TARGET_ID,
        "target_kind": TARGET_KIND,
        "target_label": TARGET_LABEL,
        "envelope_id": ENVELOPE_ID,
        "envelope_revision": ENVELOPE_REVISION,
        "scenario": scn,
        "admissible": not problems,
        "admissibility_problems": problems,
        "target": {
            "target_id": TARGET_ID,
            "kind": TARGET_KIND,
            "label": TARGET_LABEL,
            "policy": pol.identity(),
            "trained_by": "Unitree Robotics (the policy's publisher); nothing in this project trains or fine-tunes anything",
        },
        "engine": engine_info(),
    }
    if problems:
        result["outcome"] = "REJECTED_OUT_OF_ENVELOPE"
        result["scene"] = None
        result["fall_predicate"] = None
        result["published_conditions"] = None
        return _empty_tail(result, started, [])

    model, data = scene_mod.make_model(scn["floor_friction"], scn["body_mass_scale"])
    bodies = scene_mod.body_names(model)
    body_ids = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, b) for b in bodies]
    pelvis_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, scene_mod.PUSH_BODY)
    floor_gid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, scene_mod.FLOOR_GEOM)
    foot_bids = {mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, b) for b in scene_mod.FOOT_BODIES}

    result["scene"] = scene_mod.scene_description(model, scn["floor_friction"], scn["body_mass_scale"])
    result["fall_predicate"] = fall_predicate()
    result["published_conditions"] = {
        "per_axis_inside": in_published_conditions(scn),
        "prose": "conditions the policy's publisher deploys it under; None means the publisher states nothing about that axis",
    }
    result["termination_rules"] = {
        "t_max_s": T_MAX_S,
        "max_control_ticks": MAX_TICKS,
        "post_fall_s": POST_FALL_S,
        "push_duration_s": PUSH_DURATION_S,
        "control_dt_s": DT_CTRL_S,
        "physics_timestep_s": PHYSICS_DT_S,
        "control_decimation": DECIMATION,
    }

    env_problems = scene_mod.check_model(model)
    if env_problems:
        result["outcome"] = "INVALID_INITIAL_STATE"
        result["initial_state_check"] = {"ok": False, "environment_problems": env_problems}
        return _empty_tail(result, started, bodies)

    # --- initial state: the model's own qpos0, as the publisher's runner starts it ---------------
    mujoco.mj_resetData(model, data)
    mujoco.mj_forward(model, data)
    nonfoot_ground_at_start = 0
    for i in range(data.ncon):
        c = data.contact[i]
        g1, g2 = int(c.geom1), int(c.geom2)
        if floor_gid in (g1, g2):
            other = g2 if g1 == floor_gid else g1
            if int(model.geom_bodyid[other]) not in foot_bids:
                nonfoot_ground_at_start += 1
    tilt0, _ = _tilt_deg(data.qpos[3:7])
    z0 = float(data.qpos[2])
    initial_check = {
        "ok": z0 >= FALL_Z_M and tilt0 <= FALL_TILT_DEG and nonfoot_ground_at_start == 0,
        "pelvis_z0_m": round(z0, 6),
        "tilt0_deg": round(tilt0, 6),
        "non_foot_ground_contacts_at_reset": nonfoot_ground_at_start,
        "initial_state": "the model's qpos0 (pelvis at 0.793 m, joints at zero), as deploy_mujoco.py starts it; the LSTM memory reset to zero",
    }
    result["initial_state"] = {
        "qpos": canonical.quantize(data.qpos.tolist()),
        "qvel": canonical.quantize(data.qvel.tolist()),
        "total_mass_kg": round(float(model.body_mass.sum()), 4),
    }
    result["initial_state_check"] = initial_check
    if not initial_check["ok"]:
        result["outcome"] = "INVALID_INITIAL_STATE"
        return _empty_tail(result, started, bodies)

    # --- scenario-derived, reproducible randomness ---------------------------------------------
    noise_seed_hex = canonical.commitment(scn)[2:18]
    rng = np.random.default_rng(int(noise_seed_hex, 16))
    noise_std = float(scn["actuator_noise_frac"]) * policy_mod.ACTION_SCALE

    latency_ticks = int(scn["control_latency_ms"]) // DT_CTRL_MS
    target_buf: deque[np.ndarray] = deque()

    push_force = _push_force(float(scn["push_impulse_ns"]), float(scn["push_heading_deg"]))
    push_k0 = int(round(float(scn["push_time_s"]) / DT_CTRL_S))
    push_k1 = push_k0 + int(round(PUSH_DURATION_S / DT_CTRL_S))
    pushing = float(scn["push_impulse_ns"]) > 0.0
    cmd = np.array([float(scn["cmd_vx_mps"]), 0.0, 0.0], dtype=np.float32)

    pol.reset()
    action = np.zeros(policy_mod.NUM_ACTIONS, dtype=np.float32)
    default = policy_mod.DEFAULT_ANGLES.copy()
    applied_target = default.copy()
    counter = 0

    frames: list[list[float]] = []
    ticks: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    state_hasher = hashlib.sha256()

    def record_frame(t: float) -> None:
        if not record_frames:
            return
        row: list[float] = [round(t, 6)]
        for b in body_ids:
            row.extend(round(float(x), FRAME_PLACES) for x in data.xpos[b])
            row.extend(round(float(x), FRAME_PLACES) for x in data.xquat[b])
        frames.append(row)

    fell_tick: int | None = None
    fall_t: float | None = None
    fall_z: float | None = None
    fall_tilt: float | None = None
    fall_speed: float | None = None
    fall_by: str | None = None
    impact_t: float | None = None
    impact_body: str | None = None
    impact_speed: float | None = None
    impact_z: float | None = None
    peak_accel = 0.0
    pelvis_min_z = math.inf
    max_tilt = 0.0
    pelvis_max_speed = 0.0
    diverged_reason: str | None = None
    outcome = "SURVIVED"
    v_prev = _body_linvel(model, data, pelvis_id)
    x_start = float(data.qpos[0])
    last_tick = MAX_TICKS

    for tick in range(MAX_TICKS + POST_FALL_TICKS + 1):
        t = tick * DT_CTRL_S
        if tick % FRAME_STRIDE == 0:
            record_frame(t)
        state_hasher.update(np.ascontiguousarray(data.qpos, dtype=np.float64).tobytes())
        state_hasher.update(np.ascontiguousarray(data.qvel, dtype=np.float64).tobytes())

        pelvis_z = float(data.qpos[2])
        tilt, grav = _tilt_deg(data.qpos[3:7])
        pelvis_min_z = min(pelvis_min_z, pelvis_z)
        max_tilt = max(max_tilt, tilt)
        v_now = _body_linvel(model, data, pelvis_id)
        speed = float(np.linalg.norm(v_now))
        pelvis_max_speed = max(pelvis_max_speed, speed)
        if fell_tick is not None:
            peak_accel = max(peak_accel, float(np.linalg.norm(v_now - v_prev)) / DT_CTRL_S)
        v_prev = v_now

        stop_now = (fell_tick is not None and tick - fell_tick >= POST_FALL_TICKS) or tick >= MAX_TICKS + POST_FALL_TICKS
        if tick >= MAX_TICKS and fell_tick is None:
            last_tick = tick
            break
        if stop_now:
            last_tick = tick
            break

        # --- external push ----------------------------------------------------------------------
        push_on = pushing and push_k0 <= tick < push_k1
        data.xfrc_applied[pelvis_id, :3] = push_force if push_on else 0.0
        if pushing and tick == push_k0:
            events.append({
                "t_s": round(t, 6), "type": "push_start",
                "impulse_ns": round(float(scn["push_impulse_ns"]), 6),
                "heading_deg": round(float(scn["push_heading_deg"]), 6),
                "force_n": [round(float(x), 6) for x in push_force],
                "duration_s": PUSH_DURATION_S,
                "pelvis_z_m": round(pelvis_z, 6), "pelvis_speed_mps": round(speed, 6),
            })
        if pushing and tick == push_k1:
            events.append({"t_s": round(t, 6), "type": "push_end", "pelvis_z_m": round(pelvis_z, 6), "pelvis_speed_mps": round(speed, 6)})

        # --- ten physics steps under the current (delayed, noisy) joint target ------------------
        for _ in range(DECIMATION):
            q = data.qpos[7:]
            dq = data.qvel[6:]
            data.ctrl[:] = policy_mod.pd_torque(applied_target, q, dq)
            mujoco.mj_step(model, data)
            counter += 1

        # --- the policy, exactly where deploy_mujoco.py evaluates it ---------------------------
        obs = np.zeros(policy_mod.NUM_OBS, dtype=np.float32)
        obs[0:3] = data.qvel[3:6] * policy_mod.ANG_VEL_SCALE
        obs[3:6] = policy_mod.gravity_orientation(data.qpos[3:7])
        obs[6:9] = cmd * policy_mod.CMD_SCALE
        obs[9:21] = (data.qpos[7:] - default) * policy_mod.DOF_POS_SCALE
        obs[21:33] = data.qvel[6:] * policy_mod.DOF_VEL_SCALE
        obs[33:45] = action
        phase = (counter * PHYSICS_DT_S) % policy_mod.GAIT_PERIOD_S / policy_mod.GAIT_PERIOD_S
        obs[45] = math.sin(2 * math.pi * phase)
        obs[46] = math.cos(2 * math.pi * phase)
        action = pol.action(obs)
        target = (action * policy_mod.ACTION_SCALE + default).astype(np.float32)

        # --- latency (zero-order hold on the target) and target noise ---------------------------
        target_buf.append(target)
        if len(target_buf) > latency_ticks + 1:
            target_buf.popleft()
        applied_target = target_buf[0].copy() if len(target_buf) == latency_ticks + 1 else default.copy()
        if noise_std > 0.0:
            applied_target = (applied_target + rng.normal(0.0, noise_std, size=applied_target.shape)).astype(np.float32)

        # --- the predicate (ours), at the end of the tick ---------------------------------------
        z_now = float(data.qpos[2])
        tilt_now, _ = _tilt_deg(data.qpos[3:7])
        if fell_tick is None and (z_now < FALL_Z_M or tilt_now > FALL_TILT_DEG):
            fell_tick = tick + 1
            fall_t = (tick + 1) * DT_CTRL_S
            fall_z = z_now
            fall_tilt = tilt_now
            fall_speed = float(np.linalg.norm(_body_linvel(model, data, pelvis_id)))
            by = []
            if z_now < FALL_Z_M:
                by.append("pelvis_height")
            if tilt_now > FALL_TILT_DEG:
                by.append("tilt")
            fall_by = "+".join(by)
            outcome = "FELL"
            events.append({
                "t_s": round(fall_t, 6), "type": "fall_predicate_fired",
                "detected_by": fall_by,
                "owner": "tail-bazaar (this project's predicate; the publisher has none)",
                "pelvis_z_m": round(fall_z, 6), "fall_z_m": FALL_Z_M,
                "tilt_deg": round(fall_tilt, 6), "fall_tilt_deg": FALL_TILT_DEG,
                "pelvis_speed_mps": round(fall_speed, 6),
                "t_since_push_s": None if not pushing else round(fall_t - push_k0 * DT_CTRL_S, 6),
            })

        # --- ground contact of something that is not a foot, only after the predicate -----------
        if impact_t is None and fell_tick is not None:
            for i in range(data.ncon):
                c = data.contact[i]
                g1, g2 = int(c.geom1), int(c.geom2)
                if floor_gid not in (g1, g2):
                    continue
                other = g2 if g1 == floor_gid else g1
                ob = int(model.geom_bodyid[other])
                if ob in foot_bids:
                    continue
                impact_t = float(data.time)
                impact_body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, ob)
                impact_speed = float(np.linalg.norm(_body_linvel(model, data, pelvis_id)))
                impact_z = float(data.qpos[2])
                events.append({
                    "t_s": round(impact_t, 6), "type": "ground_contact",
                    "body": impact_body, "geom_index": other,
                    "pelvis_impact_speed_mps": round(impact_speed, 6),
                    "pelvis_z_m": round(impact_z, 6),
                    "after_fall_predicate": True,
                })
                break

        if not np.all(np.isfinite(data.qpos)) or not np.all(np.isfinite(data.qvel)):
            diverged_reason = "non-finite state"
        elif data.warning[mujoco.mjtWarning.mjWARN_BADQACC].number > 0:
            diverged_reason = "mujoco bad qacc warning"
        elif float(np.abs(data.qpos[:3]).max()) > 100.0:
            diverged_reason = "position out of bounds"

        if tick % FRAME_STRIDE == 0:
            ticks.append({
                "t_s": round(t, 6),
                "pelvis_z_m": round(pelvis_z, 6),
                "tilt_deg": round(tilt, 4),
                "pelvis_speed_mps": round(speed, 6),
                "push_on": bool(push_on),
                "fell": fell_tick is not None,
                "action_l2": round(float(np.linalg.norm(action)), 6),
            })

        if diverged_reason is not None:
            outcome = "DIVERGED"
            events.append({"t_s": round(float(data.time), 6), "type": "diverged", "reason": diverged_reason})
            last_tick = tick + 1
            break

    data.xfrc_applied[pelvis_id, :3] = 0.0
    if record_frames and (not frames or frames[-1][0] != round(last_tick * DT_CTRL_S, 6)):
        record_frame(last_tick * DT_CTRL_S)

    classes = normalize_failure_classes([FAILURE_CLASS] if outcome == "FELL" else [])
    primary = FAILURE_CLASS if classes else "NONE"
    survived_s = fall_t if fall_t is not None else last_tick * DT_CTRL_S
    x_travelled = float(data.qpos[0]) - x_start

    metrics: dict[str, Any] = {
        "outcome": outcome,
        "failure_class_set": "+".join(classes) if classes else "NONE",
        "primary_failure_class": primary,
        "fell": outcome == "FELL",
        "fall_detected_by": fall_by,
        "fall_time_s": None if fall_t is None else round(fall_t, 6),
        "survival_time_s": round(survived_s, 6),
        "survival_fraction_of_episode": round(survived_s / T_MAX_S, 6),
        "control_ticks": last_tick,
        "sim_steps": last_tick * DECIMATION,
        "duration_s": round(float(data.time), 6),
        "pelvis_min_z_m": None if pelvis_min_z == math.inf else round(pelvis_min_z, 6),
        "pelvis_z_at_fall_m": None if fall_z is None else round(fall_z, 6),
        "tilt_at_fall_deg": None if fall_tilt is None else round(fall_tilt, 6),
        "max_tilt_deg": round(max_tilt, 6),
        "pelvis_speed_at_fall_mps": None if fall_speed is None else round(fall_speed, 6),
        "pelvis_max_speed_mps": round(pelvis_max_speed, 6),
        "distance_travelled_x_m": round(x_travelled, 6),
        "mean_forward_speed_mps": round(x_travelled / survived_s, 6) if survived_s > 0 else 0.0,
        "commanded_forward_speed_mps": round(float(scn["cmd_vx_mps"]), 6),
        # --- severity proxies, both directly measured -----------------------------------------
        "pelvis_impact_speed_mps": None if impact_speed is None else round(impact_speed, 6),
        "ground_contact_t_s": None if impact_t is None else round(impact_t, 6),
        "ground_contact_body": impact_body,
        "peak_pelvis_accel_mps2": None if fell_tick is None else round(peak_accel, 6),
        # --- provenance of the verdict ---------------------------------------------------------
        "fall_predicate_owner": "tail-bazaar",
        "push_applied": pushing,
        "push_impulse_ns": round(float(scn["push_impulse_ns"]), 6),
        "actuator_noise_std_rad": round(noise_std, 6),
        "control_latency_ticks": latency_ticks,
    }

    result["outcome"] = outcome
    result["failure_classes"] = classes
    result["primary_failure_class"] = primary
    result["conclusive"] = outcome in ("SURVIVED", "FELL")
    result["failure_event"] = None if fall_t is None else {
        "class": FAILURE_CLASS,
        "t_s": round(fall_t, 6),
        "detected_by": f"tail-bazaar fall predicate ({fall_by})",
        "pelvis_z_m": round(fall_z, 6),
        "tilt_deg": round(fall_tilt, 6),
        "fall_z_m": FALL_Z_M,
        "fall_tilt_deg": FALL_TILT_DEG,
        "pelvis_speed_mps": round(fall_speed, 6),
        "ground_contact_t_s": None if impact_t is None else round(impact_t, 6),
        "ground_contact_body": impact_body,
    }
    result["severity"] = None if fall_t is None else {
        "proxy": SEVERITY_PROXY,
        "value": None if impact_speed is None else round(impact_speed, 6),
        "units": "m/s",
        "secondary_proxy": "peak_pelvis_accel_mps2",
        "secondary_value": round(peak_accel, 6),
        "secondary_units": "m/s^2",
        "measured": True,
        "not_a_damage_estimate": True,
    }
    result["metrics"] = metrics
    result["events"] = events
    result["ticks"] = ticks
    result["frames"] = {
        "dt_s": FRAME_DT_S, "source_dt_s": DT_CTRL_S, "stride": FRAME_STRIDE, "places": FRAME_PLACES,
        "bodies": bodies, "quat_order": "wxyz", "data": frames,
    }
    result["trajectory_hash"] = canonical.commitment(result["frames"])
    result["state_hash"] = "sha256:" + state_hasher.hexdigest()
    result["noise_seed"] = "0x" + noise_seed_hex
    result["wall_time_s"] = round(time.perf_counter() - started, 4)
    return result


def summarize(res: dict[str, Any]) -> str:
    m = res.get("metrics", {})
    s = res["scenario"]
    parts = [
        f"{res['outcome']:<9}",
        f"push={s.get('push_impulse_ns')}Ns@{s.get('push_heading_deg')}deg,t={s.get('push_time_s')}s "
        f"mu={s.get('floor_friction')} mass={s.get('body_mass_scale')} noise={s.get('actuator_noise_frac')} "
        f"lat={s.get('control_latency_ms')}ms vx={s.get('cmd_vx_mps')}",
    ]
    if m:
        parts.append(f"survive={m['survival_time_s']:.2f}s")
        parts.append(f"x={m['distance_travelled_x_m']:.2f}m")
        if m.get("fall_time_s") is not None:
            parts.append(f"fell@{m['fall_time_s']:.2f}s({m['fall_detected_by']},z={m['pelvis_z_at_fall_m']:.3f},tilt={m['tilt_at_fall_deg']:.0f})")
            if m.get("pelvis_impact_speed_mps") is not None:
                parts.append(f"impact={m['pelvis_impact_speed_mps']:.3f}m/s")
        else:
            parts.append(f"minz={m['pelvis_min_z_m']:.3f} maxtilt={m['max_tilt_deg']:.1f}")
        parts.append(f"wall={res['wall_time_s']:.2f}s")
    return " ".join(parts)
