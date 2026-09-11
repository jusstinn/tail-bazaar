"""Command line for the simulator. All output goes under the directory given by --out.

  nominal              run the nominal test suite               -> nominal-suite.json
  hunt [--mode grid|grid-load|random|random-load --n N --seed S] -> hunt-<mode>.json
  run --scenario JSON --name NAME                               -> runs/NAME.json (+ render)
  repeat --scenario JSON [--n 3]                                -> repeatability-<hash>.json
  render --run runs/NAME.json                                   -> NAME.gif, NAME-metrics.png
  compare --baseline A.json --failure B.json                    -> side-by-side.png
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import canonical
from .envelope import NOMINAL_SCENARIO, normalize
from .hunter import hunt
from .nominal import run_nominal_suite
from .render import metrics_png, side_by_side_png, side_view_gif
from .simulate import engine_info, run_scenario, summarize

SIM_ROOT = Path(__file__).resolve().parent.parent


def environment_pin() -> dict[str, Any]:
    lock = SIM_ROOT / "uv.lock"
    return {
        **engine_info(),
        "uv_lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None,
    }


def write_json(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical.dumps_bytes(canonical.quantize(doc)))


def cmd_nominal(args: argparse.Namespace) -> int:
    res = run_nominal_suite()
    res["environment"] = environment_pin()
    write_json(Path(args.out) / "nominal-suite.json", res)
    print("all_passed:", res["all_passed"])
    return 0 if res["all_passed"] else 1


def cmd_hunt(args: argparse.Namespace) -> int:
    res = hunt(mode=args.mode, n=args.n, seed=args.seed, verbose=not args.quiet)
    res["environment"] = environment_pin()
    suffix = "" if args.mode.startswith("grid") else "-seed" + str(args.seed)
    out = Path(args.out) / f"hunt-{args.mode}{suffix}.json"
    write_json(out, res)
    c = res["counts"]
    print(f"search cost: {res['search_cost']}  success={c['success']} collision={c['collision']} "
          f"load_shed={c['load_shed']} (both={c['collision_and_load_shed']}) inconclusive={c['inconclusive']}")
    total_selected = sum(len(v) for v in res["selected_by_class"].values())
    print(f"distinct findings after the class-aware duplicate rule: {total_selected}; near-duplicates: {len(res['near_duplicates'])}")
    for key in sorted(res["selected_by_class"]):
        keep = res["selected_by_class"][key]
        print(f"  class {key}: {len(keep)} distinct")
        for s in keep[:3]:
            print("    finding:", s)
    print("wrote", out)
    return 0


def _load_scenario(text: str) -> dict[str, Any]:
    return normalize(json.loads(text))


def cmd_run(args: argparse.Namespace) -> int:
    scn = _load_scenario(args.scenario)
    res = run_scenario(scn)
    res["environment"] = environment_pin()
    out = Path(args.out) / "runs" / f"{args.name}.json"
    write_json(out, res)
    print(summarize(res))
    print("events:", res["events"])
    print("trajectory_hash:", res["trajectory_hash"])
    print("wrote", out, out.stat().st_size, "bytes")
    if args.render:
        _render(out, Path(args.out), args.name)
    return 0


def _render(run_path: Path, out_dir: Path, name: str) -> None:
    res = json.loads(run_path.read_bytes())
    gif = side_view_gif(res, str(out_dir / f"{name}.gif"), label=name)
    png = metrics_png(res, str(out_dir / f"{name}-metrics.png"), title=name)
    print("wrote", gif, "and", png)


def cmd_render(args: argparse.Namespace) -> int:
    p = Path(args.run)
    _render(p, Path(args.out), p.stem)
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    a = json.loads(Path(args.baseline).read_bytes())
    b = json.loads(Path(args.failure).read_bytes())
    times = [float(x) for x in args.times.split(",")]
    out = side_by_side_png(a, b, str(Path(args.out) / "side-by-side.png"), times)
    print("wrote", out)
    return 0


def cmd_repeat(args: argparse.Namespace) -> int:
    scn = _load_scenario(args.scenario)
    hashes = []
    metrics = []
    for i in range(args.n):
        r = run_scenario(scn)
        hashes.append(r["trajectory_hash"])
        metrics.append({k: r["metrics"].get(k) for k in (
            "outcome", "chassis_outcome", "primary_failure_class", "final_clearance_m", "impact_speed_mps",
            "stopping_distance_m", "first_contact_t_s", "sim_steps",
            "load_shed", "load_shed_t_s", "load_shed_criterion", "load_shed_direction",
            "load_slip_at_shed_m", "load_rel_speed_at_shed_mps", "load_speed_at_shed_mps", "load_slip_max_m",
        )})
    # fresh process
    code = (
        "import json,sys; from tailbazaar_sim.simulate import run_scenario; "
        "r=run_scenario(json.loads(sys.argv[1])); print(json.dumps({'trajectory_hash': r['trajectory_hash'], 'metrics': r['metrics']}))"
    )
    proc = subprocess.run([sys.executable, "-c", code, json.dumps(scn)], capture_output=True, text=True, cwd=str(SIM_ROOT), check=True)
    sub = json.loads(proc.stdout.strip().splitlines()[-1])
    sub_metrics = {k: sub["metrics"].get(k) for k in metrics[0]}
    identical = len(set(hashes)) == 1 and sub["trajectory_hash"] == hashes[0] and all(m == metrics[0] for m in metrics) and sub_metrics == metrics[0]
    doc = {
        "scenario": scn,
        "in_process_runs": args.n,
        "in_process_trajectory_hashes": hashes,
        "subprocess_trajectory_hash": sub["trajectory_hash"],
        "in_process_metrics": metrics,
        "subprocess_metrics": sub_metrics,
        "identical": identical,
        "environment": environment_pin(),
        "note": "Bitwise repeatability is checked only within this pinned environment (same MuJoCo build, CPU architecture, single thread). It is not a claim about other machines or engine versions.",
    }
    tag = canonical.commitment(scn)[2:10]
    out = Path(args.out) / f"repeatability-{tag}.json"
    write_json(out, doc)
    print("identical across", args.n, "in-process runs + 1 subprocess run:", identical)
    print("trajectory hash:", hashes[0])
    print("wrote", out)
    return 0 if identical else 2


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tailbazaar-sim")
    ap.add_argument("--out", default=str(SIM_ROOT / "out"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("nominal").set_defaults(fn=cmd_nominal)
    h = sub.add_parser("hunt")
    h.add_argument("--mode", default="grid", choices=["grid", "grid-load", "random", "random-load"])
    h.add_argument("--n", type=int, default=40)
    h.add_argument("--seed", type=int, default=1)
    h.add_argument("--quiet", action="store_true")
    h.set_defaults(fn=cmd_hunt)
    r = sub.add_parser("run")
    r.add_argument("--scenario", required=True, help="JSON object with the four scenario parameters")
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
    cp.add_argument("--times", default="3.0,3.6,4.0,4.4")
    cp.set_defaults(fn=cmd_compare)
    args = ap.parse_args(argv)
    Path(args.out).mkdir(parents=True, exist_ok=True)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
