// TypeScript mirror of sim/tailbazaar_sim/envelope.py (admissibility, scenario distance, duplicate rule).
// The Python module is authoritative; the verifier additionally trusts the simulator's own
// `admissible` flag from the re-run. This mirror lets the buyer and the API reason about scenarios
// without spawning Python.
export const ENVELOPE_ID = "tb-envelope-1";
export const DT_CTRL_MS = 20;
export const DUPLICATE_DISTANCE = 0.05;
export const PARAM_ORDER = ["sensor_delay_ms", "actuator_delay_ms", "floor_friction", "payload_kg"] as const;
export type Scenario = { sensor_delay_ms: number; actuator_delay_ms: number; floor_friction: number; payload_kg: number };

export const ENVELOPE: Record<(typeof PARAM_ORDER)[number], { min: number; max: number; step?: number; places?: number; type: "int" | "float"; unit: string }> = {
  sensor_delay_ms: { min: 0, max: 300, step: DT_CTRL_MS, type: "int", unit: "ms" },
  actuator_delay_ms: { min: 0, max: 100, step: DT_CTRL_MS, type: "int", unit: "ms" },
  floor_friction: { min: 0.2, max: 1.0, places: 3, type: "float", unit: "1" },
  payload_kg: { min: 5.0, max: 60.0, places: 1, type: "float", unit: "kg" },
};

export const NOMINAL_SCENARIO: Scenario = { sensor_delay_ms: 20, actuator_delay_ms: 20, floor_friction: 0.8, payload_kg: 20.0 };

export function checkAdmissible(scn: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const k of PARAM_ORDER) {
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
  return problems;
}

export function scenarioDistance(a: Scenario, b: Scenario): number {
  let d = 0;
  for (const k of PARAM_ORDER) {
    const spec = ENVELOPE[k];
    d = Math.max(d, Math.abs(Number(a[k]) - Number(b[k])) / (spec.max - spec.min));
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
