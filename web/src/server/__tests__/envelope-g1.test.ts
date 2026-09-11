// The G1 target's TypeScript envelope mirror against the YAML the marketplace publishes.
// sim/tailbazaar_sim/g1/envelope.py is authoritative and `tailbazaar-g1 selfcheck` keeps it and the
// YAML together; this suite keeps the web layer's mirror honest against the same YAML, so the
// admissibility the verifier enforces and the axes the API publishes cannot drift from the simulator's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import { CONTINUOUS_ORDER, ENVELOPE, ENVELOPE_AXES, ENVELOPE_ID, FALL_Z_M, FREE_FALL_REF_MPS, NOMINAL_SCENARIO, checkAdmissible, isDuplicate, normalize, rangePosition, scenarioDistance, severityBand } from "../envelope-g1.js";
import { TARGETS, envelopesDoc, targetOfRun } from "../targets.js";

const yaml = fs.readFileSync(path.join(REPO_ROOT, "sim", "envelope-g1.yaml"), "utf8");

/** The `continuous:` block only — `failure_classes:` also uses "- name:" entries. */
function continuousBlocks(): string[] {
  const start = yaml.indexOf("\ncontinuous:");
  const rest = yaml.slice(start + 1);
  const end = rest.search(/\n(discrete|failure_classes|severity|outcomes|verdicts):/);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.split(/\n\s*- name: /).slice(1);
}
const field = (block: string, key: string): string | null => block.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"))?.[1] ?? null;

test("the mirror publishes the same axes as sim/envelope-g1.yaml, in GUARD's shape", () => {
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
    assert.equal(field(block, "marginal"), "null", `${name} marginal`);
    assert.equal(field(block, "scale"), "null", `${name} scale`);
    if (spec.step !== undefined) assert.equal(Number(field(block, "step")), spec.step, `${name} step`);
    if (spec.places !== undefined) assert.equal(Number(field(block, "places")), spec.places, `${name} places`);
  }
  assert.match(yaml, new RegExp(`envelope_id: ${ENVELOPE_ID}`));
  assert.match(yaml, /discrete: \[\]/, "no stratification axis on this target");
  assert.match(yaml, /control_tick_ms: 20/);
  assert.match(yaml, /push_duration_s: 0\.1/);
});

test("admissibility mirrors the Python envelope, including the optional-axis rule", () => {
  assert.deepEqual(checkAdmissible({ ...NOMINAL_SCENARIO }), []);
  assert.deepEqual(checkAdmissible({}), [], "every axis is optional; an omitted axis is read at nominal");
  assert.ok(checkAdmissible({ push_impulse_ns: 70 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ push_impulse_ns: -1 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ control_latency_ms: 30 }).some((p) => p.includes("multiple of 20")));
  assert.ok(checkAdmissible({ push_time_s: 2.01 }).some((p) => p.includes("control tick")));
  assert.ok(checkAdmissible({ cmd_vx_mps: 1.5 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ floor_friction: 0.12345 }).some((p) => p.includes("decimal places")));
  assert.ok(checkAdmissible({ init_seed: 0 }).some((p) => p.includes("unknown")), "the humanoid's stratification axis does not exist here");
});

test("the duplicate rule skips the push-only axes when unpushed and treats the heading as circular", () => {
  const a = normalize({ push_impulse_ns: 28.0, push_heading_deg: 0.0 });
  assert.ok(isDuplicate(a, normalize({ push_impulse_ns: 28.0, push_heading_deg: 359.0 })), "0 and 359 degrees are the same direction");
  assert.equal(scenarioDistance(normalize({ push_impulse_ns: 0, push_heading_deg: 0 }), normalize({ push_impulse_ns: 0, push_heading_deg: 180 })), 0, "an impulse of magnitude zero has no direction");
  assert.ok(!isDuplicate(a, normalize({ push_impulse_ns: 28.0, push_heading_deg: 90.0 })), "a side shove is not a front shove");
  assert.ok(!isDuplicate(normalize({ control_latency_ms: 80 }), normalize({ control_latency_ms: 60 })));
});

test("the severity bands are anchored to a free fall from this project's own fall-height line", () => {
  assert.ok(Math.abs(FREE_FALL_REF_MPS - Math.sqrt(2 * 9.81 * FALL_Z_M)) < 1e-12);
  assert.ok(Math.abs(FREE_FALL_REF_MPS - 3.011) < 1e-3);
  assert.equal(severityBand(1.0).band, "low");
  assert.equal(severityBand(2.5).band, "medium");
  assert.equal(severityBand(3.5).band, "high");
  assert.equal(severityBand(null).band, "none");
  assert.match(severityBand(1).definition, /never a damage, injury or cost estimate/);
  // The two findings in evidence/g1: the side shove and the 80 ms latency both land in the medium band.
  assert.equal(severityBand(2.739929).band, "medium", "the 28 N*s side-shove finding");
  assert.equal(severityBand(2.2239).band, "medium", "the 80 ms latency finding");
});

test("published conditions are the publisher's deployment configuration, per axis", () => {
  const pos = Object.fromEntries(rangePosition(normalize({ control_latency_ms: 80 })).map((p) => [p.parameter, p.in_tuned_range]));
  assert.equal(pos.control_latency_ms, false, "80 ms of latency is outside the configuration the policy is deployed with");
  assert.equal(pos.cmd_vx_mps, true, "the shipped 0.5 m/s command");
  assert.equal(pos.push_heading_deg, true, "an axis the publisher says nothing about is never 'outside' it");
  assert.equal(rangePosition(normalize({})).every((p) => p.in_tuned_range), true, "the nominal point is the published point");
  assert.equal(rangePosition(normalize({ cmd_vx_mps: 0.8 })).find((p) => p.parameter === "cmd_vx_mps")!.in_tuned_range, false);
});

test("the registry resolves a run to the G1 by the envelope the run itself declares", () => {
  assert.equal(targetOfRun({ envelope_id: "tb-g1-envelope-1" }).id, "g1");
  assert.equal(targetOfRun({ envelope_id: "tb-humanoid-envelope-1" }).id, "humanoid");
  assert.equal(TARGETS.g1.sim.module, "tailbazaar_sim.g1.cli");
  assert.equal(TARGETS.g1.replay_renderer, "g1-3d");
  assert.equal(TARGETS.g1.severity.proxy, "pelvis_impact_speed_mps");
  assert.match(TARGETS.g1.failure_classes[0].detected_by, /THIS PROJECT'S predicate/);
  const doc = envelopesDoc();
  assert.deepEqual(doc.targets.map((t) => t.target_id), ["cart", "humanoid", "arm", "g1"], "the three earlier targets stay where they are; the G1 is appended");
  assert.equal(doc.targets[3].replay_renderer, "g1-3d");
  assert.equal(doc.targets[3].axes.length, 8);
});

test("the G1 plausibility ceiling is derived from its own envelope and the scene the run carries", async () => {
  const run = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "evidence", "g1", "runs", "finding-push-28ns.json"), "utf8"));
  const limits = TARGETS.g1.replayLimitsFrom(run);
  // J_max/(m*s_min) + sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_stand), every number off the envelope or
  // the run's own scene block: the model's total mass, the publisher's qpos0 pelvis height and the
  // head's reach above the pelvis from the compiled bounding boxes.
  const mass = run.scene.total_mass_kg, hStand = run.scene.pelvis_z0_m + run.scene.head_reach_above_pelvis_m;
  const expected = 60 / (mass * 0.8) + Math.sqrt(2 * 2.4 * 9.81 * 100) + Math.sqrt(2 * 9.81 * hStand);
  assert.ok(Math.abs(limits.speed_ceiling_mps - expected) < 1e-6, `ceiling ${limits.speed_ceiling_mps} vs ${expected}`);
  assert.ok(Math.abs(mass - 32.1069) < 1e-3, "the 12-dof model's mass");
  assert.equal(limits.position_bound_m, 100);
  assert.equal(limits.dt_s, run.frames.dt_s);
  assert.ok(Math.abs(limits.max_span_s - (15 + 1.2 + run.frames.dt_s)) < 1e-12, "t_max_s + post_fall_s + one frame");
  for (const marker of ["push_impulse_ns", "body_mass_scale", "floor_friction", "control_latency_ms", "cmd_vx_mps", "salt_hex"])
    assert.ok(!limits.derivation.includes(marker), `the published derivation must not contain ${marker}`);
  const { checkReplayPlausibility } = await import("../plausibility.js");
  const honest = checkReplayPlausibility(run.frames, limits);
  assert.equal(honest.ok, true, honest.detail);
  assert.ok(honest.max_speed_mps! < limits.speed_ceiling_mps / 7, `honest replay peaks at ${honest.max_speed_mps} m/s, ceiling ${limits.speed_ceiling_mps}`);
  const forged = JSON.parse(JSON.stringify(run.frames));
  forged.data[8][1] = forged.data[8][1] + 60; // 60 m inside one 20 ms frame is 3000 m/s
  assert.equal(checkReplayPlausibility(forged, limits).ok, false);
});

test("the recorded fall crosses the stated threshold at the recorded time (frame-level check)", () => {
  const run = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "evidence", "g1", "runs", "finding-push-28ns.json"), "utf8"));
  const fell = run.events.find((e: any) => e.type === "fall_predicate_fired");
  assert.ok(fell, "the run records the predicate firing");
  assert.equal(run.fall_predicate.owner, "tail-bazaar (this project)");
  const pelvis = run.frames.bodies.indexOf("pelvis");
  const zAt = (t: number) => run.frames.data[Math.round(t / run.frames.dt_s)][1 + 7 * pelvis + 2];
  // Before the predicate fired the pelvis was above the line at every frame; at the fall time it is not,
  // or the tilt condition carried it (the run says which).
  const before = run.frames.data.filter((r: number[]) => r[0] < fell.t_s - 1e-9).every((r: number[]) => r[1 + 7 * pelvis + 2] >= run.fall_predicate.fall_z_m);
  assert.equal(before, true, "no frame before the fall time has the pelvis below the line");
  if (String(fell.detected_by).includes("pelvis_height")) assert.ok(zAt(fell.t_s) < run.fall_predicate.fall_z_m + 1e-4, `pelvis ${zAt(fell.t_s)} m at ${fell.t_s} s is below ${run.fall_predicate.fall_z_m} m`);
  assert.ok(Math.abs(fell.pelvis_z_m - zAt(fell.t_s)) < 2e-4, "the event's pelvis height is the frame's");
});
