"""Operating envelope, scenario schema, admissibility, failure classes and scenario distance.

Everything here is an ILLUSTRATIVE ASSUMPTION for a demonstration warehouse cart.
The ranges are not measured on any physical robot.

Scenario parameters (SI units unless noted):
  sensor_delay_ms    integer, multiple of 20 (one control tick). Latency of the
                     exteroceptive obstacle-distance measurement (rangefinder) as
                     seen by the controller. Proprioceptive odometry is NOT delayed.
  actuator_delay_ms  integer, multiple of 20. Latency between the controller emitting
                     a drive/brake command and the actuators applying it.
  floor_friction     tire-floor sliding friction coefficient (MuJoCo geom friction[0]
                     on the floor plane and the wheels; MuJoCo uses the max of the pair).
  payload_kg         mass of the rigid load block carried on the chassis deck.
  load_friction      sliding friction coefficient of the chassis-deck/load contact
                     (dimensionless Coulomb mu). Added in envelope revision
                     tb-envelope-1.1 together with the LOAD_SHED failure class: the
                     load is a free rigid body seated on the deck, so this coefficient
                     is the only thing holding it there. See scene.py.

Backwards compatibility
-----------------------
`load_friction` is OPTIONAL in an input scenario. A scenario written against envelope
revision tb-envelope-1 has four keys; it is read at the nominal deck grip (0.6) and
`normalize()` writes the key back explicitly, so every normalized scenario has five.
Note that revision tb-envelope-1 welded the load to the chassis (effectively infinite
grip), so replaying an old four-key scenario under the current scene reproduces the old
*scenario*, not the old *trajectory hash*.

`ENVELOPE_ID` is deliberately NOT bumped: the verifier keys on it to recognise the
envelope a submission belongs to, and the four original axes, their ranges, the
admissibility rules and the duplicate metric are all unchanged. The added axis is
recorded in `ENVELOPE_REVISION`, which every run document carries.

Failure classes
---------------
A run can exhibit COLLISION (a cart geom touched the obstacle), LOAD_SHED (the carried
load left the deck), both, or neither. Both are decided by the physics in simulate.py;
nothing assigns them directly. The marketplace verdict vocabulary (VALID / INVALID /
INCONCLUSIVE) is unchanged and lives in the web layer.
"""

from __future__ import annotations

from typing import Any, Iterable

ENVELOPE_ID = "tb-envelope-1"
# Revision of the envelope *contents* under the same id. 1.1 added the `load_friction`
# axis and the LOAD_SHED failure class; the four original axes are byte-identical.
ENVELOPE_REVISION = "tb-envelope-1.1"
DT_CTRL_MS = 20  # control tick, milliseconds (50 Hz)

ENVELOPE: dict[str, dict[str, Any]] = {
    "sensor_delay_ms": {"min": 0, "max": 300, "step": DT_CTRL_MS, "unit": "ms", "type": "int"},
    "actuator_delay_ms": {"min": 0, "max": 100, "step": DT_CTRL_MS, "unit": "ms", "type": "int"},
    "floor_friction": {"min": 0.2, "max": 1.0, "unit": "1", "type": "float", "places": 3},
    "payload_kg": {"min": 5.0, "max": 60.0, "unit": "kg", "type": "float", "places": 1},
    "load_friction": {"min": 0.1, "max": 1.0, "unit": "1", "type": "float", "places": 3},
}

# Nominal operating point the controller was tuned for (see controller.py). The nominal
# deck grip is not from controller.py — that file says nothing about how the load is
# secured — it is an illustrative assumption for a rubber-faced deck; see UNTUNED_PARAMS.
NOMINAL_SCENARIO: dict[str, Any] = {
    "sensor_delay_ms": 20,
    "actuator_delay_ms": 20,
    "floor_friction": 0.8,
    "payload_kg": 20.0,
    "load_friction": 0.6,
}

# Parameters an input scenario may omit; omitted means "at the nominal value".
OPTIONAL_PARAMS: set[str] = {"load_friction"}

# The range the controller was TUNED for, transcribed from the "Design assumptions" paragraph of the
# docstring in controller.py. That file is never edited (its SHA-256 is the controller version id in
# every evidence document), so this is a mirror of it, republished in machine-readable form.
#
# The searched ENVELOPE above is deliberately wider than this tuned range. A finding outside the tuned
# range is therefore not a defect report: it is a measured boundary of how far the operating range can
# be widened before the controller stops working. The controller checks none of these at runtime.
CONTROLLER_TUNED_RANGE: dict[str, dict[str, Any]] = {
    "sensor_delay_ms": {"max": 40},
    "actuator_delay_ms": {"max": 20},
    "floor_friction": {"min": 0.6},
    "payload_kg": {"exactly": 20.0},
}
TUNED_RANGE_PROSE = "sensor latency <= 40 ms, actuator latency <= 20 ms, floor friction >= 0.6, payload 20 kg"

# Axes the controller's own documentation says NOTHING about. No tuned bound can be transcribed for
# them, and inventing one would be a fabrication, so `in_tuned_range()` reports them as unknown rather
# than as inside or outside. What CAN be derived from controller.py without editing it is the deck grip
# each of its two braking set points demands of a load that is only held by friction:
#   mu_required = a / g, with g = 9.81 m/s^2
#     A_TRIGGER = 3.0 m/s^2 (the planned stop the controller aims for) -> 0.306
#     A_FULL    = 6.0 m/s^2 (the deceleration it assumes a full brake delivers) -> 0.612
# These two numbers are quoted in scene.py and in evidence/LOAD_SHED.md. They are arithmetic on the
# controller's published constants, not a tuned threshold.
UNTUNED_PARAMS: dict[str, str] = {
    "load_friction": (
        "controller.py documents no assumption about how the load is secured; the deck grip a planned "
        "stop demands (A_TRIGGER/g = 0.306) and a saturated brake demands (A_FULL/g = 0.612) follow "
        "from its own constants"
    ),
}
GRAVITY_MPS2 = 9.81

TUNED_RANGE_PROSE_FULL = TUNED_RANGE_PROSE + "; deck grip (load_friction) not stated by the controller"
PRODUCT_QUESTION = (
    "Can this controller be deployed in a wider operating range than it was tuned for, "
    "and where exactly does it stop working?"
)

# Failure classes a run can exhibit. Both emerge from contacts and dynamics; see simulate.py.
FAILURE_CLASSES = ("COLLISION", "LOAD_SHED")
NO_FAILURE = "NONE"
# Outcomes that answer the product question. Anything else (TIMEOUT, DIVERGED,
# INVALID_INITIAL_STATE, REJECTED_OUT_OF_ENVELOPE) is inconclusive for the marketplace.
CONCLUSIVE_OUTCOMES = ("SUCCESS", "COLLISION", "LOAD_SHED")


def in_tuned_range(scn: dict[str, Any]) -> dict[str, bool | None]:
    """Per parameter: is this value inside the range the controller was tuned for?

    None means the controller's documentation states nothing about that axis (see
    UNTUNED_PARAMS); it is neither inside nor outside a range that does not exist.
    """
    out: dict[str, bool | None] = {}
    for k, spec in CONTROLLER_TUNED_RANGE.items():
        v = float(scn[k])
        if "exactly" in spec:
            out[k] = v == float(spec["exactly"])
        else:
            out[k] = (v >= spec["min"]) if "min" in spec else (v <= spec["max"])
    for k in UNTUNED_PARAMS:
        out[k] = None
    return out


def required_deck_grip(decel_mps2: float) -> float:
    """Coulomb coefficient a seated load needs to ride out `decel_mps2` of deceleration."""
    return decel_mps2 / GRAVITY_MPS2


# Two scenarios closer than this in normalized L-infinity distance are treated as
# approximate duplicates. This is a published, deliberately simple rule; it does not
# measure semantic novelty of the resulting failure.
DUPLICATE_DISTANCE = 0.05

PARAM_ORDER = ["sensor_delay_ms", "actuator_delay_ms", "floor_friction", "payload_kg", "load_friction"]


def check_admissible(scn: dict[str, Any]) -> list[str]:
    """Return a list of violations (empty means admissible).

    Unchanged for the four original axes. `load_friction` may be omitted (it then takes
    its nominal value); when present it is checked exactly like the other float axes.
    """
    problems: list[str] = []
    for k in PARAM_ORDER:
        if k not in scn:
            if k not in OPTIONAL_PARAMS:
                problems.append(f"missing {k}")
            continue
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
    extra = set(scn) - set(PARAM_ORDER)
    if extra:
        problems.append(f"unknown parameters: {sorted(extra)}")
    return problems


def scenario_distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Normalized L-infinity distance: max over parameters of |a-b| / (max-min).

    Parameters missing from either scenario are read at their nominal value, so an old
    four-key scenario compares correctly against a five-key one.
    """
    d = 0.0
    for k in PARAM_ORDER:
        spec = ENVELOPE[k]
        span = float(spec["max"] - spec["min"])
        av = float(a.get(k, NOMINAL_SCENARIO[k]))
        bv = float(b.get(k, NOMINAL_SCENARIO[k]))
        d = max(d, abs(av - bv) / span)
    return d


def is_duplicate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """The published scenario-only duplicate rule: normalized L-infinity < 0.05.

    This is the rule the marketplace publishes and the TypeScript mirror implements. It
    compares scenarios, not findings; see `is_duplicate_finding` for the class-aware rule
    the hunter uses.
    """
    return scenario_distance(a, b) < DUPLICATE_DISTANCE


def normalize_failure_classes(classes: Iterable[str]) -> list[str]:
    """Canonical order for a set of failure classes, validated against FAILURE_CLASSES."""
    s = set(classes)
    unknown = s - set(FAILURE_CLASSES)
    if unknown:
        raise ValueError(f"unknown failure classes: {sorted(unknown)}")
    return [c for c in FAILURE_CLASSES if c in s]


def finding_distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Distance between two FINDINGS, each {"scenario": ..., "failure_classes": [...]}.

    Findings of different failure classes are never near each other: a cart that hits the
    obstacle and a cart that drops its load are different products even at the same point
    of the envelope, so the distance is infinite unless the class sets are equal. When the
    class sets do match, this is exactly `scenario_distance`, unchanged.
    """
    ca = normalize_failure_classes(a.get("failure_classes") or [])
    cb = normalize_failure_classes(b.get("failure_classes") or [])
    if ca != cb:
        return float("inf")
    return scenario_distance(a["scenario"], b["scenario"])


def is_duplicate_finding(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return finding_distance(a, b) < DUPLICATE_DISTANCE


DUPLICATE_RULE_PROSE = (
    "two findings are approximate duplicates when they carry the same set of failure classes AND their "
    f"scenarios are closer than {DUPLICATE_DISTANCE} in normalized L-infinity distance over the envelope "
    "ranges; findings of different classes are never duplicates of each other"
)


def normalize(scn: dict[str, Any]) -> dict[str, Any]:
    """Round and order a scenario. Optional axes are filled in at their nominal value."""
    out: dict[str, Any] = {}
    for k in PARAM_ORDER:
        spec = ENVELOPE[k]
        v = scn.get(k, NOMINAL_SCENARIO[k])
        if spec["type"] == "int":
            out[k] = int(v)
        else:
            out[k] = round(float(v), spec["places"])
    return out
