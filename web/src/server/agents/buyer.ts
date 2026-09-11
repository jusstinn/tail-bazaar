// BUYER AGENT (local demonstration mode). Deterministic policy, described exactly:
//   eligible = listings on the configured chain whose on-chain status is Listed, whose public summary
//              says VERIFIED and admissible, whose TARGET is one the buyer is shopping for, whose
//              subject id+hash (controller file / policy checkpoint) and envelope id equal the
//              buyer's target, and whose price is within both the per-purchase cap and the remaining
//              budget
//   ranking  = severity band (high > medium > low), then lower price, then earlier listing
// It funds escrow, signs the retrieval challenge, retrieves over HTTP, checks the package itself
// against the on-chain commitment and the advertised terms, and asks for a recheck on chain if its
// own check fails. It never sees parameters before paying.
import type { Hex } from "viem";
import { keccakHex, isCanonical } from "../canonical.js";
import { buyerBudgetWei, chainMode, roles } from "../config.js";
import { escrow, getListing, getListingExpecting, walletFor } from "../chain.js";
import { addEvent, getDb, nowIso, publicListing, type ListingRow, type OrderRow } from "../db.js";
import { targetFor, type TargetId } from "../targets.js";

export type BuyerPolicy = {
  /** Which targets this buyer shops for. null means "any target in the registry". */
  target_ids: TargetId[] | null;
  target_controller_id: string | null;
  target_controller_hash: string | null;
  target_envelope_id: string | null;
  per_purchase_cap_wei: bigint;
  remaining_budget_wei: bigint;
};
const BAND_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 };

export async function selectListing(policy: BuyerPolicy, log: (m: string) => void): Promise<{ chosen: ListingRow | null; considered: { listing_id: string; target_id: string; eligible: boolean; why: string }[] }> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM listings WHERE chain_mode = ? ORDER BY created_at ASC").all(chainMode) as unknown as ListingRow[];
  const considered: { listing_id: string; target_id: string; eligible: boolean; why: string; row?: ListingRow; band?: string }[] = [];
  for (const row of rows) {
    const s = JSON.parse(row.public_summary);
    const targetId = (row.target_id ?? s.target?.id ?? "cart") as TargetId;
    const onChain = row.status === "LISTED" ? await getListingExpecting(row.listing_id as Hex, (l) => l.status === 1) : await getListing(row.listing_id as Hex);
    const price = BigInt(row.price_wei);
    let why = "eligible";
    if (onChain.status !== 1) why = `on-chain status is ${onChain.status} (not Listed)`;
    else if (policy.target_ids && !policy.target_ids.includes(targetId)) why = `target ${targetId} is not one this buyer is shopping for (${policy.target_ids.join(", ")})`;
    else if (s.verification?.status !== "VERIFIED") why = `verification ${s.verification?.status}`;
    else if (!s.admissible) why = "not admissible";
    else if (policy.target_controller_id !== null && (s.controller?.id !== policy.target_controller_id || s.controller?.hash !== policy.target_controller_hash)) why = "controller/policy does not match the buyer's target";
    else if (policy.target_envelope_id !== null && s.envelope_id !== policy.target_envelope_id) why = "envelope does not match";
    else if (price > policy.per_purchase_cap_wei) why = `price ${price} exceeds per-purchase cap ${policy.per_purchase_cap_wei}`;
    else if (price > policy.remaining_budget_wei) why = `price ${price} exceeds remaining budget ${policy.remaining_budget_wei}`;
    considered.push({ listing_id: row.listing_id, target_id: targetId, eligible: why === "eligible", why, row, band: s.severity?.band });
  }
  const eligible = considered.filter((c) => c.eligible);
  eligible.sort((a, b) => (BAND_RANK[b.band ?? "none"] - BAND_RANK[a.band ?? "none"]) || (Number(BigInt(a.row!.price_wei) - BigInt(b.row!.price_wei))) || a.row!.created_at.localeCompare(b.row!.created_at));
  for (const c of considered) log(`buyer:   ${c.eligible ? "eligible" : "skip    "} ${c.target_id.padEnd(8)} ${c.listing_id.slice(0, 12)}... severity=${c.band} price=${c.row?.price_wei} - ${c.why}`);
  return { chosen: eligible[0]?.row ?? null, considered: considered.map(({ listing_id, target_id, eligible, why }) => ({ listing_id, target_id, eligible, why })) };
}

export async function buyerFund(listing: ListingRow, log: (m: string) => void): Promise<OrderRow> {
  const db = getDb();
  const price = BigInt(listing.price_wei);
  if (price > buyerBudgetWei) throw new Error("price exceeds buyer budget cap");
  const buyer = roles.buyer();
  const tx = await escrow.fund(buyer, listing.listing_id as Hex, price);
  db.prepare("INSERT INTO orders(order_id, listing_id, buyer, price_wei, status, fund_tx, created_at) VALUES (?,?,?,?,?,?,?)").run(listing.listing_id, listing.listing_id, buyer.address, listing.price_wei, "FUNDED", tx.hash, nowIso());
  db.prepare("UPDATE listings SET status = 'FUNDED' WHERE listing_id = ?").run(listing.listing_id);
  addEvent(listing.listing_id, "buyer", "funded", { buyer: buyer.address, price_wei: listing.price_wei, block: tx.block_number }, chainMode, tx.hash, tx.block_number);
  log(`buyer: fund tx ${tx.hash} block ${tx.block_number} (${listing.price_wei} wei into escrow)`);
  return db.prepare("SELECT * FROM orders WHERE order_id = ?").get(listing.listing_id) as unknown as OrderRow;
}

export type BuyerCheck = { ok: boolean; reason: string; delivered_hash: string; on_chain_commitment: string; checks: { name: string; ok: boolean; detail?: string }[] };

/** Retrieve through the real HTTP route with a signed challenge, then check the package locally. */
export async function buyerRetrieveAndCheck(order: OrderRow, baseUrl: string, log: (m: string) => void): Promise<{ bytes: Uint8Array; check: BuyerCheck }> {
  const buyer = roles.buyer();
  const chRes = await fetch(`${baseUrl}/api/challenges`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: order.order_id, buyer: buyer.address }) });
  if (!chRes.ok) throw new Error(`challenge request failed: ${chRes.status} ${await chRes.text()}`);
  const ch = (await chRes.json()) as { nonce: string; message: string; expires_at: number };
  const signature = await walletFor(buyer).signMessage({ message: ch.message });
  log(`buyer: signed retrieval challenge nonce ${ch.nonce.slice(0, 12)}... (EIP-191 personal message bound to order, buyer, chain ${ch.message.match(/chain_id: (\d+)/)?.[1]}, domain)`);
  const res = await fetch(`${baseUrl}/api/retrieve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: order.order_id, nonce: ch.nonce, signature }) });
  if (!res.ok) throw new Error(`retrieval failed: ${res.status} ${await res.text()}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  log(`buyer: retrieved ${bytes.length} bytes over HTTP (server-reported keccak ${res.headers.get("x-package-keccak256")?.slice(0, 14)}...)`);

  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO retrievals(order_id, package_bytes, signer, retrieved_at) VALUES (?,?,?,?)").run(order.order_id, bytes, buyer.address, nowIso());
  const onChain = await getListing(order.listing_id as Hex);
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(order.listing_id) as unknown as ListingRow;
  const summary = JSON.parse(listing.public_summary);
  const target = targetFor(listing.target_id ?? summary.target?.id);
  const checks: BuyerCheck["checks"] = [];
  const h = keccakHex(bytes);
  const c1 = h === onChain.commitment.toLowerCase();
  checks.push({ name: "hash-equals-on-chain-commitment", ok: c1, detail: `${h.slice(0, 14)}... vs ${onChain.commitment.slice(0, 14)}...` });
  let c2 = false, c3 = false, c4 = false;
  if (isCanonical(bytes)) {
    const pkg = JSON.parse(Buffer.from(bytes).toString("utf8"));
    c2 = pkg.controller?.hash === summary.controller.hash && pkg.envelope_id === summary.envelope_id && pkg.target_id === target.id;
    c3 = target.failure_outcomes.includes(pkg.claim?.outcome) && pkg.claim?.severity_band === summary.severity?.band;
    c4 = target.checkAdmissible(pkg.scenario ?? {}).length === 0 && Array.isArray(pkg.replay?.frames?.data) && pkg.replay.frames.data.length > 0;
  }
  checks.push({ name: "target-subject-and-envelope-match-summary", ok: c2 });
  checks.push({ name: "claim-matches-summary", ok: c3 });
  checks.push({ name: "scenario-admissible-and-replayable", ok: c4 });
  const ok = c1 && c2 && c3 && c4;
  const check: BuyerCheck = { ok, reason: ok ? "package matches commitment and advertised terms" : c1 ? "package content does not match the advertised terms" : "delivered package does not hash to the on-chain commitment", delivered_hash: h, on_chain_commitment: onChain.commitment, checks };
  for (const c of checks) log(`buyer:   ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? " - " + c.detail : ""}`);
  db.prepare("UPDATE orders SET buyer_check = ? WHERE order_id = ?").run(JSON.stringify(check), order.order_id);
  addEvent(order.listing_id, "buyer", "retrieved", { bytes: bytes.length, signer: buyer.address, local_check_ok: ok, reason: check.reason }, chainMode);
  if (!ok) {
    const tx = await escrow.requestRecheck(buyer, order.listing_id as Hex, check.reason);
    db.prepare("UPDATE orders SET recheck_tx = ? WHERE order_id = ?").run(tx.hash, order.order_id);
    addEvent(order.listing_id, "buyer", "recheck_requested", { reason: check.reason, block: tx.block_number }, chainMode, tx.hash, tx.block_number);
    log(`buyer: requestRecheck tx ${tx.hash} block ${tx.block_number} (event only; moves no funds)`);
  }
  return { bytes, check };
}

export async function buyerWithdraw(log: (m: string) => void) {
  const tx = await escrow.withdraw(roles.buyer());
  log(`buyer: withdraw tx ${tx.hash} block ${tx.block_number}`);
  return tx;
}

export function describePolicy(policy: BuyerPolicy) {
  return {
    mode: "deterministic (no model calls)",
    eligibility: ["on-chain status Listed", "target is one the buyer shops for", "public summary verification VERIFIED and admissible", "controller/policy id and hash equal the buyer's target", "envelope id equal", "price within per-purchase cap and remaining budget"],
    ranking: ["severity band high > medium > low", "lower price", "earlier listing"],
    targets: policy.target_ids ?? "any",
    target_controller: policy.target_controller_id === null ? "any" : { id: policy.target_controller_id, hash: policy.target_controller_hash },
    target_envelope_id: policy.target_envelope_id ?? "any",
    per_purchase_cap_wei: policy.per_purchase_cap_wei.toString(),
    remaining_budget_wei: policy.remaining_budget_wei.toString(),
  };
}

export { publicListing };
