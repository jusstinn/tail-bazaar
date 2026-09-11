// VERIFIER AGENT (local demonstration mode, but the same logic a deployed verifier would run).
// Verification semantics (documented in README):
//   1. structural + admissibility checks on the submitted scenario (out-of-envelope -> REJECTED)
//   2. duplicate rule against the failure ledger (normalized L-inf distance < 0.05 -> REJECTED_DUPLICATE)
//   3. the claim must be a COLLISION (anything else is not a failure finding -> REJECTED)
//   4. re-run the scenario in the verifier's OWN pinned environment
//   5. EVIDENCE BINDING (a): the claimed controller id and hash must equal the controller the
//      verifier actually re-ran. A seller cannot mislabel the controller version.
//   6. if the environment fingerprint matches the seller's: the trajectory hash must be identical
//      (method "exact-trajectory-hash"); otherwise the observed metrics must agree within a stated
//      tolerance (method "metrics-tolerance"). Divergence -> INCONCLUSIVE; non-collision -> REJECTED.
//   7. the private package must be canonical, hash to the seller's stated commitment, and carry the
//      same scenario, controller, trajectory hash and claim as the verified run. EVIDENCE BINDING
//      (b): the trajectory hash is RECOMPUTED from the delivered replay frames, never read from the
//      package's declared field, so altered frames behind an intact declared hash are rejected.
//   8. publish a public summary (no parameters, no trajectory), register the listing on chain
import path from "node:path";
import type { Hex } from "viem";
import { commitment, dumps, dumpsBytes, isCanonical, keccakHex } from "../canonical.js";
import { chainId, chainMode, dataDir, escrowAddress, roles } from "../config.js";
import { escrow, getListingExpecting, settledOrders } from "../chain.js";
import { addEvent, getDb, nowIso, type ListingRow, type OrderRow } from "../db.js";
import { checkAdmissible, ENVELOPE_ID, isDuplicate, operatingContext, severityBand, type Scenario } from "../envelope.js";
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
  method: "exact-trajectory-hash" | "metrics-tolerance" | null;
  fingerprint_match: boolean | null;
  verifier_run?: { outcome: string; trajectory_hash: string; controller: { id: string; hash: string }; metrics: Record<string, unknown>; file: string; environment: Record<string, unknown> };
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
  const verifierRun = { outcome: v.doc.outcome, trajectory_hash: v.doc.trajectory_hash, controller: ran, metrics: v.doc.metrics, file: v.file, environment: v.doc.environment };
  if (!check(checks, "verifier-run-admissible", v.doc.admissible && v.doc.outcome !== "INVALID_INITIAL_STATE", v.doc.outcome)) return { ...fail("REJECTED", `verifier run: ${v.doc.outcome}`), verifier_run: verifierRun };
  if (!check(checks, "verifier-run-conclusive", v.doc.outcome === "COLLISION" || v.doc.outcome === "SUCCESS", v.doc.outcome)) return { ...fail("INCONCLUSIVE", `verifier run ended with ${v.doc.outcome}`), verifier_run: verifierRun };
  if (!check(checks, "reproduces-collision", v.doc.outcome === "COLLISION", `verifier observed ${v.doc.outcome}`)) return { ...fail("REJECTED", "the claimed collision does not reproduce in the verifier's environment"), verifier_run: verifierRun };

  // EVIDENCE BINDING (a): the claim is only about the controller the verifier itself re-ran. Without
  // this, a seller could attach any controller id/hash to a real failure of a different controller.
  if (!check(checks, "claimed-controller-is-the-one-re-run", sub.controller.id === ran.id && sub.controller.hash === ran.hash, `claimed ${sub.controller.id} ${sub.controller.hash.slice(0, 20)}... vs re-run ${ran.id} ${ran.hash.slice(0, 20)}...`))
    return { ...fail("REJECTED", `claimed controller (${sub.controller.id} ${sub.controller.hash.slice(0, 20)}...) is not the controller the verifier re-ran (${ran.id} ${ran.hash.slice(0, 20)}...)`), verifier_run: verifierRun };

  const fpMatch = fingerprintHash(sub.environment) === fingerprintHash(v.doc.environment);
  check(checks, "environment-fingerprint", true, fpMatch ? "seller and verifier environments match" : "environments differ; using metrics tolerance");
  let method: VerificationResult["method"];
  if (fpMatch) {
    method = "exact-trajectory-hash";
    if (!check(checks, "trajectory-hash-identical", v.doc.trajectory_hash === sub.trajectory_hash, `${sub.trajectory_hash.slice(0, 18)} vs ${v.doc.trajectory_hash.slice(0, 18)}`))
      return { status: "INCONCLUSIVE", verdict: "INCONCLUSIVE", reason: "same environment fingerprint but different trajectory hash (numerical divergence or tampered run)", method, fingerprint_match: true, verifier_run: verifierRun, checks };
  } else {
    method = "metrics-tolerance";
    const dImp = Math.abs(Number(v.doc.metrics.impact_speed_mps) - Number(sub.claim.impact_speed_mps));
    const dT = Math.abs(Number(v.doc.metrics.first_contact_t_s) - Number(sub.claim.first_contact_t_s));
    if (!check(checks, "metrics-within-tolerance", dImp <= TOLERANCE.impact_speed_mps && dT <= TOLERANCE.first_contact_t_s, `impact speed diff ${dImp.toFixed(4)} m/s (tol ${TOLERANCE.impact_speed_mps}), contact time diff ${dT.toFixed(4)} s (tol ${TOLERANCE.first_contact_t_s})`))
      return { status: "INCONCLUSIVE", verdict: "INCONCLUSIVE", reason: "different environment and metrics outside tolerance", method, fingerprint_match: false, verifier_run: verifierRun, checks };
  }

  // package checks
  if (!check(checks, "package-canonical", isCanonical(packageBytes))) return { ...fail("REJECTED", "package is not canonical JSON"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  const pkgHash = keccakHex(packageBytes);
  if (!check(checks, "package-commitment", pkgHash === sub.package_commitment, pkgHash)) return { ...fail("REJECTED", "package bytes do not hash to the stated commitment"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  const pkg = JSON.parse(Buffer.from(packageBytes).toString("utf8"));
  const sameScenario = dumps(pkg.scenario) === dumps(sub.scenario);
  if (!check(checks, "package-scenario-matches", sameScenario)) return { ...fail("REJECTED", "package scenario differs from submission"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  if (!check(checks, "package-has-salt", typeof pkg.salt_hex === "string" && /^0x[0-9a-f]{64}$/.test(pkg.salt_hex))) return { ...fail("REJECTED", "package lacks a 32-byte salt"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  if (!check(checks, "package-controller-is-the-one-re-run", pkg.controller?.id === ran.id && pkg.controller?.hash === ran.hash, `package ${pkg.controller?.id} ${String(pkg.controller?.hash).slice(0, 20)}... vs re-run ${ran.id} ${ran.hash.slice(0, 20)}...`))
    return { ...fail("REJECTED", "the package names a controller the verifier did not re-run"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  if (!check(checks, "package-trajectory-matches", pkg.replay?.trajectory_hash === sub.trajectory_hash)) return { ...fail("REJECTED", "package replay hash differs from submission"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  // EVIDENCE BINDING (b): recompute the trajectory hash from the delivered frames. The declared
  // replay.trajectory_hash is never trusted, so frames altered behind an intact declared hash fail.
  const recomputed = recomputeTrajectoryHash(pkg.replay?.frames);
  if (!check(checks, "package-frames-hash-to-declared-trajectory", recomputed !== null && recomputed === pkg.replay?.trajectory_hash, `keccak256(canonical(frames)) = ${String(recomputed).slice(0, 20)}... vs declared ${String(pkg.replay?.trajectory_hash).slice(0, 20)}...`))
    return { ...fail("REJECTED", "the package's replay frames do not hash to its declared trajectory hash (frames altered after the hash was written)"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  if (fpMatch && !check(checks, "package-frames-reproduce-verified-trajectory", recomputed === v.doc.trajectory_hash, `${String(recomputed).slice(0, 20)}... vs verifier run ${v.doc.trajectory_hash.slice(0, 20)}...`))
    return { ...fail("REJECTED", "the package's replay frames are not the trajectory the verifier re-ran"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  if (!check(checks, "package-claim-matches", dumps(pkg.claim) === dumps(sub.claim))) return { ...fail("REJECTED", "package claim differs from submission"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };
  const bandOk = severityBand(Number(v.doc.metrics.impact_speed_mps)).band === sub.claim.severity_band;
  if (!check(checks, "severity-band-consistent", bandOk)) return { ...fail("REJECTED", "advertised severity band does not match the verifier's observation"), method, fingerprint_match: fpMatch, verifier_run: verifierRun };

  return {
    status: "VERIFIED",
    verdict: "VALID",
    reason: fpMatch
      ? "identical trajectory hash in a matching pinned environment; controller and delivered replay frames bound to the verifier's own re-run"
      : "metrics within tolerance across differing environments; controller bound to the verifier's own re-run and delivered frames hash to the declared trajectory",
    method, fingerprint_match: fpMatch, verifier_run: verifierRun, checks,
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
      evidence_binding: "the controller id+hash and the trajectory hash recomputed from the delivered replay frames were compared against the verifier's own re-run; declared hashes are not trusted",
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
    // Binding target for the delivered replay. Under "exact-trajectory-hash" it is the verifier's own
    // re-run trajectory. Under "metrics-tolerance" the two environments differ by construction, so the
    // target is the trajectory hash the verifier accepted from the submission at listing time.
    const exact = verification.method === "exact-trajectory-hash";
    const submission = JSON.parse(priv.submission) as Submission;
    const target = exact ? verification.verifier_run?.trajectory_hash : submission.trajectory_hash;
    const c5 = check(checks, "package-replay-matches-verified-run", pkg.replay?.trajectory_hash === target, `${String(pkg.replay?.trajectory_hash).slice(0, 14)}... vs ${exact ? "verifier re-run" : "trajectory verified at listing"} ${String(target).slice(0, 14)}...`);
    // Recompute the trajectory hash from the bytes actually delivered: the declared field is evidence
    // of nothing on its own. (The commitment check above already fails on any byte change; this is the
    // check that binds the frames to the verified run rather than to the seller's own assertion.)
    const recomputed = recomputeTrajectoryHash(pkg.replay?.frames);
    const c6 = check(checks, "delivered-frames-hash-to-verified-trajectory", recomputed !== null && recomputed === target, `keccak256(canonical(delivered frames)) ${String(recomputed).slice(0, 14)}... vs ${String(target).slice(0, 14)}...`);
    const ranController = verification.verifier_run?.controller ?? null;
    const c7 = check(checks, "delivered-controller-is-the-one-re-run", ranController === null || (pkg.controller?.id === ranController.id && pkg.controller?.hash === ranController.hash), ranController === null ? "verifier run predates this record; bound through the public summary instead" : `${String(pkg.controller?.hash).slice(0, 20)}... vs re-run ${ranController.hash.slice(0, 20)}...`);
    contentOk = c1 && c2 && c3 && c4 && c5 && c6 && c7;
  } else {
    check(checks, "package-content", false, hashOk ? "not canonical JSON" : "skipped: commitment mismatch");
  }
  const valid = onChain.status === 3 && hashOk && contentOk;
  const checkDoc: DeliveryCheck = {
    valid,
    verdict: valid ? "VALID" : "INVALID",
    reason: valid ? "delivered package hashes to the on-chain commitment, matches the advertised terms, and its replay frames hash to the trajectory the verifier re-ran" : !hashOk ? "COMMITMENT MISMATCH: delivered bytes do not hash to the on-chain commitment" : "delivered package does not match the advertised terms",
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
