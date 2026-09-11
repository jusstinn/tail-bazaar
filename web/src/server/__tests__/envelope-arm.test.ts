// The arm target's TypeScript envelope mirror against the YAML the marketplace publishes.
// sim/tailbazaar_sim/arm/envelope.py is authoritative and `tailbazaar_sim.arm.cli selfcheck` keeps it
// and the YAML together; this suite keeps the web layer's mirror honest against that same YAML, so
// the admissibility the verifier enforces and the axes the API publishes cannot drift from the
// simulator's. It also pins the three honest negatives the README states, straight off the committed
// hunt documents, so the prose and the evidence cannot drift apart either.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import { CONTINUOUS_ORDER, ENVELOPE, ENVELOPE_AXES, ENVELOPE_ID, INIT_SEEDS, NOMINAL_SCENARIO, TABLE_FALL_REF_MPS, TABLE_TOP_Z_M, checkAdmissible, isDuplicate, normalize, rangePosition, scenarioDistance, severityBand } from "../envelope-arm.js";
import { TARGETS, envelopesDoc, targetOfRun, TARGET_IDS } from "../targets.js";

const yaml = fs.readFileSync(path.join(REPO_ROOT, "sim", "envelope-arm.yaml"), "utf8");
const ARM = TARGETS.arm;
const readJson = (...p: string[]): any => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...p), "utf8"));

/** The `continuous:` block only. */
function continuousBlocks(): string[] {
  const start = yaml.indexOf("\ncontinuous:");
  const rest = yaml.slice(start + 1);
  const end = rest.search(/\n(discrete|failure_classes|severity|outcomes|verdicts):/);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.split(/\n\s*- name: /).slice(1);
}
const field = (block: string, key: string): string | null => block.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"))?.[1] ?? null;

test("the mirror publishes the same axes as sim/envelope-arm.yaml, in GUARD's shape", () => {
  const blocks = continuousBlocks();
  assert.equal(blocks.length, CONTINUOUS_ORDER.length, "one block per continuous axis");
  for (const block of blocks) {
    const name = block.split("\n")[0].trim();
    const spec = ENVELOPE[name];
    const axis = ENVELOPE_AXES.find((a) => a.name === name)!;
    assert.ok(spec, `${name} is a known axis`);
    assert.equal(Number(field(block, "low")), spec.min, `${name} low`);
    assert.equal(Number(field(block, "high")), spec.max, `${name} high`);
    assert.equal(Number(field(block, "nominal")), (NOMINAL_SCENARIO as Record<string, number>)[name], `${name} nominal`);
    assert.equal(field(block, "group"), axis.group, `${name} group`);
    // GUARD's distribution fields are present and deliberately null: no D is stated or estimated.
    assert.equal(field(block, "marginal"), "null", `${name} marginal`);
    assert.equal(field(block, "scale"), "null", `${name} scale`);
    if (spec.step !== undefined) assert.equal(Number(field(block, "step")), spec.step, `${name} step`);
    if (spec.places !== undefined) assert.equal(Number(field(block, "places")), spec.places, `${name} places`);
  }
  assert.match(yaml, new RegExp(`envelope_id: ${ENVELOPE_ID}`));
  assert.match(yaml, /values: \[0, 1, 2, 3, 4, 5, 6, 7\]/);
  assert.deepEqual([...INIT_SEEDS], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.match(yaml, /control_tick_ms: 40/);
  assert.match(yaml, /episode_horizon_ticks: 50/);
  assert.match(yaml, new RegExp(`airborne_margin_m: ${String(0.03)}`));
});

test("admissibility mirrors the Python envelope, including the optional-axis rule", () => {
  assert.deepEqual(checkAdmissible({ ...NOMINAL_SCENARIO }), []);
  assert.deepEqual(checkAdmissible({}), [], "every axis is optional; an omitted axis is read at nominal");
  assert.ok(checkAdmissible({ object_mass_kg: 25 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ grip_friction: 0.01 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ object_offset_x_m: 0.09 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ control_latency_ms: 20 }).some((p) => p.includes("multiple of 40")));
  assert.ok(checkAdmissible({ gripper_latency_ms: 30 }).some((p) => p.includes("multiple of 40")));
  assert.ok(checkAdmissible({ init_seed: 9 }).some((p) => p.includes("init_seed")));
  assert.ok(checkAdmissible({ object_offset_x_m: 0.000012 }).some((p) => p.includes("decimal places")));
  assert.ok(checkAdmissible({ gravity: 1.0 }).some((p) => p.includes("unknown")));
});

test("the duplicate rule is stratified by initial state, because each seed is a different problem", () => {
  const a = normalize({ grip_friction: 0.25, init_seed: 3 });
  assert.ok(isDuplicate(a, normalize({ grip_friction: 0.26, init_seed: 3 })), "one thousandth of the friction axis apart");
  assert.ok(!isDuplicate(a, normalize({ grip_friction: 0.5, init_seed: 3 })));
  assert.equal(scenarioDistance(a, normalize({ grip_friction: 0.25, init_seed: 4 })), Infinity, "reset(seed) samples a different block AND a different goal");
  // The selected finding's own published distance to nominal, recomputed by the mirror.
  assert.ok(Math.abs(scenarioDistance(a, normalize({ init_seed: 3 })) - 0.5068) < 5e-4);
});

test("the severity bands are anchored to a free fall from the scene's own table top", () => {
  assert.ok(Math.abs(TABLE_FALL_REF_MPS - Math.sqrt(2 * 9.81 * TABLE_TOP_Z_M)) < 1e-12);
  assert.equal(severityBand(1.0).band, "low");
  assert.equal(severityBand(2.0).band, "medium");
  assert.equal(severityBand(3.0).band, "high");
  assert.equal(severityBand(null).band, "none", "NOT_PLACED has no severity proxy at all");
  assert.match(severityBand(1).definition, /never a damage, breakage or cost estimate/);
  // The two findings in evidence/arm land in different bands, which is what makes the buyer's
  // severity ranking do any work at all.
  assert.equal(severityBand(3.150862).band, "high", "the grip-friction finding, onto the floor");
  assert.equal(severityBand(2.262438).band, "medium", "the combined finding, onto the table top");
});

test("published conditions are per axis, with null where the publisher states nothing", () => {
  const pos = Object.fromEntries(rangePosition(normalize({ control_latency_ms: 40 })).map((p) => [p.parameter, p.in_tuned_range]));
  assert.equal(pos.control_latency_ms, false, "one tick of latency is outside the conditions the policy was published at");
  assert.equal(pos.object_mass_kg, true);
  assert.equal(rangePosition(normalize({})).every((p) => p.in_tuned_range), true, "the nominal point is the published point");
});

test("the registry carries the arm as the third target and resolves runs to it by their own envelope", () => {
  assert.deepEqual(TARGET_IDS, ["cart", "humanoid", "arm"]);
  assert.equal(targetOfRun({ envelope_id: "tb-arm-envelope-1" }).id, "arm");
  assert.equal(targetOfRun({ target_id: "arm" }).id, "arm");
  assert.equal(ARM.sim.module, "tailbazaar_sim.arm.cli");
  assert.deepEqual(ARM.failure_outcomes, ["DROPPED", "NOT_PLACED"]);
  const doc = envelopesDoc();
  assert.deepEqual(doc.targets.map((t) => t.target_id), ["cart", "humanoid", "arm"]);
  assert.equal(doc.targets[2].replay_renderer, "arm-3d");
  assert.equal(doc.targets[2].axes.length, 7);
  // NOT_PLACED is Gymnasium-Robotics' own verdict; DROPPED is the one predicate this project owns and
  // the card says so rather than implying the environment provided it.
  const classes = Object.fromEntries(doc.targets[2].failure_classes.map((c) => [c.id, c.detected_by]));
  assert.match(classes.NOT_PLACED, /is_success/);
  assert.match(classes.DROPPED, /MuJoCo's OWN contact list/);
});

test("a claim built from an arm run carries the run's own severity, and NOT_PLACED carries none", () => {
  const run = readJson("evidence", "arm", "runs", "finding-grip-025.json");
  const claim = ARM.claimFromRun(run);
  assert.equal(claim.outcome, "DROPPED");
  assert.equal(claim.severity_proxy, "object_impact_speed_mps");
  assert.equal(claim.severity_value, 3.150862);
  assert.equal(claim.moment_t_s, 0.68);
  assert.equal(claim.severity_band, "high");
  const notPlaced = ARM.claimFromRun({ outcome: "NOT_PLACED", metrics: { primary_failure_class: "NOT_PLACED", object_impact_speed_mps: null, drop_t_s: null }, severity: null });
  assert.equal(notPlaced.severity_value, null);
  assert.equal(notPlaced.severity_band, "none");
  assert.equal(notPlaced.moment_t_s, null);
  // The claim is bound to the pinned CHECKPOINT, not to a repo name or a file path.
  const subject = ARM.subjectOf(run);
  assert.equal(subject.id, "intelligrow-fetch-pick-and-place-v4-sac-her");
  assert.match(subject.hash, /^sha256:[0-9a-f]{64}$/);
});

test("the arm plausibility ceiling is derived from its own envelope and scene, not chosen", async () => {
  const run = readJson("evidence", "arm", "runs", "finding-grip-025.json");
  const limits = ARM.replayLimitsFrom(run);
  // sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_table): the fastest anything can be moving after
  // accelerating over the simulator's own 100 m divergence bound at gravity plus the largest
  // tangential force the published contact-friction axis admits, plus a fall from the only raised
  // surface in the scene.
  const expected = Math.sqrt(2 * 2.5 * 9.81 * 100) + Math.sqrt(2 * 9.81 * 0.4);
  assert.ok(Math.abs(limits.speed_ceiling_mps - expected) < 1e-9, `ceiling ${limits.speed_ceiling_mps} vs ${expected}`);
  assert.equal(limits.position_bound_m, 100);
  assert.equal(limits.dt_s, run.frames.dt_s);
  // The horizon and the post-drop settle window are counted in control ticks by the environment and
  // the simulator, so the longest a conclusive recording can last is read off those two counts.
  assert.ok(Math.abs(limits.max_span_s - (50 + 30 + 1) * 0.04) < 1e-12);
  // The derivation is quoted in the PUBLIC delivery record, so it must name no envelope parameter.
  for (const marker of ["grip_friction", "object_mass_kg", "action_noise_frac", "control_latency_ms", "gripper_latency_ms", "init_seed", "salt_hex"])
    assert.ok(!limits.derivation.includes(marker), `the published derivation must not contain ${marker}`);

  // This scene has one body MuJoCo poses rather than integrates — the mocap weld target the
  // environment drags the gripper to — and it is identified from the run's own geometry (every one of
  // its primitives collides with nothing), never from a hard-coded name. It is teleported into place
  // on the first tick, so measuring it as a trajectory would put a 39 m/s body in an honest run.
  assert.deepEqual(limits.unchecked_speed_bodies, ["robot0:mocap"]);

  const { checkReplayPlausibility } = await import("../plausibility.js");
  const honest = checkReplayPlausibility(run.frames, limits);
  assert.equal(honest.ok, true, honest.detail);
  assert.ok(Math.abs(honest.max_speed_mps! - 2.954) < 0.01, `honest replay peaks at ${honest.max_speed_mps} m/s`);
  assert.ok(honest.max_speed_mps! < limits.speed_ceiling_mps / 20, `honest replay peaks at ${honest.max_speed_mps} m/s, ceiling ${limits.speed_ceiling_mps}`);
  assert.match(honest.detail, /robot0:mocap is a marker the engine poses/);
  // The excluded marker is still held inside the world the simulator models.
  const teleported = JSON.parse(JSON.stringify(run.frames));
  const mi = teleported.bodies.indexOf("robot0:mocap");
  teleported.data[8][1 + 7 * mi] = 500;
  assert.equal(checkReplayPlausibility(teleported, limits).ok, false, "a posed marker may still not leave the world");

  const forged = JSON.parse(JSON.stringify(run.frames));
  const oi = forged.bodies.indexOf("object0");
  forged.data[8][1 + 7 * oi] += 60; // 60 m inside one 40 ms frame is 1500 m/s
  assert.equal(checkReplayPlausibility(forged, limits).ok, false);
});

test("the honest negatives the README states are read back off the committed hunt documents", () => {
  // Mass alone never costs the grasp, at any of the eight geometries, up to ten times the published
  // payload; nor does moving the part; and the whole systems grid produced not one drop.
  const payload = ARM.normalizeHunt(readJson("evidence", "arm", "hunt-grid-payload.json"));
  assert.equal(payload.counts.simulations, 48);
  assert.equal(payload.counts.failures, 0);
  assert.equal(payload.counts.by_class.DROPPED, 0);

  const placement = ARM.normalizeHunt(readJson("evidence", "arm", "hunt-grid-placement.json"));
  assert.equal(placement.counts.simulations, 25);
  assert.equal(placement.counts.failures, 0);

  const systems = ARM.normalizeHunt(readJson("evidence", "arm", "hunt-grid-systems.json"));
  assert.equal(systems.counts.simulations, 30);
  assert.equal(systems.counts.by_class.DROPPED, 0, "latency and noise cost this policy the placement, not the part");
  assert.equal(systems.counts.by_class.NOT_PLACED, 15);

  const grip = ARM.normalizeHunt(readJson("evidence", "arm", "hunt-grid-grip.json"));
  assert.equal(grip.counts.simulations, 72);
  assert.equal(grip.counts.by_class.DROPPED, 4);
  assert.equal(grip.selected.length, 4);
  assert.equal(grip.selected[0].severity_value, 3.150862, "the mildest drop is the one the seller lists first");

  const random = ARM.normalizeHunt(readJson("evidence", "arm", "hunt-random-seed7.json"));
  const total = [payload, placement, systems, grip, random].reduce((a, h) => a + h.counts.simulations, 0);
  const drops = [payload, placement, systems, grip, random].reduce((a, h) => a + (h.counts.by_class.DROPPED ?? 0), 0);
  assert.equal(total, 325, "the search cost the README quotes");
  assert.equal(drops, 20, "the number of drops the README quotes");
  assert.equal([payload, placement, systems, grip, random].reduce((a, h) => a + h.counts.inconclusive, 0), 0);
});
