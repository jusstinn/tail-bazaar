// THE VERIFIER, ON THE THIRD TARGET. The binding rules are not re-implemented per robot: the same
// verifier runs the arm's own CLI, recomputes the trajectory hash from the delivered frames, derives
// the plausibility ceiling from the arm's own envelope and scene, and abstains rather than certify a
// replay it cannot bind. These tests pin exactly that, against the real simulator.
//
// It runs the pinned MuJoCo / Gymnasium-Robotics Fetch environment through uv (a fraction of a second
// per re-run, plus the policy load) with a throwaway database in a temp directory, so the ledger
// starts empty and nothing here touches the demo data. No chain and no private keys are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Type-only imports are erased at compile time: they load no module before the environment below is set.
import type { Submission } from "../agents/seller.js";
import type { RunDoc } from "../sim.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-arm-"));
process.env.DATABASE_PATH = path.join(tmp, "verifier-arm-test.sqlite");
delete process.env.PUBLIC_BASE_URL;

const { verifySubmission } = await import("../agents/verifier.js");
const { buildPrivatePackage, claimFromRun, SUBMISSION_SCHEMA } = await import("../agents/seller.js");
const { commitment, dumpsBytes } = await import("../canonical.js");
const { runScenario } = await import("../sim.js");
const { TARGETS } = await import("../targets.js");
const ARM = TARGETS.arm;

// The public test seller address from the README (an address, never a key).
const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const SALT = ("0x" + "a7".repeat(32)) as `0x${string}`;
// The mildest finding in evidence/arm: one axis moved, grip friction to a quarter of the shipped
// value, on the environment's own fourth published pick-and-place problem.
const SCENARIO = { grip_friction: 0.25, init_seed: 3 };
const quiet = () => {};
const HUNTER = { id: "test-fixture", mode: "grid-grip", target_id: "arm", search_cost: { simulations: 1, sim_steps: 0, wall_time_s: 0 }, counts: { simulations: 1, failures: 1, survived: 0, inconclusive: 0, by_class: { DROPPED: 1, NOT_PLACED: 0 } }, distinct_findings: 1, near_duplicates: 0 };

function submissionFor(run: RunDoc, pkgDoc: Record<string, any>, over: { environment?: Record<string, unknown> } = {}): { sub: Submission; bytes: Uint8Array } {
  const bytes = dumpsBytes(pkgDoc);
  const sub: Submission = {
    schema: SUBMISSION_SCHEMA,
    seller: SELLER,
    submitted_at: new Date().toISOString(),
    target_id: "arm",
    controller: pkgDoc.controller,
    envelope_id: run.envelope_id,
    scenario: run.scenario,
    claim: claimFromRun(ARM, run),
    environment: over.environment ?? run.environment,
    trajectory_hash: run.trajectory_hash,
    mjcf_hash: run.mjcf_hash ?? null,
    metrics: run.metrics,
    events: run.events,
    hunter: HUNTER,
    package_commitment: commitment(pkgDoc),
  };
  return { sub, bytes };
}

const fixture = await runScenario(ARM, path.join(tmp, "seller"), "arm-fixture", SCENARIO);
const honestPackage = buildPrivatePackage(ARM, fixture.doc, SELLER, HUNTER, SALT) as unknown as Record<string, any>;
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(honestPackage));
const named = (res: { checks: { name: string; ok: boolean; detail?: string }[] }, name: string) => res.checks.find((c) => c.name === name);
const elsewhere = (env: Record<string, unknown>, field = "engine_version") => ({ ...env, [field]: `${String(env[field])}-elsewhere` });

test("the fixture is a real drop decided by a mechanical predicate, and the honest package verifies", async () => {
  assert.equal(fixture.doc.outcome, "DROPPED");
  assert.equal(fixture.doc.metrics.success_predicate_mismatches, 0, "the environment's own success flag and the recomputed distance never disagreed");
  assert.equal(fixture.doc.metrics.ever_grasped, true, "it really was holding the part before it let go");
  const { sub, bytes } = submissionFor(fixture.doc, honestPackage);
  assert.equal(sub.claim.severity_proxy, "object_impact_speed_mps");
  assert.equal(sub.claim.failure_class, "DROPPED");
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "VERIFIED", res.reason);
  assert.equal(res.verdict, "VALID");
  assert.equal(res.method, "exact-trajectory-hash", "the only method that can certify a replay, on any target");
  assert.equal(res.target_id, "arm");
  for (const name of ["claimed-subject-is-the-one-re-run", "package-subject-is-the-one-re-run", "package-target-matches", "package-frames-hash-to-declared-trajectory", "replay-frames-physically-plausible", "package-frames-reproduce-verified-trajectory"])
    assert.equal(named(res, name)?.ok, true, `${name} must have run and passed`);
  // The claim is bound to the pinned POLICY CHECKPOINT, not to a repo name or a file path.
  assert.match(res.verifier_run!.controller.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(res.verifier_run!.controller.id, "intelligrow-fetch-pick-and-place-v4-sac-her");
  // The replay a buyer will be shown carries the goal site, which is not a body and so not in frames.
  assert.equal(Array.isArray(honestPackage.goal_m), true, "the package carries the fixed goal position the renderer needs");
  assert.equal(honestPackage.replay.renderer, "arm-3d");
});

test("a package naming a policy checkpoint the verifier did not re-run is rejected", async () => {
  const pkg = clone();
  pkg.controller = { id: "some-other-pick-and-place-policy", hash: "sha256:" + "ab".repeat(32) };
  const { sub, bytes } = submissionFor(fixture.doc, pkg);
  assert.equal(commitment(JSON.parse(Buffer.from(bytes).toString("utf8"))), sub.package_commitment, "the forgery is internally consistent");
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "REJECTED");
  assert.equal(res.verdict, "INVALID");
  assert.match(res.reason, /policy checkpoint/i);
  assert.equal(named(res, "claimed-subject-is-the-one-re-run")?.ok, false);
});

test("a fabricated arm replay is refused on its own terms", async () => {
  const pkg = clone();
  // Teleport the part 60 m inside one 40 ms frame: 1500 m/s, twenty times anything this scene can do.
  const oi = pkg.replay.frames.bodies.indexOf("object0");
  pkg.replay.frames.data[8][1 + 7 * oi] += 60;
  pkg.replay.trajectory_hash = commitment(pkg.replay.frames); // and every hash recomputed over it
  const environment = elsewhere(fixture.doc.environment); // and the fingerprint forced to mismatch
  pkg.environment = environment;
  const { sub } = submissionFor(fixture.doc, pkg, { environment });
  sub.trajectory_hash = pkg.replay.trajectory_hash;
  sub.package_commitment = commitment(pkg);
  const res = await verifySubmission(sub, dumpsBytes(pkg), quiet);
  assert.equal(res.status, "REJECTED", res.reason);
  assert.equal(named(res, "replay-frames-physically-plausible")?.ok, false);
  assert.equal(named(res, "package-frames-hash-to-declared-trajectory")?.ok, true, "the recomputed declared hash passes: it is not what saves us");
  assert.match(res.reason, /physically possible/i);
});

test("an honest arm package from a different environment is INCONCLUSIVE, never VALID", async () => {
  // This is not hypothetical for this target: the same scenario and the same pinned dependency set
  // produce the same OUTCOME and a different trajectory hash on macOS arm64 and on Linux x86_64.
  const pkg = clone();
  const environment = elsewhere(fixture.doc.environment, "platform");
  pkg.environment = environment;
  const { sub, bytes } = submissionFor(fixture.doc, pkg, { environment });
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "INCONCLUSIVE");
  assert.equal(res.verdict, "INCONCLUSIVE");
  assert.equal(res.method, null);
  assert.equal(named(res, "replay-frames-physically-plausible")?.ok, true, "the evidence is otherwise honest");
  assert.equal(named(res, "metrics-agree-across-environments")?.ok, true, "the metrics DO agree — that is precisely what must not be enough");
  assert.match(res.reason, /cannot be certified/i);
});

test("a claim that is not one of this target's failure classes is not a failure finding", async () => {
  const pkg = clone();
  const { sub, bytes } = submissionFor(fixture.doc, pkg);
  sub.claim = { ...sub.claim, outcome: "FELL" }; // the humanoid's class, on the arm's envelope
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "REJECTED");
  assert.equal(named(res, "claims-a-failure-class-of-this-target")?.ok, false);
  assert.match(res.reason, /not a failure finding/);
});

test("cleanup", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
