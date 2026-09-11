"""The scene under test: Gymnasium's `Humanoid-v5`, unmodified except along the envelope axes.

The MJCF is NOT authored here. It is `gymnasium/envs/mujoco/assets/humanoid.xml` exactly as
Gymnasium ships it, which is what makes the target's health predicate and its observation
layout the environment's own rather than this project's. Two things are mutated after the
model is compiled, both of them declared envelope axes:

  floor_friction    written into geom_friction[:, 0] of EVERY geom. MuJoCo combines a contact
                    pair's friction with the maximum of the two geoms, so lowering only the
                    floor would change nothing while the feet still carry 1.0. The stock model
                    ships 1.0 everywhere, so writing one value everywhere reproduces the stock
                    scene exactly at the nominal point.
  body_mass_scale   multiplies body_mass and body_inertia by the same factor, so the mass
                    DISTRIBUTION and every principal-axis ratio are unchanged and only the
                    scale moves. `mj_setConst` is called afterwards to refresh the derived
                    quantities (subtree masses, the reward's centre of mass).

The MJCF text and the mutated model are both hashed into every run document, so a replay can
prove it ran against the same compiled scene.

`render_bodies` is read straight out of the compiled model and published in the run document
so a viewer can draw the humanoid from data — primitive type, local pose and size per geom —
without hard-coding any geometry. That is the same contract the cart's `scene` block offers,
generalized.
"""

from __future__ import annotations

import hashlib
from typing import Any

import mujoco
import numpy as np

SCENE_ID = "gymnasium-humanoid-v5"
SCENE_REVISION = 1
ENV_ID = "Humanoid-v5"
# Gymnasium defaults, restated so a drift in the installed version is visible in evidence.
EXPECTED_DT_S = 0.015
EXPECTED_TIMESTEP_S = 0.003
EXPECTED_FRAME_SKIP = 5
EXPECTED_HEALTHY_Z_RANGE = (1.0, 2.0)
EXPECTED_OBS_DIM = 348
EXPECTED_ACT_DIM = 17
STOCK_FRICTION = 1.0

PUSH_BODY = "torso"
# Geoms whose contact with the floor is a normal part of walking. Everything else touching the
# floor is ground contact of a body that should not be on the ground.
FOOT_GEOMS = ("left_foot", "right_foot")
FLOOR_GEOM = "floor"

_GEOM_TYPE_NAMES = {
    int(mujoco.mjtGeom.mjGEOM_PLANE): "plane",
    int(mujoco.mjtGeom.mjGEOM_HFIELD): "hfield",
    int(mujoco.mjtGeom.mjGEOM_SPHERE): "sphere",
    int(mujoco.mjtGeom.mjGEOM_CAPSULE): "capsule",
    int(mujoco.mjtGeom.mjGEOM_ELLIPSOID): "ellipsoid",
    int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder",
    int(mujoco.mjtGeom.mjGEOM_BOX): "box",
    int(mujoco.mjtGeom.mjGEOM_MESH): "mesh",
}


def mjcf_path() -> str:
    import gymnasium.envs.mujoco as gym_mujoco

    return str((__import__("pathlib").Path(gym_mujoco.__file__).parent / "assets" / "humanoid.xml").resolve())


def mjcf_hash() -> str:
    with open(mjcf_path(), "rb") as fh:
        return "sha256:" + hashlib.sha256(fh.read()).hexdigest()


def make_env(floor_friction: float, body_mass_scale: float):
    """Build the stock environment and apply the two physical-axis mutations."""
    import gymnasium as gym

    env = gym.make(ENV_ID).unwrapped
    model = env.model
    model.geom_friction[:, 0] = float(floor_friction)
    if body_mass_scale != 1.0:
        model.body_mass[:] = model.body_mass * float(body_mass_scale)
        model.body_inertia[:] = model.body_inertia * float(body_mass_scale)
        mujoco.mj_setConst(model, env.data)
    return env


def model_hash(model: mujoco.MjModel) -> str:
    """Digest of the compiled, MUTATED model parameters that matter for the dynamics."""
    h = hashlib.sha256()
    for arr in (
        model.body_mass,
        model.body_inertia,
        model.body_pos,
        model.body_quat,
        model.geom_friction,
        model.geom_size,
        model.geom_pos,
        model.geom_quat,
        model.dof_damping,
        model.jnt_range,
        model.actuator_gear,
        model.actuator_ctrlrange,
        np.array([model.opt.timestep, model.opt.gravity[2]]),
    ):
        h.update(np.ascontiguousarray(np.asarray(arr), dtype=np.float64).tobytes())
    return "sha256:" + h.hexdigest()


def body_names(model: mujoco.MjModel) -> list[str]:
    """Every body except `world`, in model order. This is the order `frames.data` uses."""
    out = []
    for i in range(model.nbody):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, i)
        if name and name != "world":
            out.append(name)
    return out


def render_bodies(model: mujoco.MjModel) -> list[dict[str, Any]]:
    """Primitive geometry per body, local to that body frame, for a data-driven viewer."""
    out: list[dict[str, Any]] = []
    for i in range(model.ngeom):
        body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[i]))
        if body == "world":
            continue
        gtype = _GEOM_TYPE_NAMES.get(int(model.geom_type[i]), str(int(model.geom_type[i])))
        size = [round(float(x), 6) for x in model.geom_size[i]]
        entry: dict[str, Any] = {
            "body": body,
            "geom": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i),
            "type": gtype,
            "pos_m": [round(float(x), 6) for x in model.geom_pos[i]],
            "quat_wxyz": [round(float(x), 6) for x in model.geom_quat[i]],
            "rgba": [round(float(x), 3) for x in model.geom_rgba[i]],
        }
        if gtype == "sphere":
            entry["radius_m"] = size[0]
        elif gtype == "capsule":
            # MuJoCo capsule: size = (radius, half length); the axis is the geom's local z.
            entry["radius_m"] = size[0]
            entry["half_length_m"] = size[1]
            entry["axis"] = "local_z"
        else:
            entry["size_m"] = size
        out.append(entry)
    return out


def scene_description(env, model: mujoco.MjModel, floor_friction: float, body_mass_scale: float) -> dict[str, Any]:
    floor_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, FLOOR_GEOM)
    return {
        "scene_id": SCENE_ID,
        "scene_revision": SCENE_REVISION,
        "env_id": ENV_ID,
        "mjcf_source": "gymnasium/envs/mujoco/assets/humanoid.xml, unmodified",
        "mjcf_path": mjcf_path(),
        "mjcf_hash": mjcf_hash(),
        "compiled_model_hash": model_hash(model),
        "mutations": {
            "geom_friction_sliding": round(float(floor_friction), 6),
            "body_mass_scale": round(float(body_mass_scale), 6),
            "stock_geom_friction_sliding": STOCK_FRICTION,
            "note": "no other model field is written; mass scaling multiplies body_inertia by the same factor",
        },
        "bodies": body_names(model),
        "render_bodies": render_bodies(model),
        "floor": {
            "type": "plane",
            "half_extent_m": [round(float(x), 4) for x in model.geom_size[floor_id][:2]],
            "z_m": round(float(model.geom_pos[floor_id][2]), 6),
            "rgba": [round(float(x), 3) for x in model.geom_rgba[floor_id]],
        },
        "total_mass_kg": round(float(model.body_mass.sum()), 4),
        "push_body": PUSH_BODY,
        "foot_geoms": list(FOOT_GEOMS),
        "healthy_z_range_m": [float(x) for x in env._healthy_z_range],
        "reset_noise_scale": float(env._reset_noise_scale),
        "control_dt_s": round(float(env.dt), 6),
        "physics_timestep_s": float(model.opt.timestep),
        "frame_skip": int(env.frame_skip),
        "gravity_mps2": float(model.opt.gravity[2]),
        "quat_order": "wxyz",
        "up_axis": "z",
    }


def check_environment(env, model: mujoco.MjModel) -> list[str]:
    """Guard against a Gymnasium upgrade silently changing the target under our feet."""
    problems: list[str] = []
    if abs(float(env.dt) - EXPECTED_DT_S) > 1e-9:
        problems.append(f"control dt {env.dt} != expected {EXPECTED_DT_S}")
    if abs(float(model.opt.timestep) - EXPECTED_TIMESTEP_S) > 1e-12:
        problems.append(f"physics timestep {model.opt.timestep} != expected {EXPECTED_TIMESTEP_S}")
    if int(env.frame_skip) != EXPECTED_FRAME_SKIP:
        problems.append(f"frame_skip {env.frame_skip} != expected {EXPECTED_FRAME_SKIP}")
    if tuple(float(x) for x in env._healthy_z_range) != EXPECTED_HEALTHY_Z_RANGE:
        problems.append(f"healthy_z_range {tuple(env._healthy_z_range)} != expected {EXPECTED_HEALTHY_Z_RANGE}")
    if int(env.observation_space.shape[0]) != EXPECTED_OBS_DIM:
        problems.append(f"obs dim {env.observation_space.shape[0]} != expected {EXPECTED_OBS_DIM}")
    if int(env.action_space.shape[0]) != EXPECTED_ACT_DIM:
        problems.append(f"action dim {env.action_space.shape[0]} != expected {EXPECTED_ACT_DIM}")
    return problems
