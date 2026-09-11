// EVIDENCE BINDING (P2). The verifier re-runs the scenario; these tests check that what it verifies
// is bound to what it actually re-ran, not to what the seller declared:
//   (1) a package that declares a controller hash the verifier did not re-run must be REJECTED
//   (2) a package whose replay frames were altered while its declared trajectory hash was left
//       intact must be REJECTED
//   (3) the honest package must still pass
// Runs the real verifier against the real simulator (uv + MuJoCo, ~1 s per re-run) with a throwaway
// database in a temp directory, so the ledger starts empty and nothing here touches the demo data.
// No chain and no private keys are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Type-only imports are erased at compile time: they load no module before the environment below is set.
import type { Submission } from "../agents/seller.js";
import type { Scenario } from "../envelope.js";
import type { RunDoc } from "../sim.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-binding-"));
process.env.DATABASE_PATH = path.join(tmp, "verifier-binding-test.sqlite");
delete process.env.PUBLIC_BASE_URL;

const { verifySubmission } = await import("../agents/verifier.js");
const { buildPrivatePackage, claimFromRun, SUBMISSION_SCHEMA } = await import("../agents/seller.js");
const { commitment, dumpsBytes } = await import("../canonical.js");
const { ENVELOPE_ID } = await import("../envelope.js");
const { runScenario } = await import("../sim.js");

// The public test seller address from the README (an address, never a key).
const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const SALT = ("0x" + "5a".repeat(32)) as `0x${string}`;
const SCENARIO: Scenario = { sensor_delay_ms: 200, actuator_delay_ms: 20, floor_friction: 0.3, payload_kg: 20.0 };
const quiet = () => {};

/** Everything the seller asserts about a package, exactly as agents/seller.ts assembles it. */
function submissionFor(run: RunDoc, pkgDoc: Record<string, any>): { sub: Submission; bytes: Uint8Array } {
  const bytes = dumpsBytes(pkgDoc);
  const sub: Submission = {
    schema: SUBMISSION_SCHEMA,
    seller: SELLER,
    submitted_at: new Date().toISOString(),
    controller: pkgDoc.controller,
    envelope_id: ENVELOPE_ID,
    scenario: run.scenario,
    claim: claimFromRun(run),
    environment: run.environment,
    trajectory_hash: run.trajectory_hash,
    mjcf_hash: run.mjcf_hash ?? null,
    metrics: run.metrics,
    events: run.events,
    hunter: { id: "test-fixture", mode: "grid", search_cost: { simulations: 1, sim_steps: 0, wall_time_s: 0 }, counts: { success: 0, collision: 1, inconclusive: 0 } },
    package_commitment: commitment(pkgDoc),
  };
  return { sub, bytes };
}

const fixture = await runScenario(path.join(tmp, "seller"), "binding-fixture", SCENARIO);
const honestPackage = buildPrivatePackage(fixture.doc, SELLER, SALT) as unknown as Record<string, any>;
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(honestPackage));
const named = (res: { checks: { name: string; ok: boolean }[] }, name: string) => res.checks.find((c) => c.name === name);

test("the honest package verifies, and the binding checks actually ran", async () => {
  assert.equal(fixture.doc.outcome, "COLLISION", "fixture scenario must be a collision");
  const { sub, bytes } = submissionFor(fixture.doc, honestPackage);
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "VERIFIED", res.reason);
  assert.equal(res.verdict, "VALID");
  assert.equal(res.method, "exact-trajectory-hash");
  for (const name of ["claimed-controller-is-the-one-re-run", "package-controller-is-the-one-re-run", "package-frames-hash-to-declared-trajectory", "package-frames-reproduce-verified-trajectory"]) {
    assert.equal(named(res, name)?.ok, true, `${name} must have run and passed`);
  }
});

test("a package declaring a controller the verifier did not re-run is rejected", async () => {
  const pkg = clone();
  pkg.controller = { id: "stop-before-obstacle-v2", hash: "sha256:" + "ab".repeat(32) };
  const { sub, bytes } = submissionFor(fixture.doc, pkg);
  // The seller is internally consistent: the package hashes to its stated commitment and the claimed
  // controller matches the package. Only the re-run contradicts it.
  assert.equal(commitment(JSON.parse(Buffer.from(bytes).toString("utf8"))), sub.package_commitment);
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "REJECTED");
  assert.equal(res.verdict, "INVALID");
  assert.match(res.reason, /controller/i);
  assert.match(res.reason, /verifier re-ran/i);
  assert.equal(named(res, "claimed-controller-is-the-one-re-run")?.ok, false);
  assert.equal(res.verifier_run?.controller.id, "stop-before-obstacle-v1");
});

test("a package whose replay frames were altered behind an intact declared hash is rejected", async () => {
  const pkg = clone();
  const before = pkg.replay.trajectory_hash;
  pkg.replay.frames.data[10][1] = pkg.replay.frames.data[10][1] + 0.25; // move the chassis in frame 10
  pkg.replay.frames.data.pop(); // and drop the last recorded frame
  assert.equal(pkg.replay.trajectory_hash, before, "the declared trajectory hash is left untouched");
  const { sub, bytes } = submissionFor(fixture.doc, pkg);
  // The declared hash still matches the submission and the verifier's own re-run; only recomputing
  // the hash from the delivered frames exposes the alteration.
  assert.equal(sub.trajectory_hash, pkg.replay.trajectory_hash);
  assert.notEqual(commitment(pkg.replay.frames), pkg.replay.trajectory_hash);
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "REJECTED");
  assert.equal(res.verdict, "INVALID");
  assert.match(res.reason, /frames/i);
  assert.equal(named(res, "package-frames-hash-to-declared-trajectory")?.ok, false);
  assert.equal(named(res, "package-trajectory-matches")?.ok, true, "the declared hash alone would have passed");
});

test("cleanup", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
