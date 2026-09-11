// The experience reads its failure vocabulary from the run document. These tests drive REAL RECORDED
// RUNS — a cart collision, a cart load shed, and a humanoid fall from the second target — through the
// same code, so each class is narrated from its own events, severity proxy and units instead of being
// mislabelled as a collision, and a class nobody has registered still resolves.
//
// Every fixture is a committed, pipeline-generated run document under evidence/. Nothing here is
// hand-written, and nothing depends on a demo run having been executed on this machine first.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { autoplayStop, defaultPlayhead, formatValue, humanizeClass, labelForKey, presentFailure, unitFor } from "../failure.js";
import { WEB_ROOT } from "../config.js";

const EVIDENCE = path.join(WEB_ROOT, "..", "evidence");
const FINDING = path.join(EVIDENCE, "milestone", "runs", "failure.json");
const BASELINE = path.join(EVIDENCE, "milestone", "runs", "baseline.json");
const readRun = (f: string): any => JSON.parse(fs.readFileSync(f, "utf8"));

test("the sold COLLISION finding is narrated from its own recorded events", () => {
  const run = readRun(FINDING);
  const p = presentFailure(run, readRun(BASELINE));

  assert.equal(p.class_id, "COLLISION");
  assert.equal(p.known_class, true);
  assert.equal(p.label, "Collision");
  assert.equal(p.moment_label, "first contact");
  // the moment is the recorded first_contact event, not a guess and not the end of the run
  assert.equal(p.moment_t_s, run.events.find((e: any) => e.type === "first_contact").t_s);
  assert.equal(p.moment_t_s, 4.006);
  assert.notEqual(p.moment_t_s, run.metrics.duration_s, "the moment is not the parked end of the run");

  // the headline number is the impact speed the simulator recorded on that event
  assert.equal(p.headline_quantity?.key, "impact_speed_mps");
  assert.equal(p.headline_quantity?.value, run.events.find((e: any) => e.type === "first_contact").impact_speed_mps);
  assert.equal(p.headline_quantity?.unit, "m/s");
  assert.equal(p.headline_quantity?.text, "0.415 m/s");
  assert.equal(p.headline, "COLLISION · 0.415 m/s");
});

test("scrubber marks cover brake onset, the failure moment and where the baseline stopped", () => {
  const p = presentFailure(readRun(FINDING), readRun(BASELINE));
  const byId = Object.fromEntries(p.markers.map((m) => [m.id, m]));
  assert.equal(byId.brake_onset.t_s, 3.52);
  assert.equal(byId.brake_onset.kind, "cue");
  assert.equal(byId.moment.t_s, 4.006);
  assert.equal(byId.moment.kind, "moment");
  assert.equal(byId.baseline_stop.t_s, 3.94, "the nominal run's stop is on the same timeline");
  assert.deepEqual(p.markers.map((m) => m.t_s), [...p.markers.map((m) => m.t_s)].sort((a, b) => a - b), "marks are in time order");
});

test("the replay opens before the failure, not at the end of the run", () => {
  const run = readRun(FINDING);
  const p = presentFailure(run, readRun(BASELINE));
  const duration = run.metrics.duration_s as number;
  const from = defaultPlayhead(p.moment_t_s, duration);
  assert.equal(from, 3.406);
  assert.ok(from < p.moment_t_s!, "the playhead starts before the failure");
  assert.ok(Math.abs(p.moment_t_s! - from - 0.6) < 1e-9, "0.6 s of lead-in");
  assert.ok(from < duration - 1, "and nowhere near the parked end of the run");
  // the single autoplay pass runs past the failure and stops shortly after it
  const to = autoplayStop(p.moment_t_s, duration);
  assert.ok(Math.abs(to - 4.906) < 1e-9);
  assert.ok(to > p.moment_t_s!);
  assert.ok(to <= duration);
  // degenerate inputs stay in range
  assert.equal(defaultPlayhead(0.2, 5), 0);
  assert.equal(defaultPlayhead(null, 5), 0);
  assert.equal(autoplayStop(4.9, 5), 5);
});

// TARGET 2's failure class, from the second simulator. `FELL` is decided by Gymnasium's own health
// predicate, and its severity is measured on a DIFFERENT event from the failure moment: the torso
// leaves the healthy band first, and hits the floor a fraction of a second later. The presentation
// has to carry both instants and put the impact speed — not the speed at the predicate — in the
// callout, which is exactly what a reader is being told.
const HUMANOID_FINDING = path.join(EVIDENCE, "humanoid", "runs", "finding-push-8ns.json");
const HUMANOID_BASELINE = path.join(EVIDENCE, "humanoid", "runs", "baseline-nominal.json");

test("FELL is narrated from the environment's own predicate, with the impact measured on its own event", (t) => {
  if (!fs.existsSync(HUMANOID_FINDING)) return t.skip("no humanoid run recorded in evidence/ yet");
  const run = readRun(HUMANOID_FINDING);
  const p = presentFailure(run, readRun(HUMANOID_BASELINE));
  const fell = run.events.find((e: any) => e.type === "health_predicate_fired");
  const hit = run.events.find((e: any) => e.type === "ground_contact");

  assert.equal(p.class_id, "FELL");
  assert.equal(p.known_class, true);
  assert.equal(p.label, "Fell");
  assert.equal(p.moment_label, "the fall");
  // the failure moment is the predicate firing, not the ground contact and not the end of the run
  assert.equal(p.moment_t_s, fell.t_s);
  assert.equal(p.moment_t_s, 2.835);
  assert.notEqual(p.moment_t_s, run.metrics.duration_s);
  // the severity is measured later, on its own event, and that is what the callout carries
  assert.equal(p.severity_moment_t_s, hit.t_s);
  assert.equal(p.severity_label, "torso impact");
  assert.equal(p.headline_quantity?.key, "torso_impact_speed_mps");
  assert.equal(p.headline_quantity?.value, hit.torso_impact_speed_mps);
  assert.equal(p.headline_quantity?.value, 4.801319);
  assert.equal(p.headline_quantity?.unit, "m/s");
  assert.equal(p.headline, "FELL · 4.801 m/s");
  // both instants are on the scrubber, in time order, and the push that caused it is a cue
  const byId = Object.fromEntries(p.markers.map((m) => [m.id, m]));
  assert.equal(byId.moment.t_s, fell.t_s);
  assert.equal(byId.moment.kind, "moment");
  assert.equal(byId.severity.t_s, hit.t_s);
  assert.equal(byId.severity.kind, "secondary");
  assert.equal(byId.push_start.kind, "cue");
  assert.equal(byId.push_start.t_s, 2.1);
  assert.deepEqual(p.markers.map((m) => m.t_s), [...p.markers.map((m) => m.t_s)].sort((a, b) => a - b));
  // the replay still opens 0.6 s before the FALL, and plays past the impact
  const duration = run.metrics.duration_s as number;
  assert.ok(Math.abs(defaultPlayhead(p.moment_t_s, duration) - (fell.t_s - 0.6)) < 1e-9);
  assert.ok(autoplayStop(p.moment_t_s, duration) > hit.t_s, "the single autoplay pass runs past the ground contact");
  // and the surviving baseline contributes no stop marker: it never stopped, it walked the episode out
  assert.equal(byId.baseline_stop, undefined);
});

// The second failure class the simulator publishes: the payload leaves the deck under braking.
// Driven from the recorded run, so the page narrates it without a single line of collision code.
const LOAD_SHED_RUN = path.join(EVIDENCE, "load-shed", "runs", "load-shed-finding.json");

test("LOAD_SHED is narrated from its own recorded event, not as a collision", (t) => {
  if (!fs.existsSync(LOAD_SHED_RUN)) return t.skip("no LOAD_SHED run recorded in evidence/ yet");
  const run = readRun(LOAD_SHED_RUN);
  const p = presentFailure(run, readRun(BASELINE));
  const shed = run.events.find((e: any) => e.type === "load_shed");

  assert.equal(p.class_id, "LOAD_SHED");
  assert.equal(p.label, "Load shed");
  assert.equal(p.moment_t_s, shed.t_s, "its own event, not first_contact");
  assert.notEqual(p.moment?.type, "first_contact");
  // the headline is the severity proxy the simulator uses for this class
  assert.equal(p.headline_quantity?.key, "load_rel_speed_mps");
  assert.equal(p.headline_quantity?.value, shed.load_rel_speed_mps);
  assert.equal(p.headline_quantity?.unit, "m/s");
  assert.match(p.headline, /^LOAD SHED · /);
  // the descriptive fields of the event survive as attributes, without being invented
  assert.deepEqual(p.attributes.map((a) => a.key).sort(), ["criterion", "direction", "phase"]);
  assert.equal(p.markers.find((m) => m.kind === "moment")!.t_s, shed.t_s);
  assert.ok(defaultPlayhead(p.moment_t_s, run.metrics.duration_s) < shed.t_s);
});

test("a run that fails in two ways keeps both classes and both moments", (t) => {
  const severe = path.join(WEB_ROOT, "..", "evidence", "load-shed", "runs", "load-shed-severe.json");
  if (!fs.existsSync(severe)) return t.skip("no multi-class run recorded in evidence/ yet");
  const run = readRun(severe);
  const p = presentFailure(run);
  assert.deepEqual(p.classes.slice().sort(), ["COLLISION", "LOAD_SHED"]);
  assert.equal(p.class_id, run.metrics.primary_failure_class);
  assert.equal(p.moment?.type, "first_contact");
  const extra = p.also.find((a) => a.class_id !== p.class_id)!;
  assert.equal(extra.label, "Load shed");
  assert.equal(extra.t_s, run.events.find((e: any) => e.type === "load_shed").t_s);
  assert.ok(p.markers.some((m) => m.kind === "secondary" && m.t_s === extra.t_s), "the second failure is marked on the timeline too");
});

test("an unknown failure class is read from the run, never hard-coded to collision", () => {
  // A class with no registry entry at all still gets a readable name and its own moment.
  const novel = { outcome: "TIP_OVER", events: [{ type: "brake_onset", t_s: 1 }, { type: "roll_threshold_exceeded", t_s: 2.5, roll_deg: 31.5 }] };
  const q = presentFailure(novel);
  assert.equal(q.class_id, "TIP_OVER");
  assert.equal(q.known_class, false);
  assert.equal(q.label, "Tip over");
  assert.equal(q.moment_label, "roll threshold exceeded");
  assert.equal(q.moment_t_s, 2.5);
  assert.equal(q.headline_quantity?.text, "31.5 °");
  assert.match(q.sentence, /TIP_OVER/);
});

test("a run with no failure event degrades without inventing one", () => {
  const clean = { metrics: { outcome: "SUCCESS" }, events: [{ type: "brake_onset", t_s: 1.2 }, { type: "stopped", t_s: 2.4 }] };
  const p = presentFailure(clean);
  assert.equal(p.moment, null);
  assert.equal(p.moment_t_s, null);
  assert.equal(p.headline_quantity, null);
  assert.equal(p.quantities.length, 0);
  assert.equal(defaultPlayhead(p.moment_t_s, 3), 0);
  assert.equal(presentFailure(null).class_id, "UNKNOWN");
  assert.equal(presentFailure({ events: "nonsense" }).markers.length, 0);
});

test("the pre-purchase summary cannot be narrated: nothing about a scenario escapes this module", () => {
  // What a visitor sees before paying is the public summary. It carries no events, no metrics and no
  // outcome, so the presentation layer that drives the replay can say nothing about the scenario.
  const summary = {
    schema: "tb-summary-1",
    controller: { id: "stop-before-obstacle-v1", hash: "sha256:7620971c" },
    envelope_id: "tb-envelope-1", admissible: true,
    claim_kind: "controller collides with the obstacle under admissible conditions inside the published envelope",
    verification: { status: "VERIFIED", verdict: "VALID", method: "exact-trajectory-hash" },
    severity: { band: "low", proxy: "impact_speed_mps" },
    hidden: "exact scenario parameters, trajectory, replay frames and reproduction command are in the private package only",
  };
  const p = presentFailure(summary);
  assert.equal(p.class_id, "UNKNOWN");
  assert.equal(p.moment, null);
  assert.equal(p.moment_t_s, null);
  assert.deepEqual(p.quantities, []);
  assert.deepEqual(p.attributes, []);
  assert.deepEqual(p.markers, []);
  assert.equal(p.headline_quantity, null);
  // and nothing it emits names an envelope parameter or a value of one
  const emitted = JSON.stringify(p);
  for (const k of ["sensor_delay_ms", "actuator_delay_ms", "floor_friction", "payload_kg", "load_friction", "salt_hex", "trajectory_hash"]) {
    assert.ok(!emitted.includes(k), `presentation leaks ${k}`);
  }
});

test("units and labels come from the field name, with no unit invented", () => {
  assert.equal(unitFor("impact_speed_mps"), "m/s");
  assert.equal(unitFor("peak_decel_mps2"), "m/s²");
  assert.equal(unitFor("impact_kinetic_energy_j"), "J");
  assert.equal(unitFor("min_range_m"), "m");
  assert.equal(unitFor("sensor_delay_ms"), "ms");
  assert.equal(unitFor("floor_friction"), "", "a dimensionless field gets no unit");
  assert.equal(labelForKey("slip_distance_m"), "slip distance");
  assert.equal(humanizeClass("LOAD_SHED"), "Load shed");
  assert.equal(formatValue(4), "4");
  assert.equal(formatValue(0.414745), "0.415");
  assert.equal(formatValue(0.4), "0.4");
});
