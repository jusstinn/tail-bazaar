"""Explicitly specified nominal test suite for the G1 target.

These are conditions under which the policy must NOT fall. Passing them is a sanity check on the
target and on this harness, not a safety benchmark. The suite is written BEFORE it is run and is
not tuned against its own results.

  published conditions (1 case)   Exactly the publisher's deployment configuration: no push, stock
      friction and masses, no noise, no latency, walk forward at 0.5 m/s, from the model's qpos0.
      The publisher states no performance number, so the gate is the only falsifiable thing the
      configuration implies: the robot walks for the whole 15 s episode and covers at least HALF
      the distance the command asks for (0.5 m/s x 15 s = 7.5 m -> a 3.75 m floor). The floor was
      chosen as a rule ("half the commanded distance") before the first measurement.

  benign perturbations (6 cases)   Changes a deployment would consider unremarkable:
        one-tick-latency   20 ms of control latency, one single control tick.
        grippier-floor     friction 1.2 instead of 1.0.
        lighter-body       every mass scaled by 0.95.
        light-shove        a 4 N*s shove from behind (heading 180): 0.12 m/s on a 32 kg body.
        slow-walk          command 0.3 m/s instead of 0.5.
        brisk-walk         command 0.8 m/s instead of 0.5.
      These are NOT claims about what the policy is specified to tolerate; the publisher specifies
      nothing beyond the configuration. They are this project's explicit, falsifiable expectations,
      and if one of them falls the honest report is that it fell.

The suite reports TWO verdicts: `published_conditions_all_passed` (the harness gate) and
`benign_perturbations_all_passed` (an expectation about the target; false is a finding, not a bug).
"""

from __future__ import annotations

from typing import Any

from .envelope import NOMINAL_SCENARIO, normalize
from .simulate import T_MAX_S, run_scenario

SUITE_ID = "g1-nominal-v1"
DISTANCE_FLOOR_FRACTION = 0.5  # of cmd_vx_mps * T_MAX_S, applied only to the published-conditions case

NOMINAL_SUITE: list[dict[str, Any]] = [
    {"name": "published-conditions", "published": True, "scenario": {}},
    {"name": "one-tick-latency", "published": False, "scenario": {"control_latency_ms": 20}},
    {"name": "grippier-floor", "published": False, "scenario": {"floor_friction": 1.2}},
    {"name": "lighter-body", "published": False, "scenario": {"body_mass_scale": 0.95}},
    {"name": "light-shove", "published": False, "scenario": {"push_impulse_ns": 4.0, "push_heading_deg": 180.0}},
    {"name": "slow-walk", "published": False, "scenario": {"cmd_vx_mps": 0.3}},
    {"name": "brisk-walk", "published": False, "scenario": {"cmd_vx_mps": 0.8}},
]


def run_nominal_suite(verbose: bool = True) -> dict[str, Any]:
    results = []
    for case in NOMINAL_SUITE:
        scn = normalize(case["scenario"])
        r = run_scenario(scn, record_frames=False)
        m = r["metrics"]
        survived = r["outcome"] == "SURVIVED" and not m.get("fell")
        full_episode = abs(m.get("survival_time_s", 0.0) - T_MAX_S) < 1e-9
        floor = DISTANCE_FLOOR_FRACTION * float(scn["cmd_vx_mps"]) * T_MAX_S if case["published"] else None
        distance_ok = (floor is None) or (m.get("distance_travelled_x_m", 0.0) >= floor)
        passed = bool(survived and full_episode and distance_ok)
        row = {
            "name": case["name"],
            "published_conditions": case["published"],
            "scenario": r["scenario"],
            "outcome": r["outcome"],
            "failure_classes": r["failure_classes"],
            "survival_time_s": m.get("survival_time_s"),
            "distance_travelled_x_m": m.get("distance_travelled_x_m"),
            "mean_forward_speed_mps": m.get("mean_forward_speed_mps"),
            "pelvis_min_z_m": m.get("pelvis_min_z_m"),
            "max_tilt_deg": m.get("max_tilt_deg"),
            "pelvis_max_speed_mps": m.get("pelvis_max_speed_mps"),
            "distance_floor_applied_m": floor,
            "passed": passed,
        }
        results.append(row)
        if verbose:
            print(f"{'PASS' if passed else 'FAIL'} {case['name']:<22} {r['outcome']:<9} survived={m.get('survival_time_s')}s "
                  f"x={m.get('distance_travelled_x_m')}m min_z={m.get('pelvis_min_z_m')} max_tilt={m.get('max_tilt_deg')}")
    published = [r for r in results if r["published_conditions"]]
    benign = [r for r in results if not r["published_conditions"]]
    fell = [r["name"] for r in results if r["outcome"] == "FELL"]
    return {
        "suite": SUITE_ID,
        "episode_length_s": T_MAX_S,
        "distance_floor_fraction_for_published_conditions": DISTANCE_FLOOR_FRACTION,
        "expectations": "SURVIVED for the full episode; for the published-conditions case, at least half the commanded distance covered",
        "nominal_scenario": dict(NOMINAL_SCENARIO),
        "cases": results,
        "published_conditions_all_passed": all(r["passed"] for r in published),
        "benign_perturbations_all_passed": all(r["passed"] for r in benign),
        "all_passed": all(r["passed"] for r in results),
        "cases_that_fell": fell,
        "note": "published_conditions_all_passed is the gate on this harness. benign_perturbations_all_passed is an expectation about the policy; when it is false the failing case is a finding and is kept in the suite rather than removed or softened.",
    }
