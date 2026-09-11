// PHYSICAL PLAUSIBILITY OF A DELIVERED REPLAY — per target, derived, never a tuned tolerance.
//
// A delivered replay is a list of rigid-body poses. Hashes bind it to a run; the limits here say
// whether it could be a run of THAT SCENE AT ALL. Every number is read off the scene and the
// termination rules the simulator itself published in the VERIFIER'S OWN re-run document, or off the
// published envelope. A forger who rewrites the frames and then rewrites every hash over them is
// internally consistent; what saves nobody is that the frames still have to be a trajectory the
// scene could produce.
//
// Each target supplies its own derivation (see targets.ts). The reading of the frames — structure,
// monotone time, span, world bound, inter-frame speed — is identical for both, because both
// simulators record the same [t, (x, y, z, qw, qx, qy, qz) × bodies] row shape.

/** Standard gravity: the value both scenes pass to MuJoCo. */
export const GRAVITY_MPS2 = 9.81;
/** Both simulators end a run as DIVERGED as soon as a recorded coordinate exceeds 100 m
 *  (sim/tailbazaar_sim/simulate.py and sim/tailbazaar_sim/humanoid/simulate.py). A run that crosses
 *  it is never reported as a failure, so no certifiable replay can contain such a pose — and 100 m is
 *  also the longest straight line a body can travel while the run is still conclusive. */
export const SIM_POSITION_BOUND_M = 100;

/** Each recorded frame is [t, then (x, y, z, qw, qx, qy, qz) per body]. */
export const FRAME_STRIDE = 7;

export type ReplayLimits = {
  /** Recording interval of the verifier's own run. */
  dt_s: number;
  /** Fastest a body in this scene can possibly be moving, in m/s. */
  speed_ceiling_mps: number;
  /** Largest coordinate magnitude a conclusive run can contain, in m. */
  position_bound_m: number;
  /** Longest a conclusive run can last, in s. */
  max_span_s: number;
  /** How the ceiling was derived, carried into the record so it can be audited. */
  derivation: string;
};

export type PlausibilityResult = { ok: boolean; detail: string; max_speed_mps: number | null };

const numberOr = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Recording interval and the longest a conclusive run can last, read off the verifier's own run.
 *  The cart calls its post-failure tail `post_contact_s`, the humanoid `post_fall_s`; both are read. */
export function timingFrom(run: { frames?: { dt_s?: unknown }; termination_rules?: unknown }, fallbackDt: number, fallbackTMax: number): { dt_s: number; max_span_s: number } {
  const rules = (run.termination_rules ?? {}) as Record<string, unknown>;
  const dt = numberOr((run.frames as { dt_s?: unknown } | undefined)?.dt_s, 0);
  const dtS = dt > 0 ? dt : fallbackDt;
  const tMax = numberOr(rules.t_max_s, fallbackTMax);
  const tail = numberOr(rules.post_contact_s, numberOr(rules.post_fall_s, 1));
  return { dt_s: dtS, max_span_s: tMax + tail + dtS };
}

/**
 * Read the delivered frames as a trajectory and decide whether this scene could have produced them.
 * Rejects a recording that is structurally not a trajectory, that steps backwards in time, that runs
 * longer than the simulator allows, that leaves the world the simulator models, or in which any body
 * moves faster between two frames than the scene can possibly move it.
 */
export function checkReplayPlausibility(frames: unknown, limits: ReplayLimits): PlausibilityResult {
  const f = frames as { dt_s?: unknown; bodies?: unknown; data?: unknown } | null | undefined;
  if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, detail: "the package carries no replay frames", max_speed_mps: null };
  const bodies = Array.isArray(f.bodies) ? (f.bodies as unknown[]) : null;
  const rows = Array.isArray(f.data) ? (f.data as unknown[]) : null;
  const dtDeclared = Number(f.dt_s);
  if (!bodies || !rows || bodies.length === 0) return { ok: false, detail: "replay frames are not a {dt_s, bodies, data} recording", max_speed_mps: null };
  // The recording interval is fixed by the simulator. Taking it from the package would let a forger
  // stretch time until any jump looks slow, so it must equal the interval the verifier itself recorded.
  if (!(Number.isFinite(dtDeclared) && Math.abs(dtDeclared - limits.dt_s) < 1e-12))
    return { ok: false, detail: `frames declare dt_s=${f.dt_s}, but the verifier's own recording interval is ${limits.dt_s} s`, max_speed_mps: null };
  if (rows.length < 2) return { ok: false, detail: `a replay of a failure cannot consist of ${rows.length} frame(s)`, max_speed_mps: null };
  const width = 1 + FRAME_STRIDE * bodies.length;
  const violations: string[] = [];
  let maxSpeed = 0;
  let worst = "";
  let prev: number[] | null = null;
  let t0 = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length !== width || row.some((x) => typeof x !== "number" || !Number.isFinite(x)))
      return { ok: false, detail: `frame ${i} is not ${width} finite numbers (t plus ${FRAME_STRIDE} per body for ${bodies.length} bodies)`, max_speed_mps: null };
    const r = row as number[];
    if (i === 0) t0 = r[0];
    for (let b = 0; b < bodies.length; b++) {
      for (let k = 0; k < 3; k++) {
        const c = r[1 + FRAME_STRIDE * b + k];
        if (Math.abs(c) > limits.position_bound_m && violations.length < 4)
          violations.push(`frame ${i} places ${String(bodies[b])} at ${c.toFixed(3)} m on axis ${"xyz"[k]}, outside the +/-${limits.position_bound_m} m world the simulator models (it ends such a run as DIVERGED, never as a failure)`);
      }
    }
    if (prev) {
      const step = r[0] - prev[0];
      if (step < 0 && violations.length < 4) violations.push(`frame ${i} steps backwards in time (t ${prev[0]} -> ${r[0]})`);
      // A short final tick is real; a stretched one is not trusted, so never divide by more than the tick.
      const dt = step > 0 && step < limits.dt_s ? step : limits.dt_s;
      for (let b = 0; b < bodies.length; b++) {
        const o = 1 + FRAME_STRIDE * b;
        const speed = Math.hypot(r[o] - prev[o], r[o + 1] - prev[o + 1], r[o + 2] - prev[o + 2]) / dt;
        if (speed > maxSpeed) {
          maxSpeed = speed;
          worst = `${String(bodies[b])} between frames ${i - 1} and ${i}`;
        }
      }
    }
    prev = r;
  }
  const span = (prev as number[])[0] - t0;
  if (span > limits.max_span_s)
    violations.push(`the recording spans ${span.toFixed(3)} s, longer than the ${limits.max_span_s.toFixed(3)} s a conclusive run can last under the simulator's own termination rules`);
  if (maxSpeed > limits.speed_ceiling_mps)
    violations.unshift(`${worst} moves at ${maxSpeed.toFixed(3)} m/s, above the ${limits.speed_ceiling_mps.toFixed(3)} m/s this scene can produce`);
  const ceiling = `fastest recorded body ${maxSpeed.toFixed(3)} m/s, ceiling ${limits.speed_ceiling_mps.toFixed(3)} m/s = ${limits.derivation}`;
  return { ok: violations.length === 0, detail: violations.length === 0 ? ceiling : `${violations.join("; ")} [${ceiling}]`, max_speed_mps: maxSpeed };
}
