// SELLER AGENT (local demonstration mode): runs the bounded hunter FOR ONE TARGET, packages findings,
// submits them to the verifier, and delivers packages to funded orders. Deterministic policy: submit
// the top-ranked distinct failures from that target's hunt (mildest conditions first). It never edits
// the controller, the policy or the scene.
import path from "node:path";
import type { Hex } from "viem";
import { commitment, dumpsBytes, randomSaltHex } from "../canonical.js";
import { dataDir, roles, chainMode } from "../config.js";
import { escrow } from "../chain.js";
import { addEvent, getDb, nowIso, type OrderRow } from "../db.js";
import { hunt, runScenario, type RunDoc } from "../sim.js";
import { targetFor, type Claim, type HuntSummary, type Scenario, type Subject, type TargetSpec } from "../targets.js";

export const SELLER_OUT = path.join(dataDir, "sim", "seller");
export const SUBMISSION_SCHEMA = "tb-submission-2";
export const PACKAGE_SCHEMA = "tb-package-2";

/** Per-target output directory, so two targets never overwrite each other's run documents. */
export const sellerOutFor = (t: TargetSpec): string => path.join(SELLER_OUT, t.id);

export type Finding = { rank: number; target: TargetSpec; scenario: Scenario; run: RunDoc; runBytes: Uint8Array; runFile: string };

/** What a hunt cost and what it produced, as an AGGREGATE. Never a per-listing pre-purchase
 *  disclosure: it travels inside the private package and is shown only after payment. */
export type HunterRecord = {
  id: string; mode: string; target_id: string;
  search_cost: HuntSummary["search_cost"];
  counts: HuntSummary["counts"];
  distinct_findings: number; near_duplicates: number;
};

export type Submission = {
  schema: string; seller: string; submitted_at: string; target_id: string;
  controller: Subject; envelope_id: string;
  scenario: Scenario; claim: Claim; environment: Record<string, unknown>; trajectory_hash: string; mjcf_hash: string | null;
  metrics: Record<string, unknown>; events: unknown[]; hunter: HunterRecord;
  package_commitment: string;
};

export type { Claim };

export function claimFromRun(target: TargetSpec, run: RunDoc): Claim {
  return target.claimFromRun(run);
}

export function changedConditions(target: TargetSpec, scn: Scenario) {
  return target.changedConditions(scn);
}

/** The private package: everything a buyer needs to reproduce and replay the failure. Includes a
 *  random salt, and the AGGREGATE search cost of the hunt that found it (post-purchase only). */
export function buildPrivatePackage(target: TargetSpec, run: RunDoc, seller: string, hunter: HunterRecord, salt: string = randomSaltHex()) {
  return {
    schema: PACKAGE_SCHEMA,
    format: "tb-cjson-1",
    salt_hex: salt,
    seller,
    created_at: nowIso(),
    target_id: target.id,
    target_label: target.label,
    controller: target.subjectOf(run),
    envelope_id: run.envelope_id,
    engine: run.engine,
    environment: run.environment,
    scene: run.scene,
    termination_rules: run.termination_rules ?? null,
    scenario: run.scenario,
    nominal_scenario: target.nominal_scenario,
    changed_conditions: target.changedConditions(run.scenario),
    claim: target.claimFromRun(run),
    metrics: run.metrics,
    events: run.events,
    hunter,
    initial_state: run.initial_state ?? null,
    initial_state_check: run.initial_state_check ?? null,
    // Fixed scene geometry a replay needs that is NOT a posed body, and therefore not in `frames`:
    // the arm target's goal is a MuJoCo site, published once per episode. Null for targets with none.
    goal_m: (run as { goal_m?: unknown }).goal_m ?? null,
    ticks: run.ticks,
    replay: { frames: run.frames, trajectory_hash: run.trajectory_hash, mjcf_hash: run.mjcf_hash ?? null, renderer: target.replay_renderer },
    reproduce: {
      command: target.reproduceCommand(run.scenario),
      note: "Reproduction is expected to be bit-identical only in the pinned environment (uv.lock hash in environment.uv_lock_sha256, same engine build, CPU architecture, single thread).",
    },
  };
}

export async function sellerDiscover(target: TargetSpec, log: (m: string) => void, maxFindings = 2): Promise<{ hunter: HunterRecord; huntFile: string; findings: Finding[] }> {
  const outDir = sellerOutFor(target);
  log(`seller[${target.id}]: running the bounded ${target.sim.hunt_mode} hunt over the published envelope (${target.envelope_id}); the ${target.subject_noun} is never edited`);
  const h = await hunt(target, outDir);
  const c = h.summary.counts;
  const hunter: HunterRecord = {
    id: h.summary.hunter_id, mode: h.summary.mode, target_id: target.id,
    search_cost: h.summary.search_cost, counts: c,
    distinct_findings: h.summary.selected.length, near_duplicates: h.summary.near_duplicates,
  };
  log(`seller[${target.id}]: hunt done: ${c.simulations} simulations, ${h.summary.search_cost.sim_steps} physics steps, ${h.summary.search_cost.wall_time_s}s wall; failures=${c.failures} survived=${c.survived} inconclusive=${c.inconclusive}; by class ${JSON.stringify(c.by_class)}; distinct findings=${hunter.distinct_findings}, near-duplicates=${hunter.near_duplicates}`);
  // Seller memory: never resubmit a scenario that is an approximate duplicate (published rule) of one
  // it already submitted FOR THIS TARGET; the verifier's ledger would reject it anyway.
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS seller_submissions (commitment TEXT PRIMARY KEY, scenario TEXT NOT NULL, submitted_at TEXT NOT NULL)");
  ensureColumn(db, "seller_submissions", "target_id", "TEXT");
  const prior = (db.prepare("SELECT scenario FROM seller_submissions WHERE target_id = ? OR target_id IS NULL").all(target.id) as { scenario: string }[])
    .map((r) => JSON.parse(r.scenario) as Scenario)
    .filter((s) => target.checkAdmissible(s).length === 0);
  const findings: Finding[] = [];
  let skipped = 0;
  for (const sel of h.summary.selected) {
    if (findings.length >= maxFindings) break;
    if (prior.some((p) => target.isDuplicate(p, sel.scenario))) { skipped++; continue; }
    const name = `finding-${findings.length + 1}`;
    const r = await runScenario(target, outDir, name, sel.scenario);
    const claim = target.claimFromRun(r.doc);
    log(`seller[${target.id}]: re-ran ${name} with full recording: ${r.doc.outcome}, ${claim.severity_proxy} ${claim.severity_value} ${claim.severity_units} at t=${claim.moment_t_s}s, trajectory ${r.doc.trajectory_hash.slice(0, 18)}...`);
    findings.push({ rank: findings.length + 1, target, scenario: sel.scenario, run: r.doc, runBytes: r.bytes, runFile: r.file });
  }
  if (skipped) log(`seller[${target.id}]: skipped ${skipped} finding(s) already submitted in earlier runs (seller memory, duplicate rule)`);
  return { hunter, huntFile: h.file, findings };
}

function ensureColumn(db: ReturnType<typeof getDb>, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function buildSubmission(f: Finding, hunter: HunterRecord, packageDoc: ReturnType<typeof buildPrivatePackage>): { submission: Submission; packageBytes: Uint8Array; packageCommitment: Hex } {
  const target = f.target;
  const packageBytes = dumpsBytes(packageDoc);
  const packageCommitment = commitment(packageDoc);
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS seller_submissions (commitment TEXT PRIMARY KEY, scenario TEXT NOT NULL, submitted_at TEXT NOT NULL)");
  ensureColumn(db, "seller_submissions", "target_id", "TEXT");
  db.prepare("INSERT OR IGNORE INTO seller_submissions(commitment, scenario, submitted_at, target_id) VALUES (?,?,?,?)").run(packageCommitment, JSON.stringify(f.run.scenario), nowIso(), target.id);
  const submission: Submission = {
    schema: SUBMISSION_SCHEMA,
    seller: roles.seller().address,
    submitted_at: nowIso(),
    target_id: target.id,
    controller: target.subjectOf(f.run),
    envelope_id: f.run.envelope_id,
    scenario: f.run.scenario,
    claim: target.claimFromRun(f.run),
    environment: f.run.environment,
    trajectory_hash: f.run.trajectory_hash,
    mjcf_hash: f.run.mjcf_hash ?? null,
    metrics: f.run.metrics,
    events: f.run.events,
    hunter,
    package_commitment: packageCommitment,
  };
  return { submission, packageBytes, packageCommitment };
}

/** Produce the bytes the seller actually serves for an order. `tamper` is a LOCAL DEMONSTRATION switch
 *  that simulates a dishonest seller: one axis of the scenario inside the package is moved back to the
 *  nominal operating point after the commitment was registered, so the package now claims the failure
 *  happened under milder conditions than it did — and the delivered bytes no longer hash to the
 *  on-chain commitment. Which axis is read from the target's own changed-conditions list, so the
 *  demonstration works for any target without a special case. */
export function deliveredBytesFor(packageBytes: Uint8Array, tamper: boolean): Uint8Array {
  if (!tamper) return packageBytes;
  const doc = JSON.parse(Buffer.from(packageBytes).toString("utf8"));
  const target = targetFor(doc.target_id);
  const changed = target.changedConditions(doc.scenario ?? {});
  const axis = changed[0];
  if (axis) doc.scenario = { ...doc.scenario, [axis.parameter]: axis.nominal };
  doc.tampered_by_demo = `LOCAL DEMONSTRATION: ${axis ? axis.parameter : "the scenario"} altered after commitment`;
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
