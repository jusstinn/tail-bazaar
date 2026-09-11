// RUN-RECORD BINDING (review round 3, finding 1). Once the delivered replay frames hash to the
// verifier's own re-run, the verifier used to stop reading: the package's `metrics`, `scene`,
// `events`, `ticks`, `claim` and the rest were never compared with the verifier's own run document,
// only the package claim against the SELLER's submission claim (both seller-supplied). A package with
// authentic poses and a fabricated impact speed of 999 m/s, an obstacle moved from 6 m to 100 m, or a
// failure class relabelled FELL was VERIFIED — and those fields are what the replay HUD, the
// narrative and the metrics table show, so the audience saw fabricated evidence over real poses.
//
// These tests pin the rule that closes it: after the trajectory binding, every run-derived section of
// the package must be byte-identical (canonical JSON) to the verifier's own re-run, the claim is
// compared with the claim the verifier derives from ITS run, and the first mismatch is INVALID with a
// check that names the section and the path. Only the fields the re-run cannot reproduce by
// construction (salt, seller, timestamp, hunt statistics, reproduction prose) are exempt.
//
// Runs the real verifier against the real simulator (uv + MuJoCo, ~1 s per re-run) with a throwaway
// database in a temp directory. No chain and no private keys are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Type-only imports are erased at compile time: they load no module before the environment below is set.
import type { Submission } from "../agents/seller.js";
import type { Scenario } from "../envelope.js";
import type { RunDoc } from "../sim.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-run-record-"));
process.env.DATABASE_PATH = path.join(tmp, "verifier-run-record-binding-test.sqlite");
delete process.env.PUBLIC_BASE_URL;

const { verifySubmission, RUN_RECORD_EXEMPT, firstDifference, runRecordMismatch, expectedRunRecord } = await import("../agents/verifier.js");
const { buildPrivatePackage, claimFromRun, SUBMISSION_SCHEMA } = await import("../agents/seller.js");
const { commitment, dumpsBytes } = await import("../canonical.js");
const { TARGETS } = await import("../targets.js");
const CART = TARGETS.cart;
const { ENVELOPE_ID } = await import("../envelope.js");
const { runScenario } = await import("../sim.js");

const CHECK = "package-run-record-matches-verifier-rerun";
// The public test seller address from the README (an address, never a key).
const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const SALT = ("0x" + "c3".repeat(32)) as `0x${string}`;
const SCENARIO: Scenario = { sensor_delay_ms: 200, actuator_delay_ms: 20, floor_friction: 0.3, payload_kg: 20.0 };
const quiet = () => {};
const HUNTER_RECORD = { id: "test-fixture", mode: "grid", target_id: "cart", search_cost: { simulations: 1, sim_steps: 0, wall_time_s: 0 }, counts: { simulations: 1, failures: 1, survived: 0, inconclusive: 0, by_class: { COLLISION: 1 } }, distinct_findings: 1, near_duplicates: 0 };

/** Everything the seller asserts about a package, exactly as agents/seller.ts assembles it. A forger
 *  who edits the package edits the submission to match, so the seller-side consistency checks
 *  (package-claim-matches, package-scenario-matches) pass and only the re-run can contradict it. */
function submissionFor(run: RunDoc, pkgDoc: Record<string, any>): { sub: Submission; bytes: Uint8Array } {
  const bytes = dumpsBytes(pkgDoc);
  const sub: Submission = {
    schema: SUBMISSION_SCHEMA,
    seller: SELLER,
    submitted_at: new Date().toISOString(),
    target_id: "cart",
    controller: pkgDoc.controller,
    envelope_id: ENVELOPE_ID,
    scenario: pkgDoc.scenario,
    claim: pkgDoc.claim,
    environment: pkgDoc.environment,
    trajectory_hash: pkgDoc.replay.trajectory_hash,
    mjcf_hash: run.mjcf_hash ?? null,
    metrics: pkgDoc.metrics,
    events: pkgDoc.events,
    hunter: pkgDoc.hunter,
    package_commitment: commitment(pkgDoc),
  };
  return { sub, bytes };
}

const fixture = await runScenario(CART, path.join(tmp, "seller"), "run-record-fixture", SCENARIO);
const honestPackage = buildPrivatePackage(CART, fixture.doc, SELLER, HUNTER_RECORD, SALT) as unknown as Record<string, any>;
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(honestPackage));
const named = (res: { checks: { name: string; ok: boolean; detail?: string }[] }, name: string) => res.checks.find((c) => c.name === name);

/** The forgery must be internally consistent, or an older check would catch it and prove nothing. */
async function verifyForgery(pkg: Record<string, any>) {
  const { sub, bytes } = submissionFor(fixture.doc, pkg);
  assert.equal(commitment(JSON.parse(Buffer.from(bytes).toString("utf8"))), sub.package_commitment, "the bytes hash to the stated commitment");
  assert.equal(commitment(pkg.replay.frames), pkg.replay.trajectory_hash, "the frames are the honest, untouched recording");
  return verifySubmission(sub, bytes, quiet);
}

function assertRejectedBy(res: Awaited<ReturnType<typeof verifySubmission>>, section: string, pathPattern: RegExp) {
  assert.equal(res.status, "REJECTED", `expected REJECTED, got ${res.status}: ${res.reason}`);
  assert.equal(res.verdict, "INVALID");
  const c = named(res, CHECK);
  assert.ok(c, `${CHECK} must have run`);
  assert.equal(c!.ok, false, `${CHECK} must fail`);
  assert.match(c!.detail ?? "", new RegExp(`section "${section}"`), `the detail names the section (${c!.detail})`);
  assert.match(c!.detail ?? "", pathPattern, `the detail names the differing path (${c!.detail})`);
  assert.match(res.reason, new RegExp(`section "${section}"`));
  // The checks that used to be the last word all passed: this forgery is exactly the one they miss.
  assert.equal(named(res, "package-commitment")?.ok, true);
  assert.equal(named(res, "package-frames-hash-to-declared-trajectory")?.ok, true);
  assert.equal(named(res, "package-frames-reproduce-verified-trajectory")?.ok, true, "the frames ARE the verifier's own trajectory; that is what made the forgery convincing");
  assert.equal(named(res, "replay-frames-physically-plausible")?.ok, true);
}

test("the fixture is a real collision and the unmodified package still verifies, with the run record bound", async () => {
  assert.equal(fixture.doc.outcome, "COLLISION", "fixture scenario must be a collision");
  const { sub, bytes } = submissionFor(fixture.doc, honestPackage);
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "VERIFIED", res.reason);
  assert.equal(res.verdict, "VALID");
  assert.equal(res.method, "exact-trajectory-hash");
  const c = named(res, CHECK);
  assert.equal(c?.ok, true, `${CHECK} must have run and passed: ${c?.detail}`);
  assert.match(c?.detail ?? "", /byte-identical/);
  assert.match(c?.detail ?? "", /exempt: salt_hex, seller, created_at, hunter, reproduce/, "the exemption list is on the record");
  assert.equal(named(res, "package-claim-matches")?.ok, true, "the older seller-side claim check still runs");
  assert.equal(named(res, "severity-band-consistent")?.ok, true);
});

// ------------------------------------------------------------------- the reviewer's three cases
test("impact speed 999 in the metrics table is INVALID: the metrics are not the verifier's", async () => {
  const pkg = clone();
  assert.ok(pkg.metrics.impact_speed_mps < 10, `honest impact speed is ${pkg.metrics.impact_speed_mps} m/s`);
  pkg.metrics.impact_speed_mps = 999; // the HUD and the metrics table read this field; the claim is left honest so the band check passes
  const res = await verifyForgery(pkg);
  assertRejectedBy(res, "metrics", /metrics\.impact_speed_mps: package 999 vs verifier re-run 0\.\d+/);
  assert.equal(named(res, "severity-band-consistent"), undefined, "the band check never reached it; it compares the claim, not the metrics");
});

test("the obstacle moved from 6 m to 100 m in the scene is INVALID: the scene is not the verifier's", async () => {
  const pkg = clone();
  assert.equal(pkg.scene.obstacle_front_x_m, 6, "the honest scene puts the obstacle face at 6 m");
  pkg.scene.obstacle_front_x_m = 100;
  pkg.scene.obstacle_center_m = [100 + pkg.scene.obstacle_half_m[0], pkg.scene.obstacle_center_m[1], pkg.scene.obstacle_center_m[2]];
  const res = await verifyForgery(pkg);
  assertRejectedBy(res, "scene", /scene\.obstacle_(center_m\[0\]|front_x_m): package 100/);
});

test("the failure class relabelled FELL is INVALID: the claim is compared with the verifier's own claim, not the seller's submission", async () => {
  const pkg = clone();
  assert.equal(pkg.claim.failure_class, "COLLISION");
  pkg.claim.failure_class = "FELL"; // outcome stays COLLISION, so reproduction, band and the seller-side claim check all pass
  const res = await verifyForgery(pkg);
  assertRejectedBy(res, "claim", /claim\.failure_class: package "FELL" vs verifier re-run "COLLISION"/);
  assert.equal(named(res, "claims-a-failure-class-of-this-target")?.ok, true, "outcome COLLISION is a cart failure class");
  assert.equal(named(res, "reproduces-the-claimed-failure")?.ok, true, "the collision does reproduce");
  assert.equal(named(res, "package-claim-matches"), undefined, "the seller-side check (package vs submission) would have passed: both were relabelled");
});

// --------------------------------------------------------------- the rest of the run record
test("events, ticks, initial state, termination rules and a foreign top-level field are all refused", async () => {
  // (The scenario itself is not in this list: it is what the verifier re-runs, so a package whose
  // scenario differs from the submission fails package-scenario-matches, and a submission whose
  // scenario differs from the seller's run fails reproduction or the trajectory binding first.)
  const cases: { label: string; mutate: (p: Record<string, any>) => void; section: string; path: RegExp }[] = [
    { label: "first-contact event time", mutate: (p) => { p.events[1].t_s = 0.5; }, section: "events", path: /events\[1\]\.t_s/ },
    { label: "a tick's range reading", mutate: (p) => { p.ticks[5].range_used_m = 0; }, section: "ticks", path: /ticks\[5\]\.range_used_m/ },
    { label: "initial state", mutate: (p) => { p.initial_state.total_mass_kg = 1; }, section: "initial_state", path: /initial_state\.total_mass_kg/ },
    { label: "initial state check", mutate: (p) => { p.initial_state_check.initial_range_m = 99; }, section: "initial_state_check", path: /initial_state_check\.initial_range_m/ },
    { label: "termination rules", mutate: (p) => { p.termination_rules.t_max_s = 1; }, section: "termination_rules", path: /termination_rules\.t_max_s/ },
    { label: "changed-conditions narrative", mutate: (p) => { p.changed_conditions[0].value = 0; }, section: "changed_conditions", path: /changed_conditions\[0\]\.value/ },
    { label: "a field the run record does not have", mutate: (p) => { p.hud_override = { impact_speed_mps: 999 }; }, section: "hud_override", path: /no such field in the verifier's run record/ },
  ];
  for (const c of cases) {
    const pkg = clone();
    c.mutate(pkg);
    const res = await verifyForgery(pkg);
    assert.equal(res.status, "REJECTED", `${c.label}: expected REJECTED, got ${res.status}: ${res.reason}`);
    const chk = named(res, CHECK);
    assert.equal(chk?.ok, false, `${c.label}: ${CHECK} must fail`);
    assert.match(chk?.detail ?? "", new RegExp(`section "${c.section}"`), `${c.label}: names the section (${chk?.detail})`);
    assert.match(chk?.detail ?? "", c.path, `${c.label}: names the path (${chk?.detail})`);
  }
});

test("the documented exemptions are exactly the fields the re-run cannot reproduce, and nothing else is exempt", async () => {
  assert.deepEqual(Object.keys(RUN_RECORD_EXEMPT).sort(), ["created_at", "hunter", "replay.frames", "reproduce", "salt_hex", "scene.mjcf_path", "seller", "target_id"]);
  const pkg = clone();
  pkg.created_at = "2001-01-01T00:00:00.000Z";
  pkg.salt_hex = "0x" + "d4".repeat(32);
  pkg.hunter.search_cost.wall_time_s = 12345.678;
  pkg.hunter.counts.simulations = 9999;
  pkg.reproduce.note = "rewritten prose";
  const { sub, bytes } = submissionFor(fixture.doc, pkg);
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "VERIFIED", `exempt fields may differ: ${res.reason}`);
  assert.equal(named(res, CHECK)?.ok, true);
  // Every section the package carries is either compared or exempt: nothing slips through unnamed.
  const compared = Object.keys(expectedRunRecord(CART, fixture.doc, claimFromRun(CART, fixture.doc)));
  for (const k of Object.keys(honestPackage)) {
    if (k === "schema" || k === "format") continue;
    assert.ok(compared.includes(k) || k in RUN_RECORD_EXEMPT, `package field ${k} is neither compared nor exempt`);
  }
  // The comparison walks canonical structures deterministically and reports the first differing path.
  assert.equal(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }, "x"), null);
  assert.deepEqual(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }, "x")?.path, "x.a[1].b");
  assert.deepEqual(firstDifference({ a: 1 }, { a: 1, z: 0 }, "x")?.path, "x.z");
  assert.deepEqual(firstDifference([1, 2], [1], "x")?.path, "x[1]");
  assert.equal(firstDifference(20, 20.0, "x"), null, "canonical numbers: 20 and 20.0 are the same document");
  assert.equal(runRecordMismatch(honestPackage, CART, fixture.doc, claimFromRun(CART, fixture.doc)), null);
});

test("cleanup", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
