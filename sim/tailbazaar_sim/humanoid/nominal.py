"""Explicitly specified nominal test suite for the humanoid target.

These are conditions under which the policy must NOT fall. Passing them is a sanity check on
the target and on this harness, not a safety benchmark.

The suite is written BEFORE it is run and is not tuned against its own results. Two kinds of
case, and the reason each one belongs:

  published conditions (4 cases)   Exactly the environment the policy's publisher evaluated:
      no push, stock friction and masses, no noise, no latency. Only the initial state differs
      (init_seed 0..3). The publisher claims mean_reward 8127.00 +/- 46.46 over 10 deterministic
      episodes, so a fall here would mean this harness is not reproducing the published target
      and every other number in this project would be suspect. These cases also carry a return
      floor of 7000 - roughly 14 % below the published mean, chosen once, in advance, to be
      loose enough that it tests "the policy works" rather than "the policy matches to 1 %".

  benign perturbations (4 cases)   Changes a deployment would consider unremarkable and that
      should not, on their own, put a working machine on the floor:
        one-tick-latency   15 ms of control latency, one single control tick. Every real
                           actuation path has at least this.
        grippier-floor     friction 1.2 instead of 1.0. More grip than the policy trained on.
        lighter-body       every mass scaled by 0.95.
        light-shove        an 8 N*s shove, which on a 42.1 kg body is 0.19 m/s of velocity
                           change - a nudge, not a push.
      These are NOT claims about what the policy is specified to tolerate; the publisher
      specifies nothing beyond stock Humanoid-v5. They are this project's explicit, falsifiable
      expectations, and if one of them falls the honest report is that it fell.

RESULT, RECORDED HERE RATHER THAN TUNED AWAY: `one-tick-latency` FAILS. A single 15 ms control
tick of actuation delay - one tick, the smallest non-zero value the envelope can express - puts
this policy on the floor, at 6.96 s on init_seed 0 and between 1.27 s and 8.47 s across seeds
0..3. Two ticks put it down in under 0.7 s on every seed. That is not a harness artefact: at
zero latency the same four seeds all run the full 15 s, and the delay is an ordinary zero-order
hold on the action, not a change to the policy or the scene. It is the first thing this target
sells, and the suite keeps the case and reports it failing.

Because of that, the suite reports TWO verdicts rather than one:
  published_conditions_all_passed   the harness gate. If this is ever false, this project is not
                                    reproducing the published target and nothing else it says
                                    can be trusted.
  benign_perturbations_all_passed   an expectation about the target, which is currently false
                                    and is a finding, not a bug.
"""

from __future__ import annotations

from typing import Any

from .envelope import normalize
from .simulate import T_MAX_S, run_scenario

SUITE_ID = "humanoid-nominal-v1"
RETURN_FLOOR = 7000.0  # applied only to the published-conditions cases; see the module docstring

NOMINAL_SUITE: list[dict[str, Any]] = [
    {"name": "published-conditions-seed-0", "published": True, "scenario": {"init_seed": 0}},
    {"name": "published-conditions-seed-1", "published": True, "scenario": {"init_seed": 1}},
    {"name": "published-conditions-seed-2", "published": True, "scenario": {"init_seed": 2}},
    {"name": "published-conditions-seed-3", "published": True, "scenario": {"init_seed": 3}},
    {"name": "one-tick-latency", "published": False, "scenario": {"control_latency_ms": 15}},
    {"name": "grippier-floor", "published": False, "scenario": {"floor_friction": 1.2}},
    {"name": "lighter-body", "published": False, "scenario": {"body_mass_scale": 0.95}},
    {"name": "light-shove", "published": False, "scenario": {"push_impulse_ns": 8.0, "push_heading_deg": 180.0}},
]


def run_nominal_suite(verbose: bool = True) -> dict[str, Any]:
    results = []
    for case in NOMINAL_SUITE:
        r = run_scenario(normalize(case["scenario"]), record_frames=False)
        m = r["metrics"]
        survived = r["outcome"] == "SURVIVED" and not m.get("fell")
        full_episode = abs(m.get("survival_time_s", 0.0) - T_MAX_S) < 1e-9
        predicate_ok = m.get("health_predicate_mismatches") == 0
        return_ok = (not case["published"]) or (m.get("episode_return", 0.0) >= RETURN_FLOOR)
        passed = bool(survived and full_episode and predicate_ok and return_ok)
        row = {
            "name": case["name"],
            "published_conditions": case["published"],
            "scenario": r["scenario"],
            "outcome": r["outcome"],
            "failure_classes": r["failure_classes"],
            "survival_time_s": m.get("survival_time_s"),
            "episode_return": m.get("episode_return"),
            "torso_min_z_m": m.get("torso_min_z_m"),
            "torso_max_speed_mps": m.get("torso_max_speed_mps"),
            "distance_travelled_x_m": m.get("distance_travelled_x_m"),
            "health_predicate_mismatches": m.get("health_predicate_mismatches"),
            "return_floor_applied": RETURN_FLOOR if case["published"] else None,
            "passed": passed,
        }
        results.append(row)
        if verbose:
            print(
                f"{'PASS' if passed else 'FAIL'} {case['name']:<28} {r['outcome']:<9} "
                f"survived={m.get('survival_time_s')}s return={m.get('episode_return')} "
                f"min_z={m.get('torso_min_z_m')} x={m.get('distance_travelled_x_m')}m"
            )
    published = [r for r in results if r["published_conditions"]]
    benign = [r for r in results if not r["published_conditions"]]
    returns = [r["episode_return"] for r in published]
    fell = [r["name"] for r in results if r["outcome"] == "FELL"]
    return {
        "suite": SUITE_ID,
        "episode_length_s": T_MAX_S,
        "return_floor_for_published_conditions": RETURN_FLOOR,
        "expectations": (
            "SURVIVED for the full episode, zero health-predicate mismatches, and for the "
            "published-conditions cases an episode return at or above the floor"
        ),
        "published_conditions_mean_return": round(sum(returns) / len(returns), 4) if returns else None,
        "published_conditions_episodes": len(returns),
        "cases": results,
        # The harness gate: does this project reproduce the target its publisher published?
        "published_conditions_all_passed": all(r["passed"] for r in published),
        # An expectation about the TARGET. False here is a finding about the policy, not a bug.
        "benign_perturbations_all_passed": all(r["passed"] for r in benign),
        "all_passed": all(r["passed"] for r in results),
        "cases_that_fell": fell,
        "note": (
            "published_conditions_all_passed is the gate on this harness. benign_perturbations_all_passed "
            "is an expectation about the policy; when it is false the failing case is a finding and is "
            "kept in the suite rather than removed or softened."
        ),
    }
