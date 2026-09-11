// How each target's evidence is NARRATED on the finding page: the sentence that explains what was
// different and what happened, the metric table, and the tiles above it. The numbers all come out of
// the package and the baseline run; nothing here computes physics or invents a quantity.
//
// The rest of the page (stages, hashes, range bars, verifier checks, on-chain history) is identical
// for every target, so adding a third robot means adding one entry here and one renderer.
import type { Pkg, RunLike } from "./api.js";
import { esc, num } from "./format.js";
import type { FailurePresentation } from "../server/failure.js";
import { rendererFor, type SceneRenderer } from "./replay.js";

export type Stat = { label: string; value: unknown; unit: string; dec: number; note?: string };

export type TargetView = {
  id: string;
  renderer: SceneRenderer;
  baselineLabel: string;
  failureLabel: string;
  /** The headline a settled, valid order opens with. */
  headline: string;
  narrate(pkg: Pkg, baseline: RunLike, p: FailurePresentation): string;
  metrics(baseline: RunLike, pkg: Pkg): [string, unknown, unknown][];
  stats(pkg: Pkg, baseline: RunLike, p: FailurePresentation): Stat[];
};

const ev = (doc: { events?: any[] }, type: string): any | undefined => (doc.events ?? []).find((e) => e?.type === type);
/** "torso impact · torso impact speed" reads as a stutter; the quantity's own label already says it. */
const severityTile = (p: FailurePresentation): Stat | null => {
  const q = p.headline_quantity;
  if (!q) return null;
  const where = p.severity_label || p.moment_label;
  return { label: q.label.includes(where) ? q.label : `${where} · ${q.label}`, value: q.value, unit: q.unit, dec: 3 };
};
const m = (doc: { metrics?: Record<string, any> }, k: string): unknown => doc.metrics?.[k];

// ------------------------------------------------------------------------------------- the cart
const CART: TargetView = {
  id: "cart",
  renderer: rendererFor("cart-3d"),
  baselineLabel: "Baseline · nominal conditions",
  failureLabel: "Purchased scenario",
  headline: "The cart was supposed to stop.<br>Under these conditions it did not.",

  narrate(pkg, baseline, p) {
    const bOnset = ev(baseline, "brake_onset");
    const fOnset = ev(pkg, "brake_onset");
    const obs = (pkg.scene as Record<string, any>).obstacle_front_x_m as number;
    const trueRangeAtOnset = fOnset ? obs - fOnset.x_front_m : null;
    const bTrueRangeAtOnset = bOnset ? obs - bOnset.x_front_m : null;
    const head = fOnset
      ? `The controller started braking at <span class="mono">${num(fOnset.t_s, 2)} s</span> while moving at <span class="mono">${num(fOnset.speed_mps, 2)} m/s</span>. Its range measurement was ${esc(String(pkg.scenario.sensor_delay_ms))} ms stale, so it believed the obstacle was <span class="mono">${num(fOnset.range_used_m, 2)} m</span> away when the true distance was already <span class="mono">${num(trueRangeAtOnset, 2)} m</span>${bOnset ? `. With nominal sensing the same controller braked at ${num(bOnset.t_s, 2)} s with ${num(bTrueRangeAtOnset, 2)} m still in hand` : ""}.`
      : `The controller never braked before the failure.`;
    const moment = p.moment_t_s !== null
      ? ` ${esc(p.sentence)} It happened at <span class="mono">${num(p.moment_t_s, 3)} s</span>${p.headline_quantity ? `, with ${esc(p.headline_quantity.label)} <span class="mono">${esc(p.headline_quantity.text)}</span>` : ""}.`
      : "";
    return `${head}${moment} The baseline, same controller under nominal conditions, stopped with <span class="mono">${num(m(baseline, "final_clearance_m"), 3)} m</span> to spare.`;
  },

  metrics(baseline, pkg) {
    return [
      ["outcome", m(baseline, "outcome"), m(pkg, "outcome")],
      ["top speed (m/s)", num(m(baseline, "v_max_mps")), num(m(pkg, "v_max_mps"))],
      ["brake onset (s)", num(m(baseline, "brake_onset_t_s"), 2), num(m(pkg, "brake_onset_t_s"), 2)],
      ["stopping distance (m)", num(m(baseline, "stopping_distance_m")), m(pkg, "stopping_distance_m") === null ? "undefined (did not stop)" : num(m(pkg, "stopping_distance_m"))],
      ["final clearance (m)", num(m(baseline, "final_clearance_m")), num(m(pkg, "final_clearance_m"))],
      ["first contact (s)", "—", num(m(pkg, "first_contact_t_s"), 3)],
      ["impact speed (m/s)", "—", num(m(pkg, "impact_speed_mps"))],
      ["impact kinetic energy (J)", "—", num(m(pkg, "impact_kinetic_energy_j"), 1)],
      ["brake onset → impact (m)", "—", num(m(pkg, "distance_brake_onset_to_impact_m"))],
      ["peak deceleration (m/s²)", num(m(baseline, "peak_decel_mps2"), 2), num(m(pkg, "peak_decel_mps2"), 2)],
      ["total mass (kg)", num(m(baseline, "total_mass_kg"), 1), num(m(pkg, "total_mass_kg"), 1)],
    ];
  },

  stats(pkg, baseline, p) {
    const out: (Stat | null)[] = [
      severityTile(p),
      { label: "clearance left", value: m(pkg, "final_clearance_m"), unit: "m", dec: 3, note: "distance to the obstacle when the run ended" },
      { label: "baseline clearance", value: m(baseline, "final_clearance_m"), unit: "m", dec: 3, note: `target ${num(m(baseline, "target_clearance_m"), 2)} m` },
      { label: "brake onset to impact", value: m(pkg, "distance_brake_onset_to_impact_m"), unit: "m", dec: 3, note: "distance travelled after the brakes came on" },
    ];
    return out.filter((x): x is Stat => x !== null);
  },
};

// --------------------------------------------------------------------------------- the humanoid
const HUMANOID: TargetView = {
  id: "humanoid",
  renderer: rendererFor("humanoid-3d"),
  baselineLabel: "Baseline · published conditions",
  failureLabel: "Purchased scenario",
  headline: "The policy was supposed to keep walking.<br>Under these conditions it went down.",

  narrate(pkg, baseline, p) {
    const push = ev(pkg, "push_start");
    const fell = ev(pkg, "health_predicate_fired");
    const hit = ev(pkg, "ground_contact");
    const zFloor = Array.isArray(fell?.healthy_z_range_m) ? Number(fell.healthy_z_range_m[0]) : 1;
    const latency = Number(pkg.scenario.control_latency_ms ?? 0);
    const noise = Number(pkg.scenario.actuator_noise_frac ?? 0);
    const causes: string[] = [];
    if (push) causes.push(`a single <span class="mono">${num(push.impulse_ns, 1)} N·s</span> shove on the torso at <span class="mono">${num(push.t_s, 2)} s</span>, held for <span class="mono">${num(push.duration_s, 2)} s</span> from heading <span class="mono">${num(push.heading_deg, 0)}°</span>`);
    if (latency > 0) causes.push(`<span class="mono">${latency} ms</span> of actuation delay — ${Math.round(latency / 15)} control tick${latency === 15 ? "" : "s"} between the action being computed and applied`);
    if (noise > 0) causes.push(`actuator noise at <span class="mono">${num(noise * 100, 0)} %</span> of the control range`);
    if (Number(pkg.scenario.floor_friction) !== 1) causes.push(`floor friction <span class="mono">${num(pkg.scenario.floor_friction, 2)}</span> instead of the shipped 1.00`);
    if (Number(pkg.scenario.body_mass_scale) !== 1) causes.push(`every body mass scaled by <span class="mono">×${num(pkg.scenario.body_mass_scale, 2)}</span>`);
    const cause = causes.length ? `What changed: ${causes.join("; ")}.` : "Nothing outside the published conditions was changed.";
    const fall = fell
      ? ` Gymnasium's own health predicate fired at <span class="mono">${num(fell.t_s, 3)} s</span>, when the torso had dropped to <span class="mono">${num(fell.torso_z_m, 3)} m</span> — below the <span class="mono">${zFloor.toFixed(2)} m</span> floor of the height band the environment calls healthy — moving at <span class="mono">${num(fell.torso_speed_mps, 2)} m/s</span>. This project implements no fall detector of its own: the verdict is the environment's flag.`
      : "";
    const impact = hit
      ? ` It reached the ground <span class="mono">${num(hit.t_s - (fell?.t_s ?? hit.t_s), 3)} s</span> later, ${hit.geom ? `first on the <span class="mono">${esc(String(hit.geom))}</span>, ` : ""}with the torso moving at <span class="mono">${num(hit.torso_impact_speed_mps, 3)} m/s</span>.`
      : "";
    const base = ` The same policy at the published conditions survived the full <span class="mono">${num(m(baseline, "survival_time_s") ?? m(baseline, "duration_s"), 2)} s</span> episode, returning <span class="mono">${num(m(baseline, "episode_return"), 0)}</span> against <span class="mono">${num(m(pkg, "episode_return"), 0)}</span> here.`;
    return `${cause}${fall}${impact}${base}`;
  },

  metrics(baseline, pkg) {
    return [
      ["outcome", m(baseline, "outcome"), m(pkg, "outcome")],
      ["survival time (s)", num(m(baseline, "survival_time_s"), 2), num(m(pkg, "survival_time_s"), 2)],
      ["episode return", num(m(baseline, "episode_return"), 1), num(m(pkg, "episode_return"), 1)],
      ["minimum torso height (m)", num(m(baseline, "torso_min_z_m"), 3), num(m(pkg, "torso_min_z_m"), 3)],
      ["torso height when the predicate fired (m)", "—", num(m(pkg, "torso_z_at_fall_m"), 3)],
      ["fall time (s)", "—", num(m(pkg, "fall_time_s"), 3)],
      ["ground contact (s)", "—", num(m(pkg, "ground_contact_t_s"), 3)],
      ["first geom to hit the floor", "—", m(pkg, "ground_contact_geom") ?? "—"],
      ["torso impact speed (m/s)", "—", num(m(pkg, "torso_impact_speed_mps"), 3)],
      ["peak torso acceleration (m/s²)", "—", num(m(pkg, "peak_torso_accel_mps2"), 2)],
      ["top torso speed (m/s)", num(m(baseline, "torso_max_speed_mps"), 2), num(m(pkg, "torso_max_speed_mps"), 2)],
      ["distance travelled (m)", num(m(baseline, "distance_travelled_x_m"), 2), num(m(pkg, "distance_travelled_x_m"), 2)],
      ["health-predicate cross-check mismatches", m(baseline, "health_predicate_mismatches"), m(pkg, "health_predicate_mismatches")],
    ];
  },

  stats(pkg, baseline, p) {
    const out: (Stat | null)[] = [
      severityTile(p),
      { label: "survived for", value: m(pkg, "survival_time_s"), unit: "s", dec: 2, note: "until the environment called the torso unhealthy" },
      { label: "baseline survived", value: m(baseline, "survival_time_s"), unit: "s", dec: 2, note: "the full episode, at the published conditions" },
      { label: "peak torso acceleration", value: m(pkg, "peak_torso_accel_mps2"), unit: "m/s²", dec: 1, note: "largest control-tick change in torso velocity after the fall" },
    ];
    return out.filter((x): x is Stat => x !== null);
  },
};

const VIEWS: Record<string, TargetView> = { cart: CART, humanoid: HUMANOID };

/** The view for a target id. Anything unknown — including a listing registered before the
 *  marketplace became multi-target — is the cart, which was then the only target. */
export function targetView(id: string | undefined | null): TargetView {
  return VIEWS[String(id ?? "cart")] ?? CART;
}
