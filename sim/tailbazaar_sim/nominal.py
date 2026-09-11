"""Explicitly specified nominal test suite. These are the conditions the controller was
tuned for (see controller.py). Passing them is a sanity check, not a safety benchmark.

Every case must end SUCCESS, must not touch the obstacle, must finish within
CLEARANCE_TOL_M of the 0.40 m target clearance, and — since scene revision 2 made the
load a free body held only by deck friction — must NOT shed its load.

The two cases added for LOAD_SHED sit at deck grip 0.5. That number is not tuned: a
planned stop at the controller's own A_TRIGGER = 3.0 m/s^2 demands a grip of
3.0 / 9.81 = 0.306, so 0.5 carries a 1.63x margin while sitting below the 0.6 nominal.
A cart that drops its load during an ordinary, planned stop on a slightly worn deck would
be a defect, so these cases assert the opposite.
"""

from __future__ import annotations

from typing import Any

from .envelope import normalize
from .simulate import run_scenario

NOMINAL_SUITE: list[dict[str, Any]] = [
    {"name": "nominal", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 20.0, "load_friction": 0.6}},
    {"name": "no-latency-dry-floor", "scenario": {"sensor_delay_ms": 0, "actuator_delay_ms": 0, "floor_friction": 1.0, "payload_kg": 20.0, "load_friction": 0.6}},
    {"name": "design-limit-latency", "scenario": {"sensor_delay_ms": 40, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 20.0, "load_friction": 0.6}},
    {"name": "design-limit-friction", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.6, "payload_kg": 20.0, "load_friction": 0.6}},
    {"name": "light-payload", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 5.0, "load_friction": 0.6}},
    {"name": "heavy-payload", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 40.0, "load_friction": 0.6}},
    # --- added with the LOAD_SHED class: an ordinary stop must not drop the load ------
    {"name": "worn-deck", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 20.0, "load_friction": 0.5}},
    {"name": "heavy-payload-worn-deck", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 40.0, "load_friction": 0.5}},
]

# Expectation for every case: outcome SUCCESS, no contact, no load shed, and final
# clearance within +/- 0.15 m of the 0.40 m target.
CLEARANCE_TOL_M = 0.15


def run_nominal_suite(verbose: bool = True) -> dict[str, Any]:
    results = []
    for case in NOMINAL_SUITE:
        r = run_scenario(normalize(case["scenario"]), record_frames=False)
        m = r["metrics"]
        passed = (
            r["outcome"] == "SUCCESS"
            and not m.get("collision")
            and not m.get("load_shed")
            and abs(m.get("final_clearance_m", 99) - m.get("target_clearance_m", 0.4)) <= CLEARANCE_TOL_M
        )
        row = {
            "name": case["name"],
            "scenario": r["scenario"],
            "outcome": r["outcome"],
            "chassis_outcome": r["chassis_outcome"],
            "failure_classes": r["failure_classes"],
            "final_clearance_m": m.get("final_clearance_m"),
            "stopping_distance_m": m.get("stopping_distance_m"),
            "v_max_mps": m.get("v_max_mps"),
            "peak_decel_mps2": m.get("peak_decel_mps2"),
            "load_shed": m.get("load_shed"),
            "load_slip_max_m": m.get("load_slip_max_m"),
            "deck_grip_required_at_peak_decel": m.get("deck_grip_required_at_peak_decel"),
            "deck_grip_margin": m.get("deck_grip_margin"),
            "passed": passed,
        }
        results.append(row)
        if verbose:
            print(
                f"{'PASS' if passed else 'FAIL'} {case['name']:<24} {r['outcome']:<9} "
                f"clearance={m.get('final_clearance_m')} stop_dist={m.get('stopping_distance_m')} "
                f"vmax={m.get('v_max_mps')} shed={m.get('load_shed')} slipmax={m.get('load_slip_max_m')}"
            )
    return {"suite": "nominal-v2", "clearance_tolerance_m": CLEARANCE_TOL_M,
            "expectations": "SUCCESS, no obstacle contact, no LOAD_SHED, final clearance within tolerance",
            "cases": results, "all_passed": all(r["passed"] for r in results)}
