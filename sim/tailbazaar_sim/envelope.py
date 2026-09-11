"""Operating envelope, scenario schema, admissibility and scenario distance.

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
  payload_kg         mass of the rigid load block carried on the chassis.
"""

from __future__ import annotations

from typing import Any

ENVELOPE_ID = "tb-envelope-1"
DT_CTRL_MS = 20  # control tick, milliseconds (50 Hz)

ENVELOPE: dict[str, dict[str, Any]] = {
    "sensor_delay_ms": {"min": 0, "max": 300, "step": DT_CTRL_MS, "unit": "ms", "type": "int"},
    "actuator_delay_ms": {"min": 0, "max": 100, "step": DT_CTRL_MS, "unit": "ms", "type": "int"},
    "floor_friction": {"min": 0.2, "max": 1.0, "unit": "1", "type": "float", "places": 3},
    "payload_kg": {"min": 5.0, "max": 60.0, "unit": "kg", "type": "float", "places": 1},
}

# Nominal operating point the controller was tuned for (see controller.py).
NOMINAL_SCENARIO: dict[str, Any] = {
    "sensor_delay_ms": 20,
    "actuator_delay_ms": 20,
    "floor_friction": 0.8,
    "payload_kg": 20.0,
}

# Two scenarios closer than this in normalized L-infinity distance are treated as
# approximate duplicates. This is a published, deliberately simple rule; it does not
# measure semantic novelty of the resulting failure.
DUPLICATE_DISTANCE = 0.05

PARAM_ORDER = ["sensor_delay_ms", "actuator_delay_ms", "floor_friction", "payload_kg"]


def check_admissible(scn: dict[str, Any]) -> list[str]:
    """Return a list of violations (empty means admissible)."""
    problems: list[str] = []
    for k in PARAM_ORDER:
        if k not in scn:
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
    """Normalized L-infinity distance: max over parameters of |a-b| / (max-min)."""
    d = 0.0
    for k in PARAM_ORDER:
        spec = ENVELOPE[k]
        span = float(spec["max"] - spec["min"])
        d = max(d, abs(float(a[k]) - float(b[k])) / span)
    return d


def is_duplicate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return scenario_distance(a, b) < DUPLICATE_DISTANCE


def normalize(scn: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in PARAM_ORDER:
        spec = ENVELOPE[k]
        if spec["type"] == "int":
            out[k] = int(scn[k])
        else:
            out[k] = round(float(scn[k]), spec["places"])
    return out
