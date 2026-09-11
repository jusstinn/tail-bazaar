// TypeScript mirror of sim/tailbazaar_sim/g1/envelope.py (admissibility, scenario distance, duplicate
// rule, published conditions). The Python module is authoritative and `tailbazaar-g1 selfcheck` keeps
// it and sim/envelope-g1.yaml from drifting; this mirror lets the buyer, the verifier and the API reason
// about G1 scenarios without spawning Python. A test checks it against the YAML the marketplace publishes.
//
// ADDITIVE: nothing here touches any other target's envelope.

export const ENVELOPE_ID = "tb-g1-envelope-1";
export const ENVELOPE_REVISION = "tb-g1-envelope-1.0";
export const TARGET_ID = "unitree-g1-walk-v1";
export const DT_CTRL_MS = 20;
export const PUSH_DURATION_S = 0.1;
export const DUPLICATE_DISTANCE = 0.05;
/** The predicate's thresholds, restated from sim/tailbazaar_sim/g1/simulate.py (the run document carries
 *  them too, in `fall_predicate`; these are the fallbacks and the severity anchor). */
export const NOMINAL_PELVIS_Z_M = 0.77;
export const FALL_HEIGHT_FRACTION = 0.6;
export const FALL_Z_M = 0.462;
export const FALL_TILT_DEG = 60;
/** The publisher's 0.793 m qpos0 pelvis height (the free-fall term of the plausibility ceiling reads
 *  the run's own `scene.pelvis_z0_m` and `scene.head_reach_above_pelvis_m`; these are fallbacks). */
export const PELVIS_Z0_M = 0.793;
export const HEAD_REACH_ABOVE_PELVIS_M = 0.5336;
export const TOTAL_MASS_KG = 32.1069;

export type AxisSpec = { min: number; max: number; step?: number; places?: number; type: "int" | "float"; unit: string; group: string; circular?: true };

export const ENVELOPE: Record<string, AxisSpec> = {
  push_impulse_ns: { min: 0.0, max: 60.0, places: 2, type: "float", unit: "N*s", group: "physical" },
  push_heading_deg: { min: 0.0, max: 360.0, places: 1, type: "float", unit: "deg", group: "physical", circular: true },
  push_time_s: { min: 1.0, max: 8.0, places: 3, step: 0.02, type: "float", unit: "s", group: "physical" },
  floor_friction: { min: 0.4, max: 1.4, places: 3, type: "float", unit: "1", group: "physical" },
  body_mass_scale: { min: 0.8, max: 1.25, places: 3, type: "float", unit: "1", group: "physical" },
  actuator_noise_frac: { min: 0.0, max: 0.3, places: 3, type: "float", unit: "1", group: "systems" },
  control_latency_ms: { min: 0, max: 100, step: DT_CTRL_MS, type: "int", unit: "ms", group: "systems" },
  cmd_vx_mps: { min: 0.0, max: 1.0, places: 2, type: "float", unit: "m/s", group: "command" },
};

export const CONTINUOUS_ORDER = ["push_impulse_ns", "push_heading_deg", "push_time_s", "floor_friction", "body_mass_scale", "actuator_noise_frac", "control_latency_ms", "cmd_vx_mps"] as const;
export const PARAM_ORDER = [...CONTINUOUS_ORDER] as const;
export const OPTIONAL_PARAMS: ReadonlySet<string> = new Set(PARAM_ORDER);
export const PUSH_ONLY_AXES = ["push_heading_deg", "push_time_s"] as const;

export type Scenario = Record<string, number>;

export const NOMINAL_SCENARIO: Required<Record<(typeof PARAM_ORDER)[number], number>> = {
  push_impulse_ns: 0.0,
  push_heading_deg: 0.0,
  push_time_s: 3.0,
  floor_friction: 1.0,
  body_mass_scale: 1.0,
  actuator_noise_frac: 0.0,
  control_latency_ms: 0,
  cmd_vx_mps: 0.5,
};

// ---------------------------------------------------------------- what the PUBLISHER deploys
// Unitree publishes exactly one operating point for this policy: the MuJoCo deployment configuration
// (deploy/deploy_mujoco/configs/g1.yaml). An axis it says nothing about is `not_stated`.
export const PUBLISHED_CONDITIONS: Record<string, { min?: number; max?: number; exactly?: number; not_stated?: true }> = {
  push_impulse_ns: { exactly: 0.0 },
  push_heading_deg: { not_stated: true },
  push_time_s: { not_stated: true },
  floor_friction: { exactly: 1.0 },
  body_mass_scale: { exactly: 1.0 },
  actuator_noise_frac: { exactly: 0.0 },
  control_latency_ms: { exactly: 0 },
  cmd_vx_mps: { exactly: 0.5 },
};

export const PUBLISHED_CONDITIONS_PROSE =
  "Unitree's own MuJoCo deployment configuration: no external push, MuJoCo's default floor friction 1.0, stock body masses, no actuator noise, no control latency, a forward velocity command of 0.5 m/s";
export const SEARCHED_ENVELOPE_PROSE =
  "push impulse 0-60 N·s from any heading, push time 1-8 s, floor friction 0.4-1.4, body mass ×0.8-1.25, actuator noise 0-30 %, control latency 0-100 ms, forward command 0-1 m/s";
export const PUBLISHED_CONDITIONS_SOURCE =
  "deploy/deploy_mujoco/configs/g1.yaml in unitreerobotics/unitree_rl_gym @ 276801e4 (BSD-3-Clause), transcribed in sim/tailbazaar_sim/g1/policy.py and re-read at load time";
export const PRODUCT_QUESTION =
  "Unitree ships this walking policy with one MuJoCo deployment configuration and no envelope. How far can the operating range be widened — a shove, a slippery floor, a heavier body, noisy or delayed actuation, a faster or slower command — before the G1 falls over?";
export const OPERATING_CONTEXT_NOTE =
  "The searched envelope is deliberately wider than the one configuration the policy is published with, so a finding outside it is not a defect report: Unitree's runner claims nothing about pushes, latency, noise, friction, mass or other commands. Unlike the Gymnasium humanoid, this environment has no health flag, so the fall predicate is this project's own and is stated in every run document. These bounds are illustrative assumptions for a demonstration; the 'robot' is Unitree's 32 kg 12-dof MuJoCo model of the G1, not a physical machine.";

export const ENVELOPE_AXES = [
  { name: "push_impulse_ns", low: 0.0, high: 60.0, nominal: 0.0, marginal: null, scale: null, units: "N*s", group: "physical", quantization: "2 decimal places", tuned_range: "= 0" },
  { name: "push_heading_deg", low: 0.0, high: 360.0, nominal: 0.0, marginal: null, scale: null, units: "deg", group: "physical", quantization: "1 decimal place, circular", tuned_range: "not stated" },
  { name: "push_time_s", low: 1.0, high: 8.0, nominal: 3.0, marginal: null, scale: null, units: "s", group: "physical", quantization: "quantized to the 20 ms control tick", tuned_range: "not stated" },
  { name: "floor_friction", low: 0.4, high: 1.4, nominal: 1.0, marginal: null, scale: null, units: "coefficient", group: "physical", quantization: "3 decimal places", tuned_range: "= 1" },
  { name: "body_mass_scale", low: 0.8, high: 1.25, nominal: 1.0, marginal: null, scale: null, units: "coefficient", group: "physical", quantization: "3 decimal places", tuned_range: "= 1" },
  { name: "actuator_noise_frac", low: 0.0, high: 0.3, nominal: 0.0, marginal: null, scale: null, units: "coefficient", group: "systems", quantization: "3 decimal places", tuned_range: "= 0" },
  { name: "control_latency_ms", low: 0, high: 100, nominal: 0, marginal: null, scale: null, units: "ms", group: "systems", quantization: "quantized to the 20 ms control tick", tuned_range: "= 0" },
  { name: "cmd_vx_mps", low: 0.0, high: 1.0, nominal: 0.5, marginal: null, scale: null, units: "m/s", group: "command", quantization: "2 decimal places", tuned_range: "= 0.5" },
] as const;

export const DUPLICATE_RULE_PROSE =
  `same failure-class set AND normalized L-infinity distance < ${DUPLICATE_DISTANCE} over the eight continuous axes (push_heading_deg the short way round the circle; push_heading_deg and push_time_s skipped when either side has no push, because an impulse of magnitude zero has no direction or timing and the two runs are byte-identical)`;

export function checkAdmissible(scn: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const k of CONTINUOUS_ORDER) {
    if (!(k in scn)) continue;
    const spec = ENVELOPE[k];
    const v = scn[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`${k} must be a number`);
      continue;
    }
    if (spec.type === "int") {
      if (!Number.isInteger(v)) problems.push(`${k} must be an integer number of ms`);
      else if (v % (spec.step as number) !== 0) problems.push(`${k} must be a multiple of ${spec.step} ms (one control tick)`);
    } else if (Math.abs(Number(v.toFixed(spec.places)) - v) > 1e-12) problems.push(`${k} must have at most ${spec.places} decimal places`);
    if (v < spec.min || v > spec.max) problems.push(`${k}=${v} outside [${spec.min}, ${spec.max}]`);
  }
  const extra = Object.keys(scn).filter((k) => !(PARAM_ORDER as readonly string[]).includes(k));
  if (extra.length) problems.push(`unknown parameters: ${JSON.stringify(extra.sort())}`);
  const t = Number(scn.push_time_s ?? NOMINAL_SCENARIO.push_time_s);
  if (Number.isFinite(t) && t >= ENVELOPE.push_time_s.min && t <= ENVELOPE.push_time_s.max) {
    const ticks = t / (DT_CTRL_MS / 1000);
    if (Math.abs(ticks - Math.round(ticks)) > 1e-6) problems.push(`push_time_s=${t} must be a multiple of the ${DT_CTRL_MS} ms control tick`);
  }
  return problems;
}

export function normalize(scn: Record<string, unknown>): Scenario {
  const out: Scenario = {};
  for (const k of PARAM_ORDER) {
    const v = Number(scn[k] ?? NOMINAL_SCENARIO[k]);
    const spec = ENVELOPE[k];
    out[k] = spec.type === "int" ? Math.trunc(v) : Number(v.toFixed(spec.places));
  }
  return out;
}

function axisGap(k: string, av: number, bv: number): number {
  const spec = ENVELOPE[k];
  const span = spec.max - spec.min;
  if (spec.circular) {
    const d = Math.abs(av - bv) % span;
    return Math.min(d, span - d) / (span / 2);
  }
  return Math.abs(av - bv) / span;
}

export function scenarioDistance(a: Scenario, b: Scenario): number {
  const at = (s: Scenario, k: string): number => Number(s[k] ?? NOMINAL_SCENARIO[k as keyof typeof NOMINAL_SCENARIO]);
  const unpushed = at(a, "push_impulse_ns") === 0 || at(b, "push_impulse_ns") === 0;
  let d = 0;
  for (const k of CONTINUOUS_ORDER) {
    if (unpushed && (PUSH_ONLY_AXES as readonly string[]).includes(k)) continue;
    d = Math.max(d, axisGap(k, at(a, k), at(b, k)));
  }
  return d;
}

export function isDuplicate(a: Scenario, b: Scenario): boolean {
  return scenarioDistance(a, b) < DUPLICATE_DISTANCE;
}

export function rangePosition(scn: Scenario): { parameter: string; value: number; unit: string; tuned_range: string; in_tuned_range: boolean; searched_envelope: string }[] {
  return CONTINUOUS_ORDER.map((k) => {
    const t = PUBLISHED_CONDITIONS[k];
    const spec = ENVELOPE[k];
    const v = Number(scn[k] ?? NOMINAL_SCENARIO[k]);
    const inside = t.not_stated ? true : t.exactly !== undefined ? v === t.exactly : (t.min === undefined || v >= t.min) && (t.max === undefined || v <= t.max);
    const tuned = t.not_stated ? "not stated" : t.exactly !== undefined ? `= ${t.exactly}` : t.min !== undefined ? `>= ${t.min}` : `<= ${t.max}`;
    return { parameter: k, value: v, unit: spec.unit, tuned_range: tuned, in_tuned_range: inside, searched_envelope: `${spec.min} - ${spec.max}` };
  });
}

// ------------------------------------------------------------------------------- severity bands
/** The speed a free fall from the predicate's own height threshold (pelvis z = 0.462 m) reaches:
 *  sqrt(2 g z_fall) = 3.011 m/s. It is the only non-arbitrary speed this scene offers — the height at
 *  which this project's predicate already calls the robot fallen — so the coarse bands are anchored to
 *  it: a pelvis that hits the floor faster than a passive drop from there was driven down, not merely
 *  falling. */
export const FREE_FALL_REF_MPS = Math.sqrt(2 * 9.81 * FALL_Z_M);
export const SEVERITY_BAND_DEFINITION =
  `pelvis impact speed banded against the ${FREE_FALL_REF_MPS.toFixed(2)} m/s a free fall from the ${FALL_Z_M} m fall-height threshold reaches: low below half of it, medium up to it, high above it (a measured kinematic proxy, never a damage, injury or cost estimate)`;

export function severityBand(impactSpeedMps: number | null): { proxy: string; band: string; definition: string } {
  const definition = SEVERITY_BAND_DEFINITION;
  if (impactSpeedMps === null || !Number.isFinite(impactSpeedMps)) return { proxy: "pelvis_impact_speed_mps", band: "none", definition };
  const band = impactSpeedMps < FREE_FALL_REF_MPS / 2 ? "low" : impactSpeedMps <= FREE_FALL_REF_MPS ? "medium" : "high";
  return { proxy: "pelvis_impact_speed_mps", band, definition };
}
