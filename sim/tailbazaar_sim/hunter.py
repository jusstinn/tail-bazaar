"""Bounded hunter: search the operating envelope for admissible, dynamics-driven collisions.

The hunter never modifies the controller or the scene. It only chooses scenario
parameters inside the published envelope, runs the pinned simulator, and keeps runs
whose outcome is COLLISION. Two search modes:
  grid    a fixed grid over sensor delay x floor friction (actuator delay and payload
          held at their nominal values). Cost = number of grid points.
  random  N scenarios drawn with a seeded RNG uniformly over the same two axes
          (delays snapped to the 20 ms control tick, friction rounded to 3 places).

Selection policy (deterministic, documented): among admissible collisions that are not
approximate duplicates of an already-selected finding, prefer the one with the
smallest normalized distance to the nominal operating point (the "mildest" conditions
that break the controller), ties broken by higher impact speed. Severity proxy is the
impact speed in m/s (and the derived kinetic energy); it is not a damage estimate.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from .envelope import (
    DT_CTRL_MS,
    DUPLICATE_DISTANCE,
    ENVELOPE,
    NOMINAL_SCENARIO,
    is_duplicate,
    normalize,
    scenario_distance,
)
from .simulate import run_scenario, summarize

HUNTER_ID = "grid-random-hunter-v1"


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


def random_scenarios(n: int, seed: int) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    out = []
    sd_spec, fr_spec = ENVELOPE["sensor_delay_ms"], ENVELOPE["floor_friction"]
    for _ in range(n):
        sd = int(rng.integers(sd_spec["min"] // DT_CTRL_MS, sd_spec["max"] // DT_CTRL_MS + 1)) * DT_CTRL_MS
        mu = round(float(rng.uniform(fr_spec["min"], fr_spec["max"])), 3)
        out.append(normalize(dict(NOMINAL_SCENARIO, sensor_delay_ms=sd, floor_friction=mu)))
    return out


def hunt(mode: str = "grid", n: int = 40, seed: int = 1, verbose: bool = True) -> dict[str, Any]:
    if mode == "grid":
        scenarios = grid_scenarios()
    elif mode == "random":
        scenarios = random_scenarios(n, seed)
    else:
        raise ValueError(mode)
    t0 = time.perf_counter()
    runs: list[dict[str, Any]] = []
    total_steps = 0
    for scn in scenarios:
        r = run_scenario(scn, record_frames=False)
        total_steps += r["metrics"].get("sim_steps", 0)
        row = {
            "scenario": r["scenario"],
            "outcome": r["outcome"],
            "impact_speed_mps": r["metrics"].get("impact_speed_mps"),
            "final_clearance_m": r["metrics"].get("final_clearance_m"),
            "stopping_distance_m": r["metrics"].get("stopping_distance_m"),
            "distance_to_nominal": round(scenario_distance(r["scenario"], NOMINAL_SCENARIO), 4),
        }
        runs.append(row)
        if verbose:
            print(summarize(r))
    wall = time.perf_counter() - t0

    collisions = [r for r in runs if r["outcome"] == "COLLISION"]
    inconclusive = [r for r in runs if r["outcome"] not in ("COLLISION", "SUCCESS")]
    ordered = sorted(collisions, key=lambda r: (r["distance_to_nominal"], -(r["impact_speed_mps"] or 0.0)))
    selected: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    for r in ordered:
        dup_of = next((s for s in selected if is_duplicate(r["scenario"], s["scenario"])), None)
        if dup_of is None:
            selected.append(r)
        else:
            duplicates.append({"scenario": r["scenario"], "duplicate_of": dup_of["scenario"],
                               "distance": round(scenario_distance(r["scenario"], dup_of["scenario"]), 4)})

    return {
        "hunter_id": HUNTER_ID,
        "mode": mode,
        "seed": seed if mode == "random" else None,
        "search_cost": {
            "simulations": len(runs),
            "sim_steps": total_steps,
            "wall_time_s": round(wall, 3),
        },
        "envelope_searched": {
            "sensor_delay_ms": ENVELOPE["sensor_delay_ms"],
            "floor_friction": ENVELOPE["floor_friction"],
            "held_fixed": {"actuator_delay_ms": NOMINAL_SCENARIO["actuator_delay_ms"], "payload_kg": NOMINAL_SCENARIO["payload_kg"]},
        },
        "duplicate_rule": {"metric": "normalized L-infinity over envelope ranges", "threshold": DUPLICATE_DISTANCE},
        "counts": {"success": sum(1 for r in runs if r["outcome"] == "SUCCESS"), "collision": len(collisions), "inconclusive": len(inconclusive)},
        "runs": runs,
        "collisions_ranked": ordered,
        "selected": selected,
        "near_duplicates": duplicates,
    }
