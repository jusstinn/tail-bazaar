"""The scene under test: Gymnasium-Robotics' `FetchPickAndPlace-v4`, unmodified except along
the envelope axes.

The MJCF is NOT authored here. It is `gymnasium_robotics/envs/assets/fetch/pick_and_place.xml`
exactly as Gymnasium-Robotics ships it (MIT, Farama Foundation), which is what makes the
target's success predicate, its observation layout and its goal sampling the environment's own
rather than this project's. Three things are mutated after the model is compiled, all of them
declared envelope axes:

  object_mass_kg   written into body_mass of `object0`, with body_inertia scaled by the same
                   ratio so the mass DISTRIBUTION is unchanged and only the scale moves.
                   `mj_setConst` refreshes the derived quantities afterwards.
  grip_friction    written into geom_friction[0] (the Coulomb sliding coefficient) of the block
                   AND of BOTH finger pads. MuJoCo combines a contact pair's friction with the
                   maximum of the two geoms, so lowering only the block would change nothing
                   while the pads still carry 1.0 — the same trap the humanoid target
                   documents for its floor. The stock model ships 1.0 on all three, so writing
                   one value on all three reproduces the stock scene exactly at nominal.
  object_offset    x/y written into the block's free joint AFTER the environment has sampled
                   its own initial state, then `mj_forward`. The goal was already sampled
                   relative to the gripper, not the block, so this moves the part without
                   moving the target.

The MJCF text and the mutated model are both hashed into every run document, so a replay can
prove it ran against the same compiled scene.

Geometry that matters for the failure predicate, all read out of the compiled model rather
than typed in: the table top is the top face of `table0`'s box geom, and the block is a 5 cm
cube resting on it. `render_bodies` is read straight out of the compiled model and published in
the run document so a viewer can draw the arm from data — primitive type, local pose and size
per geom — without hard-coding any geometry. That is the same contract the cart and humanoid
`scene` blocks offer.

MESH GEOMS. The Fetch arm's links are meshes, which a from-data viewer cannot tessellate. Each
mesh geom is published with `type: "mesh"` and MuJoCo's own bounding half-extents in
`box_half_extent_m`, so a viewer can draw an honest proxy box and knows it is a proxy. The
gripper pads, the block, the table and the floor — everything the failure story is about — are
real boxes and a plane, and are exact.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import mujoco
import numpy as np

from . import compat

SCENE_ID = "gymnasium-robotics-fetch-pick-and-place-v4"
SCENE_REVISION = 1
ENV_ID = "FetchPickAndPlace-v4"

# Gymnasium-Robotics defaults, restated so a drift in the installed version is visible in
# evidence rather than silently changing the physics under a published run.
EXPECTED_DT_S = 0.04
EXPECTED_TIMESTEP_S = 0.002
EXPECTED_N_SUBSTEPS = 20
EXPECTED_EPISODE_STEPS = 50
EXPECTED_DISTANCE_THRESHOLD = 0.05
EXPECTED_OBS_DIM = 25
EXPECTED_ACT_DIM = 4
STOCK_FRICTION = 1.0
STOCK_OBJECT_MASS_KG = 2.0

OBJECT_BODY = "object0"
OBJECT_GEOM = "object0"
OBJECT_JOINT = "object0:joint"
TABLE_BODY = "table0"
FLOOR_GEOM = "floor0"
GRIP_SITE = "robot0:grip"
TARGET_SITE = "target0"
FINGER_GEOMS = ("robot0:l_gripper_finger_link", "robot0:r_gripper_finger_link")

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
    import gymnasium_robotics
    from gymnasium_robotics.envs.fetch import pick_and_place

    root = Path(gymnasium_robotics.__file__).parent / "envs" / "assets"
    return str((root / pick_and_place.MODEL_XML_PATH).resolve())


def mjcf_hash() -> str:
    with open(mjcf_path(), "rb") as fh:
        return "sha256:" + hashlib.sha256(fh.read()).hexdigest()


def register() -> None:
    """Install the MuJoCo-version shim and register the Gymnasium-Robotics environments."""
    compat.apply()
    import gymnasium as gym
    import gymnasium_robotics

    gym.register_envs(gymnasium_robotics)


def episode_steps() -> int:
    """The episode horizon the ENVIRONMENT registers, read from its own spec, not chosen here."""
    import gymnasium as gym

    register()
    return int(gym.spec(ENV_ID).max_episode_steps)


def make_env(object_mass_kg: float, grip_friction: float):
    """Build the stock environment and apply the two compiled-model mutations.

    The returned object is the UNWRAPPED environment. The episode horizon is applied by
    `simulate.py` rather than by Gymnasium's TimeLimit wrapper, so that a settle window can be
    run past the horizon to measure where a dropped block lands. The horizon itself is still
    the environment's own registered `max_episode_steps`; nothing about the number is invented.
    """
    import gymnasium as gym

    register()
    env = gym.make(ENV_ID).unwrapped
    model = env.model

    obj_bid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, OBJECT_BODY)
    stock_mass = float(model.body_mass[obj_bid])
    if object_mass_kg != stock_mass:
        ratio = float(object_mass_kg) / stock_mass
        model.body_mass[obj_bid] = float(object_mass_kg)
        model.body_inertia[obj_bid] = model.body_inertia[obj_bid] * ratio
        mujoco.mj_setConst(model, env.data)

    if grip_friction != STOCK_FRICTION:
        for name in (OBJECT_GEOM,) + FINGER_GEOMS:
            gid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, name)
            model.geom_friction[gid, 0] = float(grip_friction)
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
        model.geom_solref,
        model.geom_solimp,
        model.dof_damping,
        model.jnt_range,
        model.actuator_gear,
        model.actuator_ctrlrange,
        np.array([model.opt.timestep, model.opt.gravity[2]]),
    ):
        h.update(np.ascontiguousarray(np.asarray(arr), dtype=np.float64).tobytes())
    return "sha256:" + h.hexdigest()


class SceneIndex:
    """Ids, names and geometry resolved once per model, so the hot loop does no name lookups."""

    def __init__(self, model: mujoco.MjModel) -> None:
        self.model = model
        gid = lambda n: int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, n))  # noqa: E731
        bid = lambda n: int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, n))  # noqa: E731

        self.object_body = bid(OBJECT_BODY)
        self.object_geom = gid(OBJECT_GEOM)
        self.finger_geoms = tuple(gid(n) for n in FINGER_GEOMS)
        self.floor_geom = gid(FLOOR_GEOM)
        self.table_body = bid(TABLE_BODY)
        self.grip_site = int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, GRIP_SITE))
        self.target_site = int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, TARGET_SITE))

        jid = int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, OBJECT_JOINT))
        self.object_qposadr = int(model.jnt_qposadr[jid])
        self.object_dofadr = int(model.jnt_dofadr[jid])

        if min(self.object_body, self.object_geom, self.floor_geom, self.table_body) < 0:
            raise RuntimeError("the Fetch scene is missing a geom or body this target depends on")

        # The table's own box geom, found by body rather than by name (it has none in the MJCF).
        table_geoms = [g for g in range(model.ngeom) if int(model.geom_bodyid[g]) == self.table_body]
        if len(table_geoms) != 1:
            raise RuntimeError(f"expected exactly one table geom, found {len(table_geoms)}")
        self.table_geom = table_geoms[0]
        # Table top = body z + geom local z + geom half-height. Read, never typed in.
        self.table_top_z = float(
            model.body_pos[self.table_body][2]
            + model.geom_pos[self.table_geom][2]
            + model.geom_size[self.table_geom][2]
        )
        self.table_half_xy = (
            float(model.geom_size[self.table_geom][0]),
            float(model.geom_size[self.table_geom][1]),
        )
        self.table_centre_xy = (
            float(model.body_pos[self.table_body][0] + model.geom_pos[self.table_geom][0]),
            float(model.body_pos[self.table_body][1] + model.geom_pos[self.table_geom][1]),
        )
        self.object_half = float(model.geom_size[self.object_geom][2])
        # The block's centre height when it is resting on the table.
        self.resting_z = self.table_top_z + self.object_half

    # ---- mechanical predicates, all read out of MuJoCo's own contact list ----

    def grasped(self, data: mujoco.MjData) -> bool:
        """True when MuJoCo reports the block in contact with BOTH finger pads.

        This is the mechanical fact "the gripper is holding it": a contact on one pad only is
        a nudge, not a grasp. Nothing here is a heuristic about the policy's intent.
        """
        left = right = False
        for i in range(data.ncon):
            c = data.contact[i]
            g1, g2 = int(c.geom1), int(c.geom2)
            if self.object_geom not in (g1, g2):
                continue
            other = g2 if g1 == self.object_geom else g1
            if other == self.finger_geoms[0]:
                left = True
            elif other == self.finger_geoms[1]:
                right = True
        return left and right

    def any_contact(self, data: mujoco.MjData) -> bool:
        """True when MuJoCo reports the block touching ANY geom at all.

        False means free flight: the block is held by nothing and resting on nothing.
        """
        for i in range(data.ncon):
            c = data.contact[i]
            if self.object_geom in (int(c.geom1), int(c.geom2)):
                return True
        return False

    def support_contact(self, data: mujoco.MjData) -> int | None:
        """The first geom other than a finger pad that the block is touching, or None.

        In this scene that is the table top or the floor, i.e. the block has landed.
        """
        for i in range(data.ncon):
            c = data.contact[i]
            g1, g2 = int(c.geom1), int(c.geom2)
            if self.object_geom not in (g1, g2):
                continue
            other = g2 if g1 == self.object_geom else g1
            if other not in self.finger_geoms:
                return other
        return None

    def object_linvel(self, data: mujoco.MjData) -> np.ndarray:
        """World-frame linear velocity of the block. Exact: it is a free body, so this is its
        own free joint's first three dof velocities, not a com-based or derived quantity."""
        return np.asarray(data.qvel[self.object_dofadr : self.object_dofadr + 3], dtype=np.float64)

    def over_table(self, pos: np.ndarray) -> bool:
        """Is the block's centre within the table's footprint in x/y?"""
        return (
            abs(float(pos[0]) - self.table_centre_xy[0]) <= self.table_half_xy[0]
            and abs(float(pos[1]) - self.table_centre_xy[1]) <= self.table_half_xy[1]
        )

    def geom_name(self, gid: int | None) -> str | None:
        """A reportable name for a geom.

        The Fetch MJCF leaves the table's geom unnamed, so `mj_id2name` returns None for the one
        surface a dropped block most often lands on. Fall back to the owning body plus the geom
        index rather than publishing a null that reads as "we did not see what it hit".
        """
        if gid is None:
            return None
        name = mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_GEOM, int(gid))
        if name:
            return name
        body = mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_BODY, int(self.model.geom_bodyid[int(gid)]))
        return f"{body or 'world'}:geom{int(gid)}"


def render_body_names(model: mujoco.MjModel) -> list[str]:
    """Every body that carries at least one geom, except `world`, in model order.

    This is the order `frames.data` uses. Bodies with no geometry (the Fetch model's camera
    reference frames) are skipped: a viewer has nothing to draw for them and they would triple
    the frame payload for nothing.
    """
    with_geoms = {int(model.geom_bodyid[g]) for g in range(model.ngeom)}
    out: list[str] = []
    for i in range(model.nbody):
        if i not in with_geoms:
            continue
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, i)
        if name and name != "world":
            out.append(name)
    return out


def render_bodies(model: mujoco.MjModel) -> list[dict[str, Any]]:
    """One drawable primitive per geom, posed LOCAL to its body, read out of the model.

    Composing this with the per-frame body poses gives the world pose of every primitive, with
    nothing about the Fetch arm hard-coded in the viewer.
    """
    out: list[dict[str, Any]] = []
    for g in range(model.ngeom):
        bid = int(model.geom_bodyid[g])
        body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, bid)
        gtype = _GEOM_TYPE_NAMES.get(int(model.geom_type[g]), str(int(model.geom_type[g])))
        size = [float(x) for x in model.geom_size[g]]
        # Classified from the model, not by name: a geom that collides with nothing
        # (contype == conaffinity == 0) is a visual marker, not physical geometry. In this scene
        # that is the environment's mocap gizmo — three 2 m long thin bars on `robot0:mocap`
        # marking the weld target the Fetch env drives the gripper with. A viewer that drew them
        # would put a giant coordinate cross through the picture, so the contract says which is
        # which and every consumer, including render.py, can skip them.
        collides = int(model.geom_contype[g]) != 0 or int(model.geom_conaffinity[g]) != 0
        entry: dict[str, Any] = {
            "body": body,
            "geom": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, g),
            "type": gtype,
            "role": "collision" if collides else "visual_marker",
            "pos_m": [round(float(x), 6) for x in model.geom_pos[g]],
            "quat_wxyz": [round(float(x), 6) for x in model.geom_quat[g]],
            "rgba": [round(float(x), 4) for x in model.geom_rgba[g]],
            "group": int(model.geom_group[g]),
        }
        if gtype == "box":
            entry["half_extent_m"] = [round(v, 6) for v in size[:3]]
        elif gtype == "sphere":
            entry["radius_m"] = round(size[0], 6)
        elif gtype == "capsule" or gtype == "cylinder":
            entry["radius_m"] = round(size[0], 6)
            entry["half_length_m"] = round(size[1], 6)
            entry["axis"] = "local_z"
        elif gtype == "plane":
            entry["half_extent_m"] = [round(size[0], 6), round(size[1], 6)]
        else:
            # Mesh (and anything else a from-data viewer cannot tessellate): publish MuJoCo's
            # own bounding half-extents and say plainly that a box is a proxy, not the shape.
            entry["box_half_extent_m"] = [round(v, 6) for v in size[:3]]
            entry["proxy"] = "box_half_extent_m is MuJoCo's bounding box for the mesh, not its shape"
        out.append(entry)
    return out


def scene_block(env, index: SceneIndex, mutations: dict[str, Any]) -> dict[str, Any]:
    """The `scene` block that goes into every run document."""
    model = env.model
    return {
        "scene_id": SCENE_ID,
        "scene_revision": SCENE_REVISION,
        "env_id": ENV_ID,
        "mjcf_source": (
            "gymnasium_robotics/envs/assets/fetch/pick_and_place.xml, unmodified; "
            "Gymnasium-Robotics is MIT (Farama Foundation)"
        ),
        "mjcf_path": mjcf_path(),
        "mjcf_hash": mjcf_hash(),
        "compiled_model_hash": model_hash(model),
        "mutations": mutations,
        "control_dt_s": round(float(env.dt), 6),
        "physics_timestep_s": round(float(model.opt.timestep), 6),
        "n_substeps": int(env.n_substeps),
        "gravity_mps2": round(float(model.opt.gravity[2]), 6),
        "up_axis": "z",
        "quat_order": "wxyz",
        "distance_threshold_m": round(float(env.distance_threshold), 6),
        "reward_type": str(env.reward_type),
        "object_body": OBJECT_BODY,
        "object_mass_kg": round(float(model.body_mass[index.object_body]), 6),
        "object_half_extent_m": round(index.object_half, 6),
        "object_resting_z_m": round(index.resting_z, 6),
        "table_top_z_m": round(index.table_top_z, 6),
        "table_half_extent_xy_m": [round(v, 6) for v in index.table_half_xy],
        "table_centre_xy_m": [round(v, 6) for v in index.table_centre_xy],
        "finger_geoms": list(FINGER_GEOMS),
        "grip_friction": [
            round(float(model.geom_friction[index.object_geom, 0]), 6),
            round(float(model.geom_friction[index.finger_geoms[0], 0]), 6),
            round(float(model.geom_friction[index.finger_geoms[1], 0]), 6),
        ],
        "floor": {
            "type": "plane",
            "z_m": round(float(model.geom_pos[index.floor_geom][2]), 6),
            "half_extent_m": [
                round(float(model.geom_size[index.floor_geom][0]), 6),
                round(float(model.geom_size[index.floor_geom][1]), 6),
            ],
            "rgba": [round(float(x), 4) for x in model.geom_rgba[index.floor_geom]],
        },
        "goal_marker": {
            "site": TARGET_SITE,
            "half_extent_m": [round(float(x), 6) for x in model.site_size[index.target_site]],
            "rgba": [round(float(x), 4) for x in model.site_rgba[index.target_site]],
            "note": "drawn at `goal_m`, which is fixed for the whole episode",
        },
        "bodies": render_body_names(model),
        "render_bodies": render_bodies(model),
        "compat_shim": compat.info(),
    }
