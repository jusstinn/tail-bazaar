"""Run one humanoid scenario and record everything needed to verify and replay it.

Units: metres, seconds, kilograms, newtons, radians. Physics at 333.3 Hz (MuJoCo timestep
0.003 s), control at 66.67 Hz (frame_skip 5), both Gymnasium's, not ours.

What the scenario does to the run
---------------------------------
  push          a constant world-frame force of push_impulse_ns / PUSH_DURATION_S newtons,
                pointing at push_heading_deg in the horizontal plane, is written into
                `data.xfrc_applied` on the torso for the PUSH_DURATION_S window that starts
                at push_time_s. The force is applied at the torso's centre of mass, so it is
                a pure shove and adds no artificial torque. Outside the window the entry is
                zero; nothing else is ever written to xfrc_applied.
  latency       the action computed at tick k is applied from tick k + latency/15 ms. Until
                the first action arrives the actuators hold zero torque (zero-order hold).
  actuator noise  zero-mean Gaussian noise is added to each applied action, with standard
                deviation actuator_noise_frac * 0.4 (0.4 = half the width of the actuator's
                own [-0.4, 0.4] control range), drawn once per control tick and then clipped
                back into the control range. The generator is seeded from the scenario's own
                canonical commitment, so a scenario always replays identically.
  floor_friction / body_mass_scale   applied to the compiled model; see scene.py.

The failure class is the ENVIRONMENT's, not ours
------------------------------------------------
FELL is `terminated` as returned by `HumanoidEnv.step`, which Gymnasium computes from its own
`is_healthy` property: the torso height `data.qpos[2]` left `healthy_z_range` = (1.0, 2.0) m.
This module does not implement a fall detector. It records the flag, and at every tick it
cross-checks that `terminated == (not env.is_healthy)`; the cross-check result is published in
the run document, so a reader can see the flag was taken from the environment and not derived.

After the predicate fires the simulation KEEPS RUNNING for POST_FALL_S so the ground impact can
be measured and so the replay shows the fall rather than cutting to black at the moment the
torso drops below 1 m. The policy keeps acting throughout; nothing is frozen or scripted.

Severity proxy (directly measured, never a damage or injury estimate)
--------------------------------------------------------------------
  torso_impact_speed_mps   the magnitude of the torso body's linear velocity in the world
                           frame at the first contact between the floor and a geom that is not
                           a foot, looked for only AFTER the health predicate has fired: a
                           running humanoid brushes the floor with a hand now and then, so that
                           contact is only the fall's impact once the environment has already
                           declared the torso unhealthy. Read with `mujoco.mj_objectVelocity`.
  peak_torso_accel_mps2    the largest control-tick finite difference |v_k - v_(k-1)| / dt of
                           that same velocity after the predicate fires.
No monetary value, damage estimate or injury tier is attached anywhere.

Termination (first that applies):
  DIVERGED                 non-finite state, a MuJoCo bad-acceleration warning, or |position|
                           > 100 m
  FELL                     the environment's health predicate fired; the run continues
                           POST_FALL_S past that moment and then stops
  SURVIVED                 T_MAX_S (15.0 s = the 1000 control ticks Gymnasium registers as
                           this environment's episode limit) elapsed with the predicate never
                           firing
An initial state that is already unhealthy, or already has a non-foot geom on the floor, is
INVALID_INITIAL_STATE and the run is not executed.

Outcomes other than SURVIVED / FELL are inconclusive for the marketplace.
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

RUN_SCHEMA = "tb-humanoid-run-1"
TARGET_KIND = "pretrained_policy"
TARGET_LABEL = "Humanoid balance policy (SAC, Gymnasium Humanoid-v5)"

T_MAX_S = 15.0                     # 1000 control ticks: Gymnasium's registered episode limit
POST_FALL_S = 1.2                  # keep simulating past the predicate so the impact is measured
DT_CTRL_S = DT_CTRL_MS / 1000.0
MAX_TICKS = int(round(T_MAX_S / DT_CTRL_S))
POST_FALL_TICKS = int(round(POST_FALL_S / DT_CTRL_S))
ACTION_HALF_RANGE = 0.4            # half the width of the humanoid's [-0.4, 0.4] control range

# Frame payload: the control rate is 66.67 Hz and a 15 s episode is 1000 ticks. Recording every
# tick at full precision would be ~1 MB of JSON per run for a viewer that cannot show 66 Hz
# anyway, so frames are decimated by FRAME_STRIDE (to 33.3 Hz) and coordinates are rounded to
# FRAME_PLACES decimals: 0.1 mm on positions and ~0.01 deg on unit quaternions, both far below
# what a replay can resolve. The decimation is declared in the frames block (`dt_s`,
# `source_dt_s`, `stride`) so a consumer never has to guess it.
FRAME_STRIDE = 2
FRAME_PLACES = 4
FRAME_DT_S = DT_CTRL_S * FRAME_STRIDE

FAILURE_CLASS = "FELL"
SEVERITY_PROXY = "torso_impact_speed_mps"


def engine_info() -> dict[str, Any]:
    import gymnasium

    return {
        "engine": "mujoco",
        "engine_version": mujoco.__version__,
        "gymnasium_version": gymnasium.__version__,
        "numpy_version": np.__version__,
        "python_version": sys.version.split()[0],
        "platform": f"{platform.system()}-{platform.machine()}",
        "physics_timestep_s": scene_mod.EXPECTED_TIMESTEP_S,
        "control_dt_s": DT_CTRL_S,
        "frame_skip": scene_mod.EXPECTED_FRAME_SKIP,
        "threads": 1,
        "policy_backend": "numpy",
    }


def health_predicate(env) -> dict[str, Any]:
    """The published FELL detection rule, recorded in every run document."""
    return {
        "class": FAILURE_CLASS,
        "owner": "gymnasium",
        "source": "gymnasium.envs.mujoco.humanoid_v5.HumanoidEnv.is_healthy, via the `terminated` flag returned by env.step",
        "rule": "terminated when NOT (min_z < data.qpos[2] < max_z)",
        "quantity": "torso height, the free joint's z coordinate",
        "healthy_z_range_m": [float(x) for x in env._healthy_z_range],
        "terminate_when_unhealthy": bool(env._terminate_when_unhealthy),
        "sample_rate_hz": round(1.0 / DT_CTRL_S, 4),
        "no_bespoke_detector": "this project implements no fall detector of its own; it records the environment's flag",
        "severity_proxy": {
            "primary": SEVERITY_PROXY,
            "definition": (
                "magnitude of the torso body's world-frame linear velocity at the first contact between "
                "the floor and a geom that is not a foot, after the health predicate has fired"
            ),
            "secondary": "peak_torso_accel_mps2",
            "secondary_definition": (
                "largest control-tick finite difference of that velocity after the predicate fired"
            ),
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


def _empty_tail(result: dict[str, Any], started: float, bodies: list[str]) -> dict[str, Any]:
    result["metrics"] = {}
    result["events"] = []
    result["ticks"] = []
    result["failure_classes"] = []
    result["primary_failure_class"] = "NONE"
    result["failure_event"] = None
    result["severity"] = None
    result["frames"] = {
        "dt_s": FRAME_DT_S,
        "source_dt_s": DT_CTRL_S,
        "stride": FRAME_STRIDE,
        "places": FRAME_PLACES,
        "bodies": bodies,
        "quat_order": "wxyz",
        "data": [],
    }
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
        # --- explicit, top-level identity so a viewer can render this without special-casing ---
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
            "trained_by": "the policy's publisher; nothing in this project trains or fine-tunes anything",
        },
        "engine": engine_info(),
    }
    if problems:
        result["outcome"] = "REJECTED_OUT_OF_ENVELOPE"
        result["scene"] = None
        result["health_predicate"] = None
        result["published_conditions"] = None
        return _empty_tail(result, started, [])

    env = scene_mod.make_env(scn["floor_friction"], scn["body_mass_scale"])
    model, data = env.model, env.data
    bodies = scene_mod.body_names(model)
    body_ids = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, b) for b in bodies]
    torso_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, scene_mod.PUSH_BODY)
    floor_gid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, scene_mod.FLOOR_GEOM)
    foot_gids = {mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, g) for g in scene_mod.FOOT_GEOMS}

    result["scene"] = scene_mod.scene_description(env, model, scn["floor_friction"], scn["body_mass_scale"])
    result["health_predicate"] = health_predicate(env)
    result["published_conditions"] = {
        "per_axis_inside": in_published_conditions(scn),
        "prose": "conditions the policy's publisher evaluated it under; None means the publisher states nothing about that axis",
    }
    result["termination_rules"] = {
        "t_max_s": T_MAX_S,
        "max_control_ticks": MAX_TICKS,
        "post_fall_s": POST_FALL_S,
        "push_duration_s": PUSH_DURATION_S,
        "control_dt_s": DT_CTRL_S,
    }

    env_problems = scene_mod.check_environment(env, model)
    if env_problems:
        result["outcome"] = "INVALID_INITIAL_STATE"
        result["initial_state_check"] = {"ok": False, "environment_problems": env_problems}
        return _empty_tail(result, started, bodies)

    obs, _reset_info = env.reset(seed=int(scn["init_seed"]))
    if obs.shape[0] != pol.obs_dim:
        result["outcome"] = "INVALID_INITIAL_STATE"
        result["initial_state_check"] = {
            "ok": False,
            "environment_problems": [f"observation dim {obs.shape[0]} != policy input dim {pol.obs_dim}"],
        }
        return _empty_tail(result, started, bodies)

    low = np.asarray(env.action_space.low, dtype=np.float32)
    high = np.asarray(env.action_space.high, dtype=np.float32)

    # --- initial state validity ---------------------------------------------------
    nonfoot_ground_at_start = 0
    for i in range(data.ncon):
        c = data.contact[i]
        g1, g2 = int(c.geom1), int(c.geom2)
        if floor_gid in (g1, g2):
            other = g2 if g1 == floor_gid else g1
            if other not in foot_gids:
                nonfoot_ground_at_start += 1
    initial_check = {
        "ok": bool(env.is_healthy) and nonfoot_ground_at_start == 0,
        "healthy_at_reset": bool(env.is_healthy),
        "torso_z0_m": round(float(data.qpos[2]), 6),
        "non_foot_ground_contacts_at_reset": nonfoot_ground_at_start,
        "init_seed": int(scn["init_seed"]),
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

    # --- scenario-derived, reproducible randomness --------------------------------
    noise_seed_hex = canonical.commitment(scn)[2:18]
    rng = np.random.default_rng(int(noise_seed_hex, 16))
    noise_std = float(scn["actuator_noise_frac"]) * ACTION_HALF_RANGE

    latency_ticks = int(scn["control_latency_ms"]) // DT_CTRL_MS
    cmd_buf: deque[np.ndarray] = deque()

    push_force = _push_force(float(scn["push_impulse_ns"]), float(scn["push_heading_deg"]))
    push_k0 = int(round(float(scn["push_time_s"]) / DT_CTRL_S))
    push_k1 = push_k0 + int(round(PUSH_DURATION_S / DT_CTRL_S))
    pushing = float(scn["push_impulse_ns"]) > 0.0

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
    fall_torso_z: float | None = None
    fall_torso_speed: float | None = None
    impact_t: float | None = None
    impact_geom: str | None = None
    impact_speed: float | None = None
    impact_torso_z: float | None = None
    peak_accel = 0.0
    torso_min_z = math.inf
    torso_max_speed = 0.0
    episode_return = 0.0
    return_until_fall = 0.0
    predicate_mismatches = 0
    diverged_reason: str | None = None
    outcome = "SURVIVED"
    v_prev = _body_linvel(model, data, torso_id)
    x_start = float(data.qpos[0])

    last_tick = MAX_TICKS
    for tick in range(MAX_TICKS + POST_FALL_TICKS + 1):
        t = tick * DT_CTRL_S
        if tick % FRAME_STRIDE == 0:
            record_frame(t)
        state_hasher.update(np.ascontiguousarray(data.qpos, dtype=np.float64).tobytes())
        state_hasher.update(np.ascontiguousarray(data.qvel, dtype=np.float64).tobytes())

        torso_z = float(data.qpos[2])
        torso_min_z = min(torso_min_z, torso_z)
        v_now = _body_linvel(model, data, torso_id)
        speed = float(np.linalg.norm(v_now))
        torso_max_speed = max(torso_max_speed, speed)
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

        # --- control, with latency and actuator noise -----------------------------
        action = pol.action(obs, low, high)
        cmd_buf.append(action)
        if len(cmd_buf) > latency_ticks + 1:
            cmd_buf.popleft()
        applied = cmd_buf[0] if len(cmd_buf) == latency_ticks + 1 else np.zeros_like(action)
        if noise_std > 0.0:
            applied = applied + rng.normal(0.0, noise_std, size=applied.shape)
        applied = np.clip(applied, low, high).astype(np.float64)

        # --- external push ---------------------------------------------------------
        push_on = pushing and push_k0 <= tick < push_k1
        data.xfrc_applied[torso_id, :3] = push_force if push_on else 0.0
        if pushing and tick == push_k0:
            events.append({
                "t_s": round(t, 6), "type": "push_start",
                "impulse_ns": round(float(scn["push_impulse_ns"]), 6),
                "heading_deg": round(float(scn["push_heading_deg"]), 6),
                "force_n": [round(float(x), 6) for x in push_force],
                "duration_s": PUSH_DURATION_S,
                "torso_z_m": round(torso_z, 6),
                "torso_speed_mps": round(speed, 6),
            })
        if pushing and tick == push_k1:
            events.append({"t_s": round(t, 6), "type": "push_end", "torso_z_m": round(torso_z, 6),
                           "torso_speed_mps": round(speed, 6)})

        obs, reward, terminated, _truncated, _info = env.step(applied)
        episode_return += float(reward)
        if fell_tick is None:
            return_until_fall = episode_return

        # The environment's own predicate, cross-checked against the environment's own property.
        if bool(terminated) != (not bool(env.is_healthy)):
            predicate_mismatches += 1
        if terminated and fell_tick is None:
            fell_tick = tick + 1
            fall_t = (tick + 1) * DT_CTRL_S
            fall_torso_z = float(data.qpos[2])
            fall_torso_speed = float(np.linalg.norm(_body_linvel(model, data, torso_id)))
            outcome = "FELL"
            events.append({
                "t_s": round(fall_t, 6), "type": "health_predicate_fired",
                "detected_by": "gymnasium HumanoidEnv terminated flag (torso z outside healthy_z_range)",
                "torso_z_m": round(fall_torso_z, 6),
                "healthy_z_range_m": [float(x) for x in env._healthy_z_range],
                "torso_speed_mps": round(fall_torso_speed, 6),
                "t_since_push_s": None if not pushing else round(fall_t - push_k0 * DT_CTRL_S, 6),
            })

        # --- ground contact of something that is not a foot ------------------------
        # Only looked for AFTER the health predicate has fired. A running humanoid brushes the
        # floor with a hand now and then, so "first non-foot ground contact" is only the fall's
        # impact once the environment has already declared the torso unhealthy.
        if impact_t is None and fell_tick is not None:
            for i in range(data.ncon):
                c = data.contact[i]
                g1, g2 = int(c.geom1), int(c.geom2)
                if floor_gid not in (g1, g2):
                    continue
                other = g2 if g1 == floor_gid else g1
                if other in foot_gids:
                    continue
                impact_t = float(data.time)
                impact_geom = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, other)
                impact_speed = float(np.linalg.norm(_body_linvel(model, data, torso_id)))
                impact_torso_z = float(data.qpos[2])
                events.append({
                    "t_s": round(impact_t, 6), "type": "ground_contact",
                    "geom": impact_geom,
                    "torso_impact_speed_mps": round(impact_speed, 6),
                    "torso_z_m": round(impact_torso_z, 6),
                    "after_health_predicate": fell_tick is not None,
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
                "torso_z_m": round(torso_z, 6),
                "torso_speed_mps": round(speed, 6),
                "reward": round(float(reward), 6),
                "push_on": bool(push_on),
                "fell": fell_tick is not None,
                "action_l2": round(float(np.linalg.norm(applied)), 6),
            })

        if diverged_reason is not None:
            outcome = "DIVERGED"
            events.append({"t_s": round(float(data.time), 6), "type": "diverged", "reason": diverged_reason})
            last_tick = tick + 1
            break
    else:
        last_tick = MAX_TICKS + POST_FALL_TICKS

    data.xfrc_applied[torso_id, :3] = 0.0
    if record_frames and (not frames or frames[-1][0] != round(last_tick * DT_CTRL_S, 6)):
        record_frame(last_tick * DT_CTRL_S)

    classes = normalize_failure_classes([FAILURE_CLASS] if outcome == "FELL" else [])
    primary = FAILURE_CLASS if classes else "NONE"
    survived_s = (fall_t if fall_t is not None else last_tick * DT_CTRL_S)

    metrics: dict[str, Any] = {
        "outcome": outcome,
        "failure_class_set": "+".join(classes) if classes else "NONE",
        "primary_failure_class": primary,
        "fell": outcome == "FELL",
        "fall_time_s": None if fall_t is None else round(fall_t, 6),
        "survival_time_s": round(survived_s, 6),
        "survival_fraction_of_episode": round(survived_s / T_MAX_S, 6),
        "episode_return": round(episode_return, 4),
        "return_until_fall": round(return_until_fall, 4),
        "control_ticks": last_tick,
        "sim_steps": last_tick * scene_mod.EXPECTED_FRAME_SKIP,
        "duration_s": round(float(data.time), 6),
        "torso_min_z_m": None if torso_min_z == math.inf else round(torso_min_z, 6),
        "torso_z_at_fall_m": None if fall_torso_z is None else round(fall_torso_z, 6),
        "torso_speed_at_fall_mps": None if fall_torso_speed is None else round(fall_torso_speed, 6),
        "torso_max_speed_mps": round(torso_max_speed, 6),
        "distance_travelled_x_m": round(float(data.qpos[0]) - x_start, 6),
        # --- severity proxies, both directly measured ------------------------------
        "torso_impact_speed_mps": None if impact_speed is None else round(impact_speed, 6),
        "ground_contact_t_s": None if impact_t is None else round(impact_t, 6),
        "ground_contact_geom": impact_geom,
        "peak_torso_accel_mps2": None if fell_tick is None else round(peak_accel, 6),
        # --- provenance of the verdict ---------------------------------------------
        "health_predicate_mismatches": predicate_mismatches,
        "push_applied": pushing,
        "push_impulse_ns": round(float(scn["push_impulse_ns"]), 6),
        "actuator_noise_std": round(noise_std, 6),
        "control_latency_ticks": latency_ticks,
    }

    result["outcome"] = outcome
    result["failure_classes"] = classes
    result["primary_failure_class"] = primary
    result["conclusive"] = outcome in ("SURVIVED", "FELL")
    result["failure_event"] = None if fall_t is None else {
        "class": FAILURE_CLASS,
        "t_s": round(fall_t, 6),
        "detected_by": "gymnasium HumanoidEnv health predicate",
        "torso_z_m": round(fall_torso_z, 6),
        "healthy_z_range_m": [float(x) for x in env._healthy_z_range],
        "torso_speed_mps": round(fall_torso_speed, 6),
        "ground_contact_t_s": None if impact_t is None else round(impact_t, 6),
        "ground_contact_geom": impact_geom,
    }
    result["severity"] = None if fall_t is None else {
        "proxy": SEVERITY_PROXY,
        "value": None if impact_speed is None else round(impact_speed, 6),
        "units": "m/s",
        "secondary_proxy": "peak_torso_accel_mps2",
        "secondary_value": round(peak_accel, 6),
        "secondary_units": "m/s^2",
        "measured": True,
        "not_a_damage_estimate": True,
    }
    result["metrics"] = metrics
    result["events"] = events
    result["ticks"] = ticks
    result["frames"] = {
        "dt_s": FRAME_DT_S,
        "source_dt_s": DT_CTRL_S,
        "stride": FRAME_STRIDE,
        "places": FRAME_PLACES,
        "bodies": bodies,
        "quat_order": "wxyz",
        "data": frames,
    }
    result["trajectory_hash"] = canonical.commitment(result["frames"])
    result["state_hash"] = "sha256:" + state_hasher.hexdigest()
    result["noise_seed"] = "0x" + noise_seed_hex
    result["wall_time_s"] = round(time.perf_counter() - started, 4)
    env.close()
    return result


def summarize(res: dict[str, Any]) -> str:
    m = res.get("metrics", {})
    s = res["scenario"]
    parts = [
        f"{res['outcome']:<9}",
        f"push={s.get('push_impulse_ns')}Ns@{s.get('push_heading_deg')}deg,t={s.get('push_time_s')}s "
        f"mu={s.get('floor_friction')} mass={s.get('body_mass_scale')} "
        f"noise={s.get('actuator_noise_frac')} lat={s.get('control_latency_ms')}ms seed={s.get('init_seed')}",
    ]
    if m:
        parts.append(f"survive={m['survival_time_s']:.2f}s")
        parts.append(f"ret={m['episode_return']:.0f}")
        if m.get("fall_time_s") is not None:
            parts.append(f"fell@{m['fall_time_s']:.2f}s(z={m['torso_z_at_fall_m']:.3f})")
            if m.get("torso_impact_speed_mps") is not None:
                parts.append(f"impact={m['torso_impact_speed_mps']:.3f}m/s")
            parts.append(f"peakacc={m['peak_torso_accel_mps2']:.1f}")
        else:
            parts.append(f"minz={m['torso_min_z_m']:.3f}")
        parts.append(f"wall={res['wall_time_s']:.2f}s")
    return " ".join(parts)
