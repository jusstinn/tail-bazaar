"""Operating envelope, scenario schema, admissibility, failure class and scenario distance for the
Unitree G1 walking target.

EVERYTHING HERE IS AN ILLUSTRATIVE ASSUMPTION for a demonstration. None of these bounds is
measured on a physical robot. The simulated robot is Unitree's own 12-dof MuJoCo model of the G1
(about 32 kg with the arms, torso and head folded into one rigid pelvis body) under Unitree's own
pretrained walking policy; the bounds are chosen to bracket the publisher's deployment
configuration widely enough that the question "where does this policy stop working?" has an
answer inside them, and each one carries the reasoning that picked it.

Scenario parameters (SI units unless noted):
  push_impulse_ns      N*s. Magnitude of a single external impulse applied to the pelvis body's
                       centre of mass as a constant world-frame force held for PUSH_DURATION_S
                       (0.1 s = 5 control ticks = 50 physics steps). 0 means no push. Upper bound
                       60 N*s = 1.9 m/s of velocity change on a 32 kg body: a shove hard enough
                       that surviving it would be surprising, so the bound does not hide the
                       interesting region.
  push_heading_deg     deg. Direction of that force in the world horizontal plane, 0 = +x, the
                       direction the policy is commanded to walk, counter-clockwise. CIRCULAR.
  push_time_s          s. When the push starts. Must be an exact multiple of the 20 ms control
                       tick. 1.0 s (tick 50) lets the gait settle out of the straight-legged
                       initial pose; 8.0 s (tick 400) leaves >= 6.9 s of episode after the window.
  floor_friction       Coulomb sliding coefficient written into geom_friction[0] of every geom.
                       MuJoCo's default 1.0 (nothing in the vendored XML declares one) is nominal.
  body_mass_scale      dimensionless multiplier on every body mass AND matching inertia.
  actuator_noise_frac  dimensionless. Standard deviation of zero-mean Gaussian noise added to each
                       joint POSITION TARGET the PD loop tracks, as a fraction of the policy's own
                       0.25 rad action scale (so 0.3 = 0.075 rad = 4.3 deg of target jitter),
                       drawn once per control tick from a generator seeded by the scenario.
  control_latency_ms   ms, multiple of the 20 ms control tick. The target computed at tick k is
                       applied from tick k + latency/20; until the first target arrives the PD
                       loop holds the publisher's default joint angles (a zero-order hold on the
                       target, which is what a delayed position command is).
  cmd_vx_mps           m/s. The forward velocity command the policy is given (the first entry of
                       the publisher's `cmd_init`, 0.5 m/s). Lateral and yaw commands stay 0.

Failure class
-------------
FELL, and — unlike the Gymnasium humanoid — it is THIS PROJECT'S predicate, because the
publisher's runner has no notion of failure at all (it just keeps stepping). simulate.py states
it: the pelvis height drops below FALL_HEIGHT_FRACTION of the measured nominal standing height,
OR the pelvis tilts past FALL_TILT_DEG from vertical, whichever first; the run document records
which of the two fired and when.

The marketplace verdict vocabulary (VALID / INVALID / INCONCLUSIVE) is unchanged and lives in
the web layer; INCONCLUSIVE covers the non-conclusive outcomes listed below.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

from . import TARGET_ID  # noqa: F401  (re-exported)

ENVELOPE_ID = "tb-g1-envelope-1"
ENVELOPE_REVISION = "tb-g1-envelope-1.0"

# Unitree's runner steps MuJoCo at 0.002 s and evaluates the policy every 10 steps, so one control
# tick is 20 ms (50 Hz). The latency axis and the push window are quantized to it.
DT_CTRL_MS = 20
PUSH_DURATION_S = 0.1  # 5 control ticks; fixed, documented, NOT an axis

ENVELOPE: dict[str, dict[str, Any]] = {
    "push_impulse_ns": {"min": 0.0, "max": 60.0, "unit": "N*s", "type": "float", "places": 2, "group": "physical"},
    "push_heading_deg": {"min": 0.0, "max": 360.0, "unit": "deg", "type": "float", "places": 1, "group": "physical", "circular": True},
    "push_time_s": {"min": 1.0, "max": 8.0, "unit": "s", "type": "float", "places": 3, "group": "physical", "step": 0.02},
    "floor_friction": {"min": 0.4, "max": 1.4, "unit": "1", "type": "float", "places": 3, "group": "physical"},
    "body_mass_scale": {"min": 0.8, "max": 1.25, "unit": "1", "type": "float", "places": 3, "group": "physical"},
    "actuator_noise_frac": {"min": 0.0, "max": 0.3, "unit": "1", "type": "float", "places": 3, "group": "systems"},
    "control_latency_ms": {"min": 0, "max": 100, "step": DT_CTRL_MS, "unit": "ms", "type": "int", "group": "systems"},
    "cmd_vx_mps": {"min": 0.0, "max": 1.0, "unit": "m/s", "type": "float", "places": 2, "group": "command"},
}

# No discrete stratification axis: the publisher's runner starts every run from the model's own
# qpos0 and so does this target. One initial state, published in every run document.
DISCRETE: dict[str, dict[str, Any]] = {}

# The nominal operating point IS the publisher's deployment configuration: no push, stock
# friction and masses, no noise, no latency, cmd_init = walk forward at 0.5 m/s.
NOMINAL_SCENARIO: dict[str, Any] = {
    "push_impulse_ns": 0.0,
    "push_heading_deg": 0.0,
    "push_time_s": 3.0,
    "floor_friction": 1.0,
    "body_mass_scale": 1.0,
    "actuator_noise_frac": 0.0,
    "control_latency_ms": 0,
    "cmd_vx_mps": 0.5,
}

PARAM_ORDER = [
    "push_impulse_ns",
    "push_heading_deg",
    "push_time_s",
    "floor_friction",
    "body_mass_scale",
    "actuator_noise_frac",
    "control_latency_ms",
    "cmd_vx_mps",
]
CONTINUOUS_ORDER = [k for k in PARAM_ORDER if k in ENVELOPE]
OPTIONAL_PARAMS: set[str] = set(PARAM_ORDER)

# What the POLICY's publisher documents: only the deployment configuration. No push, MuJoCo's
# default friction, stock masses, no noise, no latency, cmd_init 0.5 m/s. Anything else in the
# envelope is OUTSIDE the conditions the policy was published for, and a finding there is a
# measured boundary of the operating range, not a defect report.
POLICY_PUBLISHED_CONDITIONS: dict[str, dict[str, Any]] = {
    "push_impulse_ns": {"exactly": 0.0},
    "floor_friction": {"exactly": 1.0},
    "body_mass_scale": {"exactly": 1.0},
    "actuator_noise_frac": {"exactly": 0.0},
    "control_latency_ms": {"exactly": 0},
    "cmd_vx_mps": {"exactly": 0.5},
}
PUBLISHED_CONDITIONS_PROSE = (
    "Unitree's own MuJoCo deployment configuration (deploy_mujoco/configs/g1.yaml): no external push, "
    "MuJoCo's default floor friction 1.0, stock body masses, no actuator noise, no control latency, "
    "a forward velocity command of 0.5 m/s"
)
UNSTATED_PARAMS: dict[str, str] = {
    "push_heading_deg": "meaningless while push_impulse_ns is 0; the publisher states nothing about pushes",
    "push_time_s": "same",
}
PRODUCT_QUESTION = (
    "Unitree ships this walking policy with one MuJoCo deployment configuration and no envelope. How far "
    "can the operating range be widened - a shove, a slippery floor, a heavier body, noisy or delayed "
    "actuation, a faster or slower command - before the G1 falls over?"
)

FAILURE_CLASSES = ("FELL",)
NO_FAILURE = "NONE"
CONCLUSIVE_OUTCOMES = ("SURVIVED", "FELL")
INCONCLUSIVE_OUTCOMES = ("DIVERGED", "INVALID_INITIAL_STATE", "REJECTED_OUT_OF_ENVELOPE")

DUPLICATE_DISTANCE = 0.05


def in_published_conditions(scn: dict[str, Any]) -> dict[str, bool | None]:
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
    extra = sorted(set(scn) - set(PARAM_ORDER))
    if extra:
        problems.append(f"unknown parameters: {extra}")
    t = float(scn.get("push_time_s", NOMINAL_SCENARIO["push_time_s"]))
    if ENVELOPE["push_time_s"]["min"] <= t <= ENVELOPE["push_time_s"]["max"]:
        if round(t / (DT_CTRL_MS / 1000.0), 6) != round(round(t / (DT_CTRL_MS / 1000.0)), 6):
            problems.append(f"push_time_s={t} must be a multiple of the {DT_CTRL_MS} ms control tick")
    return problems


def normalize(scn: dict[str, Any]) -> dict[str, Any]:
    """Round and order a scenario. Omitted axes are filled in at their nominal value."""
    out: dict[str, Any] = {}
    for k in PARAM_ORDER:
        v = scn.get(k, NOMINAL_SCENARIO[k])
        spec = ENVELOPE[k]
        out[k] = int(v) if spec["type"] == "int" else round(float(v), spec["places"])
    return out


def snap_push_time(t: float) -> float:
    tick = DT_CTRL_MS / 1000.0
    return round(round(t / tick) * tick, ENVELOPE["push_time_s"]["places"])


def _axis_gap(k: str, av: float, bv: float) -> float:
    spec = ENVELOPE[k]
    span = float(spec["max"]) - float(spec["min"])
    if spec.get("circular"):
        d = abs(av - bv) % span
        return min(d, span - d) / (span / 2.0)
    return abs(av - bv) / span


# Axes that only describe the push; skipped whenever either side is unpushed (see the humanoid
# envelope for the reasoning: an impulse of magnitude zero has no direction or timing).
PUSH_ONLY_AXES = ("push_heading_deg", "push_time_s")


def scenario_distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Normalized L-infinity distance over the eight continuous axes."""
    unpushed = (
        float(a.get("push_impulse_ns", NOMINAL_SCENARIO["push_impulse_ns"])) == 0.0
        or float(b.get("push_impulse_ns", NOMINAL_SCENARIO["push_impulse_ns"])) == 0.0
    )
    d = 0.0
    for k in CONTINUOUS_ORDER:
        if unpushed and k in PUSH_ONLY_AXES:
            continue
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
    "two findings are approximate duplicates when they carry the same set of failure classes AND their "
    f"scenarios are closer than {DUPLICATE_DISTANCE} in normalized L-infinity distance over the eight "
    "continuous envelope axes (push_heading_deg measured the short way round the circle; push_heading_deg "
    "and push_time_s skipped entirely when either side has no push, because they then describe nothing and "
    "the two runs are byte-identical); findings of different classes are never duplicates of each other"
)
