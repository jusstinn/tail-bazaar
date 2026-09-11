// The experience reads its failure vocabulary from the run document. These tests drive the real
// finding that was sold (COLLISION) and a second, unknown failure class through the same code, so a
// class the simulator adds later — e.g. a payload that slides off the cart under braking — is
// narrated from its own events instead of being mislabelled as a collision.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { autoplayStop, defaultPlayhead, formatValue, humanizeClass, labelForKey, presentFailure, unitFor } from "../failure.js";
import { WEB_ROOT } from "../config.js";

const FINDING = path.join(WEB_ROOT, "data", "sim", "seller", "runs", "finding-1.json");
const BASELINE = path.join(WEB_ROOT, "data", "sim", "public", "runs", "baseline.json");
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

// The second failure class the simulator publishes: the payload leaves the deck under braking.
// Driven from the recorded run, so the page narrates it without a single line of collision code.
const LOAD_SHED_RUN = path.join(WEB_ROOT, "..", "evidence", "load-shed", "runs", "load-shed-finding.json");

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
