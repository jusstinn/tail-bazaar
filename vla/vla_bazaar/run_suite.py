"""CLI for the Tail Bazaar VLA target: nominal suite, bounded search, determinism check.

Run inside openpi's aloha_sim client venv, with the policy server already up:

    uv run scripts/serve_policy.py --env ALOHA_SIM          # terminal 1
    MUJOCO_GL=egl python -m vla_bazaar.run_suite nominal    # terminal 2
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import pathlib
import sys
import time

from vla_bazaar.episode import Perturbation, run_episode

OUT = pathlib.Path("out")


def _client(host: str, port: int):
    from openpi_client import websocket_client_policy

    return websocket_client_policy.WebsocketClientPolicy(host=host, port=port)


def _dump(name: str, payload: dict) -> pathlib.Path:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps(payload, indent=2))
    print(f"  wrote {path}")
    return path


def _line(tag: str, r) -> None:
    print(
        f"  [{tag}] seed={r.seed} outcome={r.outcome} max_reward={r.max_reward}/4 "
        f"steps={r.steps} warm_infer={r.inference_ms_warm_median}ms (first {r.inference_ms_first}) "
        f"sev={r.severity} wall={r.wall_seconds}s",
        flush=True,
    )


def cmd_nominal(args) -> int:
    """The nominal suite: episodes at the unperturbed world that must succeed."""
    client = _client(args.host, args.port)
    results = []
    t0 = time.time()
    for i in range(args.episodes):
        seed = args.seed0 + i
        video = str(OUT / f"nominal_seed{seed}.mp4") if args.video else None
        if video:
            OUT.mkdir(parents=True, exist_ok=True)
        r = run_episode(client, seed, Perturbation(), video_path=video)
        _line("nominal", r)
        results.append(r)

    n_success = sum(1 for r in results if r.outcome == "SUCCESS")
    gpu_seconds = round(time.time() - t0, 1)
    payload = {
        "kind": "nominal_suite",
        "episodes": len(results),
        "successes": n_success,
        "success_rate": round(n_success / len(results), 3) if results else 0.0,
        "gpu_seconds": gpu_seconds,
        "results": [dataclasses.asdict(r) for r in results],
    }
    _dump("nominal_suite.json", payload)
    print(f"\nNOMINAL SUCCESS RATE: {n_success}/{len(results)} in {gpu_seconds}s")
    return 0 if n_success == len(results) else 1


def cmd_probe(args) -> int:
    """One episode at an arbitrary point in the envelope."""
    client = _client(args.host, args.port)
    pert = Perturbation(
        box_mass_scale=args.box_mass_scale,
        box_friction_scale=args.box_friction_scale,
        box_pos_dx=args.box_pos_dx,
        box_pos_dy=args.box_pos_dy,
        cam_dz=args.cam_dz,
        light_scale=args.light_scale,
        action_noise=args.action_noise,
        latency_steps=args.latency_steps,
    )
    video = str(OUT / args.video) if args.video else None
    if video:
        OUT.mkdir(parents=True, exist_ok=True)
    r = run_episode(client, args.seed, pert, video_path=video)
    _line("probe", r)
    _dump(args.out, dataclasses.asdict(r))
    return 0


# The bounded search ladder. Each entry widens ONE axis at a time, in order,
# so a finding names the single axis responsible rather than a soup of them.
LADDER: list[tuple[str, list[float]]] = [
    ("action_noise", [0.01, 0.02, 0.05, 0.10, 0.20]),
    ("latency_steps", [2, 5, 10]),
    ("box_mass_scale", [4.0, 10.0, 20.0]),
    ("box_friction_scale", [0.3, 0.1, 0.02]),
    ("cam_dz", [0.10, 0.20, 0.35]),
]


def cmd_search(args) -> int:
    """Bounded one-axis-at-a-time search, PAIRED against a nominal baseline.

    The pi0_aloha_sim checkpoint does not succeed reliably unperturbed (measured
    4/6). So an episode that fails at a perturbed point is, on its own, worth
    nothing: it may simply be a seed the policy was always going to fail. The
    control set is therefore restricted to the seeds that DID reach the
    environment's own success signal at the nominal point, and a failure counts
    only when such a seed flips to a non-SUCCESS outcome.
    """
    client = _client(args.host, args.port)

    baseline = json.loads(pathlib.Path(args.baseline).read_text())
    seeds = [r["seed"] for r in baseline["results"] if r["outcome"] == "SUCCESS"]
    if not seeds:
        print(f"no seed in {args.baseline} succeeds at nominal; nothing is attributable")
        return 2
    print(f"control set (succeed at nominal): {seeds}\n")

    axes = [(a, v) for a, v in LADDER if a in args.axes] if args.axes else LADDER
    trials = []
    findings = []
    t0 = time.time()
    episodes = 0

    for axis, values in axes:
        for value in values:
            pert = Perturbation(**{axis: value})
            outcomes = []
            for seed in seeds:
                r = run_episode(client, seed, pert)
                episodes += 1
                _line(f"{axis}={value}", r)
                outcomes.append(r)
                trials.append(dataclasses.asdict(r))
            failures = [r for r in outcomes if r.outcome in ("DROPPED", "NOT_COMPLETED")]
            if len(failures) >= args.min_failures:
                worst = max(failures, key=lambda r: (r.outcome == "DROPPED", r.severity))
                findings.append(
                    {
                        "axis": axis,
                        "value": value,
                        "failing_seeds": [r.seed for r in failures],
                        "n_failed": len(failures),
                        "n_control_seeds": len(seeds),
                        "attributable": True,
                        "worst_seed": worst.seed,
                        "worst_outcome": worst.outcome,
                        "worst_severity": worst.severity,
                        "worst_drop_height": worst.drop_height,
                        "worst_max_reward": worst.max_reward,
                    }
                )
                print(f"\n  FOUND: {axis}={value} fails {len(failures)}/{len(seeds)} seeds\n")
                break
        if findings and args.stop_on_first:
            break

    gpu_seconds = round(time.time() - t0, 1)
    payload = {
        "kind": "bounded_search",
        "ladder": [{"axis": a, "values": v} for a, v in axes],
        "baseline_file": args.baseline,
        "paired": True,
        "control_seeds": seeds,
        "search_cost": {"episodes": episodes, "gpu_seconds": gpu_seconds},
        "findings": findings,
        "trials": trials,
    }
    _dump("search.json", payload)
    print(f"\nSEARCH COST: {episodes} episodes, {gpu_seconds}s. Findings: {len(findings)}")
    return 0 if findings else 1


def cmd_determinism(args) -> int:
    """Same seed, same perturbation, twice. Are the traces byte-identical?"""
    client = _client(args.host, args.port)
    pert = Perturbation(action_noise=args.action_noise, box_mass_scale=args.box_mass_scale)
    runs = []
    for rep in range(2):
        r = run_episode(client, args.seed, pert)
        _line(f"rep{rep}", r)
        runs.append(r)

    a, b = runs
    payload = {
        "kind": "determinism_check",
        "seed": args.seed,
        "perturbation": pert.as_dict(),
        "action_digest_match": a.action_digest == b.action_digest,
        "obs_digest_match": a.obs_digest == b.obs_digest,
        "reward_trace_match": a.reward_trace == b.reward_trace,
        "box_z_trace_match": a.box_z_trace == b.box_z_trace,
        "outcome_match": a.outcome == b.outcome,
        "max_reward_match": a.max_reward == b.max_reward,
        "first_divergent_step": _first_divergence(a.box_z_trace, b.box_z_trace),
        "runs": [dataclasses.asdict(r) for r in runs],
    }
    _dump("determinism.json", payload)
    print("\nDETERMINISM:")
    for k in (
        "action_digest_match",
        "obs_digest_match",
        "reward_trace_match",
        "box_z_trace_match",
        "outcome_match",
    ):
        print(f"  {k}: {payload[k]}")
    print(f"  first_divergent_step: {payload['first_divergent_step']}")
    return 0


def _first_divergence(a: list[float], b: list[float]) -> int | None:
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i
    return None if len(a) == len(b) else min(len(a), len(b))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="vla_bazaar")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8000)
    sub = p.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("nominal")
    n.add_argument("--episodes", type=int, default=5)
    n.add_argument("--seed0", type=int, default=0)
    n.add_argument("--video", action="store_true")
    n.set_defaults(func=cmd_nominal)

    pr = sub.add_parser("probe")
    pr.add_argument("--seed", type=int, default=0)
    pr.add_argument("--box-mass-scale", dest="box_mass_scale", type=float, default=1.0)
    pr.add_argument("--box-friction-scale", dest="box_friction_scale", type=float, default=1.0)
    pr.add_argument("--box-pos-dx", dest="box_pos_dx", type=float, default=0.0)
    pr.add_argument("--box-pos-dy", dest="box_pos_dy", type=float, default=0.0)
    pr.add_argument("--cam-dz", dest="cam_dz", type=float, default=0.0)
    pr.add_argument("--light-scale", dest="light_scale", type=float, default=1.0)
    pr.add_argument("--action-noise", dest="action_noise", type=float, default=0.0)
    pr.add_argument("--latency-steps", dest="latency_steps", type=int, default=0)
    pr.add_argument("--video", default=None)
    pr.add_argument("--out", default="probe.json")
    pr.set_defaults(func=cmd_probe)

    s = sub.add_parser("search")
    s.add_argument("--baseline", default="out/nominal_suite.json")
    s.add_argument("--axes", nargs="*", default=None)
    s.add_argument("--min-failures", dest="min_failures", type=int, default=2)
    s.add_argument("--stop-on-first", dest="stop_on_first", action="store_true")
    s.set_defaults(func=cmd_search)

    d = sub.add_parser("determinism")
    d.add_argument("--seed", type=int, default=0)
    d.add_argument("--action-noise", dest="action_noise", type=float, default=0.0)
    d.add_argument("--box-mass-scale", dest="box_mass_scale", type=float, default=1.0)
    d.set_defaults(func=cmd_determinism)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
