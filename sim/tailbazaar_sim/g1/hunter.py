"""Bounded hunter: search the G1 envelope for admissible, dynamics-driven falls.

The hunter never modifies the policy, the model or the scene. It only chooses scenario parameters
inside the published envelope, runs the pinned simulator, and keeps the runs whose failure class
fired. Every mode has a fixed, declared cost; nothing adapts, nothing learns, no model in the loop.

Search modes (all bounded; `search_cost` in the result reports what each one actually spent):
  grid-push      impulse magnitude x heading, everything else nominal.
  grid-systems   control latency x actuator noise, no push.
  grid-terrain   floor friction x body mass scale, no push.
  random         n scenarios drawn with a seeded RNG over all eight continuous axes.

Failure class (decided by THIS PROJECT'S predicate; see simulate.py):
  FELL           pelvis below 0.462 m or tilted past 60 deg. Severity proxy:
                 pelvis_impact_speed_mps, the measured pelvis speed at the fall's first non-foot
                 ground contact.

Selection policy (deterministic, identical in shape to the other targets'): findings are grouped
by their exact set of failure classes; within a group, among findings that are not approximate
duplicates of an already-selected one, prefer the SMALLEST normalized distance to the nominal
operating point — the mildest conditions that break the policy — with ties broken by the higher
severity proxy. No severity proxy is a damage estimate and no monetary value is attached anywhere.
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
    TARGET_ID,
    is_duplicate_finding,
    normalize,
    scenario_distance,
    snap_push_time,
)
from .simulate import run_scenario, summarize

HUNTER_ID = "g1-grid-random-hunter-v1"

SEVERITY_FIELD = {"FELL": "pelvis_impact_speed_mps"}


def class_key(classes: list[str]) -> str:
    return "+".join(classes) if classes else "NONE"


def _frange(lo: float, hi: float, step: float, places: int) -> list[float]:
    n = int(round((hi - lo) / step)) + 1
    return [round(lo + i * step, places) for i in range(n)]


def push_grid(impulse_step: float = 4.0, impulse_max: float = 40.0, heading_step: float = 45.0) -> list[dict[str, Any]]:
    """Impulse magnitude x heading, capped at impulse_max (below the envelope's 60 N*s): the boundary
    sits near the bottom of the axis and there is no point paying for shoves nobody would survive."""
    impulses = _frange(ENVELOPE["push_impulse_ns"]["min"], impulse_max, impulse_step, 2)
    headings = _frange(0.0, 360.0 - heading_step, heading_step, 1)
    return [normalize(dict(NOMINAL_SCENARIO, push_impulse_ns=i, push_heading_deg=h)) for i in impulses for h in headings]


def systems_grid(noise_step: float = 0.05) -> list[dict[str, Any]]:
    lat = list(range(ENVELOPE["control_latency_ms"]["min"], ENVELOPE["control_latency_ms"]["max"] + 1, DT_CTRL_MS))
    noise = _frange(ENVELOPE["actuator_noise_frac"]["min"], ENVELOPE["actuator_noise_frac"]["max"], noise_step, 3)
    return [normalize(dict(NOMINAL_SCENARIO, control_latency_ms=l, actuator_noise_frac=n)) for l in lat for n in noise]


def terrain_grid(friction_step: float = 0.2, mass_step: float = 0.09) -> list[dict[str, Any]]:
    mu = _frange(ENVELOPE["floor_friction"]["min"], ENVELOPE["floor_friction"]["max"], friction_step, 3)
    mass = _frange(ENVELOPE["body_mass_scale"]["min"], ENVELOPE["body_mass_scale"]["max"], mass_step, 3)
    return [normalize(dict(NOMINAL_SCENARIO, floor_friction=m, body_mass_scale=s)) for m in mu for s in mass]


def random_scenarios(n: int, seed: int) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    out = []
    lat_spec = ENVELOPE["control_latency_ms"]
    for _ in range(n):
        out.append(normalize({
            "push_impulse_ns": round(float(rng.uniform(ENVELOPE["push_impulse_ns"]["min"], ENVELOPE["push_impulse_ns"]["max"])), 2),
            "push_heading_deg": round(float(rng.uniform(0.0, 360.0)), 1),
            "push_time_s": snap_push_time(float(rng.uniform(ENVELOPE["push_time_s"]["min"], ENVELOPE["push_time_s"]["max"]))),
            "floor_friction": round(float(rng.uniform(ENVELOPE["floor_friction"]["min"], ENVELOPE["floor_friction"]["max"])), 3),
            "body_mass_scale": round(float(rng.uniform(ENVELOPE["body_mass_scale"]["min"], ENVELOPE["body_mass_scale"]["max"])), 3),
            "actuator_noise_frac": round(float(rng.uniform(ENVELOPE["actuator_noise_frac"]["min"], ENVELOPE["actuator_noise_frac"]["max"])), 3),
            "control_latency_ms": int(rng.integers(lat_spec["min"] // DT_CTRL_MS, lat_spec["max"] // DT_CTRL_MS + 1)) * DT_CTRL_MS,
            "cmd_vx_mps": round(float(rng.uniform(ENVELOPE["cmd_vx_mps"]["min"], ENVELOPE["cmd_vx_mps"]["max"])), 2),
        }))
    return out


MODES: dict[str, tuple[Any, list[str]]] = {
    "grid-push": (lambda n, seed: push_grid(), ["push_impulse_ns", "push_heading_deg"]),
    "grid-systems": (lambda n, seed: systems_grid(), ["control_latency_ms", "actuator_noise_frac"]),
    "grid-terrain": (lambda n, seed: terrain_grid(), ["floor_friction", "body_mass_scale"]),
    "random": (random_scenarios, ["push_impulse_ns", "push_heading_deg", "push_time_s", "floor_friction",
                                  "body_mass_scale", "actuator_noise_frac", "control_latency_ms", "cmd_vx_mps"]),
}


def _severity(row: dict[str, Any]) -> float:
    vals = [row.get(SEVERITY_FIELD[c]) or 0.0 for c in row["failure_classes"]]
    return max(vals) if vals else 0.0


def hunt(mode: str = "grid-push", n: int = 60, seed: int = 1, verbose: bool = True) -> dict[str, Any]:
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
            "fell": m.get("fell"),
            "fall_detected_by": m.get("fall_detected_by"),
            "fall_time_s": m.get("fall_time_s"),
            "survival_time_s": m.get("survival_time_s"),
            "distance_travelled_x_m": m.get("distance_travelled_x_m"),
            "pelvis_min_z_m": m.get("pelvis_min_z_m"),
            "max_tilt_deg": m.get("max_tilt_deg"),
            "pelvis_impact_speed_mps": m.get("pelvis_impact_speed_mps"),
            "peak_pelvis_accel_mps2": m.get("peak_pelvis_accel_mps2"),
            "ground_contact_body": m.get("ground_contact_body"),
            "distance_to_nominal": round(scenario_distance(r["scenario"], NOMINAL_SCENARIO), 4),
        }
        runs.append(row)
        if verbose:
            print(summarize(r))
    wall = time.perf_counter() - t0

    failures = [r for r in runs if r["failure_classes"]]
    inconclusive = [r for r in runs if r["outcome"] not in ("SURVIVED", "FELL")]

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
                duplicates.append({"scenario": r["scenario"], "failure_classes": r["failure_classes"], "duplicate_of": dup_of["scenario"],
                                   "distance": round(scenario_distance(r["scenario"], dup_of["scenario"]), 4)})
        selected_by_class[key] = keep

    selected = selected_by_class.get("FELL", [])
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
        "envelope_searched": {**{k: ENVELOPE[k] for k in axes if k in ENVELOPE}, "held_fixed": held},
        "failure_classes": ["FELL"],
        "severity_proxies": dict(SEVERITY_FIELD),
        "duplicate_rule": {"metric": "normalized L-infinity over envelope ranges", "threshold": DUPLICATE_DISTANCE, "class_aware": True, "prose": DUPLICATE_RULE_PROSE},
        "counts": {
            "survived": sum(1 for r in runs if r["outcome"] == "SURVIVED"),
            "fell": len(failures),
            "any_failure": len(failures),
            "inconclusive": len(inconclusive),
        },
        "runs": runs,
        "selected": selected,
        "selected_by_class": selected_by_class,
        "near_duplicates": duplicates,
    }
