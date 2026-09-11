"""The scene under test: Unitree's own `g1_12dof.xml` + `scene.xml`, unmodified except along the
envelope axes.

The MJCF is NOT authored here. It is the model shipped in `unitreerobotics/unitree_rl_gym` at the
commit recorded in PROVENANCE.md, vendored verbatim under `assets/g1_description/` together with
the 27 STL meshes it references. Two things are mutated after the model is compiled, both of them
declared envelope axes:

  floor_friction    written into geom_friction[:, 0] of EVERY geom. MuJoCo combines a contact
                    pair's friction with the maximum of the two geoms, so lowering only the floor
                    would change nothing while the feet still carry 1.0. Neither the scene nor the
                    robot declares a friction, so every geom compiles with MuJoCo's default 1.0,
                    and writing one value everywhere reproduces the stock scene exactly at the
                    nominal point.
  body_mass_scale   multiplies body_mass and body_inertia by the same factor, so the mass
                    DISTRIBUTION and every principal-axis ratio are unchanged and only the scale
                    moves. `mj_setConst` is called afterwards to refresh the derived quantities.

One thing is SET rather than mutated: `opt.timestep = 0.002`, exactly as the publisher's runner
sets it (the scene declares none, and MuJoCo's default happens to be the same value).

The MJCF text, the mesh files and the compiled, mutated model are all hashed into every run
document, so a replay can prove it ran against the same scene.

`render_bodies` is read straight out of the compiled model and published in the run document so a
viewer can draw the robot from data. This robot is meshes, which a JSON document cannot carry, so
each mesh geom publishes: the asset name and file, MuJoCo's own bounding box (a PROXY, labelled as
such), and the geom's frame in TWO forms — the compiled one (`pos_m`/`quat_wxyz`, which includes
MuJoCo's re-centring of the mesh on its centre of mass and is where the proxy box belongs) and the
MJCF one (`mesh_frame_pos_m`/`mesh_frame_quat_wxyz`, the frame the raw STL vertices live in).
Every geom also says whether it is visual (`contype=0 conaffinity=0`, group 1) or collision, so a
viewer draws each link once.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import mujoco
import numpy as np

SCENE_ID = "unitree-g1-12dof-scene"
SCENE_REVISION = 1

ASSETS = Path(__file__).resolve().parent / "assets"
MJCF_SCENE = ASSETS / "g1_description" / "scene.xml"
MJCF_ROBOT = ASSETS / "g1_description" / "g1_12dof.xml"
MESH_DIR = ASSETS / "g1_description" / "meshes"
# Pinned at vendoring time (PROVENANCE.md) and checked at load time.
MJCF_ROBOT_SHA256 = "747ede40aa726b7352bae8353e95d0d0f908cec2257a27cbd78bc6e5a2d5a314"
MJCF_SCENE_SHA256 = "482d49902ca2b9fdc49d84ef5d8779fa69d66bc53ef440b4bf50079d1bac9995"

PHYSICS_TIMESTEP_S = 0.002   # deploy_mujoco configs/g1.yaml: simulation_dt
CONTROL_DECIMATION = 10      # configs/g1.yaml: control_decimation -> 50 Hz control
STOCK_FRICTION = 1.0         # MuJoCo's default sliding friction; neither XML declares one
EXPECTED_NQ = 19             # 7 (free joint) + 12 actuated joints
EXPECTED_NV = 18
EXPECTED_NU = 12

PUSH_BODY = "pelvis"
# Bodies whose contact with the floor is a normal part of walking: the four contact spheres of each
# foot hang off the ankle-roll link. Everything else touching the floor is ground contact of a body
# that should not be on the ground.
FOOT_BODIES = ("left_ankle_roll_link", "right_ankle_roll_link")
FLOOR_GEOM = "floor"

# Actuator order of the model, which is also the order of the publisher's gains and default angles.
JOINT_ORDER = (
    "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint", "left_knee_joint",
    "left_ankle_pitch_joint", "left_ankle_roll_joint",
    "right_hip_pitch_joint", "right_hip_roll_joint", "right_hip_yaw_joint", "right_knee_joint",
    "right_ankle_pitch_joint", "right_ankle_roll_joint",
)

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


def _sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def mjcf_hash() -> str:
    """sha256 over the two XML files, in a fixed order, each prefixed by its name."""
    h = hashlib.sha256()
    for p in (MJCF_SCENE, MJCF_ROBOT):
        h.update(p.name.encode() + b"\0" + p.read_bytes() + b"\0")
    return "sha256:" + h.hexdigest()


def mesh_manifest() -> list[dict[str, Any]]:
    return [{"file": p.name, "bytes": p.stat().st_size, "sha256": _sha256_file(p)} for p in sorted(MESH_DIR.glob("*.STL"))]


def mesh_manifest_hash(manifest: list[dict[str, Any]] | None = None) -> str:
    h = hashlib.sha256()
    for m in manifest if manifest is not None else mesh_manifest():
        h.update(f"{m['file']}:{m['sha256']}\n".encode())
    return "sha256:" + h.hexdigest()


def check_assets() -> list[str]:
    problems: list[str] = []
    if _sha256_file(MJCF_ROBOT) != MJCF_ROBOT_SHA256:
        problems.append("g1_12dof.xml does not match the pinned sha256")
    if _sha256_file(MJCF_SCENE) != MJCF_SCENE_SHA256:
        problems.append("scene.xml does not match the pinned sha256")
    return problems


def make_model(floor_friction: float, body_mass_scale: float) -> tuple[mujoco.MjModel, mujoco.MjData]:
    """Compile the vendored scene and apply the two physical-axis mutations."""
    model = mujoco.MjModel.from_xml_path(str(MJCF_SCENE))
    model.opt.timestep = PHYSICS_TIMESTEP_S
    data = mujoco.MjData(model)
    model.geom_friction[:, 0] = float(floor_friction)
    if body_mass_scale != 1.0:
        model.body_mass[:] = model.body_mass * float(body_mass_scale)
        model.body_inertia[:] = model.body_inertia * float(body_mass_scale)
        mujoco.mj_setConst(model, data)
    return model, data


def model_hash(model: mujoco.MjModel) -> str:
    """Digest of the compiled, MUTATED model parameters that matter for the dynamics, mesh vertices
    included (the meshes ARE the collision geometry of this robot)."""
    h = hashlib.sha256()
    for arr in (
        model.body_mass, model.body_inertia, model.body_pos, model.body_quat, model.body_ipos, model.body_iquat,
        model.geom_friction, model.geom_size, model.geom_pos, model.geom_quat, model.geom_contype, model.geom_conaffinity,
        model.dof_damping, model.dof_armature, model.dof_frictionloss, model.jnt_range, model.jnt_actfrcrange,
        model.actuator_gear, model.actuator_ctrlrange, model.mesh_vert, model.mesh_face,
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


def _quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    out = np.zeros(4)
    mujoco.mju_mulQuat(out, a, b)
    return out


def _quat_conj(q: np.ndarray) -> np.ndarray:
    return np.array([q[0], -q[1], -q[2], -q[3]])


def _rotate(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    out = np.zeros(3)
    mujoco.mju_rotVecQuat(out, v, q)
    return out


def render_bodies(model: mujoco.MjModel) -> list[dict[str, Any]]:
    """Geometry per body, local to that body frame, for a data-driven viewer (see module docstring)."""
    out: list[dict[str, Any]] = []
    r6 = lambda xs: [round(float(x), 6) for x in xs]  # noqa: E731
    for i in range(model.ngeom):
        body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[i]))
        if body == "world":
            continue
        gtype = _GEOM_TYPE_NAMES.get(int(model.geom_type[i]), str(int(model.geom_type[i])))
        size = r6(model.geom_size[i])
        visual = int(model.geom_contype[i]) == 0 and int(model.geom_conaffinity[i]) == 0
        entry: dict[str, Any] = {
            "body": body,
            "geom": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) or None,
            "geom_index": i,
            "type": gtype,
            "role": "visual" if visual else "collision",
            "group": int(model.geom_group[i]),
            "pos_m": r6(model.geom_pos[i]),
            "quat_wxyz": r6(model.geom_quat[i]),
            "rgba": [round(float(x), 3) for x in model.geom_rgba[i]],
        }
        if gtype == "sphere":
            entry["radius_m"] = size[0]
        elif gtype == "capsule":
            entry["radius_m"], entry["half_length_m"], entry["axis"] = size[0], size[1], "local_z"
        elif gtype == "cylinder":
            entry["radius_m"], entry["half_length_m"], entry["axis"] = size[0], size[1], "local_z"
        elif gtype == "box":
            entry["half_extent_m"] = size[:3]
        elif gtype == "mesh":
            mid = int(model.geom_dataid[i])
            aabb = model.geom_aabb[i]
            mesh_pos = np.array(model.mesh_pos[mid], dtype=np.float64)
            mesh_quat = np.array(model.mesh_quat[mid], dtype=np.float64)
            gq = np.array(model.geom_quat[i], dtype=np.float64)
            gp = np.array(model.geom_pos[i], dtype=np.float64)
            # compiled = mjcf o centring  =>  mjcf = compiled o centring^-1
            mjcf_q = _quat_mul(gq, _quat_conj(mesh_quat))
            mjcf_p = gp - _rotate(mjcf_q, mesh_pos)
            entry.update({
                "mesh": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mid),
                "mesh_file": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mid) + ".STL",
                "mesh_scale": [1.0, 1.0, 1.0],
                "box_center_m": r6(aabb[:3]),
                "box_half_extent_m": r6(aabb[3:6]),
                "proxy": "box_half_extent_m is MuJoCo's bounding box of the re-centred mesh, a proxy for the shape; the STL itself belongs at mesh_frame_pos_m/mesh_frame_quat_wxyz",
                "mesh_frame_pos_m": r6(mjcf_p),
                "mesh_frame_quat_wxyz": r6(mjcf_q),
            })
        else:
            entry["size_m"] = size
        out.append(entry)
    return out


def head_reach_above_pelvis(model: mujoco.MjModel) -> float:
    """Highest point of any pelvis-body geom above the pelvis origin, at qpos0 (upright), from the
    compiled bounding boxes. This is the number the plausibility ceiling's free-fall term uses."""
    pelvis = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, PUSH_BODY)
    top = 0.0
    for i in range(model.ngeom):
        if int(model.geom_bodyid[i]) != pelvis:
            continue
        if int(model.geom_type[i]) == int(mujoco.mjtGeom.mjGEOM_MESH):
            c, h = np.array(model.geom_aabb[i][:3]), np.array(model.geom_aabb[i][3:6])
        else:
            c, h = np.zeros(3), np.array([float(model.geom_size[i].max())] * 3)
        q = np.array(model.geom_quat[i], dtype=np.float64)
        centre = np.array(model.geom_pos[i]) + _rotate(q, c)
        # the rotated box's vertical half-extent
        R = np.zeros(9)
        mujoco.mju_quat2Mat(R, q)
        hz = float(np.abs(R.reshape(3, 3)[2] * h).sum())
        top = max(top, float(centre[2]) + hz)
    return top


def scene_description(model: mujoco.MjModel, floor_friction: float, body_mass_scale: float) -> dict[str, Any]:
    floor_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, FLOOR_GEOM)
    manifest = mesh_manifest()
    return {
        "scene_id": SCENE_ID,
        "scene_revision": SCENE_REVISION,
        "mjcf_source": "unitreerobotics/unitree_rl_gym resources/robots/g1_description/{scene.xml,g1_12dof.xml} @ 276801e4, unmodified",
        "mjcf_path": str(MJCF_SCENE),
        "mjcf_hash": mjcf_hash(),
        "mesh_manifest_sha256": mesh_manifest_hash(manifest),
        "mesh_files": [m["file"] for m in manifest],
        "compiled_model_hash": model_hash(model),
        "mutations": {
            "geom_friction_sliding": round(float(floor_friction), 6),
            "body_mass_scale": round(float(body_mass_scale), 6),
            "stock_geom_friction_sliding": STOCK_FRICTION,
            "timestep_set_s": PHYSICS_TIMESTEP_S,
            "note": "no other model field is written; mass scaling multiplies body_inertia by the same factor; the timestep is set to the publisher's own value",
        },
        "bodies": body_names(model),
        "joint_order": list(JOINT_ORDER),
        "render_bodies": render_bodies(model),
        "floor": {
            "type": "plane",
            "half_extent_m": [round(float(x), 4) for x in model.geom_size[floor_id][:2]],
            "z_m": round(float(model.geom_pos[floor_id][2]), 6),
            "rgba": [round(float(x), 3) for x in model.geom_rgba[floor_id]],
        },
        "total_mass_kg": round(float(model.body_mass.sum()), 4),
        "push_body": PUSH_BODY,
        "foot_bodies": list(FOOT_BODIES),
        "pelvis_z0_m": round(float(model.qpos0[2]), 6),
        "head_reach_above_pelvis_m": round(head_reach_above_pelvis(model), 6),
        "control_dt_s": round(PHYSICS_TIMESTEP_S * CONTROL_DECIMATION, 6),
        "physics_timestep_s": float(model.opt.timestep),
        "control_decimation": CONTROL_DECIMATION,
        "gravity_mps2": float(model.opt.gravity[2]),
        "quat_order": "wxyz",
        "up_axis": "z",
    }


def check_model(model: mujoco.MjModel) -> list[str]:
    """Guard against the vendored model differing from what the port assumes."""
    problems = check_assets()
    if model.nq != EXPECTED_NQ or model.nv != EXPECTED_NV or model.nu != EXPECTED_NU:
        problems.append(f"model dims nq={model.nq} nv={model.nv} nu={model.nu} != expected {EXPECTED_NQ}/{EXPECTED_NV}/{EXPECTED_NU}")
    for k, name in enumerate(JOINT_ORDER):
        if mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_ACTUATOR, k) != name:
            problems.append(f"actuator {k} is not {name}")
    if abs(float(model.opt.timestep) - PHYSICS_TIMESTEP_S) > 1e-12:
        problems.append(f"physics timestep {model.opt.timestep} != {PHYSICS_TIMESTEP_S}")
    if mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, FLOOR_GEOM) < 0:
        problems.append("no floor geom")
    return problems
