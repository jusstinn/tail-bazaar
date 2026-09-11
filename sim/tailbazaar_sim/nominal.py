"""Explicitly specified nominal test suite. These are the conditions the controller was
tuned for (see controller.py). Passing them is a sanity check, not a safety benchmark."""

from __future__ import annotations

from typing import Any

from .envelope import normalize
from .simulate import run_scenario

NOMINAL_SUITE: list[dict[str, Any]] = [
    {"name": "nominal", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 20.0}},
    {"name": "no-latency-dry-floor", "scenario": {"sensor_delay_ms": 0, "actuator_delay_ms": 0, "floor_friction": 1.0, "payload_kg": 20.0}},
    {"name": "design-limit-latency", "scenario": {"sensor_delay_ms": 40, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 20.0}},
    {"name": "design-limit-friction", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.6, "payload_kg": 20.0}},
    {"name": "light-payload", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 5.0}},
    {"name": "heavy-payload", "scenario": {"sensor_delay_ms": 20, "actuator_delay_ms": 20, "floor_friction": 0.8, "payload_kg": 40.0}},
]

# Expectation for every case: outcome SUCCESS, no contact, final clearance within
# +/- 0.15 m of the 0.40 m target.
CLEARANCE_TOL_M = 0.15


def run_nominal_suite(verbose: bool = True) -> dict[str, Any]:
    results = []
    for case in NOMINAL_SUITE:
        r = run_scenario(normalize(case["scenario"]), record_frames=False)
        m = r["metrics"]
        passed = (
            r["outcome"] == "SUCCESS"
            and not m.get("collision")
            and abs(m.get("final_clearance_m", 99) - m.get("target_clearance_m", 0.4)) <= CLEARANCE_TOL_M
        )
        row = {
            "name": case["name"],
            "scenario": r["scenario"],
            "outcome": r["outcome"],
            "final_clearance_m": m.get("final_clearance_m"),
            "stopping_distance_m": m.get("stopping_distance_m"),
            "v_max_mps": m.get("v_max_mps"),
            "peak_decel_mps2": m.get("peak_decel_mps2"),
            "passed": passed,
        }
        results.append(row)
        if verbose:
            print(f"{'PASS' if passed else 'FAIL'} {case['name']:<24} {r['outcome']:<9} clearance={m.get('final_clearance_m')} stop_dist={m.get('stopping_distance_m')} vmax={m.get('v_max_mps')}")
    return {"suite": "nominal-v1", "clearance_tolerance_m": CLEARANCE_TOL_M, "cases": results,
            "all_passed": all(r["passed"] for r in results)}
