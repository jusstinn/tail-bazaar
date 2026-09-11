"""One compatibility shim, needed to run Gymnasium-Robotics 1.4.2 on MuJoCo 3.13.0.

THE PROBLEM
-----------
`gymnasium_robotics/utils/mujoco_utils.py` decides how many qpos/qvel slots a joint
occupies and then guards the fall-through case with

    assert joint_type in (mujoco.mjtJoint.mjJNT_HINGE, mujoco.mjtJoint.mjJNT_SLIDE)

`joint_type` comes from `model.jnt_type[joint_id]`, which is a **numpy int32**, and the
tuple holds **pybind11 enum** members. On this pin that containment test is false even
though the equality test is true:

    np.int32(2) == mujoco.mjtJoint.mjJNT_SLIDE   ->  True
    np.int32(2) in (mjJNT_HINGE, mjJNT_SLIDE)    ->  False      # <- the bug
    2          in (mjJNT_HINGE, mjJNT_SLIDE)     ->  True

`in` compares with the tuple member on the left (`mjJNT_SLIDE.__eq__(np.int32(2))`, which
is False), while a plain `==` puts the numpy scalar on the left and succeeds. The result is
that `gym.make("FetchPickAndPlace-v4")` raises `AssertionError` from inside the environment
constructor, before a single step is taken. It happens at four sites in that one file:
`set_joint_qpos`, `set_joint_qvel`, `get_joint_qpos`, `get_joint_qvel`.

This is an upstream incompatibility between two pinned third-party versions, not something
this project caused and not something this project can fix by choosing better numbers. The
alternative — pinning MuJoCo down to a version Gymnasium-Robotics was tested against —
would move the engine pin the cart and humanoid targets already published evidence
against, so it is not available.

THE SHIM
--------
`mujoco_utils` reaches the enum through its own module-global name `mujoco`. Rebinding that
one name to a proxy whose `mjtJoint` members are plain Python ints makes every comparison
in the file behave the way its author intended, because `int(enum) == enum` and the branch
conditions compare against nothing but `mjtJoint` members. Every other attribute
(`mj_name2id`, `mjtObj`, `mj_jacSite`, ...) is forwarded to the real module untouched.

NO UPSTREAM LOGIC IS REPRODUCED HERE. The shim copies no function body, changes no branch,
and touches no numeric behaviour: the same `ndim` is selected, the same qpos slots are
written. That is the point of doing it this way rather than vendoring corrected copies of
four functions, which could silently drift from the version actually installed.

`verify()` proves the claim rather than asserting it, and `arm.cli selfcheck` runs it: it
writes a known value into a slide joint and a free joint through the patched functions and
reads the raw `data.qpos` back, so a future version that changes the semantics of those
functions fails loudly instead of quietly producing different physics.

Installed versions are pinned and checked, so this shim can never be applied to a
Gymnasium-Robotics that has fixed the problem itself (see `PATCHED_VERSIONS`).
"""

from __future__ import annotations

from typing import Any

import mujoco

# The exact Gymnasium-Robotics versions whose `mujoco_utils` is known to carry the four
# `assert ... in (enum, enum)` sites described above. A different version is not patched
# blind: `apply()` refuses and says so.
PATCHED_VERSIONS = ("1.4.2",)

AFFECTED_FUNCTIONS = ("set_joint_qpos", "set_joint_qvel", "get_joint_qpos", "get_joint_qvel")

SHIM_NOTE = {
    "why": (
        "gymnasium-robotics 1.4.2 guards its joint-slot arithmetic with "
        "`assert joint_type in (mujoco.mjtJoint.mjJNT_HINGE, mujoco.mjtJoint.mjJNT_SLIDE)`; on "
        "mujoco 3.13.0 that containment test is False for the numpy int32 the model returns, "
        "even though the corresponding `==` is True. The environment cannot be constructed at all."
    ),
    "what": (
        "the module-global name `mujoco` inside gymnasium_robotics.utils.mujoco_utils is rebound to "
        "a proxy that forwards every attribute to the real mujoco module except `mjtJoint`, whose "
        "four members are plain Python ints"
    ),
    "reproduces_no_upstream_logic": True,
    "changes_physics": False,
    "verified_by": "tailbazaar_sim.arm.compat.verify(), run by `arm.cli selfcheck`",
}


class _JointTypes:
    """`mujoco.mjtJoint` with plain-int members. Values read from the real enum, not typed in."""

    mjJNT_FREE = int(mujoco.mjtJoint.mjJNT_FREE)
    mjJNT_BALL = int(mujoco.mjtJoint.mjJNT_BALL)
    mjJNT_SLIDE = int(mujoco.mjtJoint.mjJNT_SLIDE)
    mjJNT_HINGE = int(mujoco.mjtJoint.mjJNT_HINGE)


class _MujocoProxy:
    """Everything is the real `mujoco`; only `mjtJoint` is the int-valued stand-in."""

    mjtJoint = _JointTypes

    def __getattr__(self, name: str) -> Any:
        return getattr(mujoco, name)


_APPLIED = False


def robotics_version() -> str:
    import gymnasium_robotics

    return str(gymnasium_robotics.__version__)


def apply() -> bool:
    """Install the shim if this Gymnasium-Robotics version needs it. Idempotent.

    Returns True if the shim is in force. Raises if the installed version is not one this
    shim was written against, rather than patching an unknown version blind.
    """
    global _APPLIED
    if _APPLIED:
        return True
    version = robotics_version()
    if version not in PATCHED_VERSIONS:
        raise RuntimeError(
            f"gymnasium-robotics {version} is installed; this compatibility shim was written and "
            f"verified against {list(PATCHED_VERSIONS)}. Check whether the upstream "
            f"`assert joint_type in (...)` sites still exist before widening PATCHED_VERSIONS."
        )
    import gymnasium_robotics.utils.mujoco_utils as mujoco_utils

    missing = [fn for fn in AFFECTED_FUNCTIONS if not hasattr(mujoco_utils, fn)]
    if missing:
        raise RuntimeError(f"gymnasium_robotics.utils.mujoco_utils is missing {missing}")
    mujoco_utils.mujoco = _MujocoProxy()
    _APPLIED = True
    return True


def bug_is_present() -> bool:
    """True when the numpy-int/enum containment test actually misbehaves on this install."""
    import numpy as np

    jt = np.int32(int(mujoco.mjtJoint.mjJNT_SLIDE))
    return bool(jt == mujoco.mjtJoint.mjJNT_SLIDE) and not (
        jt in (mujoco.mjtJoint.mjJNT_HINGE, mujoco.mjtJoint.mjJNT_SLIDE)
    )


def verify() -> dict[str, Any]:
    """Prove the patched accessors still write and read the slots they are supposed to.

    Builds a throwaway model with one slide joint and one free body, writes known values
    through the patched functions, and compares against `data.qpos` read directly. If a
    future version of either library changes what these functions mean, this fails.
    """
    import numpy as np

    apply()
    import gymnasium_robotics.utils.mujoco_utils as mujoco_utils

    xml = """
    <mujoco>
      <worldbody>
        <body name="slider">
          <joint name="s" type="slide" axis="1 0 0" range="-5 5"/>
          <geom size="0.05"/>
        </body>
        <body name="freebody" pos="0 0 1">
          <joint name="f" type="free"/>
          <geom size="0.05"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    s_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, "s")
    f_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, "f")
    s_adr = int(model.jnt_qposadr[s_id])
    f_adr = int(model.jnt_qposadr[f_id])

    # Zero everything first so "did this write spill into a neighbouring slot?" is answerable.
    data.qpos[:] = 0.0
    data.qvel[:] = 0.0
    mujoco_utils.set_joint_qpos(model, data, "s", 1.25)
    slide_only = data.qpos.copy()
    free_value = np.array([0.1, 0.2, 0.3, 1.0, 0.0, 0.0, 0.0])
    mujoco_utils.set_joint_qpos(model, data, "f", free_value)
    mujoco_utils.set_joint_qvel(model, data, "s", -0.5)

    s_dofadr = int(model.jnt_dofadr[s_id])
    checks = {
        "slide_qpos_slot_written": float(data.qpos[s_adr]) == 1.25,
        "slide_wrote_exactly_one_slot": int(np.count_nonzero(slide_only)) == 1,
        "free_qpos_slots_written": np.array_equal(data.qpos[f_adr : f_adr + 7], free_value),
        "slide_qvel_slot_written": float(data.qvel[s_dofadr]) == -0.5,
        "get_joint_qpos_roundtrip": float(mujoco_utils.get_joint_qpos(model, data, "s")[0]) == 1.25,
        "get_joint_qpos_free_roundtrip": np.array_equal(
            np.asarray(mujoco_utils.get_joint_qpos(model, data, "f")), free_value
        ),
        "get_joint_qvel_roundtrip": float(mujoco_utils.get_joint_qvel(model, data, "s")[0]) == -0.5,
    }
    return {
        "gymnasium_robotics_version": robotics_version(),
        "mujoco_version": mujoco.__version__,
        "bug_present_without_shim": bug_is_present(),
        "shim_applied": _APPLIED,
        "checks": {k: bool(v) for k, v in checks.items()},
        "ok": all(checks.values()),
        **SHIM_NOTE,
    }


def info() -> dict[str, Any]:
    """The block that goes into every run document, so evidence records the shim."""
    return {
        "gymnasium_robotics_version": robotics_version(),
        "shim_applied": _APPLIED,
        "affected_functions": list(AFFECTED_FUNCTIONS),
        **SHIM_NOTE,
    }
