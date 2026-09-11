// SELLER AGENT (local demonstration mode): runs the bounded hunter, packages findings, submits them to
// the verifier, and delivers packages to funded orders. Deterministic policy: submit the top-ranked
// distinct collisions from the grid hunt (mildest conditions first). It never edits the controller.
import path from "node:path";
import type { Hex } from "viem";
import { commitment, dumpsBytes, randomSaltHex } from "../canonical.js";
import { dataDir, roles, chainMode } from "../config.js";
import { escrow } from "../chain.js";
import { addEvent, getDb, nowIso, type OrderRow } from "../db.js";
import { ENVELOPE, NOMINAL_SCENARIO, isDuplicate, severityBand, type Scenario } from "../envelope.js";
import { hunt, runScenario, type HuntDoc, type RunDoc } from "../sim.js";

export const SELLER_OUT = path.join(dataDir, "sim", "seller");
export const SUBMISSION_SCHEMA = "tb-submission-1";
export const PACKAGE_SCHEMA = "tb-package-1";

export type Finding = { rank: number; scenario: Scenario; run: RunDoc; runBytes: Uint8Array; runFile: string };
export type Submission = {
  schema: string; seller: string; submitted_at: string; controller: { id: string; hash: string }; envelope_id: string;
  scenario: Scenario; claim: Claim; environment: Record<string, unknown>; trajectory_hash: string; mjcf_hash: string | null;
  metrics: Record<string, unknown>; events: unknown[]; hunter: { id: string; mode: string; search_cost: HuntDoc["search_cost"]; counts: HuntDoc["counts"] };
  package_commitment: string;
};
export type Claim = { outcome: string; impact_speed_mps: number | null; first_contact_t_s: number | null; severity_band: string };

export function claimFromRun(run: RunDoc): Claim {
  const impact = (run.metrics.impact_speed_mps as number | null) ?? null;
  return { outcome: run.outcome, impact_speed_mps: impact, first_contact_t_s: (run.metrics.first_contact_t_s as number | null) ?? null, severity_band: severityBand(impact).band };
}

export function changedConditions(scn: Scenario) {
  return (Object.keys(ENVELOPE) as (keyof Scenario)[])
    .filter((k) => scn[k] !== NOMINAL_SCENARIO[k])
    .map((k) => ({ parameter: k, nominal: NOMINAL_SCENARIO[k], value: scn[k], unit: ENVELOPE[k].unit }));
}

/** The private package: everything a buyer needs to reproduce and replay the failure. Includes a random salt. */
export function buildPrivatePackage(run: RunDoc, seller: string, salt: string = randomSaltHex()) {
  return {
    schema: PACKAGE_SCHEMA,
    format: "tb-cjson-1",
    salt_hex: salt,
    seller,
    created_at: nowIso(),
    controller: run.controller,
    envelope_id: run.envelope_id,
    engine: run.engine,
    environment: run.environment,
    scene: run.scene,
    termination_rules: run.termination_rules ?? null,
    scenario: run.scenario,
    nominal_scenario: NOMINAL_SCENARIO,
    changed_conditions: changedConditions(run.scenario),
    claim: claimFromRun(run),
    metrics: run.metrics,
    events: run.events,
    initial_state: run.initial_state ?? null,
    initial_state_check: run.initial_state_check ?? null,
    ticks: run.ticks,
    replay: { frames: run.frames, trajectory_hash: run.trajectory_hash, mjcf_hash: run.mjcf_hash ?? null },
    reproduce: {
      command: `uv run python -m tailbazaar_sim.cli --out OUT run --name finding --scenario '${JSON.stringify(run.scenario)}'`,
      note: "Reproduction is expected to be bit-identical only in the pinned environment (uv.lock hash in environment.uv_lock_sha256, same MuJoCo build, CPU architecture, single thread).",
    },
  };
}

export async function sellerDiscover(log: (m: string) => void, maxFindings = 2): Promise<{ hunt: HuntDoc; huntFile: string; findings: Finding[] }> {
  log("seller: running bounded grid hunt over sensor delay x floor friction (controller unchanged, envelope enforced)");
  const h = await hunt(SELLER_OUT, "grid");
  const c = h.doc.counts;
  log(`seller: hunt done: ${h.doc.search_cost.simulations} simulations, ${h.doc.search_cost.sim_steps} physics steps, ${h.doc.search_cost.wall_time_s}s wall; success=${c.success} collision=${c.collision} inconclusive=${c.inconclusive}; distinct findings=${h.doc.selected.length}, near-duplicates=${h.doc.near_duplicates.length}`);
  // Seller memory: never resubmit a scenario that is an approximate duplicate (published rule) of one
  // it already submitted; the verifier's ledger would reject it anyway.
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS seller_submissions (commitment TEXT PRIMARY KEY, scenario TEXT NOT NULL, submitted_at TEXT NOT NULL)");
  const prior = (db.prepare("SELECT scenario FROM seller_submissions").all() as { scenario: string }[]).map((r) => JSON.parse(r.scenario) as Scenario);
  const findings: Finding[] = [];
  let skipped = 0;
  for (const sel of h.doc.selected) {
    if (findings.length >= maxFindings) break;
    if (prior.some((p) => isDuplicate(p, sel.scenario))) { skipped++; continue; }
    const name = `finding-${findings.length + 1}`;
    const r = await runScenario(SELLER_OUT, name, sel.scenario);
    log(`seller: re-ran ${name} with full recording: ${r.doc.outcome}, impact ${r.doc.metrics.impact_speed_mps} m/s at t=${r.doc.metrics.first_contact_t_s}s, trajectory ${r.doc.trajectory_hash.slice(0, 18)}...`);
    findings.push({ rank: findings.length + 1, scenario: sel.scenario, run: r.doc, runBytes: r.bytes, runFile: r.file });
  }
  if (skipped) log(`seller: skipped ${skipped} finding(s) already submitted in earlier runs (seller memory, duplicate rule)`);
  return { hunt: h.doc, huntFile: h.file, findings };
}

export function buildSubmission(f: Finding, huntDoc: HuntDoc, packageDoc: ReturnType<typeof buildPrivatePackage>): { submission: Submission; packageBytes: Uint8Array; packageCommitment: Hex } {
  const packageBytes = dumpsBytes(packageDoc);
  const packageCommitment = commitment(packageDoc);
  getDb().prepare("INSERT OR IGNORE INTO seller_submissions(commitment, scenario, submitted_at) VALUES (?,?,?)").run(packageCommitment, JSON.stringify(f.run.scenario), nowIso());
  const submission: Submission = {
    schema: SUBMISSION_SCHEMA,
    seller: roles.seller().address,
    submitted_at: nowIso(),
    controller: f.run.controller,
    envelope_id: f.run.envelope_id,
    scenario: f.run.scenario,
    claim: claimFromRun(f.run),
    environment: f.run.environment,
    trajectory_hash: f.run.trajectory_hash,
    mjcf_hash: f.run.mjcf_hash ?? null,
    metrics: f.run.metrics,
    events: f.run.events,
    hunter: { id: huntDoc.hunter_id, mode: huntDoc.mode, search_cost: huntDoc.search_cost, counts: huntDoc.counts },
    package_commitment: packageCommitment,
  };
  return { submission, packageBytes, packageCommitment };
}

/** Produce the bytes the seller actually serves for an order. `tamper` is a LOCAL DEMONSTRATION switch
 *  that simulates a dishonest seller: the scenario inside the package is altered after the commitment
 *  was registered, so the delivered bytes no longer hash to the on-chain commitment. */
export function deliveredBytesFor(packageBytes: Uint8Array, tamper: boolean): Uint8Array {
  if (!tamper) return packageBytes;
  const doc = JSON.parse(Buffer.from(packageBytes).toString("utf8"));
  doc.scenario = { ...doc.scenario, sensor_delay_ms: NOMINAL_SCENARIO.sensor_delay_ms }; // claims a collision under nominal latency
  doc.tampered_by_demo = "LOCAL DEMONSTRATION: scenario altered after commitment";
  return dumpsBytes(doc);
}

export async function sellerDeliver(order: OrderRow, log: (m: string) => void): Promise<{ tx: string; delivery_hash: string; tampered: boolean }> {
  const db = getDb();
  const listing = db.prepare("SELECT demo_tamper, commitment FROM listings WHERE listing_id = ?").get(order.listing_id) as { demo_tamper: number; commitment: string };
  const pkg = db.prepare("SELECT package_bytes FROM private_packages WHERE listing_id = ?").get(order.listing_id) as { package_bytes: Uint8Array };
  const tamper = listing.demo_tamper === 1;
  const bytes = deliveredBytesFor(new Uint8Array(pkg.package_bytes), tamper);
  // A dishonest seller asserts the registered commitment as the delivery hash regardless of what it serves.
  const assertedHash = listing.commitment as Hex;
  const tx = await escrow.markDelivered(roles.seller(), order.listing_id as Hex, assertedHash);
  db.prepare("UPDATE orders SET delivered_bytes = ?, delivery_hash = ?, deliver_tx = ?, status = 'DELIVERED' WHERE order_id = ?").run(bytes, assertedHash, tx.hash, order.order_id);
  db.prepare("UPDATE listings SET status = 'DELIVERED' WHERE listing_id = ?").run(order.listing_id);
  addEvent(order.listing_id, "seller", "delivered", { asserted_delivery_hash: assertedHash, bytes: bytes.length, tampered_demo: tamper, block: tx.block_number }, chainMode, tx.hash, tx.block_number);
  log(`seller: markDelivered on chain (${chainMode}) tx ${tx.hash} block ${tx.block_number}${tamper ? " [DEMO: delivered bytes were tampered after commitment]" : ""}`);
  return { tx: tx.hash, delivery_hash: assertedHash, tampered: tamper };
}

export async function sellerWithdraw(log: (m: string) => void) {
  const tx = await escrow.withdraw(roles.seller());
  log(`seller: withdraw tx ${tx.hash} block ${tx.block_number}`);
  return tx;
}
