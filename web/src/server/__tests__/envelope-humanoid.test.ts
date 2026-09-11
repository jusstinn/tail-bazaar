// The humanoid target's TypeScript envelope mirror against the YAML the marketplace publishes.
// sim/tailbazaar_sim/humanoid/envelope.py is authoritative and `tailbazaar-humanoid selfcheck` keeps
// it and the YAML together; this suite keeps the web layer's mirror honest against the same YAML, so
// the admissibility the verifier enforces and the axes the API publishes cannot drift from the
// simulator's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import { CONTINUOUS_ORDER, ENVELOPE, ENVELOPE_AXES, ENVELOPE_ID, FREE_FALL_REF_MPS, INIT_SEEDS, NOMINAL_SCENARIO, checkAdmissible, isDuplicate, normalize, rangePosition, scenarioDistance, severityBand } from "../envelope-humanoid.js";
import { TARGETS, envelopesDoc, targetOfRun } from "../targets.js";

const yaml = fs.readFileSync(path.join(REPO_ROOT, "sim", "envelope-humanoid.yaml"), "utf8");

/** The `continuous:` block only — `failure_classes:` also uses "- name:" entries. */
function continuousBlocks(): string[] {
  const start = yaml.indexOf("\ncontinuous:");
  const rest = yaml.slice(start + 1);
  const end = rest.search(/\n(discrete|failure_classes|severity|outcomes|verdicts):/);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.split(/\n\s*- name: /).slice(1);
}
const field = (block: string, key: string): string | null => block.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"))?.[1] ?? null;

test("the mirror publishes the same axes as sim/envelope-humanoid.yaml, in GUARD's shape", () => {
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
  assert.match(yaml, /control_tick_ms: 15/);
});

test("admissibility mirrors the Python envelope, including the optional-axis rule", () => {
  assert.deepEqual(checkAdmissible({ ...NOMINAL_SCENARIO }), []);
  assert.deepEqual(checkAdmissible({}), [], "every axis is optional; an omitted axis is read at nominal");
  assert.ok(checkAdmissible({ push_impulse_ns: 130 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ push_impulse_ns: -1 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ control_latency_ms: 20 }).some((p) => p.includes("multiple of 15")));
  assert.ok(checkAdmissible({ push_time_s: 2.0 }).some((p) => p.includes("control tick")));
  assert.ok(checkAdmissible({ init_seed: 99 }).some((p) => p.includes("init_seed")));
  assert.ok(checkAdmissible({ floor_friction: 0.12345 }).some((p) => p.includes("decimal places")));
  assert.ok(checkAdmissible({ gravity: 1.0 }).some((p) => p.includes("unknown")));
});

test("the duplicate rule is class-blind on scenarios but stratified by initial state, and the heading is circular", () => {
  const a = normalize({ push_impulse_ns: 8.0, push_heading_deg: 0.0 });
  assert.ok(isDuplicate(a, normalize({ push_impulse_ns: 8.0, push_heading_deg: 359.0 })), "0 and 359 degrees are the same direction");
  assert.equal(scenarioDistance(normalize({ push_impulse_ns: 8.0, init_seed: 0 }), normalize({ push_impulse_ns: 8.0, init_seed: 1 })), Infinity, "different initial states are never duplicates");
  assert.equal(scenarioDistance(normalize({ push_impulse_ns: 0, push_heading_deg: 0 }), normalize({ push_impulse_ns: 0, push_heading_deg: 180 })), 0, "an impulse of magnitude zero has no direction");
  assert.ok(!isDuplicate(a, normalize({ push_impulse_ns: 8.0, floor_friction: 1.4 })));
});

test("the severity bands are anchored to a free fall from the environment's own healthy floor", () => {
  // sqrt(2 g z_min) with z_min = 1.0 m, the bottom of Gymnasium's healthy_z_range.
  assert.ok(Math.abs(FREE_FALL_REF_MPS - Math.sqrt(2 * 9.81)) < 1e-12);
  assert.equal(severityBand(1.0).band, "low");
  assert.equal(severityBand(3.0).band, "medium");
  assert.equal(severityBand(4.9).band, "high");
  assert.equal(severityBand(null).band, "none");
  assert.match(severityBand(1).definition, /never a damage, injury or cost estimate/);
  // The two findings in evidence/humanoid land in different bands, which is what makes the buyer's
  // severity ranking do any work at all.
  assert.equal(severityBand(4.069453).band, "medium", "the 15 ms latency finding");
  assert.equal(severityBand(4.801319).band, "high", "the 8 N*s push finding");
});

test("published conditions are per axis, with null where the publisher states nothing", () => {
  const pos = Object.fromEntries(rangePosition(normalize({ control_latency_ms: 15 })).map((p) => [p.parameter, p.in_tuned_range]));
  assert.equal(pos.control_latency_ms, false, "15 ms of latency is outside the conditions the policy was published at");
  assert.equal(pos.push_impulse_ns, true);
  assert.equal(pos.push_heading_deg, true, "an axis the publisher says nothing about is never 'outside' it");
  assert.equal(rangePosition(normalize({})).every((p) => p.in_tuned_range), true, "the nominal point is the published point");
});

test("the registry resolves a run to its target by the envelope the run itself declares", () => {
  assert.equal(targetOfRun({ envelope_id: "tb-humanoid-envelope-1" }).id, "humanoid");
  assert.equal(targetOfRun({ envelope_id: "tb-envelope-1" }).id, "cart");
  assert.equal(targetOfRun({}).id, "cart", "a record written before the registry existed is the cart");
  assert.equal(TARGETS.humanoid.sim.module, "tailbazaar_sim.humanoid.cli");
  assert.equal(TARGETS.cart.sim.module, "tailbazaar_sim.cli");
  const doc = envelopesDoc();
  // The registry may grow; these two stay where they are, in this order, with their own renderers.
  assert.deepEqual(doc.targets.slice(0, 2).map((t) => t.target_id), ["cart", "humanoid"]);
  assert.equal(doc.targets[1].replay_renderer, "humanoid-3d");
});

test("the humanoid plausibility ceiling is derived from its own envelope and body, not chosen", async () => {
  const run = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "evidence", "humanoid", "runs", "finding-push-8ns.json"), "utf8"));
  const limits = TARGETS.humanoid.replayLimitsFrom(run);
  // J_max/(m*s_min) + sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_stand): the largest velocity change the
  // published push axis can impart to the lightest admissible body, plus the fastest anything can be
  // moving after accelerating over the simulator's own 100 m divergence bound, plus a free fall from
  // the top of the healthy band plus the head's reach above the torso (0.19 + 0.09 m in the MJCF).
  const expected = 120 / (42.116 * 0.8) + Math.sqrt(2 * 2.4 * 9.81 * 100) + Math.sqrt(2 * 9.81 * (2.0 + 0.28));
  assert.ok(Math.abs(limits.speed_ceiling_mps - expected) < 1e-6, `ceiling ${limits.speed_ceiling_mps} vs ${expected}`);
  assert.equal(limits.position_bound_m, 100);
  assert.equal(limits.dt_s, run.frames.dt_s);
  assert.ok(Math.abs(limits.max_span_s - (15 + 1.2 + run.frames.dt_s)) < 1e-12, "t_max_s + post_fall_s + one frame");
  // The derivation is quoted in the PUBLIC delivery record, so it must name no envelope parameter.
  for (const marker of ["push_impulse_ns", "body_mass_scale", "floor_friction", "control_latency_ms", "init_seed", "salt_hex"])
    assert.ok(!limits.derivation.includes(marker), `the published derivation must not contain ${marker}`);

  // The honest recording sits far below the ceiling and a one-body-length teleport sits far above it.
  // Nothing physical lies in between, which is why this is an impossibility line and not a tolerance.
  const { checkReplayPlausibility } = await import("../plausibility.js");
  const honest = checkReplayPlausibility(run.frames, limits);
  assert.equal(honest.ok, true, honest.detail);
  assert.ok(honest.max_speed_mps! < limits.speed_ceiling_mps / 7, `honest replay peaks at ${honest.max_speed_mps} m/s, ceiling ${limits.speed_ceiling_mps}`);
  const forged = JSON.parse(JSON.stringify(run.frames));
  forged.data[8][1] = forged.data[8][1] + 60; // 60 m inside one 30 ms frame is 2000 m/s
  assert.equal(checkReplayPlausibility(forged, limits).ok, false);
});
