"""Nominal test suite for the arm target: the cases that must NOT drop the block.

Two blocks, reported with two separate verdicts, exactly as the humanoid target does:

  published-conditions — the environment and the policy exactly as the publisher evaluated
      them, on four of the eight published initial states. This block is a GATE ON THE
      HARNESS. If the numpy reimplementation of the actor, the compatibility shim, the
      observation key order or the scene mutations were wrong, these would not place the block
      and the mean return would not land near the publisher's own -9.70 +/- 4.17.

  benign-perturbations — small, obviously-survivable moves along four different axes. This
      block is an EXPECTATION ABOUT THE POLICY, not about the harness. If one of them fails it
      is kept and reported, not removed or softened, because a benign perturbation that breaks
      the policy is the most interesting thing the suite can find.

The cases were written before they were run and are not tuned against their own results.
"""

from __future__ import annotations

import statistics
from typing import Any

from .envelope import NOMINAL_SCENARIO, TARGET_ID, normalize
from .policy import (
    PUBLISHED_EVAL_EPISODES,
    PUBLISHED_MEAN_REWARD,
    PUBLISHED_STD_REWARD,
    load_policy,
)
from .simulate import run_scenario

# (name, scenario-delta, block, why this case must not drop the block)
CASES: list[tuple[str, dict[str, Any], str, str]] = [
    (
        "published-conditions-seed-0",
        {"init_seed": 0},
        "published-conditions",
        "the environment and the policy exactly as published; anything but a placement is a harness fault",
    ),
    (
        "published-conditions-seed-1",
        {"init_seed": 1},
        "published-conditions",
        "same, a second block and goal placement",
    ),
    (
        "published-conditions-seed-2",
        {"init_seed": 2},
        "published-conditions",
        "same, a third",
    ),
    (
        "published-conditions-seed-3",
        {"init_seed": 3},
        "published-conditions",
        "same, a fourth",
    ),
    (
        "lighter-part",
        {"object_mass_kg": 1.0, "init_seed": 0},
        "benign-perturbations",
        "half the published block mass; a gripper that can hold 2 kg should hold 1 kg",
    ),
    (
        "slightly-slicker-grip",
        {"grip_friction": 0.7, "init_seed": 1},
        "benign-perturbations",
        "30 % less grip friction; still far above the coefficient of a dry hand on plastic",
    ),
    (
        "part-1cm-off",
        {"object_offset_x_m": 0.01, "object_offset_y_m": -0.01, "init_seed": 2},
        "benign-perturbations",
        "the part 1 cm from where the environment put it, a fifth of the block's own width",
    ),
    (
        "a-little-actuation-noise",
        {"action_noise_frac": 0.05, "init_seed": 3},
        "benign-perturbations",
        "5 % of the action half-range of zero-mean noise, well inside any real servo's jitter",
    ),
]


def run_nominal_suite() -> dict[str, Any]:
    policy = load_policy()
    results = []
    for name, delta, block, why in CASES:
        scn = normalize({**NOMINAL_SCENARIO, **delta})
        res = run_scenario(scn, record_frames=False)
        m = res["metrics"]
        passed = res["outcome"] == "SUCCESS"
        results.append(
            {
                "name": name,
                "block": block,
                "why_it_must_not_drop": why,
                "scenario": scn,
                "outcome": res["outcome"],
                "passed": passed,
                "dropped": bool(m["dropped"]),
                "env_success_at_horizon": m["env_success_at_horizon"],
                "episode_return": m["episode_return"],
                "first_success_t_s": m["first_success_t_s"],
                "object_lift_m": m["object_lift_m"],
                "min_object_goal_distance_m": m["min_object_goal_distance_m"],
                "object_impact_speed_mps": m["object_impact_speed_mps"],
                "success_predicate_mismatches": m["success_predicate_mismatches"],
                "trajectory_hash": res["trajectory_hash"],
                "state_hash": res["state_hash"],
            }
        )

    published = [r for r in results if r["block"] == "published-conditions"]
    benign = [r for r in results if r["block"] == "benign-perturbations"]
    returns = [float(r["episode_return"]) for r in published]
    mean_return = round(statistics.fmean(returns), 6) if returns else None
    inside = (
        mean_return is not None
        and abs(mean_return - PUBLISHED_MEAN_REWARD) <= PUBLISHED_STD_REWARD
    )
    return {
        "schema": "tb-arm-nominal-1",
        "target_id": TARGET_ID,
        "cases": len(results),
        "results": results,
        "all_passed": all(r["passed"] for r in results),
        "published_conditions_all_passed": all(r["passed"] for r in published),
        "benign_perturbations_all_passed": all(r["passed"] for r in benign),
        "no_case_dropped": not any(r["dropped"] for r in results),
        "total_success_predicate_mismatches": sum(int(r["success_predicate_mismatches"]) for r in results),
        "reproduces_published_number": {
            "measured_mean_return": mean_return,
            "measured_over_episodes": len(published),
            "published_mean_reward": PUBLISHED_MEAN_REWARD,
            "published_std_reward": PUBLISHED_STD_REWARD,
            "published_eval_episodes": PUBLISHED_EVAL_EPISODES,
            "inside_publishers_quoted_spread": bool(inside),
            "note": (
                "the publisher's number is their claim over 10 unspecified deterministic episodes; this "
                "is a check that the numpy actor, the observation key order and the compatibility shim "
                "reproduce the published behaviour, not an independent evaluation of the policy"
            ),
        },
        "policy": policy.identity(),
        "interpretation": {
            "published-conditions": "a gate on this harness; a failure here means the harness is wrong",
            "benign-perturbations": "an expectation about the policy; a failure here is a finding, and is kept",
        },
    }
