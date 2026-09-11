// TARGET REGISTRY — the marketplace is multi-target, and every target-specific fact lives here.
//
// A target is a robot-and-controller pair with its own simulator entry point, its own published
// operating envelope, its own failure classes and its own severity proxy. The seller hunts per
// target; the verifier re-runs per target with the SAME binding rules (environment fingerprint match,
// trajectory hash RECOMPUTED from the delivered frames, a physical-plausibility bound derived from
// that target's own envelope and scene, and INCONCLUSIVE — never VALID — when the environment does
// not match); the buyer filters by target under a budget.
//
// Adding a third target means adding an entry here plus a replay renderer id the client knows: no
// agent, route, ledger row or page needs a special case.
import path from "node:path";
import * as cart from "./envelope.js";
import * as humanoid from "./envelope-humanoid.js";
import * as arm from "./envelope-arm.js";
import * as g1 from "./envelope-g1.js";
import { GRAVITY_MPS2, SIM_POSITION_BOUND_M, timingFrom, type ReplayLimits } from "./plausibility.js";

export type TargetId = "cart" | "humanoid" | "arm" | "g1";
export type Scenario = Record<string, number>;

/** The artefact under test, as the simulator itself hashes it. The verifier binds a claim to this. */
export type Subject = { id: string; hash: string };

/** What a listing claims, in the same shape for every target. `severity_value` is the target's own
 *  severity proxy — an uncalibrated kinematic measurement, never a damage or cost estimate. */
export type Claim = {
  outcome: string;
  failure_class: string;
  severity_proxy: string;
  severity_value: number | null;
  severity_units: string;
  moment_t_s: number | null;
  severity_band: string;
};

export type FailureClassSpec = { id: string; label: string; severity_proxy: string; severity_units: string; detected_by: string };

export type HuntSummary = {
  hunter_id: string;
  mode: string;
  search_cost: { simulations: number; sim_steps: number; wall_time_s: number };
  counts: { simulations: number; failures: number; survived: number; inconclusive: number; by_class: Record<string, number> };
  selected: { scenario: Scenario; outcome: string; failure_classes: string[]; severity_value: number | null; distance_to_nominal: number }[];
  near_duplicates: number;
};

export type EnvelopeDoc = ReturnType<typeof cartEnvelopeDoc>;

export type TargetSpec = {
  id: TargetId;
  /** Marketplace label and the one sentence a visitor reads first. */
  label: string;
  short_label: string;
  machine: string;
  one_liner: string;
  /** What the artefact under test is called on this target ("controller", "policy checkpoint"). */
  subject_noun: string;
  subject_label: string;
  envelope_id: string;
  envelope_yaml: string;
  envelope_doc: EnvelopeDoc;
  /** Simulator entry point: the Python module and the CLI shape the web layer spawns. */
  sim: { module: string; cli: string; hunt_mode: string; hunt_modes: string[]; hunt_n: number; hunt_seed: number; huntFile: (outDir: string, mode: string, seed: number) => string };
  /** Environment fields that must match exactly before a delivered replay can be bound by hash. */
  fingerprint_fields: readonly string[];
  failure_classes: FailureClassSpec[];
  /** Outcomes that are a failure finding, and outcomes that answer the question at all. */
  failure_outcomes: string[];
  conclusive_outcomes: string[];
  severity: { proxy: string; units: string };
  replay_renderer: "cart-3d" | "humanoid-3d" | "arm-3d" | "g1-3d";
  nominal_scenario: Scenario;
  checkAdmissible: (scn: Record<string, unknown>) => string[];
  isDuplicate: (a: Scenario, b: Scenario) => boolean;
  scenarioDistance: (a: Scenario, b: Scenario) => number;
  severityBand: (v: number | null) => { proxy: string; band: string; definition: string };
  /** Where a scenario sits against both published ranges, per axis. POST-PURCHASE ONLY. */
  rangePosition: (scn: Scenario) => { parameter: string; value: number; unit: string; tuned_range: string; in_tuned_range: boolean; searched_envelope: string }[];
  subjectOf: (run: any) => Subject;
  claimFromRun: (run: any) => Claim;
  changedConditions: (scn: Scenario) => { parameter: string; nominal: number; value: number; unit: string }[];
  reproduceCommand: (scn: Scenario) => string;
  replayLimitsFrom: (run: any) => ReplayLimits;
  normalizeHunt: (doc: any) => HuntSummary;
  claimKind: string;
};

// ------------------------------------------------------------------------------- envelope docs
/** The published envelope, identical in shape for every target so one client renders both. */
function cartEnvelopeDoc() {
  return {
    target_id: "cart" as TargetId,
    envelope_id: cart.ENVELOPE_ID,
    yaml: "sim/envelope.yaml (same axis shape as GUARD configs/guard_theta.yaml)",
    axes: cart.ENVELOPE_AXES as unknown as (typeof cart.ENVELOPE_AXES)[number][],
    nominal_scenario: cart.NOMINAL_SCENARIO as unknown as Record<string, number>,
    control_tick_ms: cart.DT_CTRL_MS,
    duplicate_rule: `normalized L-infinity distance < ${cart.DUPLICATE_DISTANCE}`,
    controller_tuned_range: { label: "range the controller was tuned for", verb: "tuned for", unstated: "no tuned range stated for this axis", prose: cart.TUNED_RANGE_PROSE, source: cart.TUNED_RANGE_SOURCE, per_parameter: cart.CONTROLLER_TUNED_RANGE as unknown as Record<string, { min?: number; max?: number; exactly?: number; not_stated?: boolean }> },
    searched_envelope: { prose: cart.SEARCHED_ENVELOPE_PROSE },
    product_question: cart.PRODUCT_QUESTION,
    note: cart.OPERATING_CONTEXT_NOTE,
    distribution: "No distribution D over these axes is stated or estimated. The search is a bounded deterministic grid; adversarially selected failures are not failure frequencies.",
    severity: { proxy: "impact_speed_mps", units: "m/s", definition: cart.severityBand(null).definition },
    failure_classes: [
      { id: "COLLISION", label: "Collision", severity_proxy: "impact_speed_mps", severity_units: "m/s", detected_by: "the simulator's own contact flag between the cart chassis and the obstacle" },
      { id: "LOAD_SHED", label: "Load shed", severity_proxy: "load_rel_speed_mps", severity_units: "m/s", detected_by: "the simulator's own slip criterion between the payload and the cart deck" },
    ],
    verdicts: { VALID: "re-simulated and bound to the delivered evidence", INVALID: "rejected (not reproducible, out of envelope, duplicate, or evidence not bound to the verified run)", INCONCLUSIVE: "numerical divergence, an environment the verifier cannot match, or metrics outside tolerance; never pays" },
  };
}

function humanoidEnvelopeDoc(): ReturnType<typeof cartEnvelopeDoc> {
  return {
    target_id: "humanoid" as TargetId,
    envelope_id: humanoid.ENVELOPE_ID,
    yaml: "sim/envelope-humanoid.yaml (same axis shape as GUARD configs/guard_theta.yaml)",
    axes: humanoid.ENVELOPE_AXES as unknown as (typeof cart.ENVELOPE_AXES)[number][],
    nominal_scenario: humanoid.NOMINAL_SCENARIO as unknown as Record<string, number>,
    control_tick_ms: humanoid.DT_CTRL_MS,
    duplicate_rule: humanoid.DUPLICATE_RULE_PROSE,
    controller_tuned_range: { label: "conditions the policy's publisher evaluated it under", verb: "published at", unstated: "the publisher states nothing about this axis", prose: humanoid.PUBLISHED_CONDITIONS_PROSE, source: humanoid.PUBLISHED_CONDITIONS_SOURCE, per_parameter: humanoid.PUBLISHED_CONDITIONS },
    searched_envelope: { prose: humanoid.SEARCHED_ENVELOPE_PROSE },
    product_question: humanoid.PRODUCT_QUESTION,
    note: humanoid.OPERATING_CONTEXT_NOTE,
    distribution: "No distribution D over these axes is stated or estimated. The search is a bounded deterministic grid; adversarially selected failures are not failure frequencies.",
    severity: { proxy: "torso_impact_speed_mps", units: "m/s", definition: humanoid.SEVERITY_BAND_DEFINITION },
    failure_classes: [
      { id: "FELL", label: "Fell", severity_proxy: "torso_impact_speed_mps", severity_units: "m/s", detected_by: "Gymnasium's own health predicate: HumanoidEnv terminates when the torso height leaves healthy_z_range (1.0-2.0 m). This project implements no fall detector." },
    ],
    verdicts: { VALID: "re-simulated and bound to the delivered evidence", INVALID: "rejected (not reproducible, out of envelope, duplicate, or evidence not bound to the verified run)", INCONCLUSIVE: "numerical divergence, an environment the verifier cannot match, or metrics outside tolerance; never pays" },
  };
}

function armEnvelopeDoc(): ReturnType<typeof cartEnvelopeDoc> {
  return {
    target_id: "arm" as TargetId,
    envelope_id: arm.ENVELOPE_ID,
    yaml: "sim/envelope-arm.yaml (same axis shape as GUARD configs/guard_theta.yaml)",
    axes: arm.ENVELOPE_AXES as unknown as (typeof cart.ENVELOPE_AXES)[number][],
    nominal_scenario: arm.NOMINAL_SCENARIO as unknown as Record<string, number>,
    control_tick_ms: arm.DT_CTRL_MS,
    duplicate_rule: arm.DUPLICATE_RULE_PROSE,
    controller_tuned_range: { label: "conditions the policy's publisher evaluated it under", verb: "published at", unstated: "the publisher states nothing about this axis", prose: arm.PUBLISHED_CONDITIONS_PROSE, source: arm.PUBLISHED_CONDITIONS_SOURCE, per_parameter: arm.PUBLISHED_CONDITIONS },
    searched_envelope: { prose: arm.SEARCHED_ENVELOPE_PROSE },
    product_question: arm.PRODUCT_QUESTION,
    note: arm.OPERATING_CONTEXT_NOTE,
    distribution: "No distribution D over these axes is stated or estimated. The search is a bounded deterministic grid; adversarially selected failures are not failure frequencies.",
    severity: { proxy: "object_impact_speed_mps", units: "m/s", definition: arm.SEVERITY_BAND_DEFINITION },
    failure_classes: [
      { id: "DROPPED", label: "Dropped", severity_proxy: "object_impact_speed_mps", severity_units: "m/s", detected_by: `a mechanical predicate over MuJoCo's OWN contact list: the block was touching both gripper pads and was more than ${arm.AIRBORNE_MARGIN_M} m above the table, then was not, and was not at the goal — confirmed over three further ticks, so one momentary lost contact while the part is still pinched is never sold as a drop. This is the one predicate this project owns: the environment scores placement, not custody.` },
      { id: "NOT_PLACED", label: "Not placed", severity_proxy: "none", severity_units: "", detected_by: "Gymnasium-Robotics' own success flag: info[\"is_success\"] is false at the environment's own episode horizon, with no drop on the way. This project implements no placement detector. This class has no severity proxy: nothing was dropped and nothing hit anything." },
    ],
    verdicts: { VALID: "re-simulated and bound to the delivered evidence", INVALID: "rejected (not reproducible, out of envelope, duplicate, or evidence not bound to the verified run)", INCONCLUSIVE: "numerical divergence, an environment the verifier cannot match, or metrics outside tolerance; never pays" },
  };
}

function g1EnvelopeDoc(): ReturnType<typeof cartEnvelopeDoc> {
  return {
    target_id: "g1" as TargetId,
    envelope_id: g1.ENVELOPE_ID,
    yaml: "sim/envelope-g1.yaml (same axis shape as GUARD configs/guard_theta.yaml)",
    axes: g1.ENVELOPE_AXES as unknown as (typeof cart.ENVELOPE_AXES)[number][],
    nominal_scenario: g1.NOMINAL_SCENARIO as unknown as Record<string, number>,
    control_tick_ms: g1.DT_CTRL_MS,
    duplicate_rule: g1.DUPLICATE_RULE_PROSE,
    controller_tuned_range: { label: "the publisher's own deployment configuration", verb: "deployed at", unstated: "the publisher states nothing about this axis", prose: g1.PUBLISHED_CONDITIONS_PROSE, source: g1.PUBLISHED_CONDITIONS_SOURCE, per_parameter: g1.PUBLISHED_CONDITIONS },
    searched_envelope: { prose: g1.SEARCHED_ENVELOPE_PROSE },
    product_question: g1.PRODUCT_QUESTION,
    note: g1.OPERATING_CONTEXT_NOTE,
    distribution: "No distribution D over these axes is stated or estimated. The search is a bounded deterministic grid; adversarially selected failures are not failure frequencies.",
    severity: { proxy: "pelvis_impact_speed_mps", units: "m/s", definition: g1.SEVERITY_BAND_DEFINITION },
    failure_classes: [
      { id: "FELL", label: "Fell", severity_proxy: "pelvis_impact_speed_mps", severity_units: "m/s", detected_by: `THIS PROJECT'S predicate, stated because Unitree's runner has no fall flag of its own: FELL when the pelvis drops below ${g1.FALL_Z_M} m (${g1.FALL_HEIGHT_FRACTION} x the measured nominal standing height of ${g1.NOMINAL_PELVIS_Z_M} m) or tilts more than ${g1.FALL_TILT_DEG} degrees from vertical, whichever first, checked every 20 ms control tick; the run document records which condition fired and when.` },
    ],
    verdicts: { VALID: "re-simulated and bound to the delivered evidence", INVALID: "rejected (not reproducible, out of envelope, duplicate, or evidence not bound to the verified run)", INCONCLUSIVE: "numerical divergence, an environment the verifier cannot match, or metrics outside tolerance; never pays" },
  };
}

// --------------------------------------------------------------------------------- hunt shapes
const FAILURE_COUNT_KEYS = ["any_failure", "collision", "fell", "load_shed", "dropped"];

function normalizeHunt(doc: any, severityProxy: string, failureClasses: string[]): HuntSummary {
  const cost = doc?.search_cost ?? {};
  const counts = (doc?.counts ?? {}) as Record<string, number>;
  const simulations = Number(cost.simulations ?? 0);
  const inconclusive = Number(counts.inconclusive ?? 0);
  const failures = Number(counts.any_failure ?? FAILURE_COUNT_KEYS.map((k) => counts[k]).find((v) => typeof v === "number") ?? 0);
  const survived = Number(counts.success ?? counts.survived ?? Math.max(simulations - failures - inconclusive, 0));
  // Count each class over the hunt's OWN run list, so "N simulations, K produced this class" is a
  // count of runs and never an inference from the summary counters.
  const runs: any[] = Array.isArray(doc?.runs) ? doc.runs : [];
  const by_class: Record<string, number> = {};
  for (const c of failureClasses) {
    by_class[c] = runs.filter((r) => (Array.isArray(r?.failure_classes) ? r.failure_classes.includes(c) : r?.outcome === c)).length;
  }
  const selected = (Array.isArray(doc?.selected) ? doc.selected : []).map((s: any) => ({
    scenario: s.scenario as Scenario,
    outcome: String(s.outcome ?? ""),
    failure_classes: Array.isArray(s.failure_classes) && s.failure_classes.length ? s.failure_classes.map(String) : [String(s.outcome ?? "")],
    severity_value: typeof s[severityProxy] === "number" ? (s[severityProxy] as number) : null,
    distance_to_nominal: Number(s.distance_to_nominal ?? 0),
  }));
  return {
    hunter_id: String(doc?.hunter_id ?? "unknown"),
    mode: String(doc?.mode ?? "unknown"),
    search_cost: { simulations, sim_steps: Number(cost.sim_steps ?? 0), wall_time_s: Number(cost.wall_time_s ?? 0) },
    counts: { simulations, failures, survived, inconclusive, by_class },
    selected,
    near_duplicates: Array.isArray(doc?.near_duplicates) ? doc.near_duplicates.length : 0,
  };
}

// ------------------------------------------------------------------------------------- targets
const CART_ENVELOPE = cartEnvelopeDoc();
const HUMANOID_ENVELOPE = humanoidEnvelopeDoc();
const ARM_ENVELOPE = armEnvelopeDoc();

const CART: TargetSpec = {
  id: "cart",
  label: "Warehouse cart",
  short_label: "Cart",
  machine: "a braking warehouse cart carrying a payload",
  one_liner: "A warehouse cart is supposed to stop short of an obstacle. It can hit the obstacle, or shed its load under braking.",
  subject_noun: "controller",
  subject_label: "Controller",
  envelope_id: cart.ENVELOPE_ID,
  envelope_yaml: "sim/envelope.yaml",
  envelope_doc: CART_ENVELOPE,
  sim: {
    module: "tailbazaar_sim.cli",
    cli: "uv run python -m tailbazaar_sim.cli --out DIR run|hunt|nominal ...",
    hunt_mode: "grid",
    hunt_modes: ["grid", "grid-load", "random"],
    hunt_n: 40,
    hunt_seed: 1,
    huntFile: (outDir, mode, seed) => path.join(outDir, mode.startsWith("grid") ? `hunt-${mode}.json` : `hunt-random-seed${seed}.json`),
  },
  fingerprint_fields: ["engine", "engine_version", "numpy_version", "python_version", "platform", "integrator", "physics_timestep_s", "control_dt_s", "substeps_per_tick", "threads", "uv_lock_sha256"],
  failure_classes: CART_ENVELOPE.failure_classes,
  failure_outcomes: ["COLLISION", "LOAD_SHED"],
  conclusive_outcomes: ["COLLISION", "SUCCESS", "LOAD_SHED"],
  severity: { proxy: "impact_speed_mps", units: "m/s" },
  replay_renderer: "cart-3d",
  nominal_scenario: cart.NOMINAL_SCENARIO as unknown as Scenario,
  checkAdmissible: cart.checkAdmissible,
  isDuplicate: (a, b) => cart.isDuplicate(a as cart.Scenario, b as cart.Scenario),
  scenarioDistance: (a, b) => cart.scenarioDistance(a as cart.Scenario, b as cart.Scenario),
  severityBand: cart.severityBand,
  rangePosition: (scn) => cart.rangePosition(scn as cart.Scenario),
  subjectOf: (run) => ({ id: String(run?.controller?.id ?? ""), hash: String(run?.controller?.hash ?? "") }),
  claimFromRun: (run) => {
    const m = (run?.metrics ?? {}) as Record<string, unknown>;
    const value = typeof m.impact_speed_mps === "number" ? m.impact_speed_mps : null;
    return {
      outcome: String(run?.outcome ?? "UNKNOWN"),
      failure_class: String(m.primary_failure_class ?? run?.outcome ?? "UNKNOWN"),
      severity_proxy: "impact_speed_mps",
      severity_value: value,
      severity_units: "m/s",
      moment_t_s: typeof m.first_contact_t_s === "number" ? m.first_contact_t_s : null,
      severity_band: cart.severityBand(value).band,
    };
  },
  changedConditions: (scn) =>
    (Object.keys(cart.ENVELOPE) as (keyof cart.Scenario)[])
      .filter((k) => scn[k] !== (cart.NOMINAL_SCENARIO as Record<string, number>)[k])
      .map((k) => ({ parameter: String(k), nominal: (cart.NOMINAL_SCENARIO as Record<string, number>)[k], value: Number(scn[k]), unit: cart.ENVELOPE[k].unit })),
  reproduceCommand: (scn) => `uv run python -m tailbazaar_sim.cli --out OUT run --name finding --scenario '${JSON.stringify(scn)}'`,
  /** Speed ceiling. Nothing in this scene is propelled except through contact with the floor, so the
   *  largest acceleration any body can sustain is bounded by gravity plus the largest tangential force
   *  the floor can transmit, mu_max * m * g, with mu_max the top of the PUBLISHED floor_friction axis.
   *  Starting from rest, a body accelerating at a_max over the longest straight line the simulator
   *  tolerates before it calls the run DIVERGED reaches sqrt(2 * a_max * 100 m); a body falling from
   *  the tallest structure in the scene adds sqrt(2 * g * h). An honest run peaks near its 2 m/s
   *  cruise, thirty times below; a fabricated 100 m jump in one tick implies 5000 m/s, seventy-five
   *  times above. Nothing physical sits in between. */
  replayLimitsFrom: (run) => {
    const half = run?.scene?.obstacle_half_m;
    const hMax = Array.isArray(half) && Number.isFinite(Number(half[2])) ? 2 * Number(half[2]) : 1.0;
    const muMax = cart.ENVELOPE.floor_friction.max;
    const aMax = (1 + muMax) * GRAVITY_MPS2;
    const ceiling = Math.sqrt(2 * aMax * SIM_POSITION_BOUND_M) + Math.sqrt(2 * GRAVITY_MPS2 * hMax);
    const { dt_s, max_span_s } = timingFrom(run ?? {}, 0.02, 10);
    return {
      dt_s, max_span_s,
      speed_ceiling_mps: ceiling,
      position_bound_m: SIM_POSITION_BOUND_M,
      // Prose only, no envelope parameter identifiers: this string reaches the public delivery record.
      derivation: `sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_obstacle) with mu_max=${muMax} (largest surface friction the published envelope admits), g=${GRAVITY_MPS2} m/s^2, d_max=${SIM_POSITION_BOUND_M} m (the simulator's divergence bound) and h_obstacle=${hMax} m (the scene's tallest structure)`,
    };
  },
  normalizeHunt: (doc) => normalizeHunt(doc, "impact_speed_mps", ["COLLISION", "LOAD_SHED"]),
  claimKind: "controller collides with the obstacle under admissible conditions inside the published envelope",
};

/** Tallest point on the humanoid above its torso origin, from the MJCF geometry the run publishes:
 *  the head sphere's centre offset plus its radius. Read off `scene.render_bodies` when present. */
function humanoidHeadReachM(run: any): number {
  const prims: any[] = Array.isArray(run?.scene?.render_bodies) ? run.scene.render_bodies : [];
  let reach = 0;
  for (const p of prims) {
    if (p?.body !== "torso") continue;
    const z = Number(p?.pos_m?.[2] ?? 0);
    const r = Number(p?.radius_m ?? 0) + Number(p?.half_length_m ?? 0);
    if (Number.isFinite(z) && Number.isFinite(r)) reach = Math.max(reach, z + r);
  }
  return reach > 0 ? reach : 0.28;
}

const HUMANOID: TargetSpec = {
  id: "humanoid",
  label: "Humanoid balance policy",
  short_label: "Humanoid",
  machine: "a 42 kg humanoid walking under a pretrained balance policy",
  one_liner: "A pretrained humanoid policy is supposed to keep walking. A shove, a slippery floor or one tick of actuation delay can put it on the floor.",
  subject_noun: "policy checkpoint",
  subject_label: "Policy",
  envelope_id: humanoid.ENVELOPE_ID,
  envelope_yaml: "sim/envelope-humanoid.yaml",
  envelope_doc: HUMANOID_ENVELOPE,
  sim: {
    module: "tailbazaar_sim.humanoid.cli",
    cli: "uv run python -m tailbazaar_sim.humanoid.cli --out DIR run|hunt|nominal|repeat ...",
    hunt_mode: "grid-push",
    hunt_modes: ["grid-push", "grid-systems", "grid-terrain", "random"],
    hunt_n: 60,
    hunt_seed: 7,
    huntFile: (outDir, mode, seed) => path.join(outDir, `hunt-${mode}${mode.startsWith("grid") ? "" : `-seed${seed}`}.json`),
  },
  fingerprint_fields: ["engine", "engine_version", "gymnasium_version", "numpy_version", "python_version", "platform", "physics_timestep_s", "control_dt_s", "frame_skip", "threads", "policy_backend", "uv_lock_sha256"],
  failure_classes: HUMANOID_ENVELOPE.failure_classes,
  failure_outcomes: ["FELL"],
  conclusive_outcomes: ["FELL", "SURVIVED"],
  severity: { proxy: "torso_impact_speed_mps", units: "m/s" },
  replay_renderer: "humanoid-3d",
  nominal_scenario: humanoid.NOMINAL_SCENARIO as unknown as Scenario,
  checkAdmissible: humanoid.checkAdmissible,
  isDuplicate: humanoid.isDuplicate,
  scenarioDistance: humanoid.scenarioDistance,
  severityBand: humanoid.severityBand,
  rangePosition: humanoid.rangePosition,
  // The policy is pinned by digest and checked at load time, so the actor-tensor sha256 is what a
  // claim is bound to: a real failure of one checkpoint cannot be sold under another one's name.
  subjectOf: (run) => ({ id: String(run?.target?.policy?.policy_id ?? run?.target_id ?? ""), hash: String(run?.target?.policy?.actor_tensor_sha256 ?? "") }),
  claimFromRun: (run) => {
    const m = (run?.metrics ?? {}) as Record<string, unknown>;
    const sev = run?.severity as { value?: unknown } | null | undefined;
    const value = typeof sev?.value === "number" ? sev.value : typeof m.torso_impact_speed_mps === "number" ? (m.torso_impact_speed_mps as number) : null;
    return {
      outcome: String(run?.outcome ?? "UNKNOWN"),
      failure_class: String(m.primary_failure_class ?? run?.outcome ?? "UNKNOWN"),
      severity_proxy: "torso_impact_speed_mps",
      severity_value: value,
      severity_units: "m/s",
      moment_t_s: typeof m.fall_time_s === "number" ? (m.fall_time_s as number) : null,
      severity_band: humanoid.severityBand(value).band,
    };
  },
  changedConditions: (scn) =>
    (humanoid.PARAM_ORDER as readonly string[])
      .filter((k) => Number(scn[k]) !== Number((humanoid.NOMINAL_SCENARIO as Record<string, number>)[k]))
      .map((k) => ({ parameter: k, nominal: (humanoid.NOMINAL_SCENARIO as Record<string, number>)[k], value: Number(scn[k]), unit: k === "init_seed" ? "1" : humanoid.ENVELOPE[k].unit })),
  reproduceCommand: (scn) => `uv run python -m tailbazaar_sim.humanoid.cli --out OUT run --name finding --scenario '${JSON.stringify(scn)}'`,
  /** Speed ceiling, same construction as the cart's, with this target's own numbers. Three terms, all
   *  read off the published envelope and the scene the run itself carries:
   *    - the largest velocity change the push axis can impart: J_max / (m_total * mass_scale_min);
   *    - the fastest a body can be moving after accelerating at a_max = (1 + mu_max) * g over the
   *      longest straight line the simulator tolerates before calling the run DIVERGED (100 m);
   *    - a free fall from the tallest the body can be while the torso is still inside Gymnasium's
   *      healthy band: the top of healthy_z_range plus the head's reach above the torso origin.
   *  The measured peak in an honest fall is about 4.5 m/s, roughly eighteen times below the ceiling;
   *  a teleport of one body length inside one 30 ms frame already implies more than 50 m/s. */
  replayLimitsFrom: (run) => {
    const scene = run?.scene ?? {};
    const mass = Number.isFinite(Number(scene.total_mass_kg)) ? Number(scene.total_mass_kg) : 42.116;
    const zHigh = Number.isFinite(Number(scene.healthy_z_range_m?.[1])) ? Number(scene.healthy_z_range_m[1]) : 2.0;
    const head = humanoidHeadReachM(run);
    const muMax = humanoid.ENVELOPE.floor_friction.max;
    const jMax = humanoid.ENVELOPE.push_impulse_ns.max;
    const scaleMin = humanoid.ENVELOPE.body_mass_scale.min;
    const dvPush = jMax / (mass * scaleMin);
    const aMax = (1 + muMax) * GRAVITY_MPS2;
    const hStand = zHigh + head;
    const ceiling = dvPush + Math.sqrt(2 * aMax * SIM_POSITION_BOUND_M) + Math.sqrt(2 * GRAVITY_MPS2 * hStand);
    const { dt_s, max_span_s } = timingFrom(run ?? {}, 0.03, 15);
    return {
      dt_s, max_span_s,
      speed_ceiling_mps: ceiling,
      position_bound_m: SIM_POSITION_BOUND_M,
      derivation: `J_max/(m*s_min) + sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_stand) with J_max=${jMax} N*s (largest impulse the published envelope admits), m=${mass} kg and s_min=${scaleMin} (lightest admissible body), mu_max=${muMax} (largest surface friction the envelope admits), g=${GRAVITY_MPS2} m/s^2, d_max=${SIM_POSITION_BOUND_M} m (the simulator's divergence bound) and h_stand=${hStand.toFixed(2)} m (top of the environment's healthy height band plus the head's reach above the torso)`,
    };
  },
  normalizeHunt: (doc) => normalizeHunt(doc, "torso_impact_speed_mps", ["FELL"]),
  claimKind: "the balance policy falls over under admissible conditions inside the published envelope",
};

const ARM: TargetSpec = {
  id: "arm",
  label: "Manipulator pick-and-place policy",
  short_label: "Arm",
  machine: "a Fetch arm picking a 5 cm block off a table under a pretrained policy",
  one_liner: "A pretrained pick-and-place policy is supposed to put the part on the goal. A slippery part, a heavy one, noise or a late gripper can make it let go in mid-air — or never place it at all.",
  subject_noun: "policy checkpoint",
  subject_label: "Policy",
  envelope_id: arm.ENVELOPE_ID,
  envelope_yaml: "sim/envelope-arm.yaml",
  envelope_doc: ARM_ENVELOPE,
  sim: {
    module: "tailbazaar_sim.arm.cli",
    cli: "uv run python -m tailbazaar_sim.arm.cli --out DIR run|hunt|nominal|repeat|policy|selfcheck ...",
    hunt_mode: "grid-grip",
    hunt_modes: ["grid-grip", "grid-payload", "grid-systems", "grid-placement", "random"],
    hunt_n: 60,
    hunt_seed: 1,
    huntFile: (outDir, mode, seed) => path.join(outDir, `hunt-${mode}${mode.startsWith("grid") ? "" : `-seed${seed}`}.json`),
  },
  fingerprint_fields: ["engine", "engine_version", "gymnasium_version", "gymnasium_robotics_version", "numpy_version", "python_version", "platform", "physics_timestep_s", "control_dt_s", "n_substeps", "threads", "policy_backend", "uv_lock_sha256"],
  failure_classes: ARM_ENVELOPE.failure_classes,
  failure_outcomes: ["DROPPED", "NOT_PLACED"],
  conclusive_outcomes: ["SUCCESS", "DROPPED", "NOT_PLACED"],
  severity: { proxy: "object_impact_speed_mps", units: "m/s" },
  replay_renderer: "arm-3d",
  nominal_scenario: arm.NOMINAL_SCENARIO as unknown as Scenario,
  checkAdmissible: arm.checkAdmissible,
  isDuplicate: arm.isDuplicate,
  scenarioDistance: arm.scenarioDistance,
  severityBand: arm.severityBand,
  rangePosition: arm.rangePosition,
  // The checkpoint is pinned by digest and every digest is checked at load time, so the actor-tensor
  // sha256 over exactly the six tensors used for control is what a claim is bound to.
  subjectOf: (run) => ({ id: String(run?.target?.policy_id ?? run?.target_id ?? ""), hash: String(run?.target?.actor_tensor_sha256 ?? "") }),
  claimFromRun: (run) => {
    const m = (run?.metrics ?? {}) as Record<string, unknown>;
    const sev = run?.severity as { value?: unknown } | null | undefined;
    // NOT_PLACED has no severity proxy on purpose: nothing was dropped and nothing hit anything, so
    // the value stays null rather than becoming an invented stand-in.
    const value = typeof sev?.value === "number" ? sev.value : typeof m.object_impact_speed_mps === "number" ? (m.object_impact_speed_mps as number) : null;
    return {
      outcome: String(run?.outcome ?? "UNKNOWN"),
      failure_class: String(m.primary_failure_class ?? run?.outcome ?? "UNKNOWN"),
      severity_proxy: "object_impact_speed_mps",
      severity_value: value,
      severity_units: "m/s",
      moment_t_s: typeof m.drop_t_s === "number" ? (m.drop_t_s as number) : null,
      severity_band: arm.severityBand(value).band,
    };
  },
  changedConditions: (scn) =>
    (arm.PARAM_ORDER as readonly string[])
      .filter((k) => Number(scn[k]) !== Number((arm.NOMINAL_SCENARIO as Record<string, number>)[k]))
      .map((k) => ({ parameter: k, nominal: (arm.NOMINAL_SCENARIO as Record<string, number>)[k], value: Number(scn[k]), unit: k === "init_seed" ? "1" : arm.ENVELOPE[k].unit })),
  reproduceCommand: (scn) => `uv run python -m tailbazaar_sim.arm.cli --out OUT run --name finding --scenario '${JSON.stringify(scn)}'`,
  /** Speed ceiling, the cart's construction with this scene's own numbers — and it is the cart's
   *  construction because this scene has the cart's shape: nothing here is propelled except through
   *  contact with a surface (the arm is dragged to a mocap target, the part is a free body). So the
   *  largest acceleration any body can sustain is bounded by gravity plus the largest tangential force
   *  a contact can transmit, mu_max * m * g, with mu_max the top of the PUBLISHED contact-friction
   *  axis; a body accelerating at that over the longest straight line the simulator tolerates before
   *  it calls the run DIVERGED reaches sqrt(2 * a_max * 100 m), and a fall from the only raised
   *  surface in the scene adds sqrt(2 * g * h_table). An honest drop peaks near 3 m/s, twenty-four
   *  times below; a teleport of one block width inside one 40 ms frame already implies 1.25 m/s and a
   *  fabricated 100 m jump implies 2500 m/s. Nothing physical sits in between. */
  replayLimitsFrom: (run) => {
    const scene = (run?.scene ?? {}) as Record<string, unknown>;
    const rules = (run?.termination_rules ?? {}) as Record<string, unknown>;
    const hTable = Number.isFinite(Number(scene.table_top_z_m)) ? Number(scene.table_top_z_m) : arm.TABLE_TOP_Z_M;
    const muMax = arm.ENVELOPE.grip_friction.max;
    const aMax = (1 + muMax) * GRAVITY_MPS2;
    const ceiling = Math.sqrt(2 * aMax * SIM_POSITION_BOUND_M) + Math.sqrt(2 * GRAVITY_MPS2 * hTable);
    // This target's horizon and post-drop settle window are counted in CONTROL TICKS by the
    // environment and the simulator, not in seconds, so the longest a conclusive recording can last is
    // read off those two counts rather than off a t_max_s the arm never publishes.
    const dt_s = Number(run?.frames?.dt_s) > 0 ? Number(run.frames.dt_s) : arm.DT_CTRL_MS / 1000;
    const horizon = Number.isFinite(Number(rules.episode_horizon_ticks)) ? Number(rules.episode_horizon_ticks) : arm.EPISODE_HORIZON_TICKS;
    const settle = Number.isFinite(Number(rules.settle_ticks_max)) ? Number(rules.settle_ticks_max) : arm.SETTLE_TICKS_MAX;
    const guard = Number.isFinite(Number(rules.divergence_guard_mps)) ? Number(rules.divergence_guard_mps) : 50;
    // The Fetch scene carries one body MuJoCo POSES rather than integrates: the mocap weld target the
    // environment drags the gripper to. It is teleported, so its frame-to-frame displacement is not a
    // trajectory and no speed ceiling means anything for it. It is identified from the run's OWN
    // geometry — a body every one of whose published primitives is a visual marker, i.e. collides
    // with nothing — and never from a hard-coded name.
    const prims: any[] = Array.isArray(scene.render_bodies) ? (scene.render_bodies as any[]) : [];
    const roles = new Map<string, Set<string>>();
    for (const p of prims) {
      if (!p?.body) continue;
      if (!roles.has(p.body)) roles.set(p.body, new Set());
      roles.get(p.body)!.add(String(p.role ?? "collision"));
    }
    const posed = [...roles].filter(([, r]) => !r.has("collision")).map(([b]) => b).sort();
    return {
      dt_s,
      max_span_s: (horizon + settle + 1) * dt_s,
      speed_ceiling_mps: ceiling,
      position_bound_m: SIM_POSITION_BOUND_M,
      unchecked_speed_bodies: posed,
      // Prose only, no envelope parameter identifiers: this string reaches the public delivery record.
      derivation: `sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_table) with mu_max=${muMax} (the largest contact friction the published envelope admits, written on the part and on both gripper pads), g=${GRAVITY_MPS2} m/s^2, d_max=${SIM_POSITION_BOUND_M} m (the simulator's divergence bound) and h_table=${hTable} m (the only raised surface in this scene; the floor plane is at z = 0). The simulator independently ends a run as DIVERGED once the carried part exceeds ${guard} m/s, so no conclusive run can contain one faster than that either`,
    };
  },
  normalizeHunt: (doc) => normalizeHunt(doc, "object_impact_speed_mps", ["DROPPED", "NOT_PLACED"]),
  claimKind: "the pick-and-place policy drops the part, or fails to place it, under admissible conditions inside the published envelope",
};

const G1_ENVELOPE = g1EnvelopeDoc();

const G1: TargetSpec = {
  id: "g1",
  label: "Unitree G1 walking policy",
  short_label: "G1",
  machine: "a 32 kg Unitree G1 humanoid walking under Unitree's own pretrained policy",
  one_liner: "Unitree's pretrained G1 walking policy is supposed to keep walking. A sideways shove or four control ticks of actuation delay can put it on the floor.",
  subject_noun: "policy checkpoint",
  subject_label: "Policy",
  envelope_id: g1.ENVELOPE_ID,
  envelope_yaml: "sim/envelope-g1.yaml",
  envelope_doc: G1_ENVELOPE,
  sim: {
    module: "tailbazaar_sim.g1.cli",
    cli: "uv run python -m tailbazaar_sim.g1.cli --out DIR run|hunt|nominal|repeat|policy|selfcheck ...",
    hunt_mode: "grid-push",
    hunt_modes: ["grid-push", "grid-systems", "grid-terrain", "random"],
    hunt_n: 60,
    hunt_seed: 7,
    huntFile: (outDir, mode, seed) => path.join(outDir, `hunt-${mode}${mode.startsWith("grid") ? "" : `-seed${seed}`}.json`),
  },
  fingerprint_fields: ["engine", "engine_version", "torch_version", "numpy_version", "python_version", "platform", "physics_timestep_s", "control_dt_s", "control_decimation", "threads", "policy_backend", "uv_lock_sha256"],
  failure_classes: G1_ENVELOPE.failure_classes,
  failure_outcomes: ["FELL"],
  conclusive_outcomes: ["FELL", "SURVIVED"],
  severity: { proxy: "pelvis_impact_speed_mps", units: "m/s" },
  replay_renderer: "g1-3d",
  nominal_scenario: g1.NOMINAL_SCENARIO as unknown as Scenario,
  checkAdmissible: g1.checkAdmissible,
  isDuplicate: g1.isDuplicate,
  scenarioDistance: g1.scenarioDistance,
  severityBand: g1.severityBand,
  rangePosition: g1.rangePosition,
  // The policy is one TorchScript file pinned by digest and checked at load time, so the sha256 of
  // those bytes is what a claim is bound to: a real fall of one checkpoint cannot be sold under another.
  subjectOf: (run) => ({ id: String(run?.target?.policy?.policy_id ?? run?.target_id ?? ""), hash: String(run?.target?.policy?.policy_file_sha256 ?? "") }),
  claimFromRun: (run) => {
    const m = (run?.metrics ?? {}) as Record<string, unknown>;
    const sev = run?.severity as { value?: unknown } | null | undefined;
    const value = typeof sev?.value === "number" ? sev.value : typeof m.pelvis_impact_speed_mps === "number" ? (m.pelvis_impact_speed_mps as number) : null;
    return {
      outcome: String(run?.outcome ?? "UNKNOWN"),
      failure_class: String(m.primary_failure_class ?? run?.outcome ?? "UNKNOWN"),
      severity_proxy: "pelvis_impact_speed_mps",
      severity_value: value,
      severity_units: "m/s",
      moment_t_s: typeof m.fall_time_s === "number" ? (m.fall_time_s as number) : null,
      severity_band: g1.severityBand(value).band,
    };
  },
  changedConditions: (scn) =>
    (g1.PARAM_ORDER as readonly string[])
      .filter((k) => Number(scn[k]) !== Number((g1.NOMINAL_SCENARIO as Record<string, number>)[k]))
      .map((k) => ({ parameter: k, nominal: (g1.NOMINAL_SCENARIO as Record<string, number>)[k], value: Number(scn[k]), unit: g1.ENVELOPE[k].unit })),
  reproduceCommand: (scn) => `uv run python -m tailbazaar_sim.g1.cli --out OUT run --name finding --scenario '${JSON.stringify(scn)}'`,
  /** Speed ceiling, the humanoid's construction with this scene's own numbers: the largest velocity
   *  change the push axis can impart to the lightest admissible body, plus the fastest anything can be
   *  moving after accelerating at (1 + mu_max) g over the simulator's 100 m divergence bound, plus a
   *  free fall from the top of the standing robot (the publisher's 0.793 m pelvis height plus the head's
   *  reach above the pelvis, both read off the run's own scene block). About 76 m/s; an honest fall
   *  peaks near 4 m/s, and a teleport of one body length inside one 20 ms frame implies more than 60. */
  replayLimitsFrom: (run) => {
    const scene = (run?.scene ?? {}) as Record<string, unknown>;
    const mass = Number.isFinite(Number(scene.total_mass_kg)) ? Number(scene.total_mass_kg) : g1.TOTAL_MASS_KG;
    const z0 = Number.isFinite(Number(scene.pelvis_z0_m)) ? Number(scene.pelvis_z0_m) : g1.PELVIS_Z0_M;
    const head = Number.isFinite(Number(scene.head_reach_above_pelvis_m)) ? Number(scene.head_reach_above_pelvis_m) : g1.HEAD_REACH_ABOVE_PELVIS_M;
    const muMax = g1.ENVELOPE.floor_friction.max;
    const jMax = g1.ENVELOPE.push_impulse_ns.max;
    const scaleMin = g1.ENVELOPE.body_mass_scale.min;
    const dvPush = jMax / (mass * scaleMin);
    const aMax = (1 + muMax) * GRAVITY_MPS2;
    const hStand = z0 + head;
    const ceiling = dvPush + Math.sqrt(2 * aMax * SIM_POSITION_BOUND_M) + Math.sqrt(2 * GRAVITY_MPS2 * hStand);
    const { dt_s, max_span_s } = timingFrom(run ?? {}, 0.02, 15);
    return {
      dt_s, max_span_s,
      speed_ceiling_mps: ceiling,
      position_bound_m: SIM_POSITION_BOUND_M,
      derivation: `J_max/(m*s_min) + sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_stand) with J_max=${jMax} N*s (largest impulse the published envelope admits), m=${mass} kg and s_min=${scaleMin} (lightest admissible body), mu_max=${muMax} (largest surface friction the envelope admits), g=${GRAVITY_MPS2} m/s^2, d_max=${SIM_POSITION_BOUND_M} m (the simulator's divergence bound) and h_stand=${hStand.toFixed(3)} m (the publisher's initial pelvis height plus the head's reach above the pelvis, both from the run's own scene)`,
    };
  },
  normalizeHunt: (doc) => normalizeHunt(doc, "pelvis_impact_speed_mps", ["FELL"]),
  claimKind: "the walking policy falls over under admissible conditions inside the published envelope",
};

export const TARGETS: Record<TargetId, TargetSpec> = { cart: CART, humanoid: HUMANOID, arm: ARM, g1: G1 };
export const TARGET_IDS: TargetId[] = ["cart", "humanoid", "arm", "g1"];
export const DEFAULT_TARGET: TargetId = "cart";

export function isTargetId(x: unknown): x is TargetId {
  return typeof x === "string" && (TARGET_IDS as string[]).includes(x);
}

/** The target a document belongs to. Records written before the registry existed carry no target id
 *  and are the cart, which is the only target that existed then. */
export function targetFor(id: unknown): TargetSpec {
  return isTargetId(id) ? TARGETS[id] : TARGETS[DEFAULT_TARGET];
}

export function targetByEnvelopeId(envelopeId: unknown): TargetSpec | null {
  return TARGET_IDS.map((t) => TARGETS[t]).find((t) => t.envelope_id === envelopeId) ?? null;
}

/** The target a RUN DOCUMENT declares, read from its own fields rather than assumed. */
export function targetOfRun(run: any): TargetSpec {
  const byEnvelope = targetByEnvelopeId(run?.envelope_id);
  if (byEnvelope) return byEnvelope;
  return targetFor(run?.target_id);
}

/** The public multi-target envelope document served by GET /api/envelope. Constants only, identical
 *  for every listing of a target: it says nothing about any individual scenario. */
export function envelopesDoc() {
  return {
    schema: "tb-envelopes-1",
    default_target: DEFAULT_TARGET,
    targets: TARGET_IDS.map((id) => {
      const t = TARGETS[id];
      return {
        ...t.envelope_doc,
        target_id: id,
        label: t.label,
        short_label: t.short_label,
        machine: t.machine,
        one_liner: t.one_liner,
        subject_noun: t.subject_noun,
        subject_label: t.subject_label,
        replay_renderer: t.replay_renderer,
        sim_entry_point: t.sim.cli,
        envelope_yaml: t.envelope_yaml,
      };
    }),
  };
}

/** The compact operating context carried inside every public summary. Prose only, no parameter
 *  identifiers and no per-listing positioning, so it cannot narrow down the hidden scenario. */
export function operatingContext(t: TargetSpec) {
  const d = t.envelope_doc;
  return {
    controller_tuned_range: d.controller_tuned_range.prose,
    controller_tuned_range_label: d.controller_tuned_range.label,
    searched_envelope: d.searched_envelope.prose,
    question: d.product_question,
    note: d.note,
    reference: `GET /api/envelope (published axes for every target, same shape as GUARD configs/guard_theta.yaml)`,
  };
}
