// Bridge to the pinned Python simulator (sim/, uv-managed). The web server never runs physics
// itself; it spawns the CLI and reads the canonical JSON documents the simulator writes.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SIM_ROOT, uvBin } from "./config.js";
import type { Scenario } from "./envelope.js";

const execFileP = promisify(execFile);

export type RunDoc = {
  schema: string; envelope_id: string; scenario: Scenario; admissible: boolean; admissibility_problems: string[];
  controller: { id: string; hash: string }; engine: Record<string, unknown>; environment: Record<string, unknown>;
  scene: Record<string, unknown>; outcome: string; metrics: Record<string, number | string | null | boolean>;
  events: Record<string, unknown>[]; ticks: Record<string, unknown>[]; frames: { dt_s: number; bodies: string[]; quat_order: string; data: number[][] };
  trajectory_hash: string; mjcf_hash?: string; initial_state?: unknown; initial_state_check?: unknown; termination_rules?: unknown; wall_time_s: number;
};

export type HuntDoc = {
  hunter_id: string; mode: string; seed: number | null; search_cost: { simulations: number; sim_steps: number; wall_time_s: number };
  counts: { success: number; collision: number; inconclusive: number };
  selected: { scenario: Scenario; outcome: string; impact_speed_mps: number | null; distance_to_nominal: number }[];
  near_duplicates: unknown[]; environment: Record<string, unknown>;
};

async function cli(outDir: string, args: string[], timeoutMs = 600_000): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const { stdout } = await execFileP(uvBin, ["run", "--project", SIM_ROOT, "python", "-m", "tailbazaar_sim.cli", "--out", outDir, ...args], {
    cwd: SIM_ROOT, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", MPLBACKEND: "Agg" },
  });
  return stdout;
}

export async function runScenario(outDir: string, name: string, scenario: Scenario): Promise<{ doc: RunDoc; bytes: Uint8Array; file: string }> {
  await cli(outDir, ["run", "--name", name, "--scenario", JSON.stringify(scenario)]);
  const file = path.join(outDir, "runs", `${name}.json`);
  const bytes = new Uint8Array(fs.readFileSync(file));
  return { doc: JSON.parse(Buffer.from(bytes).toString("utf8")) as RunDoc, bytes, file };
}

export async function hunt(outDir: string, mode: "grid" | "random", n = 40, seed = 1): Promise<{ doc: HuntDoc; file: string }> {
  await cli(outDir, ["hunt", "--mode", mode, "--n", String(n), "--seed", String(seed), "--quiet"]);
  const file = path.join(outDir, mode === "grid" ? "hunt-grid.json" : `hunt-random-seed${seed}.json`);
  return { doc: JSON.parse(fs.readFileSync(file, "utf8")) as HuntDoc, file };
}

export async function nominalSuite(outDir: string): Promise<{ all_passed: boolean; file: string }> {
  try {
    await cli(outDir, ["nominal"]);
  } catch (e: any) {
    if (e?.code !== 1) throw e; // exit 1 means a nominal case failed; the JSON still exists
  }
  const file = path.join(outDir, "nominal-suite.json");
  return { all_passed: JSON.parse(fs.readFileSync(file, "utf8")).all_passed, file };
}

/** Fields of the environment pin that must match for the exact trajectory-hash comparison. */
export const FINGERPRINT_FIELDS = [
  "engine", "engine_version", "numpy_version", "python_version", "platform", "integrator",
  "physics_timestep_s", "control_dt_s", "substeps_per_tick", "threads", "uv_lock_sha256",
] as const;

export function fingerprint(env: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FINGERPRINT_FIELDS) out[k] = env[k] ?? null;
  return out;
}
