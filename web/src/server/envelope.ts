// TypeScript mirror of sim/tailbazaar_sim/envelope.py (admissibility, scenario distance, duplicate rule).
// The Python module is authoritative; the verifier additionally trusts the simulator's own
// `admissible` flag from the re-run. This mirror lets the buyer and the API reason about scenarios
// without spawning Python.
export const ENVELOPE_ID = "tb-envelope-1";
export const DT_CTRL_MS = 20;
export const DUPLICATE_DISTANCE = 0.05;
export const PARAM_ORDER = ["sensor_delay_ms", "actuator_delay_ms", "floor_friction", "payload_kg", "load_friction"] as const;
// `load_friction` (deck grip) is OPTIONAL in an input scenario, exactly as in the Python authority:
// a four-key scenario written against envelope revision tb-envelope-1 is read at the nominal deck grip.
export const OPTIONAL_PARAMS: ReadonlySet<string> = new Set(["load_friction"]);
export type Scenario = { sensor_delay_ms: number; actuator_delay_ms: number; floor_friction: number; payload_kg: number; load_friction?: number };

export const ENVELOPE: Record<(typeof PARAM_ORDER)[number], { min: number; max: number; step?: number; places?: number; type: "int" | "float"; unit: string }> = {
  sensor_delay_ms: { min: 0, max: 300, step: DT_CTRL_MS, type: "int", unit: "ms" },
  actuator_delay_ms: { min: 0, max: 100, step: DT_CTRL_MS, type: "int", unit: "ms" },
  floor_friction: { min: 0.2, max: 1.0, places: 3, type: "float", unit: "1" },
  payload_kg: { min: 5.0, max: 60.0, places: 1, type: "float", unit: "kg" },
  load_friction: { min: 0.1, max: 1.0, places: 3, type: "float", unit: "1" },
};

export const NOMINAL_SCENARIO: Required<Scenario> = { sensor_delay_ms: 20, actuator_delay_ms: 20, floor_friction: 0.8, payload_kg: 20.0, load_friction: 0.6 };

// ---------------------------------------------------------------- operating context (P3 framing)
// The controller's TUNED RANGE, transcribed from the "Design assumptions" paragraph of the docstring
// in sim/tailbazaar_sim/controller.py. That file is the authority and is never edited (its SHA-256 is
// the controller version id in every evidence document), so this is a mirror, checked by a test.
export const CONTROLLER_TUNED_RANGE: Record<(typeof PARAM_ORDER)[number], { min?: number; max?: number; exactly?: number; not_stated?: true }> = {
  sensor_delay_ms: { max: 40 },
  actuator_delay_ms: { max: 20 },
  floor_friction: { min: 0.6 },
  payload_kg: { exactly: 20.0 },
  // controller.py documents no assumption about how the load is secured; the deck grip a planned stop
  // demands (A_TRIGGER/g = 0.306) and a saturated brake demands (A_FULL/g = 0.612) follow from its constants.
  load_friction: { not_stated: true },
};
export const TUNED_RANGE_PROSE = "sensor latency <= 40 ms, actuator latency <= 20 ms, floor friction >= 0.6, payload 20 kg";
export const SEARCHED_ENVELOPE_PROSE = "sensor latency 0-300 ms, actuator latency 0-100 ms, floor friction 0.2-1.0, payload 5-60 kg, deck grip (load friction) 0.1-1.0";
export const TUNED_RANGE_PROSE_FULL = TUNED_RANGE_PROSE + "; deck grip (load_friction) not stated by the controller";
export const TUNED_RANGE_SOURCE = "sim/tailbazaar_sim/controller.py, docstring section 'Design assumptions'";
export const PRODUCT_QUESTION =
  "Can this controller be deployed in a wider operating range than it was tuned for, and where exactly does it stop working?";
export const OPERATING_CONTEXT_NOTE =
  "The searched envelope is deliberately wider than the range the controller was tuned for, so a finding outside the tuned range is not a defect report: it is a measured boundary of the deployable range. The controller checks none of its tuned-range assumptions at runtime. Both ranges are illustrative design assumptions, not measurements of a physical robot.";

/** Where a scenario sits relative to both ranges, per parameter. Post-purchase only: this is derived
 *  from the exact parameters and therefore never appears in a pre-purchase summary. */
export function rangePosition(scn: Scenario): { parameter: string; value: number; unit: string; tuned_range: string; in_tuned_range: boolean; searched_envelope: string }[] {
  return PARAM_ORDER.map((k) => {
    const t = CONTROLLER_TUNED_RANGE[k];
    const spec = ENVELOPE[k];
    const v = Number(scn[k] ?? NOMINAL_SCENARIO[k]);
    const inTuned = t.not_stated ? true : t.exactly !== undefined ? v === t.exactly : (t.min === undefined || v >= t.min) && (t.max === undefined || v <= t.max);
    const tuned = t.not_stated ? "not stated" : t.exactly !== undefined ? `= ${t.exactly}` : t.min !== undefined ? `>= ${t.min}` : `<= ${t.max}`;
    return { parameter: k, value: v, unit: spec.unit, tuned_range: tuned, in_tuned_range: inTuned, searched_envelope: `${spec.min} - ${spec.max}` };
  });
}

/** GUARD-shaped axis rows (configs/guard_theta.yaml: name, low, high, nominal, marginal, scale, units,
 *  group). `marginal`/`scale` are deliberately null: Tail Bazaar runs a bounded deterministic grid
 *  search over these axes and does not sample from a distribution, so declaring one here would invent
 *  a modelling decision that belongs to whoever states D. See sim/envelope.yaml. */
export const ENVELOPE_AXES = [
  { name: "sensor_delay_ms", low: 0, high: 300, nominal: 20, marginal: null, scale: null, units: "ms", group: "systems", quantization: "quantized to the 20 ms control tick", tuned_range: "<= 40" },
  { name: "actuator_delay_ms", low: 0, high: 100, nominal: 20, marginal: null, scale: null, units: "ms", group: "systems", quantization: "quantized to the 20 ms control tick", tuned_range: "<= 20" },
  { name: "floor_friction", low: 0.2, high: 1.0, nominal: 0.8, marginal: null, scale: null, units: "coefficient", group: "physical", quantization: "3 decimal places", tuned_range: ">= 0.6" },
  { name: "payload_kg", low: 5.0, high: 60.0, nominal: 20.0, marginal: null, scale: null, units: "kg", group: "physical", quantization: "1 decimal place", tuned_range: "= 20" },
  { name: "load_friction", low: 0.1, high: 1.0, nominal: 0.6, marginal: null, scale: null, units: "coefficient", group: "physical", quantization: "3 decimal places", tuned_range: "not stated" },
] as const;

/** Public document served by GET /api/envelope: constants only, identical for every listing. */
export const ENVELOPE_DOC = {
  envelope_id: ENVELOPE_ID,
  yaml: "sim/envelope.yaml (same axis shape as GUARD configs/guard_theta.yaml)",
  axes: ENVELOPE_AXES,
  nominal_scenario: NOMINAL_SCENARIO,
  control_tick_ms: DT_CTRL_MS,
  duplicate_rule: `normalized L-infinity distance < ${DUPLICATE_DISTANCE}`,
  controller_tuned_range: { prose: TUNED_RANGE_PROSE, source: TUNED_RANGE_SOURCE, per_parameter: CONTROLLER_TUNED_RANGE },
  searched_envelope: { prose: SEARCHED_ENVELOPE_PROSE },
  product_question: PRODUCT_QUESTION,
  note: OPERATING_CONTEXT_NOTE,
  distribution: "No distribution D over these axes is stated or estimated. The search is a bounded deterministic grid; adversarially selected failures are not failure frequencies.",
  verdicts: { VALID: "re-simulated and bound to the delivered evidence", INVALID: "rejected (not reproducible, out of envelope, duplicate, or evidence not bound to the verified run)", INCONCLUSIVE: "numerical divergence or metrics outside tolerance; never pays" },
};

/** The compact operating context carried inside every public summary. Prose only, no parameter
 *  identifiers and no per-listing positioning, so it cannot narrow down the hidden scenario. */
export function operatingContext() {
  return {
    controller_tuned_range: TUNED_RANGE_PROSE,
    searched_envelope: SEARCHED_ENVELOPE_PROSE,
    question: PRODUCT_QUESTION,
    note: OPERATING_CONTEXT_NOTE,
    reference: "GET /api/envelope (published axes, same shape as GUARD configs/guard_theta.yaml)",
  };
}

export function checkAdmissible(scn: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const k of PARAM_ORDER) {
    const spec = ENVELOPE[k];
    if (!(k in scn)) {
      if (!OPTIONAL_PARAMS.has(k)) problems.push(`missing ${k}`);
      continue;
    }
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
  return problems;
}

export function scenarioDistance(a: Scenario, b: Scenario): number {
  let d = 0;
  for (const k of PARAM_ORDER) {
    const spec = ENVELOPE[k];
    const av = Number(a[k] ?? NOMINAL_SCENARIO[k]);
    const bv = Number(b[k] ?? NOMINAL_SCENARIO[k]);
    d = Math.max(d, Math.abs(av - bv) / (spec.max - spec.min));
  }
  return d;
}

export function isDuplicate(a: Scenario, b: Scenario): boolean {
  return scenarioDistance(a, b) < DUPLICATE_DISTANCE;
}

/** Coarse severity bucket from the impact-speed proxy. Bands are illustrative, not calibrated damage. */
export function severityBand(impactSpeedMps: number | null): { proxy: string; band: string; definition: string } {
  const definition = "impact speed band: low < 0.5 m/s, medium 0.5-1.0 m/s, high > 1.0 m/s (proxy only, not a damage estimate)";
  if (impactSpeedMps === null) return { proxy: "impact_speed_mps", band: "none", definition };
  const band = impactSpeedMps < 0.5 ? "low" : impactSpeedMps <= 1.0 ? "medium" : "high";
  return { proxy: "impact_speed_mps", band, definition };
}
