// VERIFIER AGENT (local demonstration mode, but the same logic a deployed verifier would run).
// Verification semantics (documented in README):
//   1. structural + admissibility checks on the submitted scenario (out-of-envelope -> REJECTED)
//   2. duplicate rule against the failure ledger (normalized L-inf distance < 0.05 -> REJECTED_DUPLICATE)
//   3. the claim must be a COLLISION (anything else is not a failure finding -> REJECTED)
//   4. re-run the scenario in the verifier's OWN pinned environment
//   5. EVIDENCE BINDING (a): the claimed controller id and hash must equal the controller the
//      verifier actually re-ran. A seller cannot mislabel the controller version.
//   6. the private package must be canonical, hash to the seller's stated commitment, and carry the
//      same scenario, controller, trajectory hash and claim as the verified run. EVIDENCE BINDING
//      (b): the trajectory hash is RECOMPUTED from the delivered replay frames, never read from the
//      package's declared field, so altered frames behind an intact declared hash are rejected.
//   7. PHYSICAL PLAUSIBILITY: the delivered frames are read as a trajectory and must stay inside the
//      world the simulator models, at speeds the scene can physically produce (see replayLimitsFrom).
//      A fabricated replay is INVALID on its own terms, not merely unbound.
//   8. EVIDENCE BINDING (c): the delivered replay is certified ONLY when the verifier can bind it
//      exactly - the seller's environment fingerprint equals the verifier's own AND the trajectory
//      hash recomputed from the delivered frames equals the hash of the verifier's own re-run
//      (method "exact-trajectory-hash"). If the environment fingerprint differs, the verifier CANNOT
//      bind the delivered replay to anything it ran, so the verdict is INCONCLUSIVE: the instrument
//      abstains rather than certifying evidence it cannot check. Agreement of the two headline
//      metrics across differing environments is recorded in `checks` as evidence and never certifies
//      anything on its own. (Before this rule an environment mismatch downgraded to a metrics
//      comparison, which certified a replay nobody had bound: a fabricated trajectory whose claimed
//      environment was altered to force the mismatch was returned as VERIFIED.)
//   9. publish a public summary (no parameters, no trajectory), register the listing on chain
import path from "node:path";
import type { Hex } from "viem";
import { commitment, dumps, dumpsBytes, isCanonical, keccakHex } from "../canonical.js";
import { chainId, chainMode, dataDir, escrowAddress, roles } from "../config.js";
import { escrow, getListingExpecting, settledOrders } from "../chain.js";
import { addEvent, getDb, nowIso, type ListingRow, type OrderRow } from "../db.js";
import { checkAdmissible, ENVELOPE, ENVELOPE_ID, isDuplicate, operatingContext, severityBand, type Scenario } from "../envelope.js";
import { fingerprint, runScenario, type RunDoc } from "../sim.js";
import type { Submission } from "./seller.js";

export const VERIFIER_OUT = path.join(dataDir, "sim", "verifier");
export const VERIFIER_VERSION = "tb-verifier-1";
export const SUMMARY_SCHEMA = "tb-summary-1";
export const TOLERANCE = { impact_speed_mps: 0.05, first_contact_t_s: 0.05 };

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
  verifier_run?: { outcome: string; trajectory_hash: string; controller: { id: string; hash: string }; metrics: Record<string, unknown>; file: string; environment: Record<string, unknown>; replay_limits?: ReplayLimits };
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

function fingerprintHash(env: Record<string, unknown>): Hex {
  return commitment(fingerprint(env));
}

// --------------------------------------------------------------- PHYSICAL PLAUSIBILITY OF A REPLAY
// A delivered replay is a list of rigid-body poses. Hashes bind it to a run; these limits say whether
// it could be a run of THIS scene at all. Every number below is read off the scene and the rules the
// simulator itself published in the verifier's own re-run document, or off the published envelope.
// None of it is a tuned tolerance.

/** Standard gravity, the value sim/tailbazaar_sim/scene.py passes to MuJoCo (`gravity="0 0 -9.81"`). */
export const GRAVITY_MPS2 = 9.81;
/** The simulator's own divergence bound: sim/tailbazaar_sim/simulate.py ends a run as DIVERGED as
 *  soon as a recorded body coordinate exceeds 100 m (`abs(data.xpos[...]).max() > 100.0`). A run that
 *  crosses it is never reported as a COLLISION, so no certifiable replay can contain such a pose, and
 *  100 m is also the longest straight line a body can travel while the run is still conclusive. */
export const SIM_POSITION_BOUND_M = 100;

/** Each recorded frame is [t, then (x, y, z, qw, qx, qy, qz) per body] - see `record_frame` in
 *  sim/tailbazaar_sim/simulate.py. */
const FRAME_STRIDE = 7;

export type ReplayLimits = {
  /** Recording interval of the verifier's own run: the pinned control tick (20 ms). */
  dt_s: number;
  /** Fastest a body in this scene can possibly be moving, in m/s. */
  speed_ceiling_mps: number;
  /** Largest coordinate magnitude a conclusive run can contain, in m. */
  position_bound_m: number;
  /** Longest a conclusive run can last, in s. */
  max_span_s: number;
  /** How the ceiling was derived, carried into the record so it can be audited. */
  derivation: string;
};

/** The limits a delivered replay must respect, derived from the verifier's OWN re-run document (never
 *  from the seller's) plus the published envelope.
 *
 *  Speed ceiling. Nothing in this scene is propelled except through contact with the floor, so the
 *  largest acceleration any body can sustain is bounded by gravity plus the largest tangential force
 *  the floor can transmit, mu_max * m * g, with mu_max the top of the PUBLISHED floor_friction axis
 *  (envelope.ts, 1.0). That is a_max = (1 + mu_max) * g = 19.62 m/s^2. Starting from rest, a body
 *  accelerating at a_max over the longest straight line the simulator tolerates before it calls the
 *  run DIVERGED reaches sqrt(2 * a_max * 100 m) = 62.6 m/s; a body falling from the tallest structure
 *  in the scene (the obstacle's top face, 2 * obstacle_half_m[2] = 1.0 m) adds sqrt(2 * g * h) =
 *  4.4 m/s. The ceiling is the sum, about 67 m/s.
 *
 *  This is an impossibility line, not a tolerance: an honest run of this controller peaks near its
 *  2 m/s cruise speed (v_max_mps in the run metrics), roughly thirty times below the ceiling, while
 *  the reviewer's fabricated frame - the cart moved 100 m inside one 20 ms tick - implies 5000 m/s,
 *  about seventy-five times above it. Nothing physical sits in between. */
export function replayLimitsFrom(run: { scene?: Record<string, unknown>; frames?: { dt_s?: unknown }; termination_rules?: unknown }): ReplayLimits {
  const half = (run.scene as { obstacle_half_m?: unknown } | undefined)?.obstacle_half_m;
  const hMax = Array.isArray(half) && Number.isFinite(Number(half[2])) ? 2 * Number(half[2]) : 1.0;
  const muMax = ENVELOPE.floor_friction.max;
  const aMax = (1 + muMax) * GRAVITY_MPS2;
  const ceiling = Math.sqrt(2 * aMax * SIM_POSITION_BOUND_M) + Math.sqrt(2 * GRAVITY_MPS2 * hMax);
  const dt = Number((run.frames as { dt_s?: unknown } | undefined)?.dt_s);
  const rules = (run.termination_rules ?? {}) as Record<string, unknown>;
  const tMax = Number.isFinite(Number(rules.t_max_s)) ? Number(rules.t_max_s) : 10;
  const post = Number.isFinite(Number(rules.post_contact_s)) ? Number(rules.post_contact_s) : 1;
  const dtS = Number.isFinite(dt) && dt > 0 ? dt : 0.02;
  return {
    dt_s: dtS,
    speed_ceiling_mps: ceiling,
    position_bound_m: SIM_POSITION_BOUND_M,
    max_span_s: tMax + post + dtS,
    // Prose only, no envelope parameter identifiers: this string reaches the public delivery record.
    derivation: `sqrt(2*(1+mu_max)*g*d_max) + sqrt(2*g*h_obstacle) with mu_max=${muMax} (largest surface friction the published envelope admits), g=${GRAVITY_MPS2} m/s^2, d_max=${SIM_POSITION_BOUND_M} m (the simulator's divergence bound) and h_obstacle=${hMax} m (the scene's tallest structure)`,
  };
}

export type PlausibilityResult = { ok: boolean; detail: string; max_speed_mps: number | null };

/** Read the delivered frames as a trajectory and decide whether this scene could have produced them.
 *  Rejects a recording that is structurally not a trajectory, that steps backwards in time, that runs
 *  longer than the simulator allows, that leaves the world the simulator models, or in which any body
 *  moves faster between two frames than the scene can possibly move it. */
export function checkReplayPlausibility(frames: unknown, limits: ReplayLimits): PlausibilityResult {
  const f = frames as { dt_s?: unknown; bodies?: unknown; data?: unknown } | null | undefined;
  if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, detail: "the package carries no replay frames", max_speed_mps: null };
  const bodies = Array.isArray(f.bodies) ? (f.bodies as unknown[]) : null;
  const rows = Array.isArray(f.data) ? (f.data as unknown[]) : null;
  const dtDeclared = Number(f.dt_s);
  if (!bodies || !rows || bodies.length === 0) return { ok: false, detail: "replay frames are not a {dt_s, bodies, data} recording", max_speed_mps: null };
  // The recording interval is the pinned control tick. Taking it from the package would let a forger
  // stretch time until any jump looks slow, so it must equal the interval the verifier itself recorded.
  if (!(Number.isFinite(dtDeclared) && Math.abs(dtDeclared - limits.dt_s) < 1e-12))
    return { ok: false, detail: `frames declare dt_s=${f.dt_s}, but the verifier's own recording interval is ${limits.dt_s} s (the pinned control tick)`, max_speed_mps: null };
  if (rows.length < 2) return { ok: false, detail: `a replay of a collision cannot consist of ${rows.length} frame(s)`, max_speed_mps: null };
  const width = 1 + FRAME_STRIDE * bodies.length;
  const violations: string[] = [];
  let maxSpeed = 0;
  let worst = "";
  let prev: number[] | null = null;
  let t0 = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length !== width || row.some((x) => typeof x !== "number" || !Number.isFinite(x)))
      return { ok: false, detail: `frame ${i} is not ${width} finite numbers (t plus ${FRAME_STRIDE} per body for ${bodies.length} bodies)`, max_speed_mps: null };
    const r = row as number[];
    if (i === 0) t0 = r[0];
    for (let b = 0; b < bodies.length; b++) {
      for (let k = 0; k < 3; k++) {
        const c = r[1 + FRAME_STRIDE * b + k];
        if (Math.abs(c) > limits.position_bound_m && violations.length < 4)
          violations.push(`frame ${i} places ${String(bodies[b])} at ${c.toFixed(3)} m on axis ${"xyz"[k]}, outside the +/-${limits.position_bound_m} m world the simulator models (it ends such a run as DIVERGED, never as a collision)`);
      }
    }
    if (prev) {
      const step = r[0] - prev[0];
      if (step < 0 && violations.length < 4) violations.push(`frame ${i} steps backwards in time (t ${prev[0]} -> ${r[0]})`);
      // A short final tick is real; a stretched one is not trusted, so never divide by more than the tick.
      const dt = step > 0 && step < limits.dt_s ? step : limits.dt_s;
      for (let b = 0; b < bodies.length; b++) {
        const o = 1 + FRAME_STRIDE * b;
        const speed = Math.hypot(r[o] - prev[o], r[o + 1] - prev[o + 1], r[o + 2] - prev[o + 2]) / dt;
        if (speed > maxSpeed) {
          maxSpeed = speed;
          worst = `${String(bodies[b])} between frames ${i - 1} and ${i}`;
        }
      }
    }
    prev = r;
  }
  const span = (prev as number[])[0] - t0;
  if (span > limits.max_span_s)
    violations.push(`the recording spans ${span.toFixed(3)} s, longer than the ${limits.max_span_s.toFixed(3)} s a conclusive run can last under the simulator's own termination rules`);
  if (maxSpeed > limits.speed_ceiling_mps)
    violations.unshift(`${worst} moves at ${maxSpeed.toFixed(3)} m/s, above the ${limits.speed_ceiling_mps.toFixed(3)} m/s this scene can produce`);
  const ceiling = `fastest recorded body ${maxSpeed.toFixed(3)} m/s, ceiling ${limits.speed_ceiling_mps.toFixed(3)} m/s = ${limits.derivation}`;
  return { ok: violations.length === 0, detail: violations.length === 0 ? ceiling : `${violations.join("; ")} [${ceiling}]`, max_speed_mps: maxSpeed };
}

export async function verifySubmission(sub: Submission, packageBytes: Uint8Array, log: (m: string) => void): Promise<VerificationResult> {
  const checks: VerificationResult["checks"] = [];
  const fail = (status: VerificationResult["status"], reason: string): VerificationResult => ({ status, verdict: VERDICT[status], reason, method: null, fingerprint_match: null, checks });

  if (!check(checks, "schema", sub.schema === "tb-submission-1", sub.schema)) return fail("REJECTED", "unknown submission schema");
  const problems = checkAdmissible(sub.scenario as unknown as Record<string, unknown>);
  if (!check(checks, "admissible", problems.length === 0, problems.join("; "))) return fail("REJECTED", `out of envelope: ${problems.join("; ")}`);
  if (!check(checks, "envelope", sub.envelope_id === ENVELOPE_ID, sub.envelope_id)) return fail("REJECTED", "unknown envelope");
  const db = getDb();
  const prior = db.prepare("SELECT scenario, finding_id FROM ledger WHERE verification_status = 'VERIFIED' AND controller_hash = ?").all(sub.controller.hash) as { scenario: string; finding_id: string }[];
  const dup = prior.find((p) => isDuplicate(JSON.parse(p.scenario) as Scenario, sub.scenario));
  if (!check(checks, "not-duplicate", !dup, dup ? `near-duplicate of ledger finding ${dup.finding_id} (published rule: normalized L-inf distance < 0.05)` : "no prior finding within 0.05")) return fail("REJECTED", "approximate duplicate of an existing verified finding");
  if (!check(checks, "claims-collision", sub.claim.outcome === "COLLISION", sub.claim.outcome)) return fail("REJECTED", "claimed outcome is not a collision; not a failure finding");

  log(`verifier: re-running scenario in the verifier's pinned environment`);
  const name = `verify-${sub.package_commitment.slice(2, 10)}`;
  const v = await runScenario(VERIFIER_OUT, name, sub.scenario);
  const ran = v.doc.controller; // the controller the verifier actually executed, hashed by the simulator
  const limits = replayLimitsFrom(v.doc);
  const verifierRun = { outcome: v.doc.outcome, trajectory_hash: v.doc.trajectory_hash, controller: ran, metrics: v.doc.metrics, file: v.file, environment: v.doc.environment, replay_limits: limits };
  if (!check(checks, "verifier-run-admissible", v.doc.admissible && v.doc.outcome !== "INVALID_INITIAL_STATE", v.doc.outcome)) return { ...fail("REJECTED", `verifier run: ${v.doc.outcome}`), verifier_run: verifierRun };
  if (!check(checks, "verifier-run-conclusive", v.doc.outcome === "COLLISION" || v.doc.outcome === "SUCCESS", v.doc.outcome)) return { ...fail("INCONCLUSIVE", `verifier run ended with ${v.doc.outcome}`), verifier_run: verifierRun };
  if (!check(checks, "reproduces-collision", v.doc.outcome === "COLLISION", `verifier observed ${v.doc.outcome}`)) return { ...fail("REJECTED", "the claimed collision does not reproduce in the verifier's environment"), verifier_run: verifierRun };

  // EVIDENCE BINDING (a): the claim is only about the controller the verifier itself re-ran. Without
  // this, a seller could attach any controller id/hash to a real failure of a different controller.
  if (!check(checks, "claimed-controller-is-the-one-re-run", sub.controller.id === ran.id && sub.controller.hash === ran.hash, `claimed ${sub.controller.id} ${sub.controller.hash.slice(0, 20)}... vs re-run ${ran.id} ${ran.hash.slice(0, 20)}...`))
    return { ...fail("REJECTED", `claimed controller (${sub.controller.id} ${sub.controller.hash.slice(0, 20)}...) is not the controller the verifier re-ran (${ran.id} ${ran.hash.slice(0, 20)}...)`), verifier_run: verifierRun };

  // Recorded now, acted on after the package has been examined. A replay produced under a different
  // environment pin cannot be bound to this re-run by any hash, so it can never be certified here.
  const fpMatch = fingerprintHash(sub.environment) === fingerprintHash(v.doc.environment);
  check(checks, "environment-fingerprint-matches", fpMatch, fpMatch ? "the seller's environment pin is the verifier's own" : "the seller's declared environment pin differs from the verifier's own");
  const reject = (reason: string): VerificationResult => ({ ...fail("REJECTED", reason), fingerprint_match: fpMatch, verifier_run: verifierRun });

  // package checks - always run, whatever the environment says, so the delivered evidence is examined
  // on its own terms before any verdict is reached.
  if (!check(checks, "package-canonical", isCanonical(packageBytes))) return reject("package is not canonical JSON");
  const pkgHash = keccakHex(packageBytes);
  if (!check(checks, "package-commitment", pkgHash === sub.package_commitment, pkgHash)) return reject("package bytes do not hash to the stated commitment");
  const pkg = JSON.parse(Buffer.from(packageBytes).toString("utf8"));
  const sameScenario = dumps(pkg.scenario) === dumps(sub.scenario);
  if (!check(checks, "package-scenario-matches", sameScenario)) return reject("package scenario differs from submission");
  if (!check(checks, "package-has-salt", typeof pkg.salt_hex === "string" && /^0x[0-9a-f]{64}$/.test(pkg.salt_hex))) return reject("package lacks a 32-byte salt");
  if (!check(checks, "package-controller-is-the-one-re-run", pkg.controller?.id === ran.id && pkg.controller?.hash === ran.hash, `package ${pkg.controller?.id} ${String(pkg.controller?.hash).slice(0, 20)}... vs re-run ${ran.id} ${ran.hash.slice(0, 20)}...`))
    return reject("the package names a controller the verifier did not re-run");
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
    // Recorded as evidence only. Two runs agreeing on impact speed and contact time says something
    // about the SCENARIO; it says nothing about which frames the seller delivered, so on its own it
    // must never certify a replay. This is the hole the reviewer walked through.
    const dImp = Math.abs(Number(v.doc.metrics.impact_speed_mps) - Number(sub.claim.impact_speed_mps));
    const dT = Math.abs(Number(v.doc.metrics.first_contact_t_s) - Number(sub.claim.first_contact_t_s));
    const near = dImp <= TOLERANCE.impact_speed_mps && dT <= TOLERANCE.first_contact_t_s;
    check(checks, "metrics-agree-across-environments", near, `EVIDENCE ONLY, never certifies: impact speed diff ${dImp.toFixed(4)} m/s (tol ${TOLERANCE.impact_speed_mps}), contact time diff ${dT.toFixed(4)} s (tol ${TOLERANCE.first_contact_t_s})`);
    return {
      status: "INCONCLUSIVE",
      verdict: "INCONCLUSIVE",
      reason:
        "INCONCLUSIVE: the seller's environment differs from the verifier's, so the delivered replay cannot be bound to the run the verifier performed and therefore cannot be certified. " +
        `The collision ${v.doc.outcome === "COLLISION" ? "does reproduce" : "does not reproduce"} in the verifier's own environment and the headline metrics ${near ? "agree within tolerance" : "disagree"}, but agreeing metrics bind no replay: only an identical environment fingerprint plus frames that recompute to the verifier's own trajectory hash can do that. The verifier abstains rather than certify evidence it cannot check.`,
      method: null, fingerprint_match: false, verifier_run: verifierRun, checks,
    };
  }

  const method: VerificationResult["method"] = "exact-trajectory-hash";
  if (!check(checks, "trajectory-hash-identical", v.doc.trajectory_hash === sub.trajectory_hash, `${sub.trajectory_hash.slice(0, 18)} vs ${v.doc.trajectory_hash.slice(0, 18)}`))
    return { status: "INCONCLUSIVE", verdict: "INCONCLUSIVE", reason: "same environment fingerprint but different trajectory hash (numerical divergence or tampered run)", method, fingerprint_match: true, verifier_run: verifierRun, checks };
  if (!check(checks, "package-frames-reproduce-verified-trajectory", recomputed === v.doc.trajectory_hash, `${String(recomputed).slice(0, 20)}... vs verifier run ${v.doc.trajectory_hash.slice(0, 20)}...`))
    return { ...reject("the package's replay frames are not the trajectory the verifier re-ran"), method };
  if (!check(checks, "package-claim-matches", dumps(pkg.claim) === dumps(sub.claim))) return { ...reject("package claim differs from submission"), method };
  const bandOk = severityBand(Number(v.doc.metrics.impact_speed_mps)).band === sub.claim.severity_band;
  if (!check(checks, "severity-band-consistent", bandOk)) return { ...reject("advertised severity band does not match the verifier's observation"), method };

  return {
    status: "VERIFIED",
    verdict: "VALID",
    reason: "identical trajectory hash in a matching pinned environment; controller and delivered replay frames bound to the verifier's own re-run, and the frames are a physically possible trajectory of this scene",
    method, fingerprint_match: true, verifier_run: verifierRun, checks,
  };
}

export function buildPublicSummary(sub: Submission, res: VerificationResult, priceWei: bigint, sellerSettled: number) {
  const band = severityBand(Number(res.verifier_run!.metrics.impact_speed_mps));
  return {
    schema: SUMMARY_SCHEMA,
    format: "tb-cjson-1",
    controller: sub.controller,
    envelope_id: sub.envelope_id,
    admissible: true,
    claim_kind: "controller collides with the obstacle under admissible conditions inside the published envelope",
    verification: {
      status: res.status,
      verdict: res.verdict,
      method: res.method,
      verifier_version: VERIFIER_VERSION,
      verifier: roles.verifier().address,
      environment_fingerprint: fingerprintHash(res.verifier_run!.environment),
      evidence_binding: "the seller's environment fingerprint equalled the verifier's own, and the controller id+hash and the trajectory hash RECOMPUTED from the delivered replay frames were compared against the verifier's own re-run; declared hashes are not trusted, the frames were checked to be a physically possible trajectory of this scene, and a replay the verifier cannot bind exactly is INCONCLUSIVE rather than certified",
      verified_at: nowIso(),
    },
    operating_context: operatingContext(),
    severity: { proxy: band.proxy, band: band.band, definition: band.definition },
    seller: sub.seller,
    seller_settled_orders_at_listing: sellerSettled,
    price_wei: priceWei.toString(),
    chain: { mode: chainMode, chain_id: chainId, escrow: escrowAddress },
    hidden: "exact scenario parameters, trajectory, replay frames and reproduction command are in the private package only",
  };
}

export async function verifyAndList(sub: Submission, packageBytes: Uint8Array, opts: { priceWei: bigint; demoTamper: boolean }, log: (m: string) => void) {
  const res = await verifySubmission(sub, packageBytes, log);
  const db = getDb();
  const findingId = sub.package_commitment;
  for (const c of res.checks) log(`verifier:   ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? " - " + c.detail : ""}`);
  if (res.status !== "VERIFIED") {
    db.prepare("INSERT OR REPLACE INTO ledger(finding_id, listing_id, controller_id, controller_hash, envelope_id, scenario, outcome, impact_speed_mps, trajectory_hash, verification_status, verification_method, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(findingId, null, sub.controller.id, sub.controller.hash, sub.envelope_id, JSON.stringify(sub.scenario), sub.claim.outcome, sub.claim.impact_speed_mps, sub.trajectory_hash, res.status, res.method, nowIso());
    log(`verifier: ${res.status} - ${res.reason}`);
    return { result: res, listingId: null as Hex | null, summary: null };
  }
  const sellerSettled = await settledOrders(sub.seller as Hex);
  const summary = buildPublicSummary(sub, res, opts.priceWei, sellerSettled);
  const termsHash = commitment(summary);
  const listingId = keccakHex(new Uint8Array([...Buffer.from(sub.package_commitment.slice(2), "hex"), ...Buffer.from(termsHash.slice(2), "hex")]));
  log(`verifier: VERIFIED (${res.method}); registering listing ${listingId.slice(0, 12)}... on ${chainMode} (commitment ${sub.package_commitment.slice(0, 12)}..., terms ${termsHash.slice(0, 12)}...)`);
  const tx = await escrow.registerListing(roles.verifier(), listingId, sub.seller as Hex, opts.priceWei, sub.package_commitment as Hex, termsHash);
  db.prepare("INSERT INTO listings(listing_id, chain_mode, chain_id, escrow_address, seller, price_wei, commitment, terms_hash, public_summary, status, register_tx, demo_tamper, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(listingId, chainMode, chainId, escrowAddress, sub.seller, opts.priceWei.toString(), sub.package_commitment, termsHash, Buffer.from(dumpsBytes(summary)).toString("utf8"), "LISTED", tx.hash, opts.demoTamper ? 1 : 0, nowIso());
  db.prepare("INSERT INTO private_packages(listing_id, package_bytes, submission, verification) VALUES (?,?,?,?)")
    .run(listingId, packageBytes, JSON.stringify(sub), JSON.stringify(res));
  db.prepare("INSERT OR REPLACE INTO ledger(finding_id, listing_id, controller_id, controller_hash, envelope_id, scenario, outcome, impact_speed_mps, trajectory_hash, verification_status, verification_method, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(findingId, listingId, sub.controller.id, sub.controller.hash, sub.envelope_id, JSON.stringify(sub.scenario), sub.claim.outcome, sub.claim.impact_speed_mps, sub.trajectory_hash, "VERIFIED", res.method, nowIso());
  addEvent(listingId, "verifier", "verified", { status: res.status, method: res.method, reason: res.reason, checks: res.checks.length }, chainMode);
  addEvent(listingId, "verifier", "registered", { seller: sub.seller, price_wei: opts.priceWei.toString(), commitment: sub.package_commitment, terms_hash: termsHash, block: tx.block_number }, chainMode, tx.hash, tx.block_number);
  log(`verifier: registerListing tx ${tx.hash} block ${tx.block_number}`);
  return { result: res, listingId, summary, registerTx: tx };
}

export type DeliveryCheck = {
  valid: boolean; verdict: Verdict; reason: string; on_chain_commitment: string; delivered_hash: string; asserted_delivery_hash: string | null;
  checks: { name: string; ok: boolean; detail?: string }[]; checked_at: string;
};

/** After delivery: compare the bytes the seller served against the on-chain commitment and the
 *  advertised public summary, then settle on chain. */
export async function verifierCheckDeliveryAndSettle(order: OrderRow, log: (m: string) => void): Promise<{ check: DeliveryCheck; tx: string }> {
  const db = getDb();
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(order.listing_id) as unknown as ListingRow;
  const priv = db.prepare("SELECT package_bytes, submission, verification FROM private_packages WHERE listing_id = ?").get(order.listing_id) as { package_bytes: Uint8Array; submission: string; verification: string };
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
    const c1 = check(checks, "package-controller-matches-summary", pkg.controller?.hash === summary.controller.hash);
    const c2 = check(checks, "package-envelope-matches-summary", pkg.envelope_id === summary.envelope_id);
    const c3 = check(checks, "package-claim-matches-summary", pkg.claim?.outcome === "COLLISION" && pkg.claim?.severity_band === summary.severity.band, `${pkg.claim?.outcome} / ${pkg.claim?.severity_band}`);
    const c4 = check(checks, "package-scenario-admissible", checkAdmissible(pkg.scenario ?? {}).length === 0);
    // EVIDENCE BINDING (c) at delivery. The binding target is the verifier's OWN re-run trajectory
    // hash and nothing else. A listing may only exist if it was certified by "exact-trajectory-hash",
    // so that hash is always on record; if it is not (a record written before that rule), the
    // delivered replay cannot be bound here either and the check fails rather than falling back to
    // the seller's own declared trajectory.
    const target = verification.verifier_run?.trajectory_hash ?? null;
    const c0 = check(checks, "listing-was-certified-by-exact-trajectory-binding", verification.method === "exact-trajectory-hash" && typeof target === "string", `certification method ${String(verification.method)}, verifier re-run trajectory ${target === null ? "absent from the record" : "on record"}`);
    const c5 = check(checks, "package-replay-matches-verified-run", target !== null && pkg.replay?.trajectory_hash === target, `${String(pkg.replay?.trajectory_hash).slice(0, 14)}... vs verifier re-run ${String(target).slice(0, 14)}...`);
    // Recompute the trajectory hash from the bytes actually delivered: the declared field is evidence
    // of nothing on its own. (The commitment check above already fails on any byte change; this is the
    // check that binds the frames to the verified run rather than to the seller's own assertion.)
    const recomputed = recomputeTrajectoryHash(pkg.replay?.frames);
    const c6 = check(checks, "delivered-frames-hash-to-verified-trajectory", target !== null && recomputed !== null && recomputed === target, `keccak256(canonical(delivered frames)) ${String(recomputed).slice(0, 14)}... vs ${String(target).slice(0, 14)}...`);
    const ranController = verification.verifier_run?.controller ?? null;
    const c7 = check(checks, "delivered-controller-is-the-one-re-run", ranController !== null && pkg.controller?.id === ranController.id && pkg.controller?.hash === ranController.hash, ranController === null ? "the record does not name the controller the verifier re-ran" : `${String(pkg.controller?.hash).slice(0, 20)}... vs re-run ${ranController.hash.slice(0, 20)}...`);
    // The same physical-plausibility reading of the bytes actually served, so an absurd replay is
    // refused on its own terms here too and not only by hash. The delivery record is PUBLIC, so a
    // passing check states only the scene's own ceiling; a failing one may quote the delivered
    // numbers, which are by construction not a trajectory of anything.
    const limits = verification.verifier_run?.replay_limits ?? replayLimitsFrom({});
    const plausible = checkReplayPlausibility(pkg.replay?.frames, limits);
    const c8 = check(checks, "delivered-frames-physically-plausible", plausible.ok, plausible.ok ? `no recorded body exceeds the ${limits.speed_ceiling_mps.toFixed(3)} m/s this scene can produce (${limits.derivation})` : plausible.detail);
    contentOk = c0 && c1 && c2 && c3 && c4 && c5 && c6 && c7 && c8;
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
