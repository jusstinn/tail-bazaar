// VERIFIER AGENT (local demonstration mode, but the same logic a deployed verifier would run).
// It is MULTI-TARGET: the target is read from the submission, and every rule below comes from that
// target's entry in the registry (targets.ts). The rules themselves are identical for every target.
//
// Verification semantics (documented in README):
//   1. structural + admissibility checks against THAT TARGET'S published envelope (out of envelope
//      -> REJECTED)
//   2. duplicate rule against the failure ledger, within the same target and the same subject
//      (normalized L-inf distance < 0.05 -> REJECTED_DUPLICATE)
//   3. the claim must name one of the target's own failure classes (anything else is not a failure
//      finding -> REJECTED)
//   4. re-run the scenario with THE TARGET'S OWN CLI in the verifier's OWN pinned environment
//   5. EVIDENCE BINDING (a): the claimed subject — the controller file for the cart, the pinned
//      policy checkpoint's actor-tensor digest for the humanoid — must equal the one the verifier
//      actually re-ran. A seller cannot mislabel the artefact under test.
//   6. the private package must be canonical, hash to the seller's stated commitment, and carry the
//      same scenario, subject, trajectory hash and claim as the verified run. EVIDENCE BINDING
//      (b): the trajectory hash is RECOMPUTED from the delivered replay frames, never read from the
//      package's declared field, so altered frames behind an intact declared hash are rejected.
//   7. PHYSICAL PLAUSIBILITY: the delivered frames are read as a trajectory and must stay inside the
//      world the simulator models, at speeds the scene can physically produce. The bound is derived
//      per target from its own published envelope and the scene the run carries (targets.ts:
//      replayLimitsFrom). A fabricated replay is INVALID on its own terms, not merely unbound.
//   8. EVIDENCE BINDING (c): the delivered replay is certified ONLY when the verifier can bind it
//      exactly - the seller's environment fingerprint equals the verifier's own AND the trajectory
//      hash recomputed from the delivered frames equals the hash of the verifier's own re-run
//      (method "exact-trajectory-hash"). If the environment fingerprint differs, the verifier CANNOT
//      bind the delivered replay to anything it ran, so the verdict is INCONCLUSIVE: the instrument
//      abstains rather than certifying evidence it cannot check. Agreement of the headline metrics
//      across differing environments is recorded in `checks` as evidence and never certifies
//      anything on its own.
//   9. EVIDENCE BINDING (d): once the frames are bound, every other run-derived section of the
//      package (scene, metrics, events, ticks, claim, scenario, initial state, termination rules,
//      environment, ...) must be byte-identical, after canonicalization, to the verifier's OWN run
//      document. Those sections drive the replay HUD, the narrative and the metrics table; a package
//      with authentic poses and a fabricated impact speed, a moved obstacle or a relabelled failure
//      class is REJECTED (`package-run-record-matches-verifier-rerun`). The only exempt fields are
//      the ones the re-run cannot reproduce by construction, listed in RUN_RECORD_EXEMPT.
//  10. publish a public summary (target, failure class, severity band, verdict, seller history — no
//      parameters, no trajectory), register the listing on chain
import path from "node:path";
import type { Hex } from "viem";
import { commitment, dumps, dumpsBytes, isCanonical, keccakHex } from "../canonical.js";
import { chainId, chainMode, dataDir, escrowAddress, roles } from "../config.js";
import { escrow, getListingExpecting, settledOrders } from "../chain.js";
import { addEvent, getDb, nowIso, type ListingRow, type OrderRow } from "../db.js";
import { checkReplayPlausibility, type ReplayLimits } from "../plausibility.js";
import { fingerprint, runScenario, type RunDoc } from "../sim.js";
import { operatingContext, targetFor, type Claim, type Scenario, type Subject, type TargetSpec } from "../targets.js";
import type { Submission } from "./seller.js";

export const VERIFIER_OUT = path.join(dataDir, "sim", "verifier");
export const VERIFIER_VERSION = "tb-verifier-2";
export const SUMMARY_SCHEMA = "tb-summary-2";
/** Tolerance used ONLY for the evidence line recorded when environments differ. It never certifies. */
export const TOLERANCE = { severity_value: 0.05, moment_t_s: 0.05 };

export const verifierOutFor = (t: TargetSpec): string => path.join(VERIFIER_OUT, t.id);

export type VerificationResult = {
  status: "VERIFIED" | "REJECTED" | "INCONCLUSIVE";
  /** GUARD verdict vocabulary (guard/envelope.py): VERIFIED = VALID, REJECTED = INVALID,
   *  INCONCLUSIVE = INCONCLUSIVE. INCONCLUSIVE never pays. */
  verdict: Verdict;
  reason: string;
  /** The one method that can certify a delivered replay is "exact-trajectory-hash": same pinned
   *  environment, and frames that recompute to the verifier's own re-run hash. "metrics-tolerance"
   *  is retained only so verification records written before that rule still deserialize; it is
   *  never produced, because agreeing metrics bind no replay to any run. */
  method: "exact-trajectory-hash" | "metrics-tolerance" | null;
  fingerprint_match: boolean | null;
  target_id?: string;
  verifier_run?: { outcome: string; trajectory_hash: string; controller: Subject; metrics: Record<string, unknown>; file: string; environment: Record<string, unknown>; replay_limits?: ReplayLimits };
  checks: { name: string; ok: boolean; detail?: string }[];
};

export type Verdict = "VALID" | "INVALID" | "INCONCLUSIVE";
export const VERDICT: Record<VerificationResult["status"], Verdict> = { VERIFIED: "VALID", REJECTED: "INVALID", INCONCLUSIVE: "INCONCLUSIVE" };

function check(list: VerificationResult["checks"], name: string, ok: boolean, detail?: string): boolean {
  list.push({ name, ok, detail });
  return ok;
}

/** keccak256 over the canonical bytes of the replay frames, recomputed from the delivered document.
 *  Returns null if the frames are missing or not canonically serializable. */
export function recomputeTrajectoryHash(frames: unknown): string | null {
  if (frames === undefined || frames === null) return null;
  try {
    return commitment(frames);
  } catch {
    return null;
  }
}

function fingerprintHash(target: TargetSpec, env: Record<string, unknown>): Hex {
  return commitment(fingerprint(target, env));
}

/** The listing's terms hash exactly as it is registered on chain: keccak256 over the canonical bytes
 *  of the public summary. The buyer recomputes it from the stored summary with this same function
 *  before trusting a row (agents/buyer.ts, checkTermsBinding). */
export function termsHashOf(summary: unknown): Hex {
  return commitment(summary);
}

// ------------------------------------------------------- EVIDENCE BINDING (d): the run record
/** Package fields the verifier's own re-run does NOT reproduce, each with the reason. Everything
 *  else in the package is compared byte-for-byte (after canonicalization) with the re-run. */
export const RUN_RECORD_EXEMPT: Readonly<Record<string, string>> = {
  salt_hex: "the seller's random 32-byte salt that blinds the commitment",
  seller: "the seller's address: identity, not physics",
  created_at: "wall-clock timestamp of packaging",
  hunter: "aggregate statistics of the hunt that found the scenario (simulation counts, wall time)",
  reproduce: "the reproduction command string and its note: prose, not physics",
  target_id: "checked separately against the submission (package-target-matches)",
  "replay.frames": "bound separately: keccak256 over the canonical frames must equal the verifier's own trajectory hash",
  "scene.mjcf_path": "absolute filesystem path of the pinned model on the host that ran it; the model's content is bound by scene.mjcf_hash and scene.compiled_model_hash",
};
// Not in the package at all, so nothing to exempt: the run document's wall_time_s, and the policy
// targets' `target` block (reduced to `controller`, the subject id and digest, which IS compared).

/** The package's run-derived sections, each paired with the value the verifier derives from ITS OWN
 *  run document. Compared in this order; the first mismatch names the section and the path. */
export function expectedRunRecord(target: TargetSpec, run: RunDoc, vClaim: Claim): Record<string, unknown> {
  return {
    claim: vClaim,
    metrics: run.metrics,
    scene: run.scene,
    scenario: run.scenario,
    controller: target.subjectOf(run),
    envelope_id: run.envelope_id,
    environment: run.environment,
    engine: run.engine,
    termination_rules: run.termination_rules ?? null,
    initial_state: run.initial_state ?? null,
    initial_state_check: run.initial_state_check ?? null,
    goal_m: run.goal_m ?? null,
    events: run.events,
    ticks: run.ticks,
    changed_conditions: target.changedConditions(run.scenario),
    nominal_scenario: target.nominal_scenario,
    target_label: target.label,
    replay: { trajectory_hash: run.trajectory_hash, mjcf_hash: run.mjcf_hash ?? null, renderer: target.replay_renderer },
  };
}

export type RunRecordMismatch = { section: string; path: string; package: string; verifier: string };

const preview = (v: unknown): string => {
  let s: string;
  try { s = v === undefined ? "(absent)" : dumps(v); } catch { s = String(v); }
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
};

/** First path at which two canonical documents differ, or null if they are identical. Objects are
 *  walked in sorted key order and arrays by index, so the answer is deterministic. */
export function firstDifference(a: unknown, b: unknown, at: string): { path: string; a: unknown; b: unknown } | null {
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length || i >= b.length) return { path: `${at}[${i}]`, a: i < a.length ? a[i] : undefined, b: i < b.length ? b[i] : undefined };
      const d = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      if (!(k in a) || !(k in b)) return { path: `${at}.${k}`, a: a[k], b: b[k] };
      const d = firstDifference(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }
  try {
    if (dumps(a) === dumps(b)) return null;
  } catch { /* not canonically serializable: treated as different */ }
  return { path: at, a, b };
}

/** Compare a delivered package's run-derived sections with the verifier's own re-run. Returns the
 *  first mismatch, or null when every section is byte-identical after canonicalization. */
export function runRecordMismatch(pkg: Record<string, any>, target: TargetSpec, run: RunDoc, vClaim: Claim): RunRecordMismatch | null {
  const expected = expectedRunRecord(target, run, vClaim);
  const strip = (v: unknown, key: string): unknown => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
    const copy = { ...(v as Record<string, unknown>) };
    delete copy[key];
    return copy;
  };
  for (const [section, want] of Object.entries(expected)) {
    let got: unknown = pkg[section];
    let exp: unknown = want;
    if (section === "scene") { got = strip(got, "mjcf_path"); exp = strip(exp, "mjcf_path"); }
    if (section === "replay") got = strip(got, "frames");
    const d = firstDifference(got, exp, section);
    if (d) return { section, path: d.path, package: preview(d.a), verifier: preview(d.b) };
  }
  // A field the run record does not have and the exemption list does not name is not evidence of
  // anything the verifier ran; it is refused rather than carried into the buyer's replay unchecked.
  for (const k of Object.keys(pkg)) {
    if (!(k in expected) && !(k in RUN_RECORD_EXEMPT) && k !== "schema" && k !== "format") return { section: k, path: k, package: preview(pkg[k]), verifier: "(no such field in the verifier's run record)" };
  }
  return null;
}

// Re-exported so the adversarial tests and any external reader keep one import site.
export { checkReplayPlausibility, GRAVITY_MPS2, SIM_POSITION_BOUND_M, type PlausibilityResult, type ReplayLimits } from "../plausibility.js";
/** The cart's limits, kept as a named export because the adversarial suite drives it directly. */
export const replayLimitsFrom = (run: any): ReplayLimits => targetFor((run as { target_id?: string })?.target_id).replayLimitsFrom(run ?? {});

export async function verifySubmission(sub: Submission, packageBytes: Uint8Array, log: (m: string) => void): Promise<VerificationResult> {
  const checks: VerificationResult["checks"] = [];
  const target = targetFor(sub.target_id);
  const fail = (status: VerificationResult["status"], reason: string): VerificationResult => ({ status, verdict: VERDICT[status], reason, method: null, fingerprint_match: null, target_id: target.id, checks });

  if (!check(checks, "schema", sub.schema === "tb-submission-2", sub.schema)) return fail("REJECTED", "unknown submission schema");
  if (!check(checks, "known-target", sub.target_id === target.id, String(sub.target_id))) return fail("REJECTED", "unknown target");
  if (!check(checks, "envelope", sub.envelope_id === target.envelope_id, sub.envelope_id)) return fail("REJECTED", `submission envelope ${sub.envelope_id} is not this target's envelope ${target.envelope_id}`);
  const problems = target.checkAdmissible(sub.scenario as unknown as Record<string, unknown>);
  if (!check(checks, "admissible", problems.length === 0, problems.join("; "))) return fail("REJECTED", `out of envelope: ${problems.join("; ")}`);
  const db = getDb();
  const prior = db.prepare("SELECT scenario, finding_id FROM ledger WHERE verification_status = 'VERIFIED' AND controller_hash = ? AND envelope_id = ?").all(sub.controller.hash, sub.envelope_id) as { scenario: string; finding_id: string }[];
  const dup = prior.find((p) => target.isDuplicate(JSON.parse(p.scenario) as Scenario, sub.scenario));
  if (!check(checks, "not-duplicate", !dup, dup ? `near-duplicate of ledger finding ${dup.finding_id} (published rule: ${target.envelope_doc.duplicate_rule})` : "no prior finding within the duplicate distance")) return fail("REJECTED", "approximate duplicate of an existing verified finding");
  if (!check(checks, "claims-a-failure-class-of-this-target", target.failure_outcomes.includes(sub.claim.outcome), `${sub.claim.outcome} (this target's failure classes: ${target.failure_outcomes.join(", ")})`)) return fail("REJECTED", "claimed outcome is not a failure class of this target; not a failure finding");

  log(`verifier[${target.id}]: re-running the scenario with the target's own CLI (${target.sim.module}) in the verifier's pinned environment`);
  const name = `verify-${sub.package_commitment.slice(2, 10)}`;
  const v = await runScenario(target, verifierOutFor(target), name, sub.scenario);
  const ran = target.subjectOf(v.doc); // the artefact the verifier actually executed, hashed by the simulator
  const limits = target.replayLimitsFrom(v.doc);
  const verifierRun = { outcome: v.doc.outcome, trajectory_hash: v.doc.trajectory_hash, controller: ran, metrics: v.doc.metrics, file: v.file, environment: v.doc.environment, replay_limits: limits };
  const vClaim = target.claimFromRun(v.doc);
  if (!check(checks, "verifier-run-admissible", v.doc.admissible && v.doc.outcome !== "INVALID_INITIAL_STATE", v.doc.outcome)) return { ...fail("REJECTED", `verifier run: ${v.doc.outcome}`), verifier_run: verifierRun };
  if (!check(checks, "verifier-run-conclusive", target.conclusive_outcomes.includes(v.doc.outcome), v.doc.outcome)) return { ...fail("INCONCLUSIVE", `verifier run ended with ${v.doc.outcome}`), verifier_run: verifierRun };
  if (!check(checks, "reproduces-the-claimed-failure", v.doc.outcome === sub.claim.outcome, `verifier observed ${v.doc.outcome}, claim was ${sub.claim.outcome}`)) return { ...fail("REJECTED", "the claimed failure does not reproduce in the verifier's environment"), verifier_run: verifierRun };

  // EVIDENCE BINDING (a): the claim is only about the artefact the verifier itself re-ran. Without
  // this, a seller could attach any id/hash to a real failure of a different controller or checkpoint.
  if (!check(checks, "claimed-subject-is-the-one-re-run", sub.controller.id === ran.id && sub.controller.hash === ran.hash, `claimed ${sub.controller.id} ${sub.controller.hash.slice(0, 20)}... vs re-run ${ran.id} ${ran.hash.slice(0, 20)}...`))
    return { ...fail("REJECTED", `the claimed ${target.subject_noun} (${sub.controller.id} ${sub.controller.hash.slice(0, 20)}...) is not the one the verifier re-ran (${ran.id} ${ran.hash.slice(0, 20)}...)`), verifier_run: verifierRun };

  // Recorded now, acted on after the package has been examined. A replay produced under a different
  // environment pin cannot be bound to this re-run by any hash, so it can never be certified here.
  const fpMatch = fingerprintHash(target, sub.environment) === fingerprintHash(target, v.doc.environment);
  check(checks, "environment-fingerprint-matches", fpMatch, fpMatch ? "the seller's environment pin is the verifier's own" : "the seller's declared environment pin differs from the verifier's own");
  const reject = (reason: string): VerificationResult => ({ ...fail("REJECTED", reason), fingerprint_match: fpMatch, verifier_run: verifierRun });

  // package checks - always run, whatever the environment says, so the delivered evidence is examined
  // on its own terms before any verdict is reached.
  if (!check(checks, "package-canonical", isCanonical(packageBytes))) return reject("package is not canonical JSON");
  const pkgHash = keccakHex(packageBytes);
  if (!check(checks, "package-commitment", pkgHash === sub.package_commitment, pkgHash)) return reject("package bytes do not hash to the stated commitment");
  const pkg = JSON.parse(Buffer.from(packageBytes).toString("utf8"));
  if (!check(checks, "package-target-matches", pkg.target_id === target.id, String(pkg.target_id))) return reject("package names a different target from the submission");
  const sameScenario = dumps(pkg.scenario) === dumps(sub.scenario);
  if (!check(checks, "package-scenario-matches", sameScenario)) return reject("package scenario differs from submission");
  if (!check(checks, "package-has-salt", typeof pkg.salt_hex === "string" && /^0x[0-9a-f]{64}$/.test(pkg.salt_hex))) return reject("package lacks a 32-byte salt");
  if (!check(checks, "package-subject-is-the-one-re-run", pkg.controller?.id === ran.id && pkg.controller?.hash === ran.hash, `package ${pkg.controller?.id} ${String(pkg.controller?.hash).slice(0, 20)}... vs re-run ${ran.id} ${ran.hash.slice(0, 20)}...`))
    return reject(`the package names a ${target.subject_noun} the verifier did not re-run`);
  if (!check(checks, "package-trajectory-matches", pkg.replay?.trajectory_hash === sub.trajectory_hash)) return reject("package replay hash differs from submission");
  // EVIDENCE BINDING (b): recompute the trajectory hash from the delivered frames. The declared
  // replay.trajectory_hash is never trusted, so frames altered behind an intact declared hash fail.
  const recomputed = recomputeTrajectoryHash(pkg.replay?.frames);
  if (!check(checks, "package-frames-hash-to-declared-trajectory", recomputed !== null && recomputed === pkg.replay?.trajectory_hash, `keccak256(canonical(frames)) = ${String(recomputed).slice(0, 20)}... vs declared ${String(pkg.replay?.trajectory_hash).slice(0, 20)}...`))
    return reject("the package's replay frames do not hash to its declared trajectory hash (frames altered after the hash was written)");
  // PHYSICAL PLAUSIBILITY: hashes only prove a document is internally consistent. A forger who
  // rewrites the frames and then rewrites every hash over them is internally consistent too; what
  // saves nobody is that the frames still have to be a trajectory this scene could produce.
  const plausible = checkReplayPlausibility(pkg.replay?.frames, limits);
  if (!check(checks, "replay-frames-physically-plausible", plausible.ok, plausible.detail))
    return reject(`the delivered replay is not a physically possible trajectory of this scene: ${plausible.detail}`);

  // EVIDENCE BINDING (c): the delivered replay is certified only when it can be bound exactly.
  if (!fpMatch) {
    // Recorded as evidence only. Two runs agreeing on the severity proxy and the failure time says
    // something about the SCENARIO; it says nothing about which frames the seller delivered, so on
    // its own it must never certify a replay.
    const dSev = Math.abs(Number(vClaim.severity_value) - Number(sub.claim.severity_value));
    const dT = Math.abs(Number(vClaim.moment_t_s) - Number(sub.claim.moment_t_s));
    const near = dSev <= TOLERANCE.severity_value && dT <= TOLERANCE.moment_t_s;
    check(checks, "metrics-agree-across-environments", near, `EVIDENCE ONLY, never certifies: ${vClaim.severity_proxy} diff ${dSev.toFixed(4)} ${vClaim.severity_units} (tol ${TOLERANCE.severity_value}), failure time diff ${dT.toFixed(4)} s (tol ${TOLERANCE.moment_t_s})`);
    return {
      status: "INCONCLUSIVE",
      verdict: "INCONCLUSIVE",
      reason:
        "INCONCLUSIVE: the seller's environment differs from the verifier's, so the delivered replay cannot be bound to the run the verifier performed and therefore cannot be certified. " +
        `The failure ${v.doc.outcome === sub.claim.outcome ? "does reproduce" : "does not reproduce"} in the verifier's own environment and the headline metrics ${near ? "agree within tolerance" : "disagree"}, but agreeing metrics bind no replay: only an identical environment fingerprint plus frames that recompute to the verifier's own trajectory hash can do that. The verifier abstains rather than certify evidence it cannot check.`,
      method: null, fingerprint_match: false, target_id: target.id, verifier_run: verifierRun, checks,
    };
  }

  const method: VerificationResult["method"] = "exact-trajectory-hash";
  if (!check(checks, "trajectory-hash-identical", v.doc.trajectory_hash === sub.trajectory_hash, `${sub.trajectory_hash.slice(0, 18)} vs ${v.doc.trajectory_hash.slice(0, 18)}`))
    return { status: "INCONCLUSIVE", verdict: "INCONCLUSIVE", reason: "same environment fingerprint but different trajectory hash (numerical divergence or tampered run)", method, fingerprint_match: true, target_id: target.id, verifier_run: verifierRun, checks };
  if (!check(checks, "package-frames-reproduce-verified-trajectory", recomputed === v.doc.trajectory_hash, `${String(recomputed).slice(0, 20)}... vs verifier run ${v.doc.trajectory_hash.slice(0, 20)}...`))
    return { ...reject("the package's replay frames are not the trajectory the verifier re-ran"), method };
  // EVIDENCE BINDING (d): the frames are now the verifier's own trajectory, so every other section
  // the simulator derives from that trajectory must be the verifier's own as well. The claim is
  // compared with the claim derived from the VERIFIER'S run (vClaim), never with the seller's
  // submission; the scene, metrics, events, ticks and the rest with the verifier's run document.
  const rr = runRecordMismatch(pkg, target, v.doc, vClaim);
  if (!check(checks, "package-run-record-matches-verifier-rerun", rr === null, rr
    ? `section "${rr.section}" differs at ${rr.path}: package ${rr.package} vs verifier re-run ${rr.verifier}`
    : `${Object.keys(expectedRunRecord(target, v.doc, vClaim)).length} run-derived sections byte-identical (canonical JSON) to the verifier's own run document; exempt: ${Object.keys(RUN_RECORD_EXEMPT).join(", ")}`))
    return { ...reject(`the package's run record is not the run the verifier performed: section "${rr!.section}" differs at ${rr!.path} (authentic frames do not certify fabricated metrics, scene or claim)`), method };
  if (!check(checks, "package-claim-matches", dumps(pkg.claim) === dumps(sub.claim))) return { ...reject("package claim differs from submission"), method };
  const bandOk = target.severityBand(vClaim.severity_value).band === sub.claim.severity_band;
  if (!check(checks, "severity-band-consistent", bandOk, `${target.severityBand(vClaim.severity_value).band} vs advertised ${sub.claim.severity_band}`)) return { ...reject("advertised severity band does not match the verifier's observation"), method };

  return {
    status: "VERIFIED",
    verdict: "VALID",
    reason: `identical trajectory hash in a matching pinned environment; the ${target.subject_noun} and the delivered replay frames are bound to the verifier's own re-run, and the frames are a physically possible trajectory of this scene`,
    method, fingerprint_match: true, target_id: target.id, verifier_run: verifierRun, checks,
  };
}

export function buildPublicSummary(sub: Submission, res: VerificationResult, priceWei: bigint, sellerSettled: number) {
  const target = targetFor(sub.target_id);
  // The band advertised is the one the VERIFIER measured in its own re-run, never the seller's claim.
  const vClaim = target.claimFromRun({ metrics: res.verifier_run!.metrics, outcome: res.verifier_run!.outcome });
  const band = target.severityBand(vClaim.severity_value ?? sub.claim.severity_value);
  const cls = target.failure_classes.find((c) => c.id === sub.claim.failure_class);
  return {
    schema: SUMMARY_SCHEMA,
    format: "tb-cjson-1",
    // WHAT A BUYER SEES BEFORE PAYING: target, failure class, severity band, verification status and
    // the seller's settled history. Nothing here is derived from the exact scenario parameters.
    target: { id: target.id, label: target.label, machine: target.machine, subject_label: target.subject_label, replay_renderer: target.replay_renderer },
    failure_class: { id: sub.claim.failure_class, label: cls?.label ?? sub.claim.failure_class, detected_by: cls?.detected_by ?? "the simulator's own failure predicate" },
    controller: sub.controller,
    envelope_id: sub.envelope_id,
    admissible: true,
    claim_kind: target.claimKind,
    verification: {
      status: res.status,
      verdict: res.verdict,
      method: res.method,
      verifier_version: VERIFIER_VERSION,
      verifier: roles.verifier().address,
      environment_fingerprint: fingerprintHash(target, res.verifier_run!.environment),
      evidence_binding: `the seller's environment fingerprint equalled the verifier's own, and the ${target.subject_noun} id+hash and the trajectory hash RECOMPUTED from the delivered replay frames were compared against the verifier's own re-run with this target's own simulator; declared hashes are not trusted, the frames were checked to be a physically possible trajectory of this scene, and a replay the verifier cannot bind exactly is INCONCLUSIVE rather than certified`,
      verified_at: nowIso(),
    },
    operating_context: operatingContext(target),
    severity: { proxy: band.proxy, band: band.band, definition: band.definition },
    seller: sub.seller,
    seller_settled_orders_at_listing: sellerSettled,
    price_wei: priceWei.toString(),
    chain: { mode: chainMode, chain_id: chainId, escrow: escrowAddress },
    hidden: "exact scenario parameters, trajectory, replay frames, the hunt that found it and the reproduction command are in the private package only",
  };
}

export async function verifyAndList(sub: Submission, packageBytes: Uint8Array, opts: { priceWei: bigint; demoTamper: boolean }, log: (m: string) => void) {
  const target = targetFor(sub.target_id);
  const res = await verifySubmission(sub, packageBytes, log);
  const db = getDb();
  const findingId = sub.package_commitment;
  for (const c of res.checks) log(`verifier:   ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? " - " + c.detail : ""}`);
  const ledgerRow = (listingId: string | null, status: string) =>
    db.prepare("INSERT OR REPLACE INTO ledger(finding_id, listing_id, target_id, controller_id, controller_hash, envelope_id, scenario, outcome, impact_speed_mps, trajectory_hash, verification_status, verification_method, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(findingId, listingId, target.id, sub.controller.id, sub.controller.hash, sub.envelope_id, JSON.stringify(sub.scenario), sub.claim.outcome, sub.claim.severity_value, sub.trajectory_hash, status, res.method, nowIso());
  if (res.status !== "VERIFIED") {
    ledgerRow(null, res.status);
    log(`verifier: ${res.status} - ${res.reason}`);
    return { result: res, listingId: null as Hex | null, summary: null };
  }
  const sellerSettled = await settledOrders(sub.seller as Hex);
  const summary = buildPublicSummary(sub, res, opts.priceWei, sellerSettled);
  const termsHash = termsHashOf(summary);
  const listingId = keccakHex(new Uint8Array([...Buffer.from(sub.package_commitment.slice(2), "hex"), ...Buffer.from(termsHash.slice(2), "hex")]));
  log(`verifier: VERIFIED (${res.method}); registering ${target.id} listing ${listingId.slice(0, 12)}... on ${chainMode} (commitment ${sub.package_commitment.slice(0, 12)}..., terms ${termsHash.slice(0, 12)}...)`);
  const tx = await escrow.registerListing(roles.verifier(), listingId, sub.seller as Hex, opts.priceWei, sub.package_commitment as Hex, termsHash);
  db.prepare("INSERT INTO listings(listing_id, chain_mode, chain_id, escrow_address, target_id, seller, price_wei, commitment, terms_hash, public_summary, status, register_tx, demo_tamper, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(listingId, chainMode, chainId, escrowAddress, target.id, sub.seller, opts.priceWei.toString(), sub.package_commitment, termsHash, Buffer.from(dumpsBytes(summary)).toString("utf8"), "LISTED", tx.hash, opts.demoTamper ? 1 : 0, nowIso());
  db.prepare("INSERT INTO private_packages(listing_id, package_bytes, submission, verification) VALUES (?,?,?,?)")
    .run(listingId, packageBytes, JSON.stringify(sub), JSON.stringify(res));
  ledgerRow(listingId, "VERIFIED");
  addEvent(listingId, "verifier", "verified", { target: target.id, status: res.status, method: res.method, reason: res.reason, checks: res.checks.length }, chainMode);
  addEvent(listingId, "verifier", "registered", { seller: sub.seller, price_wei: opts.priceWei.toString(), commitment: sub.package_commitment, terms_hash: termsHash, block: tx.block_number }, chainMode, tx.hash, tx.block_number);
  log(`verifier: registerListing tx ${tx.hash} block ${tx.block_number}`);
  return { result: res, listingId, summary, registerTx: tx };
}

export type DeliveryCheck = {
  valid: boolean; verdict: Verdict; reason: string; on_chain_commitment: string; delivered_hash: string; asserted_delivery_hash: string | null;
  checks: { name: string; ok: boolean; detail?: string }[]; checked_at: string;
};

/** After delivery: compare the bytes the seller served against the on-chain commitment and the
 *  advertised public summary, then settle on chain. Target-aware exactly as verification is. */
export async function verifierCheckDeliveryAndSettle(order: OrderRow, log: (m: string) => void): Promise<{ check: DeliveryCheck; tx: string }> {
  const db = getDb();
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(order.listing_id) as unknown as ListingRow;
  const priv = db.prepare("SELECT package_bytes, submission, verification FROM private_packages WHERE listing_id = ?").get(order.listing_id) as { package_bytes: Uint8Array; submission: string; verification: string };
  const target = targetFor(listing.target_id ?? (JSON.parse(priv.submission) as Submission).target_id);
  const onChain = await getListingExpecting(order.listing_id as Hex, (l) => l.status === 3);
  const checks: DeliveryCheck["checks"] = [];
  const delivered = order.delivered_bytes ? new Uint8Array(order.delivered_bytes) : new Uint8Array();
  const deliveredHash = keccakHex(delivered);
  check(checks, "on-chain-status-delivered", onChain.status === 3, `status ${onChain.status}`);
  check(checks, "delivered-bytes-present", delivered.length > 0, `${delivered.length} bytes`);
  const hashOk = check(checks, "delivered-hash-equals-commitment", deliveredHash === onChain.commitment.toLowerCase(), `keccak256(delivered) ${deliveredHash.slice(0, 14)}... vs on-chain commitment ${onChain.commitment.slice(0, 14)}...`);
  check(checks, "seller-asserted-hash-honest", (order.delivery_hash ?? "").toLowerCase() === deliveredHash, `seller asserted ${(order.delivery_hash ?? "").slice(0, 14)}...`);
  let contentOk = false;
  if (hashOk && isCanonical(delivered)) {
    const pkg = JSON.parse(Buffer.from(delivered).toString("utf8"));
    const summary = JSON.parse(listing.public_summary);
    const verification = JSON.parse(priv.verification) as VerificationResult;
    const cT = check(checks, "package-target-matches-summary", pkg.target_id === (summary.target?.id ?? target.id), `${String(pkg.target_id)} vs ${String(summary.target?.id ?? target.id)}`);
    const c1 = check(checks, "package-subject-matches-summary", pkg.controller?.hash === summary.controller.hash);
    const c2 = check(checks, "package-envelope-matches-summary", pkg.envelope_id === summary.envelope_id);
    const c3 = check(checks, "package-claim-matches-summary", target.failure_outcomes.includes(pkg.claim?.outcome) && pkg.claim?.severity_band === summary.severity.band, `${pkg.claim?.outcome} / ${pkg.claim?.severity_band}`);
    const c4 = check(checks, "package-scenario-admissible", target.checkAdmissible(pkg.scenario ?? {}).length === 0);
    // EVIDENCE BINDING (c) at delivery. The binding target is the verifier's OWN re-run trajectory
    // hash and nothing else. A listing may only exist if it was certified by "exact-trajectory-hash",
    // so that hash is always on record; if it is not, the delivered replay cannot be bound here
    // either and the check fails rather than falling back to the seller's own declared trajectory.
    const trajTarget = verification.verifier_run?.trajectory_hash ?? null;
    const c0 = check(checks, "listing-was-certified-by-exact-trajectory-binding", verification.method === "exact-trajectory-hash" && typeof trajTarget === "string", `certification method ${String(verification.method)}, verifier re-run trajectory ${trajTarget === null ? "absent from the record" : "on record"}`);
    const c5 = check(checks, "package-replay-matches-verified-run", trajTarget !== null && pkg.replay?.trajectory_hash === trajTarget, `${String(pkg.replay?.trajectory_hash).slice(0, 14)}... vs verifier re-run ${String(trajTarget).slice(0, 14)}...`);
    // Recompute the trajectory hash from the bytes actually delivered: the declared field is evidence
    // of nothing on its own.
    const recomputed = recomputeTrajectoryHash(pkg.replay?.frames);
    const c6 = check(checks, "delivered-frames-hash-to-verified-trajectory", trajTarget !== null && recomputed !== null && recomputed === trajTarget, `keccak256(canonical(delivered frames)) ${String(recomputed).slice(0, 14)}... vs ${String(trajTarget).slice(0, 14)}...`);
    const ranSubject = verification.verifier_run?.controller ?? null;
    const c7 = check(checks, "delivered-subject-is-the-one-re-run", ranSubject !== null && pkg.controller?.id === ranSubject.id && pkg.controller?.hash === ranSubject.hash, ranSubject === null ? `the record does not name the ${target.subject_noun} the verifier re-ran` : `${String(pkg.controller?.hash).slice(0, 20)}... vs re-run ${ranSubject.hash.slice(0, 20)}...`);
    // The same physical-plausibility reading of the bytes actually served, so an absurd replay is
    // refused on its own terms here too and not only by hash. The delivery record is PUBLIC, so a
    // passing check states only the scene's own ceiling; a failing one may quote the delivered
    // numbers, which are by construction not a trajectory of anything.
    const limits = verification.verifier_run?.replay_limits ?? target.replayLimitsFrom({});
    const plausible = checkReplayPlausibility(pkg.replay?.frames, limits);
    const c8 = check(checks, "delivered-frames-physically-plausible", plausible.ok, plausible.ok ? `no recorded body exceeds the ${limits.speed_ceiling_mps.toFixed(3)} m/s this scene can produce (${limits.derivation})` : plausible.detail);
    contentOk = cT && c0 && c1 && c2 && c3 && c4 && c5 && c6 && c7 && c8;
  } else {
    check(checks, "package-content", false, hashOk ? "not canonical JSON" : "skipped: commitment mismatch");
  }
  const valid = onChain.status === 3 && hashOk && contentOk;
  const checkDoc: DeliveryCheck = {
    valid,
    verdict: valid ? "VALID" : "INVALID",
    reason: valid ? "delivered package hashes to the on-chain commitment, matches the advertised terms, and its replay frames are a physically possible trajectory that hashes to the run the verifier itself re-ran" : !hashOk ? "COMMITMENT MISMATCH: delivered bytes do not hash to the on-chain commitment" : "delivered package does not match the advertised terms",
    on_chain_commitment: onChain.commitment, delivered_hash: deliveredHash, asserted_delivery_hash: order.delivery_hash, checks, checked_at: nowIso(),
  };
  for (const c of checks) log(`verifier:   ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? " - " + c.detail : ""}`);
  log(`verifier: delivery ${valid ? "VALID" : "INVALID"} - ${checkDoc.reason}; settling on chain`);
  const tx = await escrow.settle(roles.verifier(), order.listing_id as Hex, valid);
  const status = valid ? "SETTLED_VALID" : "SETTLED_INVALID";
  db.prepare("UPDATE orders SET delivery_check = ?, settle_tx = ?, status = ? WHERE order_id = ?").run(JSON.stringify(checkDoc), tx.hash, status, order.order_id);
  db.prepare("UPDATE listings SET status = ? WHERE listing_id = ?").run(status, order.listing_id);
  addEvent(order.listing_id, "verifier", valid ? "settled_valid" : "settled_invalid", { reason: checkDoc.reason, credited_to: valid ? listing.seller : order.buyer, block: tx.block_number }, chainMode, tx.hash, tx.block_number);
  log(`verifier: settle(${valid}) tx ${tx.hash} block ${tx.block_number} -> ${valid ? "seller" : "buyer"} credited ${order.price_wei} wei (pull payment)`);
  return { check: checkDoc, tx: tx.hash };
}
