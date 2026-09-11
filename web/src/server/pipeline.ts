// LOCAL DEMONSTRATION PIPELINE: runs the seller, verifier and buyer agents end to end against the
// configured chain (local anvil or Base Sepolia). One run at a time. Every step is logged and stored.
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import { balanceOf, publicClient, requireEscrow, saveReceipt, verifierOf, withdrawable } from "./chain.js";
import { buyerBudgetWei, chainId, chainMode, dataDir, listingPriceWei, publicBaseUrl, roleAddresses, roles } from "./config.js";
import { addEvent, getDb, nowIso, publicListing, publicOrder, type ListingRow, type OrderRow } from "./db.js";
import { ENVELOPE_ID, NOMINAL_SCENARIO } from "./envelope.js";
import { runScenario } from "./sim.js";
import { buyerFund, buyerRetrieveAndCheck, buyerWithdraw, describePolicy, selectListing, type BuyerPolicy } from "./agents/buyer.js";
import { buildPrivatePackage, buildSubmission, sellerDeliver, sellerDiscover, sellerWithdraw } from "./agents/seller.js";
import { verifierCheckDeliveryAndSettle, verifyAndList } from "./agents/verifier.js";

export type PipelineLog = { ts: string; msg: string }[];
let running: { run_id: string; started_at: string; log: PipelineLog; status: "running" | "done" | "failed"; error?: string } | null = null;
let lastFinishedAt = 0;

export function pipelineStatus() {
  return running ? { run_id: running.run_id, status: running.status, started_at: running.started_at, log: running.log, error: running.error ?? null } : null;
}

export const PUBLIC_OUT = path.join(dataDir, "sim", "public");

/** Public baseline run (nominal conditions). Regenerated in the current environment if missing. */
export async function ensureBaseline(): Promise<{ file: string; trajectory_hash: string }> {
  const file = path.join(PUBLIC_OUT, "runs", "baseline.json");
  if (!fs.existsSync(file)) await runScenario(PUBLIC_OUT, "baseline", NOMINAL_SCENARIO);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, trajectory_hash: doc.trajectory_hash };
}

export async function runDemoPipeline(opts: { evidenceDir?: string | null; baseUrl?: string } = {}): Promise<{ run_id: string; log: PipelineLog; orders: string[] }> {
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
    L(`preflight: chain mode ${chainMode} (chain id ${chainId}), escrow ${escrowAddr}, block ${await publicClient.getBlockNumber()}`);
    for (const [role, a] of Object.entries(addrs)) {
      const b = await balanceOf(a as Hex);
      L(`preflight: ${role} ${a} balance ${b} wei`);
      if (b === 0n) throw new Error(`${role} wallet ${a} has no ${chainMode === "testnet" ? "Base Sepolia test ETH" : "local ether"}`);
    }
    const base = await ensureBaseline();
    L(`public baseline run (nominal conditions) trajectory ${base.trajectory_hash.slice(0, 18)}...`);

    // ---- seller discovery + verifier listing ----
    const disc = await sellerDiscover(L, 2);
    if (disc.findings.length === 0) throw new Error("the hunter found no admissible collision inside the envelope");
    if (evidenceDir) fs.copyFileSync(disc.huntFile, path.join(evidenceDir, "hunt-grid.json"));
    const listed: Hex[] = [];
    for (const f of disc.findings) {
      const tamper = f.rank === 2; // the second listing demonstrates an invalid delivery
      const pkgDoc = buildPrivatePackage(f.run, addrs.seller);
      const { submission, packageBytes, packageCommitment } = buildSubmission(f, disc.hunt, pkgDoc);
      L(`seller: submitting finding #${f.rank} (claim: ${submission.claim.outcome}, ${submission.claim.severity_band} severity band) with salted package commitment ${packageCommitment.slice(0, 14)}...${tamper ? " [DEMO: this listing's delivery will be tampered]" : ""}`);
      const res = await verifyAndList(submission, packageBytes, { priceWei: listingPriceWei, demoTamper: tamper }, L);
      if (res.listingId) {
        listed.push(res.listingId);
        await receipts(`listing-${listed.length}-register`, res.registerTx?.hash);
        if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, `listing-${listed.length}-public-summary.json`), JSON.stringify(res.summary, null, 2) + "\n");
      }
    }
    if (listed.length === 0) throw new Error("no listing was registered");

    // ---- buyer purchases under a budget ----
    const target = disc.findings[0].run.controller;
    const policy: BuyerPolicy = { target_controller_id: target.id, target_controller_hash: target.hash, target_envelope_id: ENVELOPE_ID, per_purchase_cap_wei: buyerBudgetWei, remaining_budget_wei: buyerBudgetWei * 2n };
    L(`buyer: policy ${JSON.stringify(describePolicy(policy))}`);
    for (let i = 0; i < listed.length; i++) {
      const sel = await selectListing(policy, L);
      if (!sel.chosen) {
        L("buyer: no eligible listing under the current policy; stopping");
        break;
      }
      const listing = sel.chosen;
      L(`buyer: selected listing ${listing.listing_id.slice(0, 12)}... at ${listing.price_wei} wei`);
      const order = await buyerFund(listing, L);
      policy.remaining_budget_wei -= BigInt(listing.price_wei);
      orders.push(order.order_id);
      const n = orders.length;
      await receipts(`order-${n}-fund`, order.fund_tx);
      const del = await sellerDeliver(order, L);
      await receipts(`order-${n}-deliver`, del.tx);
      const fresh = () => db.prepare("SELECT * FROM orders WHERE order_id = ?").get(order.order_id) as unknown as OrderRow;
      const ret = await buyerRetrieveAndCheck(fresh(), baseUrl, L);
      if (!ret.check.ok) await receipts(`order-${n}-recheck`, fresh().recheck_tx);
      L("buyer: requesting verification of the delivered package");
      const settled = await verifierCheckDeliveryAndSettle(fresh(), L);
      await receipts(`order-${n}-settle`, settled.tx);
      if (settled.check.valid) {
        const w = await sellerWithdraw(L);
        db.prepare("UPDATE orders SET withdraw_tx = ? WHERE order_id = ?").run(w.hash, order.order_id);
        addEvent(order.listing_id, "seller", "withdrawn", { amount_wei: order.price_wei, block: w.block_number }, chainMode, w.hash, w.block_number);
        await receipts(`order-${n}-withdraw-seller`, w.hash);
      } else {
        const w = await buyerWithdraw(L);
        db.prepare("UPDATE orders SET withdraw_tx = ? WHERE order_id = ?").run(w.hash, order.order_id);
        addEvent(order.listing_id, "buyer", "refund_withdrawn", { amount_wei: order.price_wei, block: w.block_number }, chainMode, w.hash, w.block_number);
        await receipts(`order-${n}-withdraw-buyer`, w.hash);
      }
      L(`order ${n}: ${settled.check.valid ? "VALID -> seller paid" : "INVALID -> buyer refunded"}; escrow withdrawable now seller=${await withdrawable(addrs.seller as Hex)} buyer=${await withdrawable(addrs.buyer as Hex)}`);
      if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, `order-${n}.json`), JSON.stringify({ order: publicOrder(fresh()), listing: publicListing(db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(order.listing_id) as unknown as ListingRow), events: db.prepare("SELECT * FROM events WHERE listing_id = ? ORDER BY id").all(order.listing_id) }, null, 2) + "\n");
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
    lines.push(`## Order ${i + 1}: ${o.status}`, "", `- Listing id: ${o.listing_id}`, `- Commitment (on chain): ${l.commitment}`, `- Terms hash: ${l.terms_hash}`, `- Severity band: ${s.severity?.band}; verification ${s.verification?.status} (${s.verification?.method})`, `- Price: ${o.price_wei} wei`);
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
