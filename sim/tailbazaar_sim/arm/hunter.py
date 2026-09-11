"""Bounded hunter: search the arm envelope for admissible, dynamics-driven drops.

The hunter never modifies the policy, the environment or the scene. It only chooses scenario
parameters inside the published envelope, runs the pinned simulator, and keeps the runs whose
failure class fired. Every mode has a fixed, declared cost; nothing adapts, nothing learns, and
there is no model in the loop.

Search modes (all bounded; `search_cost` in the result reports what each one actually spent):
  grid-grip      grip friction x initial state. The direct question: how slippery does the part
                 have to be before the gripper loses it?
  grid-payload   block mass x initial state. Does a heavier part ON ITS OWN cost the grasp?
                 One axis crossed with the stratification, unconfounded with friction.
  grid-systems   control latency x action noise, everything else nominal. The axis every real
                 deployment has.
  grid-placement block offset x by y, on one initial state. Does a part that is not quite where
                 the policy expected cost it the grasp, or only the placement?
  random         n scenarios drawn with a seeded RNG over all seven continuous axes and the
                 eight published initial states, so the search is not confined to the planes the
                 grids happen to cut.

Failure classes (see simulate.py for who owns each predicate):
  DROPPED        the block left the gripper in mid-air before the environment called it placed.
                 Mechanical predicate over MuJoCo's own contact list. Severity proxy:
                 object_impact_speed_mps, the measured block speed at its landing.
  NOT_PLACED     the ENVIRONMENT's own info["is_success"] was false at its own horizon, with no
                 drop on the way. No severity proxy: nothing was dropped and nothing hit
                 anything, so there is no measured quantity to report and the field is null
                 rather than an invented number.

Selection policy (deterministic, documented and identical in shape to the cart's and the
humanoid's): findings are grouped by their exact set of failure classes; within a group, among
findings that are not approximate duplicates of an already-selected one, prefer the SMALLEST
normalized distance to the nominal operating point OF THEIR OWN INITIAL-STATE STRATUM (see
`nominal_for`) — the mildest conditions that break the policy — with ties broken by the higher
severity proxy. No severity proxy is a damage estimate and no monetary value is attached
anywhere.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from .envelope import (
    DISCRETE,
    DT_CTRL_MS,
    DUPLICATE_DISTANCE,
    DUPLICATE_RULE_PROSE,
    ENVELOPE,
    INIT_SEEDS,
    NOMINAL_SCENARIO,
    TARGET_ID,
    is_duplicate_finding,
    normalize,
    scenario_distance,
)
from .simulate import run_scenario, summarize

HUNTER_ID = "arm-grid-random-hunter-v1"

# NOT_PLACED has no severity proxy on purpose: nothing was dropped, so there is no impact to
# measure. An invented stand-in (how far short it stopped, say) would look like a severity and
# would not be one.
SEVERITY_FIELD: dict[str, str | None] = {
    "DROPPED": "object_impact_speed_mps",
    "NOT_PLACED": None,
}

CONCLUSIVE = ("SUCCESS", "DROPPED", "NOT_PLACED")


def class_key(classes: list[str]) -> str:
    return "+".join(classes) if classes else "NONE"


def _frange(lo: float, hi: float, step: float, places: int) -> list[float]:
    n = int(round((hi - lo) / step)) + 1
    return [round(lo + i * step, places) for i in range(n)]


def grip_grid(friction_values: tuple[float, ...] = (1.0, 0.7, 0.5, 0.35, 0.25, 0.15, 0.1, 0.05, 0.02)) -> list[dict[str, Any]]:
    """Grip friction against every published initial state.

    The values are spaced roughly geometrically rather than linearly: the stock coefficient is
    1.0 and the interesting region is near the bottom of the axis, so a linear sweep would spend
    most of its budget where nothing happens.
    """
    return [normalize({"grip_friction": f, "init_seed": s}) for f in friction_values for s in INIT_SEEDS]


def payload_grid(
    mass_values: tuple[float, ...] = (0.5, 2.0, 5.0, 10.0, 15.0, 20.0),
) -> list[dict[str, Any]]:
    """Block mass against every published initial state, everything else nominal.

    One axis crossed with the stratification, the same shape as `grid-grip`, so the answer to
    "does a heavier part ON ITS OWN make it drop the block?" is not confounded with friction.
    The mass x friction interaction is covered by the random mode.
    """
    return [normalize({"object_mass_kg": m, "init_seed": s}) for m in mass_values for s in INIT_SEEDS]


def systems_grid(noise_step: float = 0.1) -> list[dict[str, Any]]:
    """Control latency x action noise, on the nominal initial state."""
    lat_spec = ENVELOPE["control_latency_ms"]
    latencies = list(range(int(lat_spec["min"]), int(lat_spec["max"]) + 1, DT_CTRL_MS))
    noises = _frange(0.0, float(ENVELOPE["action_noise_frac"]["max"]), noise_step, 3)
    return [
        normalize({"control_latency_ms": lat, "action_noise_frac": nz})
        for lat in latencies
        for nz in noises
    ]


def placement_grid(step: float = 0.025) -> list[dict[str, Any]]:
    """Block x-offset x y-offset, on the nominal initial state."""
    lo = float(ENVELOPE["object_offset_x_m"]["min"])
    hi = float(ENVELOPE["object_offset_x_m"]["max"])
    values = _frange(lo, hi, step, 4)
    return [
        normalize({"object_offset_x_m": dx, "object_offset_y_m": dy}) for dx in values for dy in values
    ]


def random_scenarios(n: int, seed: int) -> list[dict[str, Any]]:
    """n draws over every continuous axis and the eight published initial states."""
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        lat = ENVELOPE["control_latency_ms"]
        glat = ENVELOPE["gripper_latency_ms"]
        out.append(
            normalize(
                {
                    "object_mass_kg": round(float(rng.uniform(ENVELOPE["object_mass_kg"]["min"], ENVELOPE["object_mass_kg"]["max"])), 3),
                    "grip_friction": round(float(rng.uniform(ENVELOPE["grip_friction"]["min"], ENVELOPE["grip_friction"]["max"])), 3),
                    "object_offset_x_m": round(float(rng.uniform(ENVELOPE["object_offset_x_m"]["min"], ENVELOPE["object_offset_x_m"]["max"])), 4),
                    "object_offset_y_m": round(float(rng.uniform(ENVELOPE["object_offset_y_m"]["min"], ENVELOPE["object_offset_y_m"]["max"])), 4),
                    "action_noise_frac": round(float(rng.uniform(ENVELOPE["action_noise_frac"]["min"], ENVELOPE["action_noise_frac"]["max"])), 3),
                    "control_latency_ms": int(rng.integers(int(lat["min"]) // DT_CTRL_MS, int(lat["max"]) // DT_CTRL_MS + 1)) * DT_CTRL_MS,
                    "gripper_latency_ms": int(rng.integers(int(glat["min"]) // DT_CTRL_MS, int(glat["max"]) // DT_CTRL_MS + 1)) * DT_CTRL_MS,
                    "init_seed": int(rng.choice(INIT_SEEDS)),
                }
            )
        )
    return out


MODES: dict[str, tuple[Any, list[str]]] = {
    "grid-grip": (lambda n, seed: grip_grid(), ["grip_friction", "init_seed"]),
    "grid-payload": (lambda n, seed: payload_grid(), ["object_mass_kg", "init_seed"]),
    "grid-systems": (lambda n, seed: systems_grid(), ["control_latency_ms", "action_noise_frac"]),
    "grid-placement": (lambda n, seed: placement_grid(), ["object_offset_x_m", "object_offset_y_m"]),
    "random": (
        random_scenarios,
        [
            "object_mass_kg",
            "grip_friction",
            "object_offset_x_m",
            "object_offset_y_m",
            "action_noise_frac",
            "control_latency_ms",
            "gripper_latency_ms",
            "init_seed",
        ],
    ),
}


def nominal_for(scn: dict[str, Any]) -> dict[str, Any]:
    """The nominal operating point WITHIN a scenario's own initial-state stratum.

    `init_seed` is a stratification, so `scenario_distance` is infinite between two different
    initial states by construction. Ranking a finding by its distance to the global nominal
    point would therefore be infinite for every seed but 0. The meaningful question is "how far
    from nominal operation, holding the block and goal placement fixed", which is the distance
    to nominal with init_seed carried over. It is finite for every scenario and identical to the
    global distance on seed 0.
    """
    return dict(NOMINAL_SCENARIO, init_seed=int(scn["init_seed"]))


def _severity(row: dict[str, Any]) -> float:
    vals = []
    for c in row["failure_classes"]:
        field = SEVERITY_FIELD.get(c)
        if field:
            vals.append(row.get(field) or 0.0)
    return max(vals) if vals else 0.0


def hunt(mode: str = "grid-grip", n: int = 60, seed: int = 1, verbose: bool = True) -> dict[str, Any]:
    if mode not in MODES:
        raise ValueError(mode)
    build, axes = MODES[mode]
    scenarios = build(n, seed)
    held = {k: NOMINAL_SCENARIO[k] for k in NOMINAL_SCENARIO if k not in axes}

    t0 = time.perf_counter()
    runs: list[dict[str, Any]] = []
    total_steps = 0
    for scn in scenarios:
        r = run_scenario(scn, record_frames=False)
        m = r["metrics"]
        total_steps += m.get("sim_steps", 0)
        row = {
            "scenario": r["scenario"],
            "outcome": r["outcome"],
            "failure_classes": r["failure_classes"],
            "primary_failure_class": r["primary_failure_class"],
            "dropped": m.get("dropped"),
            "drop_t_s": m.get("drop_t_s"),
            "drop_height_above_table_m": m.get("drop_height_above_table_m"),
            "recovered_after_drop": m.get("recovered_after_drop"),
            "env_success_at_horizon": m.get("env_success_at_horizon"),
            "episode_return": m.get("episode_return"),
            "object_impact_speed_mps": m.get("object_impact_speed_mps"),
            "landed_on_geom": m.get("landed_on_geom"),
            "landed_on_the_floor": m.get("landed_on_the_floor"),
            "object_lift_m": m.get("object_lift_m"),
            "min_object_goal_distance_m": m.get("min_object_goal_distance_m"),
            "ever_grasped": m.get("ever_grasped"),
            "success_predicate_mismatches": m.get("success_predicate_mismatches"),
            "init_seed": r["scenario"]["init_seed"],
            "distance_to_nominal": round(scenario_distance(r["scenario"], nominal_for(r["scenario"])), 4),
        }
        runs.append(row)
        if verbose:
            print(summarize(r))
    wall = time.perf_counter() - t0

    failures = [r for r in runs if r["failure_classes"]]
    inconclusive = [r for r in runs if r["outcome"] not in CONCLUSIVE]
    mismatches = sum(r["success_predicate_mismatches"] or 0 for r in runs)

    groups: dict[str, list[dict[str, Any]]] = {}
    for r in failures:
        groups.setdefault(class_key(r["failure_classes"]), []).append(r)
    selected_by_class: dict[str, list[dict[str, Any]]] = {}
    duplicates: list[dict[str, Any]] = []
    for key in sorted(groups):
        ordered_g = sorted(groups[key], key=lambda r: (r["distance_to_nominal"], -_severity(r)))
        keep: list[dict[str, Any]] = []
        for r in ordered_g:
            dup_of = next((s for s in keep if is_duplicate_finding(r, s)), None)
            if dup_of is None:
                keep.append(r)
            else:
                duplicates.append(
                    {
                        "scenario": r["scenario"],
                        "failure_classes": r["failure_classes"],
                        "duplicate_of": dup_of["scenario"],
                        "distance": round(scenario_distance(r["scenario"], dup_of["scenario"]), 4),
                    }
                )
        selected_by_class[key] = keep

    selected = selected_by_class.get("DROPPED", [])
    return {
        "hunter_id": HUNTER_ID,
        "target_id": TARGET_ID,
        "mode": mode,
        "seed": seed if mode == "random" else None,
        "search_cost": {
            "simulations": len(runs),
            "sim_steps": total_steps,
            "wall_time_s": round(wall, 3),
            "bounded_by": "a fixed scenario list built before the first run; no adaptation, no model in the loop",
        },
        "envelope_searched": {
            **{k: ENVELOPE[k] for k in axes if k in ENVELOPE},
            **({"init_seed": DISCRETE["init_seed"]} if "init_seed" in axes else {}),
            "held_fixed": held,
        },
        "failure_classes": ["DROPPED", "NOT_PLACED"],
        "severity_proxies": dict(SEVERITY_FIELD),
        "duplicate_rule": {
            "metric": "normalized L-infinity over envelope ranges",
            "threshold": DUPLICATE_DISTANCE,
            "class_aware": True,
            "prose": DUPLICATE_RULE_PROSE,
        },
        "counts": {
            "success": sum(1 for r in runs if r["outcome"] == "SUCCESS"),
            "dropped": sum(1 for r in runs if r["outcome"] == "DROPPED"),
            "dropped_but_recovered": sum(1 for r in runs if r["recovered_after_drop"]),
            "dropped_to_the_floor": sum(1 for r in runs if r["landed_on_the_floor"]),
            "not_placed": sum(1 for r in runs if r["outcome"] == "NOT_PLACED"),
            "any_failure": len(failures),
            "inconclusive": len(inconclusive),
        },
        "success_predicate_mismatches_total": mismatches,
        "runs": runs,
        "selected": selected,
        "selected_by_class": selected_by_class,
        "near_duplicates": duplicates,
    }
