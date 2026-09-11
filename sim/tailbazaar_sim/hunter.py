"""Bounded hunter: search the operating envelope for admissible, dynamics-driven failures.

The hunter never modifies the controller or the scene. It only chooses scenario
parameters inside the published envelope, runs the pinned simulator, and keeps runs that
exhibit a failure class. Search modes:
  grid        a fixed grid over sensor delay x floor friction (actuator delay, payload and
              deck grip held at their nominal values). Cost = number of grid points.
  grid-load   a fixed grid over load friction x floor friction, the two physical axes that
              govern whether a carried load stays on the deck (both delays and the payload
              held at their nominal values). Added with the LOAD_SHED class.
  random      N scenarios drawn with a seeded RNG uniformly over the same two axes as
              `grid` (delays snapped to the 20 ms control tick, friction rounded to 3
              places).
  random-load N scenarios drawn with a seeded RNG over sensor delay x floor friction x
              load friction.

Failure classes (both decided by the physics; see simulate.py):
  COLLISION   a cart geom touched the obstacle. Severity proxy: impact speed (m/s).
  LOAD_SHED   the load left the deck. Severity proxy: the load's speed relative to the
              chassis at the moment the shed criterion fired (m/s).
A run may carry both.

Selection policy (deterministic, documented): findings are grouped by their exact set of
failure classes, because a cart that hits a rack and a cart that drops its pallet are
different products and are never duplicates of each other. Within a class group, among
findings that are not approximate duplicates of an already-selected one, prefer the
smallest normalized distance to the nominal operating point (the "mildest" conditions
that break the controller), ties broken by higher severity proxy. No severity proxy is a
damage estimate and no monetary value is attached anywhere.

`selected` keeps exactly its schema tb-run-1 meaning — the COLLISION findings, in the
same order the same rule always produced — so existing consumers are unaffected.
`selected_by_class` is the complete, class-aware structure.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from .envelope import (
    DT_CTRL_MS,
    DUPLICATE_DISTANCE,
    DUPLICATE_RULE_PROSE,
    ENVELOPE,
    NOMINAL_SCENARIO,
    is_duplicate_finding,
    normalize,
    scenario_distance,
)
from .simulate import run_scenario, summarize

HUNTER_ID = "grid-random-hunter-v2"

# Which severity proxy ranks a finding, per failure-class set.
SEVERITY_FIELD = {
    "COLLISION": "impact_speed_mps",
    "LOAD_SHED": "load_rel_speed_at_shed_mps",
}


def class_key(classes: list[str]) -> str:
    return "+".join(classes) if classes else "NONE"


def grid_scenarios(delay_steps: int = 20, friction_steps: float = 0.1) -> list[dict[str, Any]]:
    delays = list(range(ENVELOPE["sensor_delay_ms"]["min"], ENVELOPE["sensor_delay_ms"]["max"] + 1, delay_steps))
    fr_lo, fr_hi = ENVELOPE["floor_friction"]["min"], ENVELOPE["floor_friction"]["max"]
    n = int(round((fr_hi - fr_lo) / friction_steps)) + 1
    frictions = [round(fr_lo + i * friction_steps, 3) for i in range(n)]
    out = []
    for mu in frictions:
        for sd in delays:
            out.append(normalize(dict(NOMINAL_SCENARIO, sensor_delay_ms=sd, floor_friction=mu)))
    return out


def load_grid_scenarios(load_steps: float = 0.05, friction_steps: float = 0.1) -> list[dict[str, Any]]:
    """Grid over the two physical axes that govern whether the load stays on the deck."""
    lf_lo, lf_hi = ENVELOPE["load_friction"]["min"], ENVELOPE["load_friction"]["max"]
    nl = int(round((lf_hi - lf_lo) / load_steps)) + 1
    loads = [round(lf_lo + i * load_steps, 3) for i in range(nl)]
    fr_lo, fr_hi = ENVELOPE["floor_friction"]["min"], ENVELOPE["floor_friction"]["max"]
    nf = int(round((fr_hi - fr_lo) / friction_steps)) + 1
    frictions = [round(fr_lo + i * friction_steps, 3) for i in range(nf)]
    out = []
    for mu in frictions:
        for lf in loads:
            out.append(normalize(dict(NOMINAL_SCENARIO, floor_friction=mu, load_friction=lf)))
    return out


def random_scenarios(n: int, seed: int) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    out = []
    sd_spec, fr_spec = ENVELOPE["sensor_delay_ms"], ENVELOPE["floor_friction"]
    for _ in range(n):
        sd = int(rng.integers(sd_spec["min"] // DT_CTRL_MS, sd_spec["max"] // DT_CTRL_MS + 1)) * DT_CTRL_MS
        mu = round(float(rng.uniform(fr_spec["min"], fr_spec["max"])), 3)
        out.append(normalize(dict(NOMINAL_SCENARIO, sensor_delay_ms=sd, floor_friction=mu)))
    return out


def random_load_scenarios(n: int, seed: int) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    out = []
    sd_spec, fr_spec, lf_spec = ENVELOPE["sensor_delay_ms"], ENVELOPE["floor_friction"], ENVELOPE["load_friction"]
    for _ in range(n):
        sd = int(rng.integers(sd_spec["min"] // DT_CTRL_MS, sd_spec["max"] // DT_CTRL_MS + 1)) * DT_CTRL_MS
        mu = round(float(rng.uniform(fr_spec["min"], fr_spec["max"])), 3)
        lf = round(float(rng.uniform(lf_spec["min"], lf_spec["max"])), 3)
        out.append(normalize(dict(NOMINAL_SCENARIO, sensor_delay_ms=sd, floor_friction=mu, load_friction=lf)))
    return out


MODES = {
    "grid": (lambda n, seed: grid_scenarios(), ["sensor_delay_ms", "floor_friction"]),
    "grid-load": (lambda n, seed: load_grid_scenarios(), ["load_friction", "floor_friction"]),
    "random": (random_scenarios, ["sensor_delay_ms", "floor_friction"]),
    "random-load": (random_load_scenarios, ["sensor_delay_ms", "floor_friction", "load_friction"]),
}


def _severity(row: dict[str, Any]) -> float:
    """Severity proxy for a finding's own class set: the worse of the proxies it carries."""
    vals = [row.get(SEVERITY_FIELD[c]) or 0.0 for c in row["failure_classes"]]
    return max(vals) if vals else 0.0


def hunt(mode: str = "grid", n: int = 40, seed: int = 1, verbose: bool = True) -> dict[str, Any]:
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
            "chassis_outcome": r["chassis_outcome"],
            "failure_classes": r["failure_classes"],
            "primary_failure_class": r["primary_failure_class"],
            "impact_speed_mps": m.get("impact_speed_mps"),
            "final_clearance_m": m.get("final_clearance_m"),
            "stopping_distance_m": m.get("stopping_distance_m"),
            "load_shed": m.get("load_shed"),
            "load_shed_t_s": m.get("load_shed_t_s"),
            "load_shed_criterion": m.get("load_shed_criterion"),
            "load_shed_direction": m.get("load_shed_direction"),
            "load_shed_phase": m.get("load_shed_phase"),
            "load_rel_speed_at_shed_mps": m.get("load_rel_speed_at_shed_mps"),
            "load_slip_max_m": m.get("load_slip_max_m"),
            "peak_decel_mps2": m.get("peak_decel_mps2"),
            "deck_grip_margin": m.get("deck_grip_margin"),
            "distance_to_nominal": round(scenario_distance(r["scenario"], NOMINAL_SCENARIO), 4),
        }
        runs.append(row)
        if verbose:
            print(summarize(r))
    wall = time.perf_counter() - t0

    failures = [r for r in runs if r["failure_classes"]]
    collisions = [r for r in runs if "COLLISION" in r["failure_classes"]]
    sheds = [r for r in runs if "LOAD_SHED" in r["failure_classes"]]
    both = [r for r in runs if len(r["failure_classes"]) == 2]
    inconclusive = [r for r in runs if r["outcome"] not in ("COLLISION", "LOAD_SHED", "SUCCESS")]

    # Class-aware selection: group by the exact class set, then apply the existing
    # mildest-first rule inside each group. Findings of different class sets are never
    # duplicates of each other, so no cross-group comparison ever happens.
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
                duplicates.append({"scenario": r["scenario"], "failure_classes": r["failure_classes"],
                                   "duplicate_of": dup_of["scenario"],
                                   "distance": round(scenario_distance(r["scenario"], dup_of["scenario"]), 4)})
        selected_by_class[key] = keep

    # Backwards-compatible view: the COLLISION-only ranking and selection, unchanged.
    ordered = sorted(collisions, key=lambda r: (r["distance_to_nominal"], -(r["impact_speed_mps"] or 0.0)))
    selected: list[dict[str, Any]] = []
    for r in ordered:
        if not any(
            s["failure_classes"] == r["failure_classes"]
            and scenario_distance(r["scenario"], s["scenario"]) < DUPLICATE_DISTANCE
            for s in selected
        ):
            selected.append(r)

    searched = {k: ENVELOPE[k] for k in axes}
    return {
        "hunter_id": HUNTER_ID,
        "mode": mode,
        "seed": seed if mode.startswith("random") else None,
        "search_cost": {
            "simulations": len(runs),
            "sim_steps": total_steps,
            "wall_time_s": round(wall, 3),
        },
        "envelope_searched": {**searched, "held_fixed": held},
        "failure_classes": ["COLLISION", "LOAD_SHED"],
        "severity_proxies": dict(SEVERITY_FIELD),
        "duplicate_rule": {
            "metric": "normalized L-infinity over envelope ranges",
            "threshold": DUPLICATE_DISTANCE,
            "class_aware": True,
            "prose": DUPLICATE_RULE_PROSE,
        },
        "counts": {
            "success": sum(1 for r in runs if r["outcome"] == "SUCCESS"),
            "collision": len(collisions),
            "load_shed": len(sheds),
            "collision_and_load_shed": len(both),
            "load_shed_only": len(sheds) - len(both),
            "any_failure": len(failures),
            "inconclusive": len(inconclusive),
        },
        "runs": runs,
        "collisions_ranked": ordered,
        "selected": selected,
        "selected_by_class": selected_by_class,
        "near_duplicates": duplicates,
    }
