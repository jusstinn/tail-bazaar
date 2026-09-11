// TypeScript mirror of sim/tailbazaar_sim/humanoid/envelope.py (admissibility, scenario distance,
// duplicate rule, published conditions). The Python module is authoritative and `tailbazaar-humanoid
// selfcheck` keeps it and sim/envelope-humanoid.yaml from drifting; this mirror lets the buyer, the
// verifier and the API reason about humanoid scenarios without spawning Python. A test checks it
// against the YAML the marketplace publishes.
//
// ADDITIVE: nothing here touches the cart envelope (tb-envelope-1) in ./envelope.ts.

export const ENVELOPE_ID = "tb-humanoid-envelope-1";
export const ENVELOPE_REVISION = "tb-humanoid-envelope-1.0";
export const TARGET_ID = "humanoid-balance-sac-v1";
export const DT_CTRL_MS = 15;
export const PUSH_DURATION_S = 0.15;
export const DUPLICATE_DISTANCE = 0.05;

export type AxisSpec = { min: number; max: number; step?: number; places?: number; type: "int" | "float"; unit: string; group: string; circular?: true };

export const ENVELOPE: Record<string, AxisSpec> = {
  push_impulse_ns: { min: 0.0, max: 120.0, places: 2, type: "float", unit: "N*s", group: "physical" },
  push_heading_deg: { min: 0.0, max: 360.0, places: 1, type: "float", unit: "deg", group: "physical", circular: true },
  push_time_s: { min: 0.6, max: 7.8, places: 3, step: 0.015, type: "float", unit: "s", group: "physical" },
  floor_friction: { min: 0.4, max: 1.4, places: 3, type: "float", unit: "1", group: "physical" },
  body_mass_scale: { min: 0.8, max: 1.25, places: 3, type: "float", unit: "1", group: "physical" },
  actuator_noise_frac: { min: 0.0, max: 0.3, places: 3, type: "float", unit: "1", group: "systems" },
  control_latency_ms: { min: 0, max: 90, step: DT_CTRL_MS, type: "int", unit: "ms", group: "systems" },
};

export const INIT_SEEDS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export const CONTINUOUS_ORDER = ["push_impulse_ns", "push_heading_deg", "push_time_s", "floor_friction", "body_mass_scale", "actuator_noise_frac", "control_latency_ms"] as const;
export const PARAM_ORDER = [...CONTINUOUS_ORDER, "init_seed"] as const;
/** Every axis is optional in an input scenario; an omitted axis is read at its nominal value. */
export const OPTIONAL_PARAMS: ReadonlySet<string> = new Set(PARAM_ORDER);
/** Axes that describe only the push. With no push they describe nothing and are skipped. */
export const PUSH_ONLY_AXES = ["push_heading_deg", "push_time_s"] as const;

export type Scenario = Record<string, number>;

export const NOMINAL_SCENARIO: Required<Record<(typeof PARAM_ORDER)[number], number>> = {
  push_impulse_ns: 0.0,
  push_heading_deg: 0.0,
  push_time_s: 2.1,
  floor_friction: 1.0,
  body_mass_scale: 1.0,
  actuator_noise_frac: 0.0,
  control_latency_ms: 0,
  init_seed: 0,
};

// ---------------------------------------------------------------- what the PUBLISHER evaluated
// The cart's analogue is the controller's documented "tuned range". Here it is the conditions the
// policy's publisher evaluated the checkpoint under: unmodified Gymnasium Humanoid-v5. Transcribed
// from the model card and the SB3 save (see evidence/humanoid/README.md), not invented. An axis the
// publisher says nothing about is `not_stated`, never an invented bound.
export const PUBLISHED_CONDITIONS: Record<string, { min?: number; max?: number; exactly?: number; not_stated?: true }> = {
  push_impulse_ns: { exactly: 0.0 },
  push_heading_deg: { not_stated: true },
  push_time_s: { not_stated: true },
  floor_friction: { exactly: 1.0 },
  body_mass_scale: { exactly: 1.0 },
  actuator_noise_frac: { exactly: 0.0 },
  control_latency_ms: { exactly: 0 },
  init_seed: { not_stated: true },
};

export const PUBLISHED_CONDITIONS_PROSE =
  "unmodified Gymnasium Humanoid-v5: no external push, floor friction 1.0, stock body masses, no actuator noise, no control latency";
export const SEARCHED_ENVELOPE_PROSE =
  "push impulse 0-120 N·s from any heading, push time 0.6-7.8 s, floor friction 0.4-1.4, body mass ×0.8-1.25, actuator noise 0-30 %, control latency 0-90 ms, over eight published initial states";
export const PUBLISHED_CONDITIONS_SOURCE =
  "the policy publisher's model card on Hugging Face (farama-minari/Humanoid-v5-SAC-expert @ f9130b25), transcribed in sim/tailbazaar_sim/humanoid/envelope.py";
export const PRODUCT_QUESTION =
  "This policy is published with a mean return of 8127 on stock Humanoid-v5. How far can the operating range be widened — a shove, a slippery floor, a heavier body, noisy or delayed actuation — before it falls over?";
export const OPERATING_CONTEXT_NOTE =
  "The searched envelope is deliberately wider than the conditions the policy was published for, so a finding outside them is not a defect report: the publisher evaluated unmodified Humanoid-v5 and claims nothing about pushes, latency, noise, friction or mass. These bounds are illustrative assumptions for a demonstration; the 'robot' is Gymnasium's 42.116 kg MuJoCo mannequin, not a product.";

/** GUARD-shaped axis rows, identical in shape to the cart's. `marginal`/`scale` are null on purpose:
 *  no distribution D over these axes is stated or estimated. `tuned_range` carries the publisher's
 *  conditions, which is this target's analogue of the cart controller's tuned range. */
export const ENVELOPE_AXES = [
  { name: "push_impulse_ns", low: 0.0, high: 120.0, nominal: 0.0, marginal: null, scale: null, units: "N*s", group: "physical", quantization: "2 decimal places", tuned_range: "= 0" },
  { name: "push_heading_deg", low: 0.0, high: 360.0, nominal: 0.0, marginal: null, scale: null, units: "deg", group: "physical", quantization: "1 decimal place, circular", tuned_range: "not stated" },
  { name: "push_time_s", low: 0.6, high: 7.8, nominal: 2.1, marginal: null, scale: null, units: "s", group: "physical", quantization: "quantized to the 15 ms control tick", tuned_range: "not stated" },
  { name: "floor_friction", low: 0.4, high: 1.4, nominal: 1.0, marginal: null, scale: null, units: "coefficient", group: "physical", quantization: "3 decimal places", tuned_range: "= 1" },
  { name: "body_mass_scale", low: 0.8, high: 1.25, nominal: 1.0, marginal: null, scale: null, units: "coefficient", group: "physical", quantization: "3 decimal places", tuned_range: "= 1" },
  { name: "actuator_noise_frac", low: 0.0, high: 0.3, nominal: 0.0, marginal: null, scale: null, units: "coefficient", group: "systems", quantization: "3 decimal places", tuned_range: "= 0" },
  { name: "control_latency_ms", low: 0, high: 90, nominal: 0, marginal: null, scale: null, units: "ms", group: "systems", quantization: "quantized to the 15 ms control tick", tuned_range: "= 0" },
] as const;

export const DUPLICATE_RULE_PROSE =
  `same failure-class set AND same init_seed AND normalized L-infinity distance < ${DUPLICATE_DISTANCE} over the seven continuous axes (push_heading_deg the short way round the circle; push_heading_deg and push_time_s skipped when either side has no push, because an impulse of magnitude zero has no direction or timing and the two runs are byte-identical)`;

export function checkAdmissible(scn: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const k of CONTINUOUS_ORDER) {
    if (!(k in scn)) continue; // optional: read at nominal
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
  if ("init_seed" in scn) {
    const s = scn.init_seed;
    if (typeof s !== "number" || !Number.isInteger(s) || !(INIT_SEEDS as readonly number[]).includes(s)) problems.push(`init_seed must be one of ${JSON.stringify([...INIT_SEEDS])}`);
  }
  const extra = Object.keys(scn).filter((k) => !(PARAM_ORDER as readonly string[]).includes(k));
  if (extra.length) problems.push(`unknown parameters: ${JSON.stringify(extra.sort())}`);
  // The push must name one unambiguous control tick (mirrors the Python check).
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
    if (k === "init_seed") { out[k] = Math.trunc(v); continue; }
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

/** Normalized L-infinity distance over the CONTINUOUS axes. `init_seed` is a stratification, not a
 *  coordinate: two runs from different initial states are different findings, never duplicates. */
export function scenarioDistance(a: Scenario, b: Scenario): number {
  const at = (s: Scenario, k: string): number => Number(s[k] ?? NOMINAL_SCENARIO[k as keyof typeof NOMINAL_SCENARIO]);
  if (Math.trunc(at(a, "init_seed")) !== Math.trunc(at(b, "init_seed"))) return Infinity;
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

/** Where a scenario sits relative to both ranges, per axis. Post-purchase only. */
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
/** The speed a free fall from the bottom of Gymnasium's own healthy band (torso z = 1.0 m) reaches:
 *  sqrt(2 g z_min) = 4.429 m/s. It is the only non-arbitrary speed this scene offers, so the coarse
 *  bands are anchored to it — a torso that hits the floor faster than a passive drop from the height
 *  at which the environment already calls it unhealthy was driven down, not merely falling. */
export const FREE_FALL_REF_MPS = Math.sqrt(2 * 9.81 * 1.0);
export const SEVERITY_BAND_DEFINITION =
  `torso impact speed banded against the ${FREE_FALL_REF_MPS.toFixed(2)} m/s a free fall from the 1.0 m healthy-height floor reaches: low below half of it, medium up to it, high above it (a measured kinematic proxy, never a damage, injury or cost estimate)`;

export function severityBand(impactSpeedMps: number | null): { proxy: string; band: string; definition: string } {
  const definition = SEVERITY_BAND_DEFINITION;
  if (impactSpeedMps === null || !Number.isFinite(impactSpeedMps)) return { proxy: "torso_impact_speed_mps", band: "none", definition };
  const band = impactSpeedMps < FREE_FALL_REF_MPS / 2 ? "low" : impactSpeedMps <= FREE_FALL_REF_MPS ? "medium" : "high";
  return { proxy: "torso_impact_speed_mps", band, definition };
}
