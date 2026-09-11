// TypeScript mirror of sim/tailbazaar_sim/arm/envelope.py (admissibility, scenario distance,
// duplicate rule, the conditions the policy's publisher evaluated it under). The Python module is
// authoritative and `tailbazaar_sim.arm.cli selfcheck` keeps it and sim/envelope-arm.yaml from
// drifting; this mirror lets the buyer, the verifier and the API reason about arm scenarios without
// spawning Python. A test checks it against the YAML the marketplace publishes.
//
// ADDITIVE: nothing here touches the cart envelope (tb-envelope-1) in ./envelope.ts or the humanoid
// envelope (tb-humanoid-envelope-1) in ./envelope-humanoid.ts.

export const ENVELOPE_ID = "tb-arm-envelope-1";
export const ENVELOPE_REVISION = "tb-arm-envelope-1.0";
export const TARGET_ID = "arm-pick-place-sac-v1";
/** Gymnasium-Robotics runs the Fetch model at 0.002 s with n_substeps 20, so one control tick is
 *  40 ms (25 Hz). Both latency axes are quantized to it. */
export const DT_CTRL_MS = 40;
export const DUPLICATE_DISTANCE = 0.05;
/** How far above its resting height the block's centre must be for a loss of grasp to count as a drop
 *  rather than a release onto the table. Fixed and documented in the simulator, NOT an axis. */
export const AIRBORNE_MARGIN_M = 0.03;
/** The environment's own registered episode horizon, in control ticks, and the simulator's cap on how
 *  far past it a drop may be followed so the landing can be measured. */
export const EPISODE_HORIZON_TICKS = 50;
export const SETTLE_TICKS_MAX = 30;
/** The table top, the only raised surface in this scene; the floor plane is at z = 0. */
export const TABLE_TOP_Z_M = 0.4;

export type AxisSpec = { min: number; max: number; step?: number; places?: number; type: "int" | "float"; unit: string; group: string };

export const ENVELOPE: Record<string, AxisSpec> = {
  object_mass_kg: { min: 0.2, max: 20.0, places: 3, type: "float", unit: "kg", group: "physical" },
  grip_friction: { min: 0.02, max: 1.5, places: 3, type: "float", unit: "coefficient", group: "physical" },
  object_offset_x_m: { min: -0.05, max: 0.05, places: 4, type: "float", unit: "m", group: "physical" },
  object_offset_y_m: { min: -0.05, max: 0.05, places: 4, type: "float", unit: "m", group: "physical" },
  action_noise_frac: { min: 0.0, max: 0.5, places: 3, type: "float", unit: "1", group: "systems" },
  control_latency_ms: { min: 0, max: 160, step: DT_CTRL_MS, type: "int", unit: "ms", group: "systems" },
  gripper_latency_ms: { min: 0, max: 160, step: DT_CTRL_MS, type: "int", unit: "ms", group: "systems" },
};

export const INIT_SEEDS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export const CONTINUOUS_ORDER = ["object_mass_kg", "grip_friction", "object_offset_x_m", "object_offset_y_m", "action_noise_frac", "control_latency_ms", "gripper_latency_ms"] as const;
export const PARAM_ORDER = [...CONTINUOUS_ORDER, "init_seed"] as const;
/** Every axis is optional in an input scenario; an omitted axis is read at its nominal value. */
export const OPTIONAL_PARAMS: ReadonlySet<string> = new Set(PARAM_ORDER);

export type Scenario = Record<string, number>;

export const NOMINAL_SCENARIO: Required<Record<(typeof PARAM_ORDER)[number], number>> = {
  object_mass_kg: 2.0,
  grip_friction: 1.0,
  object_offset_x_m: 0.0,
  object_offset_y_m: 0.0,
  action_noise_frac: 0.0,
  control_latency_ms: 0,
  gripper_latency_ms: 0,
  init_seed: 0,
};

// ---------------------------------------------------------------- what the PUBLISHER evaluated
// The cart's analogue is the controller's documented "tuned range". Here it is the conditions the
// policy's publisher trained and evaluated the checkpoint under: unmodified FetchPickAndPlace-v4.
// Transcribed from the model repository's results.json and config.json (see evidence/arm/README.md),
// not invented. An axis the publisher says nothing about is `not_stated`, never an invented bound.
export const PUBLISHED_CONDITIONS: Record<string, { min?: number; max?: number; exactly?: number; not_stated?: true }> = {
  object_mass_kg: { exactly: 2.0 },
  grip_friction: { exactly: 1.0 },
  object_offset_x_m: { exactly: 0.0 },
  object_offset_y_m: { exactly: 0.0 },
  action_noise_frac: { exactly: 0.0 },
  control_latency_ms: { exactly: 0 },
  gripper_latency_ms: { exactly: 0 },
  init_seed: { not_stated: true },
};

export const PUBLISHED_CONDITIONS_PROSE =
  "unmodified Gymnasium-Robotics FetchPickAndPlace-v4: the shipped 2 kg block, shipped friction, the environment's own block and goal sampling, no action noise, no control latency";
export const SEARCHED_ENVELOPE_PROSE =
  "payload mass 0.2-20 kg, grip friction 0.02-1.5, the part up to 5 cm from where the environment put it on either axis, action noise 0-50 % of the command range, control latency 0-160 ms and an extra 0-160 ms on the gripper channel alone, over eight published pick-and-place problems";
export const PUBLISHED_CONDITIONS_SOURCE =
  "the policy publisher's model repository on Hugging Face (IntelliGrow/FetchPickAndPlace-v4 @ 04bb1bf7), transcribed in sim/tailbazaar_sim/arm/envelope.py";
export const PRODUCT_QUESTION =
  "This policy is published as placing the block in about ten control steps, every episode. How far can the operating range be widened - a heavier part, a slipperier one, a part that is not quite where it was expected, noisy or delayed actuation - before it drops what it is carrying?";
export const OPERATING_CONTEXT_NOTE =
  "The searched envelope is deliberately wider than the conditions the policy was published for, so a finding outside them is not a defect report: the publisher evaluated unmodified FetchPickAndPlace-v4 and claims nothing about payload mass, grip friction, block placement, noise or latency. These bounds are illustrative assumptions for a demonstration; the 'robot' is Gymnasium-Robotics' MuJoCo Fetch mannequin driven by a mocap weld on its end effector, and the 'part' is a 5 cm cube, not a product. The policy checkpoint declares NO LICENCE, and neither does any alternative found on the hub.";

/** GUARD-shaped axis rows, identical in shape to the cart's and the humanoid's. `marginal`/`scale` are
 *  null on purpose: no distribution D over these axes is stated or estimated. `tuned_range` carries
 *  the publisher's conditions, this target's analogue of the cart controller's tuned range. */
export const ENVELOPE_AXES = [
  { name: "object_mass_kg", low: 0.2, high: 20.0, nominal: 2.0, marginal: null, scale: null, units: "kg", group: "physical", quantization: "3 decimal places", tuned_range: "= 2" },
  { name: "grip_friction", low: 0.02, high: 1.5, nominal: 1.0, marginal: null, scale: null, units: "coefficient", group: "physical", quantization: "3 decimal places", tuned_range: "= 1" },
  { name: "object_offset_x_m", low: -0.05, high: 0.05, nominal: 0.0, marginal: null, scale: null, units: "m", group: "physical", quantization: "4 decimal places", tuned_range: "= 0" },
  { name: "object_offset_y_m", low: -0.05, high: 0.05, nominal: 0.0, marginal: null, scale: null, units: "m", group: "physical", quantization: "4 decimal places", tuned_range: "= 0" },
  { name: "action_noise_frac", low: 0.0, high: 0.5, nominal: 0.0, marginal: null, scale: null, units: "coefficient", group: "systems", quantization: "3 decimal places", tuned_range: "= 0" },
  { name: "control_latency_ms", low: 0, high: 160, nominal: 0, marginal: null, scale: null, units: "ms", group: "systems", quantization: "quantized to the 40 ms control tick", tuned_range: "= 0" },
  { name: "gripper_latency_ms", low: 0, high: 160, nominal: 0, marginal: null, scale: null, units: "ms", group: "systems", quantization: "quantized to the 40 ms control tick", tuned_range: "= 0" },
] as const;

export const DUPLICATE_RULE_PROSE =
  `same failure-class set AND same init_seed AND normalized L-infinity distance < ${DUPLICATE_DISTANCE} over the seven continuous axes. Unlike the humanoid's push axes there are no conditional axes here: every axis of this envelope changes the dynamics on its own at every point of the envelope, so none of them can ever describe nothing`;

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
  return Math.abs(av - bv) / (spec.max - spec.min);
}

/** Normalized L-infinity distance over the CONTINUOUS axes. `init_seed` is a stratification, not a
 *  coordinate: reset(seed=s) samples a different block position AND a different goal, so two runs
 *  from different seeds are different pick-and-place problems and never duplicates of each other. */
export function scenarioDistance(a: Scenario, b: Scenario): number {
  const at = (s: Scenario, k: string): number => Number(s[k] ?? NOMINAL_SCENARIO[k as keyof typeof NOMINAL_SCENARIO]);
  if (Math.trunc(at(a, "init_seed")) !== Math.trunc(at(b, "init_seed"))) return Infinity;
  let d = 0;
  for (const k of CONTINUOUS_ORDER) d = Math.max(d, axisGap(k, at(a, k), at(b, k)));
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
/** The speed a free fall from the table top reaches at the floor: sqrt(2 g h_table) = 2.80 m/s. It is
 *  the only non-arbitrary speed this scene offers — the block starts on that table and the floor is
 *  the other surface it can reach — so the coarse bands are anchored to it. A block that hits
 *  something faster than a passive fall off its own table was carried up and let go, not merely
 *  nudged off the edge. NOT_PLACED has no severity proxy at all: nothing was dropped and nothing hit
 *  anything, so the value is null and the band is "none" rather than an invented stand-in. */
export const TABLE_FALL_REF_MPS = Math.sqrt(2 * 9.81 * TABLE_TOP_Z_M);
export const SEVERITY_BAND_DEFINITION =
  `block impact speed banded against the ${TABLE_FALL_REF_MPS.toFixed(2)} m/s a free fall from the ${TABLE_TOP_Z_M.toFixed(2)} m table top reaches at the floor: low below half of it, medium up to it, high above it (a measured kinematic proxy, never a damage, breakage or cost estimate)`;

export function severityBand(impactSpeedMps: number | null): { proxy: string; band: string; definition: string } {
  const definition = SEVERITY_BAND_DEFINITION;
  if (impactSpeedMps === null || !Number.isFinite(impactSpeedMps)) return { proxy: "object_impact_speed_mps", band: "none", definition };
  const band = impactSpeedMps < TABLE_FALL_REF_MPS / 2 ? "low" : impactSpeedMps <= TABLE_FALL_REF_MPS ? "medium" : "high";
  return { proxy: "object_impact_speed_mps", band, definition };
}
