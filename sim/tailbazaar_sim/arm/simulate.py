"""Run one scenario against the pinned pick-and-place policy and write a run document.

Determinism. Every source of randomness is pinned: the environment's own block and goal
sampling comes from `reset(seed=init_seed)`, and the action-noise generator is seeded from the
scenario's canonical commitment, so a scenario always replays identically. MuJoCo itself is
deterministic on a single thread. `state_hash` is a sha256 over the raw float64 qpos/qvel bytes
at EVERY control tick, undecimated and unrounded; `trajectory_hash` is the keccak-256
commitment over the canonical JSON of the decimated replay frames, the same construction the
cart and the humanoid use. Both are published, and `cli repeat` checks both.

WHAT IS THIS PROJECT'S AND WHAT IS THE ENVIRONMENT'S
---------------------------------------------------
The environment's, read and never reimplemented:
  * the scene, the arm, the block, the goal sampling and the initial state;
  * `info["is_success"]`, i.e. `FetchEnv._is_success(achieved_goal, goal)`, which is
    `goal_distance < distance_threshold` with the environment's own 5 cm threshold;
  * the reward, the observation, and the registered 50-step episode horizon.
This project cross-checks the success flag at every tick against the distance recomputed from the
environment's own `achieved_goal` and `desired_goal`, and publishes `success_predicate_mismatches`
in every document. It is 0 everywhere in the evidence.

This project's, and documented as such:
  * the DROP predicate, which the environment does not provide and cannot: the environment
    scores placement, not custody. It is mechanical and reads MuJoCo's own contact list —
    see `DROP_PREDICATE` below, including why a proposed release has to be confirmed before it
    counts. It invents no detector for anything the environment already reports, which is exactly
    why NOT_PLACED is the environment's flag and nothing else.
  * the settle window: after a drop, stepping continues past the environment's horizon (the
    policy still acting, nothing frozen or scripted) until the block has landed, so the impact
    can be measured and the replay shows the fall. Capped at SETTLE_TICKS.
"""

from __future__ import annotations

import hashlib
import math
import platform
import time
from typing import Any

import mujoco
import numpy as np

from .. import canonical
from . import scene as scene_mod
from .envelope import (
    AIRBORNE_MARGIN_M,
    CONCLUSIVE_OUTCOMES,
    DT_CTRL_MS,
    ENVELOPE_ID,
    ENVELOPE_REVISION,
    NO_FAILURE,
    NOMINAL_SCENARIO,
    PUBLISHED_CONDITIONS_PROSE,
    TARGET_ID,
    check_admissible,
    in_published_conditions,
    normalize,
)
from .policy import load_policy

SCHEMA = "tb-arm-run-1"
TARGET_KIND = "pretrained_policy"
TARGET_LABEL = "Fetch pick-and-place policy (SAC+HER, Gymnasium-Robotics FetchPickAndPlace-v4)"

DT_CTRL_S = DT_CTRL_MS / 1000.0
ACTION_HALF_RANGE = 1.0  # the action box is [-1, 1]

# Control runs at 25 Hz, which is already a sensible replay rate, so frames are recorded at the
# control rate with no decimation (stride 1) and rounded to 4 decimals — 0.1 mm on positions and
# about 0.01 deg on unit quaternions. The state hash is computed on the undecimated, unrounded
# state, so this never weakens the repeatability check.
FRAME_STRIDE = 1
FRAME_PLACES = 4

# Ticks the simulation may run past the environment's own horizon, to land a dropped block.
SETTLE_TICKS = 30  # 1.2 s
POST_IMPACT_TICKS = 5  # 0.2 s after the landing, so the replay shows it come to rest

# How long a loss of grasp must persist before it counts as a drop rather than a blip.
#
# THIS IS NOT COSMETIC. Without it the predicate is wrong: MuJoCo's contact list can report one
# pad's contact missing for a single 40 ms tick while the block is still firmly pinched and being
# carried UPWARD at constant speed. That happened in the first grid sweep — the block rose
# 0.507 -> 0.601 -> 0.632 m at a steady 0.67 m/s with one tick of "not grasped" in the middle —
# and it is a contact-list artefact, not a dropped part. A drop that is immediately re-caught is
# also not a drop. So a release is confirmed only if, over the next DROP_CONFIRM_TICKS,
#   * the grasp is NOT regained, and
#   * the block is at some point touching NOTHING AT ALL, i.e. it is genuinely in free flight.
# 3 ticks is 120 ms, in which a released block falls about 7 cm — unmistakable, and short enough
# that a real drop is still attributed to the tick it actually left the hand.
DROP_CONFIRM_TICKS = 3

# Divergence guard: a block moving faster than this is a solver blow-up, not a dropped part.
MAX_PLAUSIBLE_SPEED_MPS = 50.0

DROP_PREDICATE = {
    "class": "DROPPED",
    "owner": "this project (the environment scores placement, not custody)",
    "rule": (
        "a release is proposed at control tick k when the block was in contact with BOTH gripper "
        "finger pads at tick k-1, AND its centre was more than airborne_margin_m above its resting "
        "height on the table at tick k-1, AND at tick k MuJoCo reports it in contact with fewer than "
        "both pads, AND the environment's own info['is_success'] is false at tick k. It is CONFIRMED "
        "as a drop only if, over the following drop_confirm_ticks, the grasp is not regained and the "
        "block is at some tick in contact with nothing at all. Otherwise it is discarded."
    ),
    "plain_english": (
        "it was being held, it was off the table, it left the hand, it stayed out of the hand, and it "
        "was not at the goal"
    ),
    "why_confirmation": (
        "MuJoCo's contact list can drop one pad for a single tick while the block is still pinched and "
        "being carried upward; without the confirmation window that artefact would be sold as a drop"
    ),
    "reads": "mujoco MjData.contact, the engine's own contact list; no vision, no heuristic, no policy introspection",
    "airborne_margin_m": AIRBORNE_MARGIN_M,
    "drop_confirm_ticks": DROP_CONFIRM_TICKS,
    "detected_within": (
        "the release must occur within the environment's own registered episode horizon; its "
        "confirmation window may extend up to drop_confirm_ticks past it"
    ),
    "severity_proxy": {
        "primary": "object_impact_speed_mps",
        "definition": (
            "the block's world-frame linear speed (its free joint's linear dof velocity, exact for a "
            "free body) at the last control tick at which it was still unsupported, i.e. immediately "
            "before its first contact with the table or the floor after the drop"
        ),
        "sampling_note": (
            "speed is sampled at the 40 ms control tick, so a free fall gains about 0.39 m/s between "
            "samples; the reported value is the last sample before contact, never an extrapolation"
        ),
        "secondary": "drop_height_m",
        "secondary_definition": "block centre height at the drop minus its centre height at that first contact",
        "not_a_damage_estimate": True,
    },
}

SUCCESS_PREDICATE = {
    "class": "NOT_PLACED (when false at the horizon)",
    "owner": "gymnasium-robotics",
    "source": "gymnasium_robotics.envs.fetch.fetch_env.MujocoFetchEnv._is_success, via info['is_success'] from env.step",
    "rule": "success when goal_distance(achieved_goal, desired_goal) < distance_threshold",
    "no_bespoke_detector": (
        "this project implements no placement detector; it records the environment's flag and "
        "cross-checks it at every tick against the distance recomputed from the environment's OWN "
        "achieved_goal and desired_goal"
    ),
    "block_position_source": (
        "obs['achieved_goal'], which is the environment's own read of the block's site. NOTE: after "
        "mujoco.mj_step the kinematics cache (xpos, site_xpos, contacts) is one 2 ms physics substep "
        "behind qpos, because mj_step evaluates forward dynamics and then integrates. The environment "
        "computes is_success from that cache, so this project does too — comparing the environment's "
        "boolean against a position recomputed from qpos instead disagrees on about one tick in a "
        "thousand, purely where the distance sits within ~2 mm of the 50 mm threshold. The skew is "
        "1.4 mm at 0.7 m/s, far below every threshold used here (the airborne margin is 30 mm)."
    ),
    "block_velocity_source": (
        "the block's free-joint linear dof velocity from qvel, exact for a free body; the environment "
        "publishes only a dt-scaled site velocity, so there is no environment-owned alternative"
    ),
}


def engine_info() -> dict[str, Any]:
    import gymnasium
    import gymnasium_robotics

    return {
        "engine": "mujoco",
        "engine_version": mujoco.__version__,
        "gymnasium_version": gymnasium.__version__,
        "gymnasium_robotics_version": gymnasium_robotics.__version__,
        "numpy_version": np.__version__,
        "python_version": platform.python_version(),
        "platform": f"{platform.system()}-{platform.machine()}",
        "threads": 1,
        "policy_backend": "numpy",
        "control_dt_s": DT_CTRL_S,
        "physics_timestep_s": scene_mod.EXPECTED_TIMESTEP_S,
        "n_substeps": scene_mod.EXPECTED_N_SUBSTEPS,
    }


def _empty_tail(result: dict[str, Any], started: float, bodies: list[str]) -> dict[str, Any]:
    """Finish a document for a run that never stepped (rejected or invalid initial state)."""
    result["frames"] = {
        "bodies": bodies,
        "dt_s": round(DT_CTRL_S * FRAME_STRIDE, 6),
        "source_dt_s": DT_CTRL_S,
        "stride": FRAME_STRIDE,
        "places": FRAME_PLACES,
        "quat_order": "wxyz",
        "data": [],
    }
    result["ticks"] = []
    result["events"] = []
    result["wall_time_s"] = round(time.time() - started, 4)
    result["trajectory_hash"] = canonical.commitment(result["frames"])
    result["state_hash"] = "sha256:" + hashlib.sha256(b"").hexdigest()
    result["conclusive"] = result["outcome"] in CONCLUSIVE_OUTCOMES
    return result


def run_scenario(scenario: dict[str, Any], record_frames: bool = True) -> dict[str, Any]:
    """Simulate one scenario. Returns the run document; never raises on an inadmissible input."""
    started = time.time()
    problems = check_admissible(scenario)
    scn = normalize(scenario)
    policy = load_policy()

    result: dict[str, Any] = {
        "schema": SCHEMA,
        "target_id": TARGET_ID,
        "target_kind": TARGET_KIND,
        "target_label": TARGET_LABEL,
        "envelope_id": ENVELOPE_ID,
        "envelope_revision": ENVELOPE_REVISION,
        "scenario": scn,
        "admissible": not problems,
        "admissibility_problems": problems,
        "target": policy.identity(),
        "published_conditions": {
            "prose": PUBLISHED_CONDITIONS_PROSE,
            "per_axis_inside": in_published_conditions(scn),
            "note": "None means the publisher states nothing about that axis",
        },
        "drop_predicate": DROP_PREDICATE,
        "success_predicate": SUCCESS_PREDICATE,
        "engine": engine_info(),
    }

    if problems:
        result.update(
            outcome="REJECTED_OUT_OF_ENVELOPE",
            failure_classes=[],
            primary_failure_class=NO_FAILURE,
            failure_event=None,
            severity=None,
            metrics={"outcome": "REJECTED_OUT_OF_ENVELOPE"},
            scene=None,
            initial_state=None,
            initial_state_check={"ok": False, "reason": "scenario rejected before any simulation"},
            noise_seed=None,
        )
        return _empty_tail(result, started, [])

    env = scene_mod.make_env(float(scn["object_mass_kg"]), float(scn["grip_friction"]))
    model, data = env.model, env.data
    index = scene_mod.SceneIndex(model)
    horizon = scene_mod.episode_steps()

    obs, _ = env.reset(seed=int(scn["init_seed"]))

    # The block offset is applied AFTER the environment has sampled its own initial state, so
    # the goal (sampled relative to the gripper) does not move with the part.
    dx, dy = float(scn["object_offset_x_m"]), float(scn["object_offset_y_m"])
    offset_applied = bool(dx or dy)
    if offset_applied:
        import gymnasium_robotics.utils.mujoco_utils as mujoco_utils

        q = np.asarray(mujoco_utils.get_joint_qpos(model, data, scene_mod.OBJECT_JOINT)).copy()
        q[0] += dx
        q[1] += dy
        mujoco_utils.set_joint_qpos(model, data, scene_mod.OBJECT_JOINT, q)
        mujoco.mj_forward(model, data)
        obs = env._get_obs()

    body_ids = [
        int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, n))
        for n in scene_mod.render_body_names(model)
    ]
    body_names = scene_mod.render_body_names(model)
    goal = np.asarray(env.goal, dtype=np.float64).copy()

    result["scene"] = scene_mod.scene_block(
        env,
        index,
        {
            "object_mass_kg": round(float(scn["object_mass_kg"]), 6),
            "grip_friction": round(float(scn["grip_friction"]), 6),
            "object_offset_m": [round(dx, 6), round(dy, 6)],
            "note": (
                "mass and friction are written into the compiled model; the offset is written into the "
                "block's free joint after reset. Nothing else in the scene is touched."
            ),
        },
    )
    result["goal_m"] = [round(float(x), 6) for x in goal]
    result["episode_horizon_ticks"] = horizon
    result["episode_horizon_source"] = "gymnasium.spec('FetchPickAndPlace-v4').max_episode_steps"

    obj0 = np.asarray(obs["achieved_goal"], dtype=np.float64)
    grip0 = np.asarray(data.site_xpos[index.grip_site], dtype=np.float64)
    init_ok_resting = abs(float(obj0[2]) - index.resting_z) < 5e-3
    init_ok_on_table = index.over_table(obj0)
    init_ok_free = not index.grasped(data)
    init_not_already_done = float(np.linalg.norm(obj0 - goal)) >= float(env.distance_threshold)
    result["initial_state_check"] = {
        "init_seed": int(scn["init_seed"]),
        "object_xyz_m": [round(float(x), 6) for x in obj0],
        "gripper_xyz_m": [round(float(x), 6) for x in grip0],
        "goal_xyz_m": [round(float(x), 6) for x in goal],
        "object_goal_distance_m": round(float(np.linalg.norm(obj0 - goal)), 6),
        "goal_in_the_air": bool(float(goal[2]) > index.resting_z + 1e-3),
        "object_resting_on_table": bool(init_ok_resting),
        "object_within_table_footprint": bool(init_ok_on_table),
        "object_not_already_grasped": bool(init_ok_free),
        "object_not_already_at_goal": bool(init_not_already_done),
        "offset_applied": offset_applied,
        "ok": bool(init_ok_resting and init_ok_on_table and init_ok_free and init_not_already_done),
    }
    result["initial_state"] = {
        "qpos": canonical.quantize(data.qpos.tolist()),
        "qvel": canonical.quantize(data.qvel.tolist()),
        "object_mass_kg": round(float(model.body_mass[index.object_body]), 6),
    }

    if not result["initial_state_check"]["ok"]:
        env.close()
        result.update(
            outcome="INVALID_INITIAL_STATE",
            failure_classes=[],
            primary_failure_class=NO_FAILURE,
            failure_event=None,
            severity=None,
            metrics={"outcome": "INVALID_INITIAL_STATE"},
            noise_seed=None,
        )
        return _empty_tail(result, started, body_names)

    # ---- actuation path: latency then noise ------------------------------------------------
    # The arm channels and the gripper channel are delayed independently (the gripper's delay is
    # ON TOP of the common one). Noise is added where an actuator would add it: after the
    # transport delay, at the moment the command is applied, so the two axes compose cleanly and
    # the noise sequence for a given seed does not depend on the latency.
    noise_seed_hex = canonical.commitment(scn)[2:18]
    rng = np.random.default_rng(int(noise_seed_hex, 16))
    noise_std = float(scn["action_noise_frac"]) * ACTION_HALF_RANGE
    lat = int(scn["control_latency_ms"]) // DT_CTRL_MS
    glat = lat + int(scn["gripper_latency_ms"]) // DT_CTRL_MS
    low = np.asarray(env.action_space.low, dtype=np.float32)
    high = np.asarray(env.action_space.high, dtype=np.float32)
    zero_action = np.zeros(int(env.action_space.shape[0]), dtype=np.float32)
    issued: list[np.ndarray] = []

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

    prev_grasped = index.grasped(data)
    prev_airborne = float(obj0[2]) > index.resting_z + AIRBORNE_MARGIN_M
    prev_speed = 0.0
    prev_z = float(obj0[2])

    pending: dict[str, Any] | None = None  # a proposed release awaiting confirmation
    drop_tick: int | None = None
    drop_t: float | None = None
    drop_z: float | None = None
    drop_dist: float | None = None
    impact_tick: int | None = None
    impact_t: float | None = None
    impact_speed: float | None = None
    impact_geom: str | None = None
    impact_z: float | None = None
    peak_speed_after_drop = 0.0
    lift_max_z = float(obj0[2])
    min_goal_dist = float(np.linalg.norm(obj0 - goal))
    ever_grasped = False
    grasp_ticks = 0
    first_grasp_t: float | None = None
    first_success_t: float | None = None
    env_success_at_horizon = 0.0
    episode_return = 0.0
    success_mismatches = 0
    diverged_reason: str | None = None
    landed_on_floor = False

    last_tick = 0
    for tick in range(horizon + SETTLE_TICKS):
        t = tick * DT_CTRL_S
        if tick % FRAME_STRIDE == 0:
            record_frame(t)
        state_hasher.update(np.ascontiguousarray(data.qpos, dtype=np.float64).tobytes())
        state_hasher.update(np.ascontiguousarray(data.qvel, dtype=np.float64).tobytes())

        raw = np.asarray(policy.action(policy.observation_vector(obs), low, high), dtype=np.float32)
        issued.append(raw)
        applied = (issued[tick - lat] if tick >= lat else zero_action).copy()
        applied[3] = float(issued[tick - glat][3]) if tick >= glat else 0.0
        if noise_std > 0.0:
            applied = np.clip(applied + rng.normal(0.0, noise_std, applied.shape), low, high).astype(
                np.float32
            )

        obs, reward, terminated, truncated, info = env.step(applied)
        last_tick = tick + 1

        # The block's position is the ENVIRONMENT's own `achieved_goal`, so the geometry reported
        # here and the flag the environment reports are computed from the same read of the block.
        obj = np.asarray(obs["achieved_goal"], dtype=np.float64)
        obj_z = float(obj[2])
        speed = float(np.linalg.norm(index.object_linvel(data)))
        goal_dist = float(np.linalg.norm(obj - np.asarray(obs["desired_goal"], dtype=np.float64)))
        is_grasped = index.grasped(data)
        touching_anything = index.any_contact(data)
        env_success = float(info["is_success"])

        # Cross-check the environment's own flag against the distance recomputed from the
        # environment's own achieved_goal and desired_goal.
        if bool(env_success > 0.5) != bool(goal_dist < float(env.distance_threshold)):
            success_mismatches += 1

        if not np.all(np.isfinite(data.qpos)) or not np.all(np.isfinite(data.qvel)):
            diverged_reason = "non-finite qpos/qvel"
        elif speed > MAX_PLAUSIBLE_SPEED_MPS:
            diverged_reason = f"block speed {speed:.1f} m/s exceeds the {MAX_PLAUSIBLE_SPEED_MPS} m/s plausibility bound"

        in_episode = tick < horizon
        if in_episode:
            episode_return += float(reward)
            env_success_at_horizon = env_success
            if env_success > 0.5 and first_success_t is None:
                first_success_t = t + DT_CTRL_S
        if is_grasped:
            ever_grasped = True
            grasp_ticks += 1
            if first_grasp_t is None:
                first_grasp_t = t + DT_CTRL_S
        lift_max_z = max(lift_max_z, obj_z)
        min_goal_dist = min(min_goal_dist, goal_dist)

        # ---- the drop predicate: propose a release, then confirm or discard it ----------------
        if drop_tick is None and pending is not None:
            if is_grasped:
                # Back in the hand inside the confirmation window: a contact-list blip or a catch,
                # not a drop. Discarded, and recorded so the evidence shows it was considered.
                events.append(
                    {
                        "event": "RELEASE_DISCARDED",
                        "t_s": pending["t_s"],
                        "reason": f"the grasp was regained {tick - pending['tick']} tick(s) later",
                    }
                )
                pending = None
            else:
                pending["free_flight"] = pending["free_flight"] or not touching_anything
                if tick - pending["tick"] >= DROP_CONFIRM_TICKS:
                    if pending["free_flight"]:
                        drop_tick = pending["tick"]
                        drop_t = pending["t_s"]
                        drop_z = pending["z"]
                        drop_dist = pending["goal_dist"]
                        events.append(
                            {
                                "event": "DROPPED",
                                "t_s": drop_t,
                                "confirmed_at_t_s": round(t + DT_CTRL_S, 6),
                                "object_z_m": round(float(drop_z), 6),
                                "height_above_table_m": round(float(drop_z) - index.resting_z, 6),
                                "object_goal_distance_m": round(float(drop_dist), 6),
                                "object_speed_mps": pending["speed"],
                                "detected_by": (
                                    "both-pad contact lost while airborne and not at the goal, then "
                                    f"not regained and in free flight within {DROP_CONFIRM_TICKS} ticks"
                                ),
                            }
                        )
                    else:
                        events.append(
                            {
                                "event": "RELEASE_DISCARDED",
                                "t_s": pending["t_s"],
                                "reason": (
                                    f"the block was still touching something at every tick of the "
                                    f"{DROP_CONFIRM_TICKS}-tick confirmation window, so it never left the hand"
                                ),
                            }
                        )
                    pending = None

        if (
            drop_tick is None
            and pending is None
            and in_episode
            and prev_grasped
            and prev_airborne
            and not is_grasped
            and env_success <= 0.5
        ):
            pending = {
                "tick": tick,
                "t_s": round(t + DT_CTRL_S, 6),
                "z": obj_z,
                "goal_dist": goal_dist,
                "speed": round(speed, 6),
                "free_flight": not touching_anything,
            }

        if drop_tick is not None and tick > drop_tick:
            peak_speed_after_drop = max(peak_speed_after_drop, speed)
        support = index.support_contact(data)
        if drop_tick is not None and impact_tick is None and tick > drop_tick and support is not None:
            impact_tick = tick
            impact_t = round(t + DT_CTRL_S, 6)
            # The speed at the LAST unsupported sample: at this tick the contact impulse has
            # already been applied, so the pre-contact sample is the honest impact speed.
            impact_speed = prev_speed
            impact_geom = index.geom_name(support)
            impact_z = prev_z
            landed_on_floor = support == index.floor_geom
            events.append(
                {
                    "event": "LANDED",
                    "t_s": impact_t,
                    "geom": impact_geom,
                    "impact_speed_mps": round(float(impact_speed), 6),
                    "object_z_m": round(obj_z, 6),
                    "on_the_floor": landed_on_floor,
                }
            )

        prev_grasped = is_grasped
        prev_airborne = obj_z > index.resting_z + AIRBORNE_MARGIN_M
        prev_speed = speed
        prev_z = obj_z

        ticks.append(
            {
                "t_s": round(t + DT_CTRL_S, 6),
                "in_episode": in_episode,
                "object_z_m": round(obj_z, 6),
                "object_goal_distance_m": round(goal_dist, 6),
                "object_speed_mps": round(speed, 6),
                "grasped": bool(is_grasped),
                "is_success": bool(env_success > 0.5),
                "reward": round(float(reward), 6),
                "action_l2": round(float(np.linalg.norm(applied)), 6),
            }
        )

        if diverged_reason is not None:
            break
        if tick + 1 >= horizon:
            if drop_tick is None and pending is None:
                break
            if drop_tick is not None and impact_tick is not None and tick >= impact_tick + POST_IMPACT_TICKS:
                break

    # The loop records the state BEFORE each step, so without this the final state — the one the
    # outcome is read from — would never appear in the replay.
    record_frame(last_tick * DT_CTRL_S)
    env.close()

    # ---- outcome, in the declared precedence -------------------------------------------------
    success_at_horizon = bool(env_success_at_horizon > 0.5)
    if diverged_reason is not None:
        outcome = "DIVERGED"
    elif drop_tick is not None:
        outcome = "DROPPED"
    elif not success_at_horizon:
        outcome = "NOT_PLACED"
    else:
        outcome = "SUCCESS"
    failure_classes = [c for c in ("DROPPED", "NOT_PLACED") if c == outcome]
    recovered = bool(outcome == "DROPPED" and success_at_horizon)

    failure_event: dict[str, Any] | None = None
    severity: dict[str, Any] | None = None
    if outcome == "DROPPED":
        failure_event = {
            "class": "DROPPED",
            "t_s": drop_t,
            "detected_by": DROP_PREDICATE["plain_english"],
            "object_z_m": round(float(drop_z), 6),
            "height_above_table_m": round(float(drop_z) - index.resting_z, 6),
            "object_goal_distance_m": round(float(drop_dist), 6),
            "distance_threshold_m": round(float(scene_mod.EXPECTED_DISTANCE_THRESHOLD), 6),
            "landed_t_s": impact_t,
            "landed_on_geom": impact_geom,
            "landed_on_the_floor": landed_on_floor,
            "recovered_after_drop": recovered,
            "env_success_at_horizon": success_at_horizon,
        }
        if impact_speed is not None:
            severity = {
                "proxy": "object_impact_speed_mps",
                "value": round(float(impact_speed), 6),
                "units": "m/s",
                "secondary_proxy": "drop_height_m",
                "secondary_value": round(float(drop_z) - float(impact_z), 6),
                "secondary_units": "m",
                "measured": True,
                "not_a_damage_estimate": True,
            }
        else:
            severity = {
                "proxy": "object_impact_speed_mps",
                "value": None,
                "units": "m/s",
                "measured": False,
                "why_none": (
                    "no contact between the block and the table or the floor occurred between the drop "
                    "and the end of the settle window; see recovered_after_drop"
                ),
                "not_a_damage_estimate": True,
            }
    elif outcome == "NOT_PLACED":
        failure_event = {
            "class": "NOT_PLACED",
            "t_s": round(horizon * DT_CTRL_S, 6),
            "detected_by": "the environment's own info['is_success'], false at its registered horizon",
            "object_goal_distance_m": round(float(min_goal_dist), 6),
            "closest_approach_m": round(float(min_goal_dist), 6),
            "distance_threshold_m": round(float(scene_mod.EXPECTED_DISTANCE_THRESHOLD), 6),
            "ever_grasped": ever_grasped,
        }

    result["metrics"] = {
        "outcome": outcome,
        "primary_failure_class": outcome if outcome in ("DROPPED", "NOT_PLACED") else NO_FAILURE,
        "failure_class_set": "+".join(failure_classes) if failure_classes else NO_FAILURE,
        "env_success_at_horizon": success_at_horizon,
        "episode_return": round(episode_return, 6),
        "first_success_t_s": first_success_t,
        "dropped": drop_tick is not None,
        "drop_t_s": drop_t,
        "drop_height_above_table_m": None if drop_z is None else round(float(drop_z) - index.resting_z, 6),
        "recovered_after_drop": recovered,
        "object_impact_speed_mps": None if impact_speed is None else round(float(impact_speed), 6),
        "object_peak_speed_after_drop_mps": round(peak_speed_after_drop, 6) if drop_tick is not None else None,
        "landed_on_geom": impact_geom,
        "landed_on_the_floor": landed_on_floor,
        "object_max_z_m": round(lift_max_z, 6),
        "object_lift_m": round(lift_max_z - index.resting_z, 6),
        "min_object_goal_distance_m": round(min_goal_dist, 6),
        "ever_grasped": ever_grasped,
        "first_grasp_t_s": first_grasp_t,
        "grasp_ticks": grasp_ticks,
        "control_ticks": last_tick,
        "sim_steps": last_tick * scene_mod.EXPECTED_N_SUBSTEPS,
        "duration_s": round(last_tick * DT_CTRL_S, 6),
        "settle_ticks_used": max(0, last_tick - horizon),
        "success_predicate_mismatches": success_mismatches,
        "control_latency_ticks": lat,
        "gripper_latency_ticks_total": glat,
        "action_noise_std": round(noise_std, 6),
        "diverged_reason": diverged_reason,
    }
    result["outcome"] = outcome
    result["failure_classes"] = failure_classes
    result["primary_failure_class"] = result["metrics"]["primary_failure_class"]
    result["failure_event"] = failure_event
    result["severity"] = severity
    result["noise_seed"] = "0x" + noise_seed_hex
    result["conclusive"] = outcome in CONCLUSIVE_OUTCOMES
    result["termination_rules"] = {
        "episode_horizon_ticks": horizon,
        "horizon_owner": "gymnasium-robotics (registered max_episode_steps)",
        "settle_ticks_max": SETTLE_TICKS,
        "settle_note": (
            "stepping continues past the horizon only after a drop, until the block has landed plus "
            f"{POST_IMPACT_TICKS} ticks, capped at {SETTLE_TICKS} ticks. The policy keeps acting "
            "throughout; nothing is frozen or scripted, and a drop is never detected in the settle window."
        ),
        "divergence_guard_mps": MAX_PLAUSIBLE_SPEED_MPS,
    }
    result["frames"] = {
        "bodies": body_names,
        "dt_s": round(DT_CTRL_S * FRAME_STRIDE, 6),
        "source_dt_s": DT_CTRL_S,
        "stride": FRAME_STRIDE,
        "places": FRAME_PLACES,
        "quat_order": "wxyz",
        "note": "control runs at 25 Hz, already a sensible replay rate, so no decimation is applied",
        "data": frames,
    }
    result["ticks"] = ticks
    result["events"] = events
    result["wall_time_s"] = round(time.time() - started, 4)
    result["trajectory_hash"] = canonical.commitment(result["frames"])
    result["state_hash"] = "sha256:" + state_hasher.hexdigest()
    return result


def summarize(res: dict[str, Any]) -> str:
    m = res["metrics"]
    bits = [
        f"outcome={res['outcome']}",
        f"env_success={m.get('env_success_at_horizon')}",
        f"return={m.get('episode_return')}",
        f"lift={m.get('object_lift_m')}m",
        f"min_goal_dist={m.get('min_object_goal_distance_m')}m",
    ]
    if m.get("dropped"):
        bits.append(f"drop_t={m.get('drop_t_s')}s")
        bits.append(f"impact={m.get('object_impact_speed_mps')}m/s")
        if m.get("recovered_after_drop"):
            bits.append("recovered")
    return "  ".join(str(b) for b in bits)


__all__ = ["run_scenario", "summarize", "engine_info", "SCHEMA", "DROP_PREDICATE", "SUCCESS_PREDICATE"]


def _selfcheck_math() -> dict[str, Any]:
    """Sanity relations that must hold regardless of the policy; used by `cli selfcheck`."""
    return {
        "control_dt_s": DT_CTRL_S,
        "frame_stride": FRAME_STRIDE,
        "airborne_margin_m": AIRBORNE_MARGIN_M,
        "nominal_is_admissible": not check_admissible(NOMINAL_SCENARIO),
        "nominal_all_inside_published": all(
            v is not False for v in in_published_conditions(NOMINAL_SCENARIO).values()
        ),
        "dt_matches_scene": math.isclose(DT_CTRL_S, scene_mod.EXPECTED_DT_S, rel_tol=1e-9),
    }
