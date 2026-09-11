"""Command line for the ARM target. Additive: the cart's `tailbazaar_sim.cli` and the
humanoid's `tailbazaar_sim.humanoid.cli` are untouched and keep working exactly as they did.
All output goes under the directory given by --out (default sim/out-arm).

  policy                                          print the pinned provenance, verify digests
  selfcheck                                       YAML/Python drift, shim proof, rule checks
  nominal                                         -> nominal-suite.json
  hunt --mode MODE [--n N --seed S]               -> hunt-<mode>[-seedS].json
  run --scenario JSON --name NAME [--render]      -> runs/NAME.json (+ gif/png)
  repeat --scenario JSON [--n 3]                  -> repeatability-<hash>.json
  render --run runs/NAME.json                     -> NAME.gif, NAME-metrics.png
  compare --baseline A.json --failure B.json      -> <name>-side-by-side.png
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import yaml

from .. import canonical
from . import compat, envelope as env_mod, scene as scene_mod
from .envelope import (
    DISCRETE,
    DUPLICATE_DISTANCE,
    ENVELOPE,
    ENVELOPE_ID,
    ENVELOPE_REVISION,
    NOMINAL_SCENARIO,
    PARAM_ORDER,
    check_admissible,
    normalize,
    scenario_distance,
)
from .hunter import hunt
from .nominal import run_nominal_suite
from .policy import (
    ARCHIVE_SHA256,
    PROVENANCE_URL,
    REPO_ID,
    REPO_REVISION,
    WEIGHTS_SHA256,
    load_policy,
)
from .simulate import _selfcheck_math, engine_info, run_scenario, summarize

SIM_ROOT = Path(__file__).resolve().parents[2]
ENVELOPE_YAML = SIM_ROOT / "envelope-arm.yaml"
DEFAULT_OUT = SIM_ROOT / "out-arm"


def environment_pin() -> dict[str, Any]:
    lock = SIM_ROOT / "uv.lock"
    return {
        **engine_info(),
        "uv_lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None,
    }


def write_json(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical.dumps_bytes(canonical.quantize(doc)))


def _load_scenario(text: str) -> dict[str, Any]:
    return normalize(json.loads(text))


# ---------------------------------------------------------------------------- policy


def cmd_policy(args: argparse.Namespace) -> int:
    p = load_policy()
    ident = p.identity()
    print(f"repo      {REPO_ID}")
    print(f"revision  {REPO_REVISION}")
    print(f"url       {PROVENANCE_URL}")
    print(f"archive   {ident['archive_filename']}  {ident['archive_bytes']} bytes")
    print(f"          {ident['archive_sha256']}  (pinned sha256:{ARCHIVE_SHA256})")
    print(f"weights   {ident['weights_member']}  {ident['weights_bytes']} bytes")
    print(f"          {ident['weights_sha256']}  (pinned sha256:{WEIGHTS_SHA256})")
    print(f"actor     {ident['actor_tensor_sha256']}")
    print(f"net       {ident['obs_dim']} -> {ident['hidden_sizes']} -> {ident['action_dim']}  "
          f"({ident['n_actor_parameters']} parameters, {ident['activation']})")
    print(f"obs order {ident['obs_key_order']} = {ident['obs_key_dims']}")
    print(f"algo      {ident['algo_detail']}, {ident['framework']} {ident['framework_version']}")
    print(f"claim     mean_reward {ident['published_mean_reward']} +/- "
          f"{round(float(ident['published_std_reward']), 2)} over {ident['published_eval_episodes']} "
          f"deterministic episodes of {ident['published_env_id']} (the PUBLISHER's claim)")
    print(f"licence   {ident['licence']['status']} (declared_spdx: {ident['licence']['declared_spdx']})")
    print("          " + ident["licence"]["survey"])
    if args.json:
        print(json.dumps(ident, indent=2, sort_keys=True))
    return 0


# ---------------------------------------------------------------------------- selfcheck


def _yaml_axis_map(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {a["name"]: a for a in doc.get("continuous", [])}


def cmd_selfcheck(args: argparse.Namespace) -> int:
    problems: list[str] = []
    notes: list[str] = []

    shim = compat.verify()
    if not shim["ok"]:
        problems.append(f"compatibility shim verification failed: {shim['checks']}")
    notes.append(
        f"compat shim: gymnasium-robotics {shim['gymnasium_robotics_version']} on mujoco "
        f"{shim['mujoco_version']}, upstream bug present: {shim['bug_present_without_shim']}, "
        f"all {len(shim['checks'])} accessor checks pass"
    )

    if not ENVELOPE_YAML.exists():
        problems.append(f"{ENVELOPE_YAML} is missing")
    else:
        doc = yaml.safe_load(ENVELOPE_YAML.read_text())
        if doc.get("envelope_id") != ENVELOPE_ID:
            problems.append(f"envelope_id drift: yaml {doc.get('envelope_id')} vs python {ENVELOPE_ID}")
        if doc.get("envelope_revision") != ENVELOPE_REVISION:
            problems.append("envelope_revision drift")
        axes = _yaml_axis_map(doc)
        if set(axes) != set(ENVELOPE):
            problems.append(f"axis set drift: yaml {sorted(axes)} vs python {sorted(ENVELOPE)}")
        for name, spec in ENVELOPE.items():
            a = axes.get(name)
            if a is None:
                continue
            if float(a["low"]) != float(spec["min"]) or float(a["high"]) != float(spec["max"]):
                problems.append(f"{name}: yaml [{a['low']}, {a['high']}] vs python [{spec['min']}, {spec['max']}]")
            if float(a["nominal"]) != float(NOMINAL_SCENARIO[name]):
                problems.append(f"{name}: yaml nominal {a['nominal']} vs python {NOMINAL_SCENARIO[name]}")
            if a.get("group") != spec["group"]:
                problems.append(f"{name}: group drift")
            if a.get("marginal") is not None or a.get("scale") is not None:
                problems.append(f"{name}: marginal/scale must be null (no distribution D is stated)")
        d = doc.get("discrete", [])
        yaml_seeds = {x["name"]: x for x in d}
        if set(yaml_seeds) != set(DISCRETE):
            problems.append("discrete axis set drift")
        elif list(yaml_seeds["init_seed"]["values"]) != list(DISCRETE["init_seed"]["values"]):
            problems.append("init_seed values drift")
        if doc.get("target_id") != env_mod.TARGET_ID:
            problems.append("target_id drift")
        if float(doc.get("duplicate_distance", -1)) != float(DUPLICATE_DISTANCE):
            problems.append("duplicate_distance drift")
        if int(doc.get("control_tick_ms", -1)) != int(env_mod.DT_CTRL_MS):
            problems.append("control_tick_ms drift")
        if float(doc.get("airborne_margin_m", -1)) != float(env_mod.AIRBORNE_MARGIN_M):
            problems.append("airborne_margin_m drift")
        tgt = doc.get("target", {})
        if tgt.get("repo_revision") != REPO_REVISION:
            problems.append("yaml target.repo_revision drift")
        if tgt.get("archive_sha256") != ARCHIVE_SHA256:
            problems.append("yaml target.archive_sha256 drift")
        if tgt.get("weights_sha256") != WEIGHTS_SHA256:
            problems.append("yaml target.weights_sha256 drift")
        notes.append(f"envelope yaml: {len(axes)} continuous + {len(d)} discrete axes agree with envelope.py")

    # Rules that must hold regardless of anything downloaded.
    math_checks = _selfcheck_math()
    for k, v in math_checks.items():
        if v is False:
            problems.append(f"self-check failed: {k}")
    if check_admissible(NOMINAL_SCENARIO):
        problems.append("the nominal scenario is not admissible in its own envelope")
    if scenario_distance(NOMINAL_SCENARIO, NOMINAL_SCENARIO) != 0.0:
        problems.append("distance from nominal to itself is not zero")
    if sorted(PARAM_ORDER) != sorted(list(ENVELOPE) + list(DISCRETE)):
        problems.append("PARAM_ORDER does not cover exactly the continuous + discrete axes")
    for name, spec in ENVELOPE.items():
        nom = float(NOMINAL_SCENARIO[name])
        if not (float(spec["min"]) <= nom <= float(spec["max"])):
            problems.append(f"{name}: nominal {nom} outside its own bounds")
    notes.append(f"scenario rules: {len(ENVELOPE)} continuous axes, nominal admissible, distance metric sane")

    # Scene facts read out of the compiled model, not typed in.
    if not args.offline:
        env = scene_mod.make_env(float(NOMINAL_SCENARIO["object_mass_kg"]), float(NOMINAL_SCENARIO["grip_friction"]))
        index = scene_mod.SceneIndex(env.model)
        horizon = scene_mod.episode_steps()
        if abs(float(env.dt) - scene_mod.EXPECTED_DT_S) > 1e-9:
            problems.append(f"control dt drift: {env.dt} vs {scene_mod.EXPECTED_DT_S}")
        if horizon != scene_mod.EXPECTED_EPISODE_STEPS:
            problems.append(f"episode horizon drift: {horizon} vs {scene_mod.EXPECTED_EPISODE_STEPS}")
        if abs(float(env.distance_threshold) - scene_mod.EXPECTED_DISTANCE_THRESHOLD) > 1e-9:
            problems.append("distance_threshold drift")
        if abs(float(env.model.body_mass[index.object_body]) - scene_mod.STOCK_OBJECT_MASS_KG) > 1e-9:
            problems.append("stock object mass drift")
        notes.append(
            f"scene: dt {env.dt}s, horizon {horizon} ticks, threshold {env.distance_threshold} m, "
            f"table top {round(index.table_top_z, 4)} m, block half {round(index.object_half, 4)} m, "
            f"resting z {round(index.resting_z, 4)} m"
        )
        env.close()

    for n in notes:
        print("ok  ", n)
    for p in problems:
        print("FAIL", p)
    print("selfcheck:", "PASS" if not problems else f"FAIL ({len(problems)} problems)")
    return 0 if not problems else 1


# ---------------------------------------------------------------------------- run/hunt


def cmd_nominal(args: argparse.Namespace) -> int:
    res = run_nominal_suite()
    res["environment"] = environment_pin()
    write_json(Path(args.out) / "nominal-suite.json", res)
    for r in res["results"]:
        print(f"  {r['name']:32s} {r['outcome']:11s} return={r['episode_return']:7.1f} "
              f"lift={r['object_lift_m']:.4f}m  goal_dist={r['min_object_goal_distance_m']:.4f}m  "
              f"dropped={r['dropped']}")
    rp = res["reproduces_published_number"]
    print(f"measured mean return over {rp['measured_over_episodes']} published-conditions episodes: "
          f"{rp['measured_mean_return']}  (publisher claims {rp['published_mean_reward']} +/- "
          f"{round(rp['published_std_reward'], 2)}; inside: {rp['inside_publishers_quoted_spread']})")
    print("published_conditions_all_passed:", res["published_conditions_all_passed"])
    print("benign_perturbations_all_passed:", res["benign_perturbations_all_passed"])
    print("no_case_dropped:", res["no_case_dropped"])
    print("all_passed:", res["all_passed"])
    return 0 if res["all_passed"] else 1


def cmd_hunt(args: argparse.Namespace) -> int:
    res = hunt(mode=args.mode, n=args.n, seed=args.seed, verbose=not args.quiet)
    res["environment"] = environment_pin()
    suffix = "" if args.mode.startswith("grid") else "-seed" + str(args.seed)
    out = Path(args.out) / f"hunt-{args.mode}{suffix}.json"
    write_json(out, res)
    c = res["counts"]
    sc = res["search_cost"]
    print(f"search cost: {sc['simulations']} simulations, {sc['sim_steps']} sim steps, {sc['wall_time_s']}s")
    print(f"  success={c['success']} dropped={c['dropped']} (recovered={c['dropped_but_recovered']}, "
          f"to the floor={c['dropped_to_the_floor']}) not_placed={c['not_placed']} inconclusive={c['inconclusive']}")
    print(f"  success-predicate mismatches: {res['success_predicate_mismatches_total']}")
    total_selected = sum(len(v) for v in res["selected_by_class"].values())
    print(f"distinct findings after the class-aware duplicate rule: {total_selected}; "
          f"near-duplicates: {len(res['near_duplicates'])}")
    for key in sorted(res["selected_by_class"]):
        keep = res["selected_by_class"][key]
        print(f"  class {key}: {len(keep)} distinct")
        for s in keep[:3]:
            print(f"    d={s['distance_to_nominal']} sev={s['object_impact_speed_mps']} {s['scenario']}")
    print("wrote", out)
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    scn = _load_scenario(args.scenario)
    res = run_scenario(scn)
    res["environment"] = environment_pin()
    out = Path(args.out) / "runs" / f"{args.name}.json"
    write_json(out, res)
    print(summarize(res))
    print("events:", json.dumps(res["events"]))
    print("trajectory_hash:", res["trajectory_hash"])
    print("state_hash:", res["state_hash"])
    print("wrote", out, out.stat().st_size, "bytes")
    if args.render:
        _render(out, Path(args.out), args.name)
    return 0


def _render(run_path: Path, out_dir: Path, name: str) -> None:
    from .render import metrics_png, side_view_gif

    res = json.loads(run_path.read_bytes())
    gif = side_view_gif(res, str(out_dir / f"{name}.gif"), label=name)
    png = metrics_png(res, str(out_dir / f"{name}-metrics.png"), title=name)
    print("wrote", gif, "and", png)


def cmd_render(args: argparse.Namespace) -> int:
    p = Path(args.run)
    _render(p, Path(args.out), p.stem)
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    from .render import side_by_side_png

    a = json.loads(Path(args.baseline).read_bytes())
    b = json.loads(Path(args.failure).read_bytes())
    times = [float(x) for x in args.times.split(",")] if args.times else None
    out = side_by_side_png(a, b, str(Path(args.out) / f"{args.name}.png"), times)
    print("wrote", out)
    return 0


REPEAT_FIELDS = (
    "outcome",
    "primary_failure_class",
    "env_success_at_horizon",
    "episode_return",
    "dropped",
    "drop_t_s",
    "drop_height_above_table_m",
    "recovered_after_drop",
    "object_impact_speed_mps",
    "object_peak_speed_after_drop_mps",
    "landed_on_geom",
    "landed_on_the_floor",
    "object_max_z_m",
    "min_object_goal_distance_m",
    "first_grasp_t_s",
    "grasp_ticks",
    "control_ticks",
    "sim_steps",
    "success_predicate_mismatches",
)


def cmd_repeat(args: argparse.Namespace) -> int:
    scn = _load_scenario(args.scenario)
    hashes: list[str] = []
    state_hashes: list[str] = []
    metrics: list[dict[str, Any]] = []
    for _ in range(args.n):
        r = run_scenario(scn)
        hashes.append(r["trajectory_hash"])
        state_hashes.append(r["state_hash"])
        metrics.append({k: r["metrics"].get(k) for k in REPEAT_FIELDS})
    code = (
        "import json,sys; from tailbazaar_sim.arm.simulate import run_scenario; "
        "r=run_scenario(json.loads(sys.argv[1])); "
        "print(json.dumps({'trajectory_hash': r['trajectory_hash'], 'state_hash': r['state_hash'], "
        "'metrics': r['metrics']}))"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code, json.dumps(scn)],
        capture_output=True,
        text=True,
        cwd=str(SIM_ROOT),
        check=True,
    )
    sub = json.loads(proc.stdout.strip().splitlines()[-1])
    sub_metrics = {k: sub["metrics"].get(k) for k in REPEAT_FIELDS}
    identical = (
        len(set(hashes)) == 1
        and len(set(state_hashes)) == 1
        and sub["trajectory_hash"] == hashes[0]
        and sub["state_hash"] == state_hashes[0]
        and all(m == metrics[0] for m in metrics)
        and sub_metrics == metrics[0]
    )
    doc = {
        "schema": "tb-arm-repeat-1",
        "target_id": env_mod.TARGET_ID,
        "scenario": scn,
        "in_process_runs": args.n,
        "in_process_trajectory_hashes": hashes,
        "in_process_state_hashes": state_hashes,
        "subprocess_trajectory_hash": sub["trajectory_hash"],
        "subprocess_state_hash": sub["state_hash"],
        "in_process_metrics": metrics,
        "subprocess_metrics": sub_metrics,
        "compared_metric_fields": list(REPEAT_FIELDS),
        "identical": identical,
        "environment": environment_pin(),
        "note": (
            "Bitwise repeatability is checked only within this pinned environment (same MuJoCo build, "
            "same gymnasium-robotics, CPU architecture, single thread). It is not a claim about other "
            "machines or engine versions. `state_hash` is the stricter digest: sha256 over the raw "
            "float64 qpos/qvel bytes at EVERY control tick, undecimated and unrounded."
        ),
    }
    tag = canonical.commitment(scn)[2:10]
    out = Path(args.out) / f"repeatability-{tag}.json"
    write_json(out, doc)
    print(f"identical across {args.n} in-process runs + 1 subprocess run: {identical}")
    print("trajectory hash:", hashes[0])
    print("state hash:     ", state_hashes[0])
    print("wrote", out)
    return 0 if identical else 2


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tailbazaar-arm")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    sub = ap.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("policy")
    pl.add_argument("--json", action="store_true")
    pl.set_defaults(fn=cmd_policy)

    sc = sub.add_parser("selfcheck")
    sc.add_argument("--offline", action="store_true", help="skip the checks that build the scene")
    sc.set_defaults(fn=cmd_selfcheck)

    sub.add_parser("nominal").set_defaults(fn=cmd_nominal)

    h = sub.add_parser("hunt")
    h.add_argument("--mode", default="grid-grip",
                   choices=["grid-grip", "grid-payload", "grid-systems", "grid-placement", "random"])
    h.add_argument("--n", type=int, default=60)
    h.add_argument("--seed", type=int, default=1)
    h.add_argument("--quiet", action="store_true")
    h.set_defaults(fn=cmd_hunt)

    r = sub.add_parser("run")
    r.add_argument("--scenario", required=True, help="JSON object with any subset of the envelope axes")
    r.add_argument("--name", required=True)
    r.add_argument("--render", action="store_true")
    r.set_defaults(fn=cmd_run)

    rp = sub.add_parser("repeat")
    rp.add_argument("--scenario", required=True)
    rp.add_argument("--n", type=int, default=3)
    rp.set_defaults(fn=cmd_repeat)

    rd = sub.add_parser("render")
    rd.add_argument("--run", required=True)
    rd.set_defaults(fn=cmd_render)

    cp = sub.add_parser("compare")
    cp.add_argument("--baseline", required=True)
    cp.add_argument("--failure", required=True)
    cp.add_argument("--name", default="side-by-side")
    cp.add_argument("--times", default="", help="comma-separated seconds; empty picks them from the drop")
    cp.set_defaults(fn=cmd_compare)

    args = ap.parse_args(argv)
    Path(args.out).mkdir(parents=True, exist_ok=True)
    started = time.time()
    rc = args.fn(args)
    if not getattr(args, "quiet", False):
        print(f"[{args.cmd} finished in {time.time() - started:.2f}s]")
    return rc


if __name__ == "__main__":
    sys.exit(main())
