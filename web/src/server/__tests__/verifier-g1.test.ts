// THE VERIFIER, ON THE FOURTH TARGET. The binding rules are not re-implemented per robot: the same
// verifier runs the G1's own CLI (Unitree's pretrained TorchScript policy under MuJoCo), recomputes the
// trajectory hash from the delivered frames, derives the plausibility ceiling from the G1's own envelope
// and scene, and abstains rather than certify a replay it cannot bind. Against the real simulator.
//
// It runs the pinned MuJoCo + torch G1 through uv (a few seconds per re-run, mostly torch import) with
// a throwaway database in a temp directory, so the ledger starts empty and nothing here touches the demo
// data. No chain and no private keys are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Submission } from "../agents/seller.js";
import type { RunDoc } from "../sim.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-g1-"));
process.env.DATABASE_PATH = path.join(tmp, "verifier-g1-test.sqlite");
delete process.env.PUBLIC_BASE_URL;

const { verifySubmission } = await import("../agents/verifier.js");
const { buildPrivatePackage, claimFromRun, SUBMISSION_SCHEMA } = await import("../agents/seller.js");
const { commitment, dumpsBytes } = await import("../canonical.js");
const { runScenario } = await import("../sim.js");
const { TARGETS } = await import("../targets.js");
const G1 = TARGETS.g1;

const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const SALT = ("0x" + "d4".repeat(32)) as `0x${string}`;
// The mildest finding in evidence/g1: one 28 N*s shove from the side at t = 3.0 s, nothing else moved.
const SCENARIO = { push_impulse_ns: 28.0, push_heading_deg: 90.0 };
const quiet = () => {};
const HUNTER = { id: "test-fixture", mode: "grid-push", target_id: "g1", search_cost: { simulations: 1, sim_steps: 0, wall_time_s: 0 }, counts: { simulations: 1, failures: 1, survived: 0, inconclusive: 0, by_class: { FELL: 1 } }, distinct_findings: 1, near_duplicates: 0 };

function submissionFor(run: RunDoc, pkgDoc: Record<string, any>, over: { environment?: Record<string, unknown> } = {}): { sub: Submission; bytes: Uint8Array } {
  const bytes = dumpsBytes(pkgDoc);
  const sub: Submission = {
    schema: SUBMISSION_SCHEMA,
    seller: SELLER,
    submitted_at: new Date().toISOString(),
    target_id: "g1",
    controller: pkgDoc.controller,
    envelope_id: run.envelope_id,
    scenario: run.scenario,
    claim: claimFromRun(G1, run),
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

const fixture = await runScenario(G1, path.join(tmp, "seller"), "g1-fixture", SCENARIO);
const honestPackage = buildPrivatePackage(G1, fixture.doc, SELLER, HUNTER, SALT) as unknown as Record<string, any>;
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(honestPackage));
const named = (res: { checks: { name: string; ok: boolean; detail?: string }[] }, name: string) => res.checks.find((c) => c.name === name);
const elsewhere = (env: Record<string, unknown>, field = "torch_version") => ({ ...env, [field]: `${String(env[field])}-elsewhere` });

test("the fixture is a real fall decided by this project's stated predicate, and the honest package verifies", async () => {
  assert.equal(fixture.doc.outcome, "FELL");
  const fell = fixture.doc.events.find((e: any) => e.type === "fall_predicate_fired") as any;
  assert.ok(fell, "the run records which condition fired and when");
  assert.match(String(fell.owner), /this project/);
  const { sub, bytes } = submissionFor(fixture.doc, honestPackage);
  assert.equal(sub.claim.severity_proxy, "pelvis_impact_speed_mps");
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "VERIFIED", res.reason);
  assert.equal(res.verdict, "VALID");
  assert.equal(res.method, "exact-trajectory-hash");
  assert.equal(res.target_id, "g1");
  for (const name of ["claimed-subject-is-the-one-re-run", "package-subject-is-the-one-re-run", "package-target-matches", "package-frames-hash-to-declared-trajectory", "replay-frames-physically-plausible", "package-frames-reproduce-verified-trajectory", "package-run-record-matches-verifier-rerun"])
    assert.equal(named(res, name)?.ok, true, `${name} must have run and passed`);
  // The claim is bound to the pinned POLICY FILE's bytes, not to a path or a repo name.
  assert.equal(res.verifier_run!.controller.id, "unitree-rl-gym-g1-motion-pt");
  assert.equal(res.verifier_run!.controller.hash, "sha256:cf668f75b90d1abf73d2b87612a6e76bccc61ff7e083b63582d3f6aaa3c1759d");
});

test("a package naming a policy checkpoint the verifier did not re-run is rejected", async () => {
  const pkg = clone();
  pkg.controller = { id: "some-other-g1-policy", hash: "sha256:" + "ab".repeat(32) };
  const { sub, bytes } = submissionFor(fixture.doc, pkg);
  assert.equal(commitment(JSON.parse(Buffer.from(bytes).toString("utf8"))), sub.package_commitment, "the forgery is internally consistent");
  const res = await verifySubmission(sub, bytes, quiet);
  assert.equal(res.status, "REJECTED");
  assert.equal(res.verdict, "INVALID");
  assert.match(res.reason, /policy checkpoint/i);
  assert.equal(named(res, "claimed-subject-is-the-one-re-run")?.ok, false);
});

test("a fabricated G1 replay is refused on its own terms", async () => {
  const pkg = clone();
  // Teleport the pelvis 60 m inside one 20 ms frame: 3000 m/s, far above anything this scene can do.
  pkg.replay.frames.data[8][1] = pkg.replay.frames.data[8][1] + 60;
  pkg.replay.trajectory_hash = commitment(pkg.replay.frames);
  const environment = elsewhere(fixture.doc.environment);
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

test("an honest G1 package from a different environment is INCONCLUSIVE, never VALID", async () => {
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

test("cleanup", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
