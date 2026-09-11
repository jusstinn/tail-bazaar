import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAdmissible, isDuplicate, scenarioDistance, severityBand, NOMINAL_SCENARIO } from "../envelope.js";

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
