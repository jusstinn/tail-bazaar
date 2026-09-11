// LOCAL DEMONSTRATION PIPELINE: runs the seller, verifier and buyer agents end to end, FOR EVERY
// TARGET IN THE REGISTRY, against the configured chain (local anvil or Base Sepolia). One run at a
// time. Every step is logged and stored.
//
// Per target: the seller runs that target's bounded hunt with that target's own CLI, submits its
// mildest distinct findings, and the verifier re-runs each one with the same CLI and the same
// binding rules. One listing per pipeline run is deliberately delivered tampered so the refund path
// is on screen too. The buyer then shops TARGET BY TARGET under a budget, which is what makes the
// target filter visible in the log.
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import { balanceOf, publicClient, requireEscrow, retry, saveReceipt, verifierOf, withdrawable } from "./chain.js";
import { buyerBudgetWei, chainId, chainMode, dataDir, listingPriceWei, publicBaseUrl, roleAddresses, roles } from "./config.js";
import { addEvent, getDb, nowIso, publicListing, publicOrder, type ListingRow, type OrderRow } from "./db.js";
import { writeLedger } from "./ledger.js";
import { provenance } from "./provenance.js";
import { runScenario } from "./sim.js";
import { TARGET_IDS, TARGETS, type TargetId, type TargetSpec } from "./targets.js";
import { buyerFund, buyerRetrieveAndCheck, buyerWithdraw, describePolicy, selectListing, type BuyerPolicy } from "./agents/buyer.js";
import { buildPrivatePackage, buildSubmission, sellerDeliver, sellerDiscover, sellerWithdraw } from "./agents/seller.js";
import { verifierCheckDeliveryAndSettle, verifyAndList } from "./agents/verifier.js";

export type PipelineLog = { ts: string; msg: string }[];
let running: { run_id: string; started_at: string; log: PipelineLog; status: "running" | "done" | "failed"; error?: string } | null = null;
let lastFinishedAt = 0;

export function pipelineStatus() {
  if (running) return { run_id: running.run_id, status: running.status, started_at: running.started_at, log: running.log, error: running.error ?? null };
  // No run in this process: report the most recent persisted run (e.g. one made by `npm run demo`).
  const row = getDb().prepare("SELECT run_id, started_at, status, log FROM pipeline_runs ORDER BY started_at DESC LIMIT 1").get() as { run_id: string; started_at: string; status: string; log: string } | undefined;
  if (!row) return null;
  const log = JSON.parse(row.log) as PipelineLog;
  const failed = log.find((l) => l.msg.startsWith("pipeline FAILED"));
  return { run_id: row.run_id, status: row.status === "running" ? "failed" : row.status, started_at: row.started_at, log, error: failed ? failed.msg : null };
}

export const PUBLIC_OUT = path.join(dataDir, "sim", "public");
export const publicOutFor = (t: TargetSpec): string => path.join(PUBLIC_OUT, t.id);

/** Public baseline run (nominal conditions) for one target. Regenerated in the current environment
 *  if missing. It is the surviving run the replay draws as a ghost behind the purchased failure. */
export async function ensureBaseline(target: TargetSpec): Promise<{ file: string; trajectory_hash: string }> {
  // Before the marketplace was multi-target the cart baseline lived one directory up; keep reading it.
  const legacy = path.join(PUBLIC_OUT, "runs", "baseline.json");
  const file = path.join(publicOutFor(target), "runs", "baseline.json");
  if (!fs.existsSync(file) && target.id === "cart" && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(legacy, file);
  }
  if (!fs.existsSync(file)) await runScenario(target, publicOutFor(target), "baseline", target.nominal_scenario);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, trajectory_hash: doc.trajectory_hash };
}

/** How many findings each target lists in one demonstration run, and which of them is delivered
 *  tampered. The tampered one is always the cart's second listing, so a single demo shows both a
 *  valid settlement and a refund without spending four transactions on the refund path. */
const FINDINGS_PER_TARGET = 2;
const TAMPERED: { target: TargetId; rank: number } = { target: "cart", rank: 2 };

export async function runDemoPipeline(opts: { evidenceDir?: string | null; baseUrl?: string; targets?: TargetId[] } = {}): Promise<{ run_id: string; log: PipelineLog; orders: string[] }> {
  if (running && running.status === "running") throw new Error("a pipeline run is already in progress");
  if (Date.now() - lastFinishedAt < 15_000) throw new Error("please wait a few seconds between pipeline runs");
  const run_id = "run-" + Date.now().toString(36);
  const log: PipelineLog = [];
  running = { run_id, started_at: nowIso(), log, status: "running" };
  const db = getDb();
  db.prepare("INSERT INTO pipeline_runs(run_id, started_at, status, log) VALUES (?,?,?,?)").run(run_id, running.started_at, "running", "[]");
  const L = (msg: string) => {
    log.push({ ts: nowIso(), msg });
    console.log(`[pipeline] ${msg}`);
    db.prepare("UPDATE pipeline_runs SET log = ? WHERE run_id = ?").run(JSON.stringify(log), run_id);
  };
  const orders: string[] = [];
  const baseUrl = opts.baseUrl ?? publicBaseUrl;
  const evidenceDir = opts.evidenceDir ?? null;
  const targetIds = opts.targets ?? TARGET_IDS;
  const receipts = async (name: string, hash: string | null | undefined) => {
    if (evidenceDir && hash) await saveReceipt(path.join(evidenceDir, "receipts"), name, hash as Hex);
  };
  try {
    // ---- preflight ----
    const addrs = roleAddresses();
    const escrowAddr = requireEscrow();
    const code = await publicClient.getCode({ address: escrowAddr });
    if (!code || code === "0x") throw new Error(`no contract code at ${escrowAddr} on ${chainMode}`);
    const onChainVerifier = await verifierOf();
    if (onChainVerifier.toLowerCase() !== addrs.verifier.toLowerCase()) throw new Error(`escrow verifier ${onChainVerifier} is not our verifier ${addrs.verifier}`);
    const prov = provenance();
    L(`provenance: git ${prov.git_sha ? prov.git_sha.slice(0, 12) : "unknown"}${prov.git_dirty ? " (DIRTY working tree)" : prov.git_dirty === false ? " (clean)" : ""}, envelopes ${prov.envelope_ids.join(", ")}, config hash ${prov.envelope_config_hash.slice(0, 14)}...`);
    L(`preflight: chain mode ${chainMode} (chain id ${chainId}), escrow ${escrowAddr}, block ${await publicClient.getBlockNumber()}`);
    L(`targets in this run: ${targetIds.map((t) => `${t} (${TARGETS[t].envelope_id}, ${TARGETS[t].sim.module})`).join("; ")}`);
    for (const [role, a] of Object.entries(addrs)) {
      // a just-confirmed top-up may not be visible on every RPC backend yet: retry zero balances briefly
      const b = await retry(async () => { const x = await balanceOf(a as Hex); if (x === 0n) throw new Error("zero"); return x; }, 8, 2500).catch(() => 0n);
      L(`preflight: ${role} ${a} balance ${b} wei`);
      if (b === 0n) throw new Error(`${role} wallet ${a} has no ${chainMode === "testnet" ? "Base Sepolia test ETH" : "local ether"}`);
    }

    // ---- per target: baseline, seller discovery, verifier listing ----
    const listedByTarget = new Map<TargetId, Hex[]>();
    let listedCount = 0;
    for (const id of targetIds) {
      const target = TARGETS[id];
      const base = await ensureBaseline(target);
      L(`[${id}] public baseline run (nominal conditions, survives) trajectory ${base.trajectory_hash.slice(0, 18)}...`);
      const disc = await sellerDiscover(target, L, FINDINGS_PER_TARGET);
      if (disc.findings.length === 0) { L(`[${id}] the hunter found no new admissible failure inside the envelope; skipping this target`); continue; }
      if (evidenceDir) fs.copyFileSync(disc.huntFile, path.join(evidenceDir, `hunt-${id}-${disc.hunter.mode}.json`));
      const listed: Hex[] = [];
      for (const f of disc.findings) {
        const tamper = id === TAMPERED.target && f.rank === TAMPERED.rank;
        const pkgDoc = buildPrivatePackage(target, f.run, addrs.seller, disc.hunter);
        const { submission, packageBytes, packageCommitment } = buildSubmission(f, disc.hunter, pkgDoc);
        L(`seller[${id}]: submitting finding #${f.rank} (claim: ${submission.claim.failure_class}, ${submission.claim.severity_band} severity band) with salted package commitment ${packageCommitment.slice(0, 14)}...${tamper ? " [DEMO: this listing's delivery will be tampered]" : ""}`);
        const res = await verifyAndList(submission, packageBytes, { priceWei: listingPriceWei, demoTamper: tamper }, L);
        if (res.listingId) {
          listed.push(res.listingId);
          listedCount++;
          await receipts(`listing-${listedCount}-${id}-register`, res.registerTx?.hash);
          if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, `listing-${listedCount}-${id}-public-summary.json`), JSON.stringify(res.summary, null, 2) + "\n");
        }
      }
      if (listed.length) listedByTarget.set(id, listed);
    }
    if (listedCount === 0) throw new Error("no listing was registered for any target");
    L(`marketplace: ${listedCount} listing(s) across ${listedByTarget.size} target(s) — ${[...listedByTarget].map(([t, l]) => `${t}: ${l.length}`).join(", ")}`);

    // ---- buyer purchases, target by target, under a budget ----
    // One policy per target makes the filter visible: every listing of the other target is skipped
    // with a printed reason, and the budget is what stops the buyer, not the supply.
    for (const [id, listed] of listedByTarget) {
      const budget = listingPriceWei * BigInt(listed.length);
      const policy: BuyerPolicy = {
        target_ids: [id],
        target_controller_id: null, target_controller_hash: null,
        target_envelope_id: TARGETS[id].envelope_id,
        per_purchase_cap_wei: buyerBudgetWei,
        remaining_budget_wei: budget,
      };
      L(`buyer: shopping for target ${id} with policy ${JSON.stringify(describePolicy(policy))}`);
      for (let i = 0; i < listed.length; i++) {
        const sel = await selectListing(policy, L);
        if (!sel.chosen) { L(`buyer: no eligible ${id} listing under the current policy and budget; moving on`); break; }
        const listing = sel.chosen;
        L(`buyer: selected ${id} listing ${listing.listing_id.slice(0, 12)}... at ${listing.price_wei} wei`);
        const order = await buyerFund(listing, L);
        policy.remaining_budget_wei -= BigInt(listing.price_wei);
        orders.push(order.order_id);
        const n = orders.length;
        await receipts(`order-${n}-${id}-fund`, order.fund_tx);
        const del = await sellerDeliver(order, L);
        await receipts(`order-${n}-${id}-deliver`, del.tx);
        const fresh = () => db.prepare("SELECT * FROM orders WHERE order_id = ?").get(order.order_id) as unknown as OrderRow;
        const ret = await buyerRetrieveAndCheck(fresh(), baseUrl, L);
        if (!ret.check.ok) await receipts(`order-${n}-${id}-recheck`, fresh().recheck_tx);
        L("buyer: requesting verification of the delivered package");
        const settled = await verifierCheckDeliveryAndSettle(fresh(), L);
        await receipts(`order-${n}-${id}-settle`, settled.tx);
        if (settled.check.valid) {
          const w = await sellerWithdraw(L);
          db.prepare("UPDATE orders SET withdraw_tx = ? WHERE order_id = ?").run(w.hash, order.order_id);
          addEvent(order.listing_id, "seller", "withdrawn", { amount_wei: order.price_wei, block: w.block_number }, chainMode, w.hash, w.block_number);
          await receipts(`order-${n}-${id}-withdraw-seller`, w.hash);
        } else {
          const w = await buyerWithdraw(L);
          db.prepare("UPDATE orders SET withdraw_tx = ? WHERE order_id = ?").run(w.hash, order.order_id);
          addEvent(order.listing_id, "buyer", "refund_withdrawn", { amount_wei: order.price_wei, block: w.block_number }, chainMode, w.hash, w.block_number);
          await receipts(`order-${n}-${id}-withdraw-buyer`, w.hash);
        }
        // read the credited party's balance until the withdraw is visible (lagging RPC backends)
        const credited = (settled.check.valid ? addrs.seller : addrs.buyer) as Hex;
        const left = await retry(async () => { const x = await withdrawable(credited); if (x !== 0n) throw new Error("not yet"); return x; }, 8, 2500).catch(() => withdrawable(credited));
        L(`order ${n} (${id}): ${settled.check.valid ? "VALID -> seller paid" : "INVALID -> buyer refunded"}; ${settled.check.valid ? "seller" : "buyer"} withdrawable after withdraw = ${left} wei`);
        if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, `order-${n}-${id}.json`), JSON.stringify({ order: publicOrder(fresh()), listing: publicListing(db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(order.listing_id) as unknown as ListingRow), events: db.prepare("SELECT * FROM events WHERE listing_id = ? ORDER BY id").all(order.listing_id) }, null, 2) + "\n");
      }
    }
    if (evidenceDir) {
      // The failure ledger a GUARD-style estimator would ingest. It carries the theta vector of every
      // finding, so it is an operator/Loop-facing artifact: no HTTP route ever serves it.
      const led = writeLedger(path.join(evidenceDir, "ledger.json"));
      L(`failure ledger: ${led.doc.n_findings} finding(s) (${JSON.stringify(led.doc.verdict_counts)}) across targets ${JSON.stringify(led.doc.findings_by_target)} over ${led.doc.n_search_runs} search simulations -> ${led.file}`);
    }
    if (evidenceDir && chainMode === "testnet") writeTestnetMd(evidenceDir, orders);
    running.status = "done";
    lastFinishedAt = Date.now();
    db.prepare("UPDATE pipeline_runs SET status = 'done', finished_at = ?, log = ? WHERE run_id = ?").run(nowIso(), JSON.stringify(log), run_id);
    L("pipeline finished");
    return { run_id, log, orders };
  } catch (e: any) {
    running.status = "failed";
    running.error = String(e?.message ?? e);
    lastFinishedAt = Date.now();
    L(`pipeline FAILED: ${running.error}`);
    db.prepare("UPDATE pipeline_runs SET status = 'failed', finished_at = ?, log = ? WHERE run_id = ?").run(nowIso(), JSON.stringify(log), run_id);
    throw e;
  }
}

function writeTestnetMd(evidenceDir: string, orderIds: string[]) {
  const db = getDb();
  const dep = fs.existsSync(path.join(evidenceDir, "deployment.json")) ? JSON.parse(fs.readFileSync(path.join(evidenceDir, "deployment.json"), "utf8")) : null;
  const ex = "https://sepolia.basescan.org";
  const lines: string[] = [];
  lines.push("# Base Sepolia evidence (public testnet, test ETH only)", "");
  lines.push(`Generated ${nowIso()} by the marketplace pipeline in testnet mode. Every hash below is a real transaction on chain id 84532; receipts are in \`receipts/\`.`, "");
  if (dep) {
    lines.push("## Contract", "", `- FailureEscrow: [${dep.address}](${ex}/address/${dep.address})`, `- Deployment tx: [${dep.deploy_tx}](${ex}/tx/${dep.deploy_tx}) (block ${dep.block})`, `- Verifier (deployer): ${dep.verifier}`, `- Source verification: sourcify=${dep.verification?.sourcify ?? "?"}, blockscout=${dep.verification?.blockscout ?? "?"}, basescan=${dep.verification?.basescan ?? "?"}`, "");
  }
  const rows = db.prepare(`SELECT * FROM orders WHERE order_id IN (${orderIds.map(() => "?").join(",")}) ORDER BY created_at`).all(...orderIds) as unknown as OrderRow[];
  rows.forEach((o, i) => {
    const l = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(o.listing_id) as unknown as ListingRow;
    const s = JSON.parse(l.public_summary);
    lines.push(`## Order ${i + 1}: ${o.status}`, "", `- Target: ${l.target_id ?? s.target?.id ?? "cart"} (${s.target?.label ?? "warehouse cart"})`, `- Listing id: ${o.listing_id}`, `- Commitment (on chain): ${l.commitment}`, `- Terms hash: ${l.terms_hash}`, `- Failure class: ${s.failure_class?.id ?? "COLLISION"}; severity band: ${s.severity?.band}; verification ${s.verification?.status} (${s.verification?.method})`, `- Price: ${o.price_wei} wei`);
    const tx = (label: string, h: string | null) => { if (h) lines.push(`- ${label}: [${h}](${ex}/tx/${h})`); };
    tx("registerListing (verifier)", l.register_tx);
    tx("fund (buyer)", o.fund_tx);
    tx("markDelivered (seller)", o.deliver_tx);
    tx("requestRecheck (buyer)", o.recheck_tx);
    tx(`settle(${o.status === "SETTLED_VALID"}) (verifier)`, o.settle_tx);
    tx(o.status === "SETTLED_VALID" ? "withdraw (seller)" : "withdraw refund (buyer)", o.withdraw_tx);
    if (o.delivery_check) {
      const c = JSON.parse(o.delivery_check);
      lines.push(`- Verifier delivery check: ${c.valid ? "VALID" : "INVALID"} - ${c.reason}`);
    }
    lines.push("");
  });
  fs.writeFileSync(path.join(evidenceDir, "TESTNET.md"), lines.join("\n") + "\n");
}
