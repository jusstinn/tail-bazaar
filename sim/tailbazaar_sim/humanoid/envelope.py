"""Operating envelope, scenario schema, admissibility, failure class and scenario distance
for the humanoid balance target.

EVERYTHING HERE IS AN ILLUSTRATIVE ASSUMPTION for a demonstration. None of these bounds is
measured on a physical robot, and the simulated humanoid is Gymnasium's 42.1 kg MuJoCo
`humanoid.xml` mannequin, not any product. The bounds are chosen to bracket the nominal
operating point widely enough that the question "where does this policy stop working?" has
an answer inside them, and each one carries the reasoning that picked it.

Scenario parameters (SI units unless noted):
  push_impulse_ns      N*s. Magnitude of a single external impulse applied to the torso's
                       centre of mass as a constant world-frame force held for
                       PUSH_DURATION_S (0.15 s = 10 control ticks). 0 means no push.
                       Upper bound 120 N*s = 2.85 m/s of torso-mass velocity change on a
                       42.1 kg body: a shove hard enough that surviving it would be
                       surprising, so the bound does not hide the interesting region.
  push_heading_deg     deg. Direction of that force in the world horizontal plane, 0 = +x
                       (the direction the policy runs), measured counter-clockwise. This
                       axis is CIRCULAR; see scenario_distance.
  push_time_s          s. When the push starts. Must be an exact multiple of the 15 ms
                       control tick, so a scenario names one unambiguous tick and two
                       different numbers can never mean the same run. The bounds are
                       themselves tick multiples: 0.6 s (tick 40) lets the gait settle out of
                       the reset pose first, and 7.8 s (tick 520) leaves >= 7 s of episode
                       after the 0.15 s push window ends.
  floor_friction       Coulomb sliding coefficient written into geom_friction[0] of the
                       floor plane. Gymnasium's humanoid.xml ships 1.0, which is the
                       nominal. 0.4 is a wet-ish hard floor, 1.4 a grippy rubber mat.
  body_mass_scale      dimensionless multiplier applied to every body mass AND to the
                       matching diagonal inertia (so the mass distribution is unchanged and
                       only the scale differs). +-20/25 % covers carrying a payload or a
                       lighter variant of the same machine.
  actuator_noise_frac  dimensionless. Standard deviation of zero-mean Gaussian noise added
                       to each commanded torque as a fraction of that actuator's control
                       range, drawn once per control tick from a seeded generator (see
                       simulate.py: the seed is derived from the scenario, so a scenario
                       always replays identically).
  control_latency_ms   ms, multiple of the 15 ms control tick. The action computed at tick
                       k is applied from tick k + control_latency_ms/15; before the first
                       action arrives the actuators hold zero torque. This is the systems
                       axis every real deployment has.
  init_seed            DISCRETE stratification, not a continuous axis. Gymnasium's
                       `reset(seed=s)` perturbs the humanoid's initial qpos/qvel by uniform
                       noise of scale 0.01, so each seed is a different initial state. Eight
                       of them are published; a finding names the one it was found on.

Failure class
-------------
FELL, and it is decided by GYMNASIUM'S OWN health predicate, not by anything invented here:
`HumanoidEnv.terminated` is true exactly when the torso height `data.qpos[2]` leaves the
environment's `healthy_z_range` (1.0 m, 2.0 m). simulate.py reads that flag off the
unmodified environment object and cross-checks it against the range it reports. There is no
second, bespoke fall detector.

The marketplace verdict vocabulary (VALID / INVALID / INCONCLUSIVE) is unchanged and lives
in the web layer; INCONCLUSIVE covers the non-conclusive outcomes listed below.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

ENVELOPE_ID = "tb-humanoid-envelope-1"
ENVELOPE_REVISION = "tb-humanoid-envelope-1.0"
TARGET_ID = "humanoid-balance-sac-v1"

# Gymnasium's Humanoid-v5 runs MuJoCo at 0.003 s with frame_skip 5, so one control tick is
# 15 ms (66.67 Hz). Both the latency axis and the push window are quantized to it.
DT_CTRL_MS = 15
PUSH_DURATION_S = 0.15  # 10 control ticks; fixed, documented, NOT an axis

ENVELOPE: dict[str, dict[str, Any]] = {
    "push_impulse_ns": {"min": 0.0, "max": 120.0, "unit": "N*s", "type": "float", "places": 2, "group": "physical"},
    "push_heading_deg": {"min": 0.0, "max": 360.0, "unit": "deg", "type": "float", "places": 1, "group": "physical", "circular": True},
    "push_time_s": {"min": 0.6, "max": 7.8, "unit": "s", "type": "float", "places": 3, "group": "physical", "step": 0.015},
    "floor_friction": {"min": 0.4, "max": 1.4, "unit": "1", "type": "float", "places": 3, "group": "physical"},
    "body_mass_scale": {"min": 0.8, "max": 1.25, "unit": "1", "type": "float", "places": 3, "group": "physical"},
    "actuator_noise_frac": {"min": 0.0, "max": 0.3, "unit": "1", "type": "float", "places": 3, "group": "systems"},
    "control_latency_ms": {"min": 0, "max": 90, "step": DT_CTRL_MS, "unit": "ms", "type": "int", "group": "systems"},
}

# Stratified (discrete) axis: one of eight published initial states.
INIT_SEEDS = (0, 1, 2, 3, 4, 5, 6, 7)
DISCRETE: dict[str, dict[str, Any]] = {
    "init_seed": {"values": list(INIT_SEEDS), "unit": "1", "type": "int", "group": "physical"},
}

# The nominal operating point: no push, the environment's shipped floor friction and masses,
# no actuator noise, no control latency. This is the point the published mean_reward was
# measured at by the policy's publisher.
NOMINAL_SCENARIO: dict[str, Any] = {
    "push_impulse_ns": 0.0,
    "push_heading_deg": 0.0,
    "push_time_s": 2.1,
    "floor_friction": 1.0,
    "body_mass_scale": 1.0,
    "actuator_noise_frac": 0.0,
    "control_latency_ms": 0,
    "init_seed": 0,
}

PARAM_ORDER = [
    "push_impulse_ns",
    "push_heading_deg",
    "push_time_s",
    "floor_friction",
    "body_mass_scale",
    "actuator_noise_frac",
    "control_latency_ms",
    "init_seed",
]
CONTINUOUS_ORDER = [k for k in PARAM_ORDER if k in ENVELOPE]

# Every axis is optional in an input scenario; an omitted axis is read at its nominal value
# and written back explicitly by normalize(), exactly like the cart's `load_friction`.
OPTIONAL_PARAMS: set[str] = set(PARAM_ORDER)

# What the POLICY's publisher documents about the conditions it was trained and evaluated
# under. Transcribed from the model card and the SB3 save, not invented: the checkpoint was
# trained and evaluated on unmodified Gymnasium `Humanoid-v5`, which means no push, shipped
# friction and masses, no actuator noise and no control latency. Anything else in the
# envelope above is OUTSIDE the conditions the policy was published for, and a finding there
# is a measured boundary of the operating range, not a defect report.
POLICY_PUBLISHED_CONDITIONS: dict[str, dict[str, Any]] = {
    "push_impulse_ns": {"exactly": 0.0},
    "floor_friction": {"exactly": 1.0},
    "body_mass_scale": {"exactly": 1.0},
    "actuator_noise_frac": {"exactly": 0.0},
    "control_latency_ms": {"exactly": 0},
}
PUBLISHED_CONDITIONS_PROSE = (
    "unmodified Gymnasium Humanoid-v5: no external push, floor friction 1.0, stock body masses, "
    "no actuator noise, no control latency"
)
UNSTATED_PARAMS: dict[str, str] = {
    "push_heading_deg": "meaningless while push_impulse_ns is 0; the publisher states nothing about pushes",
    "push_time_s": "same",
    "init_seed": "the publisher evaluated 10 unspecified episodes; the seeds are not published",
}
PRODUCT_QUESTION = (
    "This policy is published with a mean return of 8127 on stock Humanoid-v5. How far can the "
    "operating range be widened - a shove, a slippery floor, a heavier body, noisy or delayed "
    "actuation - before it falls over?"
)

FAILURE_CLASSES = ("FELL",)
NO_FAILURE = "NONE"
# Outcomes that answer the product question. Anything else is INCONCLUSIVE for the marketplace.
CONCLUSIVE_OUTCOMES = ("SURVIVED", "FELL")
INCONCLUSIVE_OUTCOMES = ("DIVERGED", "INVALID_INITIAL_STATE", "REJECTED_OUT_OF_ENVELOPE")

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
    # The push must land inside the episode with room for the whole 0.15 s window.
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
        if k == "init_seed":
            out[k] = int(v)
            continue
        spec = ENVELOPE[k]
        out[k] = int(v) if spec["type"] == "int" else round(float(v), spec["places"])
    return out


def snap_push_time(t: float) -> float:
    """Snap a push time to the control tick, then round to the axis's declared places."""
    tick = DT_CTRL_MS / 1000.0
    return round(round(t / tick) * tick, ENVELOPE["push_time_s"]["places"])


def _axis_gap(k: str, av: float, bv: float) -> float:
    spec = ENVELOPE[k]
    span = float(spec["max"]) - float(spec["min"])
    if spec.get("circular"):
        # 0 deg and 359 deg are the same direction: take the short way round, so the
        # duplicate rule cannot be defeated by naming a heading from the other side of zero.
        d = abs(av - bv) % span
        return min(d, span - d) / (span / 2.0)
    return abs(av - bv) / span


# Axes that only describe the push. When there is no push they describe nothing: two scenarios
# that differ only in the direction or the timing of an impulse of magnitude zero produce
# byte-identical trajectories, because simulate.py never writes xfrc_applied at all. Counting
# such a difference as distance would make the nominal point (impulse 0, heading 0) look "far"
# from an equally unpushed scenario at heading 180, and would let the same run be sold twice
# under two headings. Both are wrong, so these axes are skipped whenever either side is unpushed.
PUSH_ONLY_AXES = ("push_heading_deg", "push_time_s")


def scenario_distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Normalized L-infinity distance over the CONTINUOUS axes.

    `init_seed` is a stratification, not a coordinate: two runs from different initial
    states are different findings, so the distance is infinite unless the seeds match.
    Axes missing from either scenario are read at their nominal value.
    """
    if int(a.get("init_seed", NOMINAL_SCENARIO["init_seed"])) != int(b.get("init_seed", NOMINAL_SCENARIO["init_seed"])):
        return math.inf
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
    "two findings are approximate duplicates when they carry the same set of failure classes AND the "
    "same init_seed AND their scenarios are closer than "
    f"{DUPLICATE_DISTANCE} in normalized L-infinity distance over the seven continuous envelope axes "
    "(push_heading_deg measured the short way round the circle; push_heading_deg and push_time_s "
    "skipped entirely when either side has no push, because they then describe nothing and the two "
    "runs are byte-identical); findings from different initial states or different classes are never "
    "duplicates of each other"
)
