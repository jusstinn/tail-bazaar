"""Command line for the G1 target. All output goes under the directory given by --out.

  policy                                                        -> prints the pinned provenance
  selfcheck                                                     -> envelope/YAML drift + rule checks
  nominal                                                       -> nominal-suite.json
  hunt [--mode grid-push|grid-systems|grid-terrain|random ...]   -> hunt-<mode>.json
  run --scenario JSON --name NAME                               -> runs/NAME.json
  repeat --scenario JSON [--n 3]                                -> repeatability-<hash>.json

Same command shape as the humanoid target's CLI, so the web bridge (web/src/server/sim.ts) drives
it without a special case. There is no `render`/`compare` here: the marketplace renders this
target from the run document in the browser (web/src/client/replay-g1.ts).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from .. import canonical
from .envelope import NOMINAL_SCENARIO, TARGET_ID, normalize
from .hunter import MODES, hunt
from .nominal import run_nominal_suite
from .policy import load_policy
from .simulate import engine_info, run_scenario, summarize

SIM_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = SIM_ROOT / "out-g1"


def environment_pin() -> dict[str, Any]:
    lock = SIM_ROOT / "uv.lock"
    return {**engine_info(), "uv_lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None}


def write_json(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical.dumps_bytes(canonical.quantize(doc)))


def cmd_policy(args: argparse.Namespace) -> int:
    print(json.dumps(load_policy().identity(), indent=2))
    return 0


def cmd_nominal(args: argparse.Namespace) -> int:
    res = run_nominal_suite()
    res["environment"] = environment_pin()
    res["target_id"] = TARGET_ID
    res["target"] = {"target_id": TARGET_ID, "policy": load_policy().identity()}
    out = Path(args.out) / "nominal-suite.json"
    write_json(out, res)
    print("published-conditions gate:", res["published_conditions_all_passed"],
          "| benign perturbations:", res["benign_perturbations_all_passed"], "| fell:", res["cases_that_fell"])
    print("wrote", out)
    return 0 if res["published_conditions_all_passed"] else 1


def cmd_hunt(args: argparse.Namespace) -> int:
    res = hunt(mode=args.mode, n=args.n, seed=args.seed, verbose=not args.quiet)
    res["environment"] = environment_pin()
    res["policy"] = load_policy().identity()
    suffix = "" if args.mode.startswith("grid") else "-seed" + str(args.seed)
    out = Path(args.out) / f"hunt-{args.mode}{suffix}.json"
    write_json(out, res)
    c = res["counts"]
    print(f"search cost: {res['search_cost']}  survived={c['survived']} fell={c['fell']} inconclusive={c['inconclusive']}")
    total_selected = sum(len(v) for v in res["selected_by_class"].values())
    print(f"distinct findings after the duplicate rule: {total_selected}; near-duplicates: {len(res['near_duplicates'])}")
    for key in sorted(res["selected_by_class"]):
        keep = res["selected_by_class"][key]
        print(f"  class {key}: {len(keep)} distinct; mildest three:")
        for s in keep[:3]:
            print("    ", json.dumps(s["scenario"]), "->", s["outcome"], f"fell@{s['fall_time_s']}s ({s['fall_detected_by']}) impact={s['pelvis_impact_speed_mps']}m/s d={s['distance_to_nominal']}")
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
    print("events:", json.dumps(res["events"]))
    print("trajectory_hash:", res["trajectory_hash"])
    print("state_hash:", res["state_hash"])
    print("wrote", out, out.stat().st_size, "bytes")
    return 0


REPEAT_METRIC_KEYS = (
    "outcome", "primary_failure_class", "fell", "fall_detected_by", "fall_time_s", "survival_time_s",
    "distance_travelled_x_m", "pelvis_min_z_m", "pelvis_z_at_fall_m", "tilt_at_fall_deg", "pelvis_impact_speed_mps",
    "ground_contact_t_s", "ground_contact_body", "peak_pelvis_accel_mps2", "sim_steps",
)


def cmd_repeat(args: argparse.Namespace) -> int:
    scn = _load_scenario(args.scenario)
    hashes, states, metrics = [], [], []
    for _ in range(args.n):
        r = run_scenario(scn)
        hashes.append(r["trajectory_hash"])
        states.append(r["state_hash"])
        metrics.append({k: r["metrics"].get(k) for k in REPEAT_METRIC_KEYS})
    code = (
        "import json,sys; from tailbazaar_sim.g1.simulate import run_scenario; "
        "r=run_scenario(json.loads(sys.argv[1])); "
        "print(json.dumps({'trajectory_hash': r['trajectory_hash'], 'state_hash': r['state_hash'], 'metrics': r['metrics']}))"
    )
    proc = subprocess.run([sys.executable, "-c", code, json.dumps(scn)], capture_output=True, text=True, cwd=str(SIM_ROOT), check=True)
    sub = json.loads(proc.stdout.strip().splitlines()[-1])
    sub_metrics = {k: sub["metrics"].get(k) for k in REPEAT_METRIC_KEYS}
    identical = (
        len(set(hashes)) == 1 and len(set(states)) == 1
        and sub["trajectory_hash"] == hashes[0] and sub["state_hash"] == states[0]
        and all(m == metrics[0] for m in metrics) and sub_metrics == metrics[0]
    )
    doc = {
        "target_id": TARGET_ID,
        "scenario": scn,
        "in_process_runs": args.n,
        "in_process_trajectory_hashes": hashes,
        "in_process_state_hashes": states,
        "subprocess_trajectory_hash": sub["trajectory_hash"],
        "subprocess_state_hash": sub["state_hash"],
        "in_process_metrics": metrics,
        "subprocess_metrics": sub_metrics,
        "identical": identical,
        "environment": environment_pin(),
        "policy": load_policy().identity(),
        "note": (
            "Bitwise repeatability is checked only within this pinned environment (same MuJoCo and torch build, same "
            "policy digests, same CPU architecture, single torch thread, LSTM memory reset per run). It is not a claim "
            "about other machines or engine versions. `trajectory_hash` is keccak over the canonical JSON of the replay "
            "frames; `state_hash` is sha256 over the raw float64 qpos/qvel bytes at every control tick, the stricter of the two."
        ),
    }
    tag = canonical.commitment(scn)[2:10]
    out = Path(args.out) / f"repeatability-{tag}.json"
    write_json(out, doc)
    print("identical across", args.n, "in-process runs + 1 subprocess run:", identical)
    print("trajectory hash:", hashes[0])
    print("state hash:", states[0])
    print("wrote", out)
    return 0 if identical else 2


def cmd_selfcheck(args: argparse.Namespace) -> int:
    """Static consistency checks that need no simulation: YAML vs envelope.py, admissibility, duplicates."""
    import yaml

    from . import envelope as E

    failures: list[str] = []

    def check(ok: bool, what: str) -> None:
        print(("  ok   " if ok else "  FAIL ") + what)
        if not ok:
            failures.append(what)

    doc = yaml.safe_load((SIM_ROOT / "envelope-g1.yaml").read_text())
    axes = {a["name"]: a for a in doc["continuous"]}
    print("envelope-g1.yaml vs envelope.py")
    check(set(axes) == set(E.CONTINUOUS_ORDER), "the same continuous axes, in the same set")
    for k, spec in E.ENVELOPE.items():
        a = axes.get(k, {})
        check(a.get("low") == spec["min"] and a.get("high") == spec["max"], f"{k} bounds")
        check(a.get("nominal") == E.NOMINAL_SCENARIO[k], f"{k} nominal")
        if "step" in spec:
            check(a.get("step") == spec["step"], f"{k} step")
    check(doc.get("discrete") in (None, []), "no discrete axis")
    check(doc["envelope_id"] == E.ENVELOPE_ID, "envelope_id")
    check(doc["envelope_revision"] == E.ENVELOPE_REVISION, "envelope_revision")
    check(doc["target_id"] == TARGET_ID, "target_id")
    check(doc["control_tick_ms"] == E.DT_CTRL_MS, "control tick")
    check(doc["push_duration_s"] == E.PUSH_DURATION_S, "push duration")
    check([f["name"] for f in doc["failure_classes"]] == list(E.FAILURE_CLASSES), "failure classes")

    print("admissibility")
    check(E.check_admissible(E.NOMINAL_SCENARIO) == [], "the nominal point is admissible")
    check(E.check_admissible({}) == [], "an empty scenario is admissible (every axis is optional)")
    for bad, why in (
        ({"push_impulse_ns": 70.0}, "impulse above the upper bound"),
        ({"push_impulse_ns": -1.0}, "negative impulse"),
        ({"control_latency_ms": 30}, "latency that is not a whole control tick"),
        ({"push_time_s": 2.01}, "push time that is not a whole control tick"),
        ({"cmd_vx_mps": 1.5}, "a command above the axis"),
        ({"floor_friction": 0.12345}, "more decimal places than the axis declares"),
        ({"init_seed": 0}, "an axis that does not exist on this target"),
    ):
        check(E.check_admissible(bad) != [], f"rejected: {why}")

    print("duplicate rule")
    a = E.normalize({"push_impulse_ns": 8.0, "push_heading_deg": 0.0})
    b = E.normalize({"push_impulse_ns": 8.0, "push_heading_deg": 359.0})
    check(E.scenario_distance(a, b) < 0.05, "headings 0 and 359 are the same direction (circular)")
    c = E.normalize({"push_impulse_ns": 0.0, "push_heading_deg": 0.0})
    d = E.normalize({"push_impulse_ns": 0.0, "push_heading_deg": 180.0})
    check(E.scenario_distance(c, d) == 0.0, "unpushed scenarios do not differ by heading")
    g = {"scenario": a, "failure_classes": ["FELL"]}
    h = {"scenario": a, "failure_classes": []}
    check(E.finding_distance(g, h) == float("inf"), "different failure-class sets are never duplicates")

    print(("FAILED: " + str(len(failures))) if failures else "all self-checks passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tailbazaar-g1")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("policy").set_defaults(fn=cmd_policy)
    sub.add_parser("selfcheck").set_defaults(fn=cmd_selfcheck)
    sub.add_parser("nominal").set_defaults(fn=cmd_nominal)
    h = sub.add_parser("hunt")
    h.add_argument("--mode", default="grid-push", choices=sorted(MODES))
    h.add_argument("--n", type=int, default=60)
    h.add_argument("--seed", type=int, default=1)
    h.add_argument("--quiet", action="store_true")
    h.set_defaults(fn=cmd_hunt)
    r = sub.add_parser("run")
    r.add_argument("--scenario", required=True, help=f"JSON object; omitted axes take nominal {json.dumps(NOMINAL_SCENARIO)}")
    r.add_argument("--name", required=True)
    r.set_defaults(fn=cmd_run)
    rp = sub.add_parser("repeat")
    rp.add_argument("--scenario", required=True)
    rp.add_argument("--n", type=int, default=3)
    rp.set_defaults(fn=cmd_repeat)
    args = ap.parse_args(argv)
    Path(args.out).mkdir(parents=True, exist_ok=True)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
