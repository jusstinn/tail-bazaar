import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkAdmissible, isDuplicate, rangePosition, scenarioDistance, severityBand, CONTROLLER_TUNED_RANGE, ENVELOPE, ENVELOPE_AXES, NOMINAL_SCENARIO, PARAM_ORDER } from "../envelope.js";
import { REPO_ROOT } from "../config.js";

test("admissibility mirrors the Python envelope", () => {
  assert.deepEqual(checkAdmissible({ ...NOMINAL_SCENARIO }), []);
  assert.ok(checkAdmissible({ ...NOMINAL_SCENARIO, sensor_delay_ms: 320 }).some((p) => p.includes("outside")));
  assert.ok(checkAdmissible({ ...NOMINAL_SCENARIO, sensor_delay_ms: 30 }).some((p) => p.includes("multiple of 20")));
  assert.ok(checkAdmissible({ ...NOMINAL_SCENARIO, floor_friction: 0.1 }).length > 0);
  assert.ok(checkAdmissible({ ...NOMINAL_SCENARIO, extra: 1 }).some((p) => p.includes("unknown")));
});

test("duplicate rule is normalized L-infinity < 0.05", () => {
  const a = { ...NOMINAL_SCENARIO, sensor_delay_ms: 200, floor_friction: 0.3 };
  assert.ok(isDuplicate(a, { ...a, floor_friction: 0.31 }));
  assert.ok(!isDuplicate(a, { ...a, floor_friction: 0.35 }));
  assert.equal(scenarioDistance(a, { ...a, sensor_delay_ms: 230 }), 0.1);
});

test("severity bands are coarse buckets of the impact-speed proxy", () => {
  assert.equal(severityBand(0.41).band, "low");
  assert.equal(severityBand(0.9).band, "medium");
  assert.equal(severityBand(1.2).band, "high");
  assert.equal(severityBand(null).band, "none");
});

// The controller's tuned range is documented in the docstring of controller.py, which is never edited
// (its SHA-256 is the controller version id). These tests fail if the published mirrors drift from it.
test("the published tuned range still matches the controller's own docstring", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "sim", "tailbazaar_sim", "controller.py"), "utf8");
  const doc = src.slice(src.indexOf("Design assumptions"), src.indexOf("Design assumptions") + 400);
  assert.match(doc, /sensor latency <= 40 ms/);
  assert.match(doc, /actuator latency <= 20 ms/);
  assert.match(doc, /floor friction >= 0\.6/);
  assert.match(doc, /20 kg payload/);
  assert.deepEqual(CONTROLLER_TUNED_RANGE, { sensor_delay_ms: { max: 40 }, actuator_delay_ms: { max: 20 }, floor_friction: { min: 0.6 }, payload_kg: { exactly: 20.0 }, load_friction: { not_stated: true } });
  // the controller states nothing about deck grip, so that axis is never "outside the tuned range"
  assert.doesNotMatch(doc, /load_friction|deck grip/);
  // and the searched envelope really is wider than the tuned range on the two axes the demo sells
  assert.ok(ENVELOPE.sensor_delay_ms.max > 40 && ENVELOPE.floor_friction.min < 0.6);
});

test("a sold scenario is positioned against both ranges, per parameter", () => {
  const sold = { ...NOMINAL_SCENARIO, sensor_delay_ms: 200, floor_friction: 0.3 };
  const pos = Object.fromEntries(rangePosition(sold).map((p) => [p.parameter, p.in_tuned_range]));
  assert.deepEqual(pos, { sensor_delay_ms: false, actuator_delay_ms: true, floor_friction: false, payload_kg: true, load_friction: true });
  assert.deepEqual(Object.fromEntries(rangePosition(NOMINAL_SCENARIO).map((p) => [p.parameter, p.in_tuned_range])), { sensor_delay_ms: true, actuator_delay_ms: true, floor_friction: true, payload_kg: true, load_friction: true });
});

test("sim/envelope.yaml publishes the same axes in GUARD's shape", () => {
  const yaml = fs.readFileSync(path.join(REPO_ROOT, "sim", "envelope.yaml"), "utf8");
  // Parse only the axis section: it starts at the first "- name:" entry and ends at the next top-level
  // key (the YAML also lists failure classes under their own key, and those entries use "- name:" too).
  const axisStart = yaml.search(/\n\s*- name: /);
  const rest = yaml.slice(axisStart);
  const axisEnd = rest.search(/\n[A-Za-z_]+:\s*(#.*)?$/m);
  const axisSection = axisEnd === -1 ? rest : rest.slice(0, axisEnd);
  const blocks = axisSection.split(/\n\s*- name: /).slice(1);
  assert.equal(blocks.length, PARAM_ORDER.length, "one block per envelope axis");
  const field = (block: string, key: string): string | null => block.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"))?.[1] ?? null;
  for (const block of blocks) {
    const name = block.split("\n")[0].trim() as (typeof PARAM_ORDER)[number];
    const spec = ENVELOPE[name];
    const axis = ENVELOPE_AXES.find((a) => a.name === name)!;
    assert.ok(spec, `${name} is a known axis`);
    assert.equal(Number(field(block, "low")), spec.min, `${name} low`);
    assert.equal(Number(field(block, "high")), spec.max, `${name} high`);
    assert.equal(Number(field(block, "nominal")), NOMINAL_SCENARIO[name], `${name} nominal`);
    assert.equal(field(block, "group"), axis.group, `${name} group`);
    assert.equal(field(block, "units"), axis.units, `${name} units`);
    // GUARD's distribution fields are present and deliberately null: no D is stated or estimated.
    assert.equal(field(block, "marginal"), "null", `${name} marginal`);
    assert.equal(field(block, "scale"), "null", `${name} scale`);
    assert.equal(field(block, "tuned_range"), `"${axis.tuned_range}"`, `${name} tuned_range`);
  }
});
