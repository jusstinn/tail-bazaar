// ADVERSARIAL VERIFICATION. An external reviewer showed that a FABRICATED replay could be certified:
// they rewrote the recorded frames (the cart moved 100 m inside one 20 ms tick), recomputed the
// seller's own declared hashes over the tampered frames so the package was internally consistent, and
// altered the claimed environment so the fingerprint would not match the verifier's. The verifier then
// fell back to comparing two headline metrics - which genuinely agreed, because the SCENARIO really
// does collide - and returned VERIFIED with no failed check. The collision reproduced; the delivered
// replay was fiction.
//
// These tests pin the rule that closes it: a delivered replay is certified only when the verifier can
// bind it exactly (same environment fingerprint AND frames that recompute to the verifier's own re-run
// hash), an unbindable replay is INCONCLUSIVE rather than VALID, and a replay that is not a physically
// possible trajectory of this scene is INVALID on its own terms.
//
// Runs the real verifier against the real simulator (uv + MuJoCo, ~1 s per re-run) with a throwaway
// database in a temp directory, so the ledger starts empty and nothing here touches the demo data.
// No chain and no private keys are needed: the only call that would reach a chain is the one this
// suite proves is never made.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Type-only imports are erased at compile time: they load no module before the environment below is set.
import type { Submission } from "../agents/seller.js";
import type { Scenario } from "../envelope.js";
import type { RunDoc } from "../sim.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-adversarial-"));
process.env.DATABASE_PATH = path.join(tmp, "verifier-adversarial-test.sqlite");
delete process.env.PUBLIC_BASE_URL;

const { verifySubmission, verifyAndList, checkReplayPlausibility, replayLimitsFrom, SIM_POSITION_BOUND_M } = await import("../agents/verifier.js");
const { buildPrivatePackage, claimFromRun, SUBMISSION_SCHEMA } = await import("../agents/seller.js");
const { commitment, keccakHex, dumpsBytes } = await import("../canonical.js");
const { TARGETS } = await import("../targets.js");
const CART = TARGETS.cart;
const { ENVELOPE_ID } = await import("../envelope.js");
const { getDb } = await import("../db.js");
const { runScenario } = await import("../sim.js");

// The public test seller address from the README (an address, never a key).
const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const SALT = ("0x" + "a7".repeat(32)) as `0x${string}`;
const SCENARIO: Scenario = { sensor_delay_ms: 200, actuator_delay_ms: 20, floor_friction: 0.3, payload_kg: 20.0 };
const quiet = () => {};
const HUNTER_RECORD = { id: "test-fixture", mode: "grid", target_id: "cart", search_cost: { simulations: 1, sim_steps: 0, wall_time_s: 0 }, counts: { simulations: 1, failures: 1, survived: 0, inconclusive: 0, by_class: { COLLISION: 1 } }, distinct_findings: 1, near_duplicates: 0 };

/** Everything the seller asserts about a package, exactly as agents/seller.ts assembles it. The
 *  overrides are the forger's levers: what environment is claimed, and what trajectory hash. */
function submissionFor(run: RunDoc, pkgDoc: Record<string, any>, over: { environment?: Record<string, unknown>; trajectory_hash?: string } = {}): { sub: Submission; bytes: Uint8Array } {
  const bytes = dumpsBytes(pkgDoc);
  const sub: Submission = {
    schema: SUBMISSION_SCHEMA,
    seller: SELLER,
    submitted_at: new Date().toISOString(),
    target_id: "cart",
    controller: pkgDoc.controller,
    envelope_id: ENVELOPE_ID,
    scenario: run.scenario,
    claim: claimFromRun(CART, run),
    environment: over.environment ?? run.environment,
    trajectory_hash: over.trajectory_hash ?? run.trajectory_hash,
    mjcf_hash: run.mjcf_hash ?? null,
    metrics: run.metrics,
    events: run.events,
    hunter: HUNTER_RECORD,
    package_commitment: commitment(pkgDoc),
  };
  return { sub, bytes };
}

const fixture = await runScenario(CART, path.join(tmp, "seller"), "adversarial-fixture", SCENARIO);
const honestPackage = buildPrivatePackage(CART, fixture.doc, SELLER, HUNTER_RECORD, SALT) as unknown as Record<string, any>;
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(honestPackage));
const named = (res: { checks: { name: string; ok: boolean; detail?: string }[] }, name: string) => res.checks.find((c) => c.name === name);
const rows = (table: string) => Number((getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
/** A fingerprinted field of the environment pin, changed so the two fingerprints cannot match. */
const elsewhere = (env: Record<string, unknown>, field = "engine_version") => ({ ...env, [field]: `${String(env[field])}-elsewhere` });

test("the fixture is a real collision and the honest package still verifies", async () => {
  assert.equal(fixture.doc.outcome, "COLLISION", "fixture scenario must be a collision");
  const { sub, bytes } = submissionFor(fixture.doc, honestPackage);
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "VERIFIED", res.reason);
  assert.equal(res.verdict, "VALID");
  assert.equal(res.method, "exact-trajectory-hash", "the only method that can certify a replay");
  assert.equal(named(res, "environment-fingerprint-matches")?.ok, true);
  assert.equal(named(res, "replay-frames-physically-plausible")?.ok, true);
  assert.equal(named(res, "package-frames-reproduce-verified-trajectory")?.ok, true);
});

// ---------------------------------------------------------------------- the reviewer's exact attack
test("the reviewer's fabricated replay is refused: frames rewritten, every hash recomputed, environment altered", async () => {
  const pkg = clone();
  const JUMP_M = 100; // the reviewer's move: the cart teleports 100 m inside a single 20 ms tick
  const FRAME = 10;
  pkg.replay.frames.data[FRAME][1] = pkg.replay.frames.data[FRAME][1] + JUMP_M; // chassis x
  // The forger then recomputes the seller's declared hashes over the tampered frames ...
  pkg.replay.trajectory_hash = commitment(pkg.replay.frames);
  // ... and alters the claimed environment so the fingerprint cannot match, which used to downgrade
  // verification to a comparison of two metrics the honest scenario satisfies anyway.
  const environment = elsewhere(fixture.doc.environment);
  pkg.environment = environment;
  const { sub, bytes } = submissionFor(fixture.doc, pkg, { environment, trajectory_hash: pkg.replay.trajectory_hash });

  // The forgery is internally consistent, which is exactly why hashes alone did not catch it.
  assert.equal(keccakHex(bytes), sub.package_commitment, "the bytes hash to the stated commitment");
  assert.equal(commitment(pkg.replay.frames), pkg.replay.trajectory_hash, "the declared trajectory hash is the hash of the frames actually shipped");

  const res = await verifySubmission(sub, bytes, quiet);
  assert.notEqual(res.status, "VERIFIED", `a fabricated replay must never be certified (got ${res.status}: ${res.reason})`);
  assert.notEqual(res.verdict, "VALID");
  assert.equal(res.status, "REJECTED", "an impossible trajectory is INVALID on its own terms, not merely unbound");
  assert.equal(res.verdict, "INVALID");
  // The check that catches it, and the checks that show why nothing else did.
  assert.equal(named(res, "replay-frames-physically-plausible")?.ok, false, "the 100 m jump must be caught as physically impossible");
  assert.equal(named(res, "environment-fingerprint-matches")?.ok, false, "the forger did force the fingerprint mismatch");
  assert.equal(named(res, "package-commitment")?.ok, true, "the commitment check passes: it is not what saves us");
  assert.equal(named(res, "package-frames-hash-to-declared-trajectory")?.ok, true, "the recomputed declared hash passes: it is not what saves us");
  assert.match(res.reason, /physically possible/i);
  assert.match(named(res, "replay-frames-physically-plausible")?.detail ?? "", /m\/s/, "the failing check states the implied speed and the ceiling it broke");
});

test("the same fabricated replay is refused even when the forger leaves the environment honest", async () => {
  const pkg = clone();
  pkg.replay.frames.data[10][1] = pkg.replay.frames.data[10][1] + 100;
  pkg.replay.trajectory_hash = commitment(pkg.replay.frames);
  const { sub, bytes } = submissionFor(fixture.doc, pkg, { trajectory_hash: pkg.replay.trajectory_hash });
  const res = await verifySubmission(sub, bytes, quiet);
  assert.notEqual(res.status, "VERIFIED");
  assert.equal(named(res, "environment-fingerprint-matches")?.ok, true, "this forger did not touch the environment");
  assert.equal(named(res, "replay-frames-physically-plausible")?.ok, false);
});

// -------------------------------------------------------- environment mismatch: abstain, never pay
test("an honest package re-submitted under a different environment is INCONCLUSIVE, and no money moves", async () => {
  const pkg = clone();
  const environment = elsewhere(fixture.doc.environment, "platform");
  pkg.environment = environment;
  const { sub, bytes } = submissionFor(fixture.doc, pkg, { environment });

  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "INCONCLUSIVE");
  assert.equal(res.verdict, "INCONCLUSIVE", "the project's vocabulary: VALID / INVALID / INCONCLUSIVE");
  assert.equal(res.method, null, "no method certifies a replay the verifier cannot bind");
  assert.equal(res.fingerprint_match, false);
  assert.equal(named(res, "environment-fingerprint-matches")?.ok, false);
  assert.equal(named(res, "replay-frames-physically-plausible")?.ok, true, "the evidence is otherwise honest");
  assert.equal(named(res, "metrics-agree-across-environments")?.ok, true, "the metrics DO agree - that is precisely what must not be enough");
  assert.equal(named(res, "package-frames-reproduce-verified-trajectory"), undefined, "the exact binding was never reached, so nothing was certified");
  assert.match(res.reason, /INCONCLUSIVE/);
  assert.match(res.reason, /environment differs/i);
  assert.match(res.reason, /cannot be certified/i);

  // Money. verifyAndList is the only path that escrows anything: on a non-VERIFIED verdict it must
  // register no listing and store no package, so there is nothing to fund, deliver or settle. (It
  // would have to reach a chain to do any of that, and no chain is running in this suite.)
  assert.equal(rows("listings"), 0);
  const out = await verifyAndList(sub, bytes, { priceWei: 1000000000000000n, demoTamper: false }, quiet);
  assert.equal(out.result.verdict, "INCONCLUSIVE");
  assert.equal(out.listingId, null, "no listing id: nothing was registered on chain");
  assert.equal(out.summary, null, "no public summary: nothing was advertised");
  assert.equal(rows("listings"), 0, "no listing row");
  assert.equal(rows("private_packages"), 0, "no package held for delivery");
  assert.equal(rows("orders"), 0, "no order, therefore no escrowed funds");
  const led = getDb().prepare("SELECT verification_status, listing_id FROM ledger WHERE finding_id = ?").get(sub.package_commitment) as { verification_status: string; listing_id: string | null };
  assert.equal(led.verification_status, "INCONCLUSIVE", "the abstention is recorded in the ledger");
  assert.equal(led.listing_id, null);
});

// ------------------------------------------------------------------- the existing protection holds
test("a tampered replay whose declared hash was left intact is still rejected in a matching environment", async () => {
  const pkg = clone();
  const before = pkg.replay.trajectory_hash;
  pkg.replay.frames.data[12][1] = pkg.replay.frames.data[12][1] + 0.25; // a small, physically possible nudge
  assert.equal(pkg.replay.trajectory_hash, before, "the declared trajectory hash is left untouched");
  const { sub, bytes } = submissionFor(fixture.doc, pkg);
  assert.equal(sub.trajectory_hash, pkg.replay.trajectory_hash, "the declared hash still matches the submission and the verifier's own re-run");
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "REJECTED");
  assert.equal(res.verdict, "INVALID");
  assert.match(res.reason, /frames/i);
  assert.equal(named(res, "package-trajectory-matches")?.ok, true, "the declared hash alone would have passed");
  assert.equal(named(res, "package-frames-hash-to-declared-trajectory")?.ok, false, "recomputing from the delivered frames exposes it");
});

test("a physically possible forgery in a matching environment is not certified either", async () => {
  const pkg = clone();
  pkg.replay.frames.data[12][1] = pkg.replay.frames.data[12][1] + 0.05; // 2.5 m/s over one tick: plausible
  pkg.replay.trajectory_hash = commitment(pkg.replay.frames); // and every hash recomputed
  const { sub, bytes } = submissionFor(fixture.doc, pkg, { trajectory_hash: pkg.replay.trajectory_hash });
  const res = await verifySubmission(sub, bytes, quiet);
  assert.notEqual(res.status, "VERIFIED");
  assert.notEqual(res.verdict, "VALID");
  assert.equal(named(res, "replay-frames-physically-plausible")?.ok, true, "plausible, and still not bound");
  assert.equal(named(res, "trajectory-hash-identical")?.ok, false, "it is not the trajectory the verifier re-ran");
});

// --------------------------------------------------------------------------- the threshold itself
test("the plausibility ceiling is derived from the scene, not chosen", async () => {
  const limits = replayLimitsFrom(fixture.doc);
  // sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_obstacle), with mu_max = 1.0 (top of the published
  // floor_friction axis), g = 9.81, d_max = 100 m (the simulator's own DIVERGED bound) and
  // h_obstacle = 1.0 m (the scene's tallest structure): about 67 m/s.
  const expected = Math.sqrt(2 * 2 * 9.81 * SIM_POSITION_BOUND_M) + Math.sqrt(2 * 9.81 * 1.0);
  assert.ok(Math.abs(limits.speed_ceiling_mps - expected) < 1e-9, `ceiling ${limits.speed_ceiling_mps} vs ${expected}`);
  assert.equal(limits.position_bound_m, 100);
  assert.equal(limits.dt_s, fixture.doc.frames.dt_s);
  assert.match(limits.derivation, /mu_max/);
  // The derivation is quoted in the delivery record, which is served by the public orders endpoint,
  // so it must name no envelope parameter (the same discipline operatingContext() follows).
  for (const marker of ["sensor_delay_ms", "actuator_delay_ms", "floor_friction", "payload_kg", "salt_hex", "trajectory_hash"])
    assert.ok(!limits.derivation.includes(marker), `the published derivation must not contain ${marker}`);

  // The honest recording sits far below the ceiling; the reviewer's frame sits far above it. Nothing
  // physical lies in between, which is why this is an impossibility line and not a tolerance.
  const honest = checkReplayPlausibility(fixture.doc.frames, limits);
  assert.equal(honest.ok, true, honest.detail);
  assert.ok(honest.max_speed_mps! < limits.speed_ceiling_mps / 10, `honest replay peaks at ${honest.max_speed_mps} m/s, ceiling ${limits.speed_ceiling_mps}`);
  const forged = JSON.parse(JSON.stringify(fixture.doc.frames));
  forged.data[10][1] = forged.data[10][1] + 100;
  assert.equal(checkReplayPlausibility(forged, limits).ok, false, "100 m in one 20 ms tick is 5000 m/s");

  // Stretching time to make the jump look slow does not help: the recording interval must be the
  // pinned control tick the verifier itself recorded.
  const stretched = JSON.parse(JSON.stringify(forged));
  stretched.dt_s = 100;
  for (let i = 0; i < stretched.data.length; i++) stretched.data[i][0] = i * 100;
  const res = checkReplayPlausibility(stretched, limits);
  assert.equal(res.ok, false);
  assert.match(res.detail, /dt_s/);
});

test("cleanup", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
