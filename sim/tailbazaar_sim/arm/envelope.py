"""Operating envelope, scenario schema, admissibility, failure classes and scenario distance
for the manipulator pick-and-place target.

EVERYTHING HERE IS AN ILLUSTRATIVE ASSUMPTION for a demonstration. None of these bounds is
measured on a physical robot. The "robot" is Gymnasium-Robotics' MuJoCo Fetch mannequin driven
by mocap-welded end-effector position commands, not a product, and the "part" it carries is a
5 cm cube. The bounds are chosen to bracket the nominal operating point widely enough that the
question "where does this policy stop holding on to the object?" has an answer inside them,
and each one carries the reasoning that picked it.

Scenario parameters (SI units unless noted):
  object_mass_kg       kg. Mass of the block, with its inertia scaled by the same ratio so the
                       mass distribution is unchanged. The stock MJCF ships 2.0 kg, which is
                       the nominal. READ THIS AXIS AS PAYLOAD MASS, NOT AS A MATERIAL: a 5 cm
                       cube at 2 kg is already a density of 16 000 kg/m^3, denser than lead, so
                       the stock block is not a realistic object either. 0.2 kg is a light
                       plastic part of that size; 20 kg is a payload ten times what the policy
                       ever saw. The bound is deliberately past the interesting region.
  grip_friction        Coulomb sliding coefficient written into geom_friction[0] of the block
                       AND both finger pads. MuJoCo combines a contact pair's friction with the
                       maximum of the two geoms, so lowering only the block would change
                       nothing while the pads still carry 1.0. The stock model ships 1.0 on all
                       three, which is the nominal. 0.02 is an oily or iced part; 1.5 is a
                       tackier pad than the stock rubber.
  object_offset_x_m    m. Offset added to the block's x position AFTER the environment has
  object_offset_y_m    m. sampled its own initial state, so the part is where the policy did
                       not expect while the goal (sampled relative to the gripper, not the
                       block) does not move. +-0.05 m is a third of the environment's own
                       obj_range of 0.15 m, and keeps the block on the table at every seed.
  control_latency_ms   ms, multiple of the 40 ms control tick. The action computed at tick k is
                       applied from tick k + control_latency_ms/40; before the first action
                       arrives the actuators hold a zero action. This is the systems axis every
                       real deployment has. 160 ms is four ticks.
  gripper_latency_ms   ms, multiple of the control tick, applied to the GRIPPER channel only
                       and ON TOP of control_latency_ms. A real gripper's open/close command
                       goes through a different path from the arm's servo loop and can lag it;
                       this axis asks whether the hand closing late, or letting go late, is
                       enough on its own to lose the part.
  action_noise_frac    dimensionless. Standard deviation of zero-mean Gaussian noise added to
                       each commanded action as a fraction of the action half-range (the action
                       box is [-1, 1], so the half-range is 1.0), drawn once per control tick
                       from a seeded generator and clipped back into the box. The seed is
                       derived from the scenario, so a scenario always replays identically.
  init_seed            DISCRETE stratification, not a continuous axis. `reset(seed=s)` makes
                       the environment sample a different block position and a different goal,
                       so each seed is a different pick-and-place problem. Eight of them are
                       published; a finding names the one it was found on.

Failure classes
---------------
DROPPED is decided by a MECHANICAL predicate over MuJoCo's own contact list plus the
ENVIRONMENT's own success flag, not by anything about the policy's intent:

    the block was in contact with BOTH finger pads at tick k-1, and its centre was more than
    AIRBORNE_MARGIN_M above where it rests on the table, and at tick k MuJoCo reports no
    contact with at least one pad, and the environment's own `info["is_success"]` is false.

In plain terms: it was being held, it was off the table, it is no longer being held, and it is
not at the goal. `simulate.py` keeps stepping afterwards so the landing can be measured.

NOT_PLACED is the environment's own verdict: `info["is_success"]` is false at the environment's
own registered episode horizon. That flag is `FetchEnv._is_success`, which is
`goal_distance(achieved_goal, goal) < distance_threshold` with the environment's own 5 cm
threshold. This project implements no success detector; `simulate.py` cross-checks the flag
against the distance it recomputes and publishes the mismatch count in every document.

SUCCESS is that same flag being true at the horizon with no drop on the way.

The marketplace verdict vocabulary (VALID / INVALID / INCONCLUSIVE) is unchanged and lives in
the web layer; INCONCLUSIVE covers the non-conclusive outcomes listed below.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

ENVELOPE_ID = "tb-arm-envelope-1"
ENVELOPE_REVISION = "tb-arm-envelope-1.0"
TARGET_ID = "arm-pick-place-sac-v1"

# Gymnasium-Robotics runs the Fetch model at 0.002 s with n_substeps 20, so one control tick is
# 40 ms (25 Hz). Both latency axes are quantized to it.
DT_CTRL_MS = 40

# How far above its resting height the block's centre must be for a loss of grasp to count as a
# drop rather than a release onto the table. 0.03 m is a little over one block half-width: at
# that height the block is unambiguously in the air and will fall if let go. Fixed and
# documented, NOT an axis, so the predicate has one unambiguous meaning.
AIRBORNE_MARGIN_M = 0.03

ENVELOPE: dict[str, dict[str, Any]] = {
    "object_mass_kg": {"min": 0.2, "max": 20.0, "unit": "kg", "type": "float", "places": 3, "group": "physical"},
    "grip_friction": {"min": 0.02, "max": 1.5, "unit": "coefficient", "type": "float", "places": 3, "group": "physical"},
    "object_offset_x_m": {"min": -0.05, "max": 0.05, "unit": "m", "type": "float", "places": 4, "group": "physical"},
    "object_offset_y_m": {"min": -0.05, "max": 0.05, "unit": "m", "type": "float", "places": 4, "group": "physical"},
    "action_noise_frac": {"min": 0.0, "max": 0.5, "unit": "1", "type": "float", "places": 3, "group": "systems"},
    "control_latency_ms": {"min": 0, "max": 160, "step": DT_CTRL_MS, "unit": "ms", "type": "int", "group": "systems"},
    "gripper_latency_ms": {"min": 0, "max": 160, "step": DT_CTRL_MS, "unit": "ms", "type": "int", "group": "systems"},
}

# Stratified (discrete) axis: one of eight published pick-and-place problems.
INIT_SEEDS = (0, 1, 2, 3, 4, 5, 6, 7)
DISCRETE: dict[str, dict[str, Any]] = {
    "init_seed": {"values": list(INIT_SEEDS), "unit": "1", "type": "int", "group": "physical"},
}

# The nominal operating point: the environment's shipped block mass and friction, the block
# where the environment put it, no action noise, no latency. This is the point the published
# mean_reward was measured at by the policy's publisher.
NOMINAL_SCENARIO: dict[str, Any] = {
    "object_mass_kg": 2.0,
    "grip_friction": 1.0,
    "object_offset_x_m": 0.0,
    "object_offset_y_m": 0.0,
    "action_noise_frac": 0.0,
    "control_latency_ms": 0,
    "gripper_latency_ms": 0,
    "init_seed": 0,
}

PARAM_ORDER = [
    "object_mass_kg",
    "grip_friction",
    "object_offset_x_m",
    "object_offset_y_m",
    "action_noise_frac",
    "control_latency_ms",
    "gripper_latency_ms",
    "init_seed",
]
CONTINUOUS_ORDER = [k for k in PARAM_ORDER if k in ENVELOPE]

# Every axis is optional in an input scenario; an omitted axis is read at its nominal value and
# written back explicitly by normalize(), exactly like the cart's `load_friction`.
OPTIONAL_PARAMS: set[str] = set(PARAM_ORDER)

# What the POLICY's publisher documents about the conditions it was trained and evaluated
# under. Transcribed from the model repository's results.json and config.json, not invented:
# the checkpoint was trained and evaluated on unmodified `FetchPickAndPlace-v4`, which means
# the shipped 2 kg block, shipped friction, the environment's own block placement, no action
# noise and no latency. Anything else in the envelope above is OUTSIDE the conditions the
# policy was published for, and a finding there is a measured boundary of the operating range,
# not a defect report.
POLICY_PUBLISHED_CONDITIONS: dict[str, dict[str, Any]] = {
    "object_mass_kg": {"exactly": 2.0},
    "grip_friction": {"exactly": 1.0},
    "object_offset_x_m": {"exactly": 0.0},
    "object_offset_y_m": {"exactly": 0.0},
    "action_noise_frac": {"exactly": 0.0},
    "control_latency_ms": {"exactly": 0},
    "gripper_latency_ms": {"exactly": 0},
}
PUBLISHED_CONDITIONS_PROSE = (
    "unmodified Gymnasium-Robotics FetchPickAndPlace-v4: the shipped 2 kg block, shipped friction, "
    "the environment's own block and goal sampling, no action noise, no control latency"
)
UNSTATED_PARAMS: dict[str, str] = {
    "init_seed": "the publisher evaluated 10 unspecified deterministic episodes; the seeds are not published",
}
PRODUCT_QUESTION = (
    "This policy is published as placing the block in about ten control steps, every episode. How "
    "far can the operating range be widened - a heavier part, a slipperier one, a part that is not "
    "quite where it was expected, noisy or delayed actuation - before it drops what it is carrying?"
)

FAILURE_CLASSES = ("DROPPED", "NOT_PLACED")
NO_FAILURE = "NONE"
# Outcomes that answer the product question. Anything else is INCONCLUSIVE for the marketplace.
CONCLUSIVE_OUTCOMES = ("SUCCESS", "DROPPED", "NOT_PLACED")
INCONCLUSIVE_OUTCOMES = ("DIVERGED", "INVALID_INITIAL_STATE", "REJECTED_OUT_OF_ENVELOPE")
INCONCLUSIVE = "INCONCLUSIVE"

# Outcome precedence, applied top to bottom by simulate.py. A run that dropped the block and
# then recovered and placed it anyway is still a DROP — the marketplace question is literally
# "does this arm drop things" — but the run document carries `recovered_after_drop: true` and
# the environment's own success flag, so nobody has to take that on trust.
OUTCOME_PRECEDENCE = ("DIVERGED", "INVALID_INITIAL_STATE", "DROPPED", "NOT_PLACED", "SUCCESS")

DUPLICATE_DISTANCE = 0.05


def in_published_conditions(scn: dict[str, Any]) -> dict[str, bool | None]:
    """Per axis: is this value inside the conditions the policy was published for?

    None means the publisher states nothing about that axis (see UNSTATED_PARAMS); it is
    neither inside nor outside a range that does not exist.
    """
    out: dict[str, bool | None] = {}
    for k, spec in POLICY_PUBLISHED_CONDITIONS.items():
        v = float(scn[k])
        if "exactly" in spec:
            out[k] = v == float(spec["exactly"])
        elif "min" in spec:
            out[k] = v >= float(spec["min"])
        else:
            out[k] = v <= float(spec["max"])
    for k in UNSTATED_PARAMS:
        out[k] = None
    return out


def check_admissible(scn: dict[str, Any]) -> list[str]:
    """Return a list of violations (empty means admissible)."""
    problems: list[str] = []
    for k in CONTINUOUS_ORDER:
        if k not in scn:
            continue  # optional: read at nominal
        spec = ENVELOPE[k]
        v = scn[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            problems.append(f"{k} must be a number")
            continue
        if spec["type"] == "int":
            if int(v) != v:
                problems.append(f"{k} must be an integer number of ms")
            elif int(v) % spec["step"] != 0:
                problems.append(f"{k} must be a multiple of {spec['step']} ms (one control tick)")
        else:
            if round(float(v), spec["places"]) != float(v):
                problems.append(f"{k} must have at most {spec['places']} decimal places")
        if v < spec["min"] or v > spec["max"]:
            problems.append(f"{k}={v} outside [{spec['min']}, {spec['max']}]")
    if "init_seed" in scn:
        s = scn["init_seed"]
        if isinstance(s, bool) or not isinstance(s, int) or s not in INIT_SEEDS:
            problems.append(f"init_seed must be one of {list(INIT_SEEDS)}")
    extra = sorted(set(scn) - set(PARAM_ORDER))
    if extra:
        problems.append(f"unknown parameters: {extra}")
    return problems


def normalize(scn: dict[str, Any]) -> dict[str, Any]:
    """Round and order a scenario. Omitted axes are filled in at their nominal value."""
    out: dict[str, Any] = {}
    for k in PARAM_ORDER:
        v = scn.get(k, NOMINAL_SCENARIO[k])
        if k == "init_seed":
            out[k] = int(v)
            continue
        spec = ENVELOPE[k]
        out[k] = int(v) if spec["type"] == "int" else round(float(v), spec["places"])
    return out


def snap_latency(ms: float) -> int:
    """Snap a latency to the control tick."""
    return int(round(ms / DT_CTRL_MS) * DT_CTRL_MS)


def _axis_gap(k: str, av: float, bv: float) -> float:
    spec = ENVELOPE[k]
    span = float(spec["max"]) - float(spec["min"])
    return abs(av - bv) / span


def scenario_distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Normalized L-infinity distance over the CONTINUOUS axes.

    `init_seed` is a stratification, not a coordinate: two runs from different block and goal
    placements are different findings, so the distance is infinite unless the seeds match.
    Axes missing from either scenario are read at their nominal value.

    Unlike the humanoid's push axes there are no conditional axes here: every axis of this
    envelope changes the dynamics on its own at every point of the envelope, so none of them
    can ever describe nothing.
    """
    if int(a.get("init_seed", NOMINAL_SCENARIO["init_seed"])) != int(
        b.get("init_seed", NOMINAL_SCENARIO["init_seed"])
    ):
        return math.inf
    d = 0.0
    for k in CONTINUOUS_ORDER:
        av = float(a.get(k, NOMINAL_SCENARIO[k]))
        bv = float(b.get(k, NOMINAL_SCENARIO[k]))
        d = max(d, _axis_gap(k, av, bv))
    return d


def is_duplicate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return scenario_distance(a, b) < DUPLICATE_DISTANCE


def normalize_failure_classes(classes: Iterable[str]) -> list[str]:
    s = set(classes)
    unknown = s - set(FAILURE_CLASSES)
    if unknown:
        raise ValueError(f"unknown failure classes: {sorted(unknown)}")
    return [c for c in FAILURE_CLASSES if c in s]


def finding_distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    ca = normalize_failure_classes(a.get("failure_classes") or [])
    cb = normalize_failure_classes(b.get("failure_classes") or [])
    if ca != cb:
        return math.inf
    return scenario_distance(a["scenario"], b["scenario"])


def is_duplicate_finding(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return finding_distance(a, b) < DUPLICATE_DISTANCE


DUPLICATE_RULE_PROSE = (
    "two findings are approximate duplicates when they carry the same set of failure classes AND the "
    "same init_seed AND their scenarios are closer than "
    f"{DUPLICATE_DISTANCE} in normalized L-infinity distance over the seven continuous envelope axes; "
    "findings from different initial states or different classes are never duplicates of each other"
)
