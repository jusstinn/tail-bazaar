// Bridge to the pinned Python simulators (sim/, uv-managed). The web server never runs physics
// itself; it spawns the target's own CLI and reads the canonical JSON documents the simulator writes.
//
// Every target declares its module and CLI shape in the registry (targets.ts):
//   cart      uv run python -m tailbazaar_sim.cli          --out DIR run|hunt|nominal ...
//   humanoid  uv run python -m tailbazaar_sim.humanoid.cli --out DIR run|hunt|nominal|repeat ...
// Both write runs/<name>.json, a hunt document, and nominal-suite.json, so one bridge drives both.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SIM_ROOT, uvBin } from "./config.js";
import type { HuntSummary, Scenario, TargetSpec } from "./targets.js";

const execFileP = promisify(execFile);

export type RunDoc = {
  schema: string; envelope_id: string; scenario: Scenario; admissible: boolean; admissibility_problems: string[];
  controller?: { id: string; hash: string }; target?: Record<string, unknown>; target_id?: string;
  engine: Record<string, unknown>; environment: Record<string, unknown>;
  scene: Record<string, unknown>; outcome: string; metrics: Record<string, number | string | null | boolean>;
  events: Record<string, unknown>[]; ticks: Record<string, unknown>[]; frames: { dt_s: number; bodies: string[]; quat_order: string; data: number[][] };
  trajectory_hash: string; mjcf_hash?: string; state_hash?: string; severity?: Record<string, unknown> | null;
  failure_classes?: string[]; initial_state?: unknown; initial_state_check?: unknown; termination_rules?: unknown; wall_time_s: number;
};

async function cli(target: TargetSpec, outDir: string, args: string[], timeoutMs = 900_000): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const { stdout } = await execFileP(uvBin, ["run", "--project", SIM_ROOT, "python", "-m", target.sim.module, "--out", outDir, ...args], {
    cwd: SIM_ROOT, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", MPLBACKEND: "Agg" },
  });
  return stdout;
}

export async function runScenario(target: TargetSpec, outDir: string, name: string, scenario: Scenario): Promise<{ doc: RunDoc; bytes: Uint8Array; file: string }> {
  await cli(target, outDir, ["run", "--name", name, "--scenario", JSON.stringify(scenario)]);
  const file = path.join(outDir, "runs", `${name}.json`);
  const bytes = new Uint8Array(fs.readFileSync(file));
  return { doc: JSON.parse(Buffer.from(bytes).toString("utf8")) as RunDoc, bytes, file };
}

export async function hunt(target: TargetSpec, outDir: string, mode = target.sim.hunt_mode, n = target.sim.hunt_n, seed = target.sim.hunt_seed): Promise<{ summary: HuntSummary; raw: unknown; file: string }> {
  await cli(target, outDir, ["hunt", "--mode", mode, "--n", String(n), "--seed", String(seed), "--quiet"]);
  const file = target.sim.huntFile(outDir, mode, seed);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return { summary: target.normalizeHunt(raw), raw, file };
}

export async function nominalSuite(target: TargetSpec, outDir: string): Promise<{ all_passed: boolean | null; file: string; doc: any }> {
  try {
    await cli(target, outDir, ["nominal"]);
  } catch (e: any) {
    if (e?.code !== 1) throw e; // exit 1 means a nominal case failed; the JSON still exists
  }
  const file = path.join(outDir, "nominal-suite.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  // The cart publishes one gate (`all_passed`); the humanoid publishes two, and the one that gates
  // the harness is the published-conditions block. A benign perturbation falling is a FINDING.
  return { all_passed: doc.all_passed ?? doc.published_conditions_all_passed ?? null, file, doc };
}

export function fingerprint(target: TargetSpec, env: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of target.fingerprint_fields) out[k] = env[k] ?? null;
  return out;
}
