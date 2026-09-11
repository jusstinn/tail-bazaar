// THE BUYER DOES NOT TRUST THE DATABASE'S COPY OF THE TERMS (review round 3, finding 3). The
// buyer's ranking and eligibility read the robot, the severity band and the verification status from
// `listings.public_summary`, a database row, and never checked that the summary still hashed to the
// terms hash the verifier registered on chain, nor that the row's seller, price and commitment were
// the chain's. A row whose summary had been edited after registration (severity band raised from low
// to high, say) jumped the queue and was funded on the strength of terms nobody had certified.
//
// These tests pin the fix: selectListing() recomputes the summary's terms hash with the same function
// the verifier used to register it (termsHashOf) and compares it, the seller, the price and the
// commitment with the chain, marking a listing ineligible with a plain reason when any differs; and
// buyerFund() re-checks all four immediately before sending fund() and throws instead of funding.
//
// The chain reads are stubbed through chain.ts's own injection point (setChainClientsForTests), the
// same way chain-reverted.test.ts does. Throwaway database; no chain; the buyer key is generated for
// this process and signs nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
// Type-only imports are erased at compile time: they load no module before the environment below is set.
import type { ListingRow } from "../db.js";
import type { BuyerPolicy } from "../agents/buyer.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-terms-"));
process.env.DATABASE_PATH = path.join(tmp, "buyer-terms-binding-test.sqlite");
process.env.CHAIN_MODE = "local";
const ESCROW = "0x" + "e".repeat(40);
process.env.ESCROW_ADDRESS_LOCAL = ESCROW;
process.env.BUYER_PRIVATE_KEY = generatePrivateKey(); // this process only; never persisted, never used to sign
delete process.env.PUBLIC_BASE_URL;

const { setChainClientsForTests } = await import("../chain.js");
const { getDb } = await import("../db.js");
const { selectListing, buyerFund, checkTermsBinding } = await import("../agents/buyer.js");
const { termsHashOf } = await import("../agents/verifier.js");
const { dumps } = await import("../canonical.js");
const { chainMode, chainId } = await import("../config.js");

const quiet = () => {};
const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const OTHER_SELLER = "0x1B27C90FcD738E960D3D505682EC2732A08c7f99";
const PRICE = 1000000000000000n;
const id = (n: number): string => "0x" + String(n).repeat(64);
const HONEST = id(1);        // stored terms are the on-chain terms
const ALTERED = id(2);       // public_summary edited after registration: severity band low -> high
const SELLER_SWAP = id(3);   // row.seller is not the on-chain seller
const PRICE_SWAP = id(4);    // row.price_wei is lower than the on-chain price
const COMMIT_SWAP = id(5);   // row.commitment is not the on-chain commitment
const commitmentOf = (listing: string) => "0x" + listing.slice(2, 4).repeat(32);

function summaryFor(band: string) {
  return {
    schema: "tb-summary-2", format: "tb-cjson-1",
    target: { id: "cart", label: "Warehouse cart", machine: "a braking warehouse cart carrying a payload", subject_label: "Controller", replay_renderer: "cart-3d" },
    failure_class: { id: "COLLISION", label: "Collision", detected_by: "the simulator's own contact flag" },
    controller: { id: "stop-before-obstacle-v1", hash: "sha256:" + "0".repeat(64) }, envelope_id: "tb-envelope-1", admissible: true,
    claim_kind: "k", verification: { status: "VERIFIED", verdict: "VALID", method: "exact-trajectory-hash" },
    operating_context: {}, severity: { proxy: "impact_speed_mps", band, definition: "d" }, seller: SELLER,
    seller_settled_orders_at_listing: 0, price_wei: PRICE.toString(), chain: { mode: chainMode, chain_id: chainId, escrow: ESCROW }, hidden: "h",
  };
}
const REGISTERED = summaryFor("low");            // what the verifier certified and hashed on chain
const TERMS = termsHashOf(REGISTERED);

// The chain's view of each listing: registered by the verifier, never edited since.
const chainView: Record<string, { seller: string; price: bigint; commitment: string; termsHash: string }> = {
  [HONEST]: { seller: SELLER, price: PRICE, commitment: commitmentOf(HONEST), termsHash: TERMS },
  [ALTERED]: { seller: SELLER, price: PRICE, commitment: commitmentOf(ALTERED), termsHash: TERMS },
  [SELLER_SWAP]: { seller: SELLER, price: PRICE, commitment: commitmentOf(SELLER_SWAP), termsHash: TERMS },
  [PRICE_SWAP]: { seller: SELLER, price: PRICE, commitment: commitmentOf(PRICE_SWAP), termsHash: TERMS },
  [COMMIT_SWAP]: { seller: SELLER, price: PRICE, commitment: commitmentOf(COMMIT_SWAP), termsHash: TERMS },
};
const writes: { functionName: string; args: unknown[] }[] = [];
setChainClientsForTests({
  publicClient: {
    readContract: async ({ functionName, args }) => {
      if (functionName === "getListing") {
        const v = chainView[String(args[0])];
        if (!v) throw new Error(`unknown listing ${String(args[0])}`);
        return { seller: v.seller, buyer: "0x" + "0".repeat(40), price: v.price, commitment: v.commitment, termsHash: v.termsHash, deliveryHash: "0x" + "0".repeat(64), fundedAt: 0n, deliveryDeadline: 0n, settlementDeadline: 0n, status: 1n };
      }
      if (functionName === "settledOrders") return 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: async (a: any) => ({ request: { functionName: a.functionName, args: a.args, value: a.value } }),
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 5n, gasUsed: 1n }),
    getTransactionReceipt: async () => { throw new Error("not used"); },
    getBalance: async () => 0n,
    getBlockNumber: async () => 1n,
  },
  walletFor: () => ({ writeContract: async (req: any) => { writes.push(req); return ("0x" + "ab".repeat(32)) as Hex; } }),
});

// The stored rows. The ALTERED row's summary was edited after the verifier registered TERMS; the
// other three copy the honest summary but disagree with the chain on one of the other three facts.
const db = getDb();
const insert = db.prepare("INSERT INTO listings(listing_id, chain_mode, chain_id, escrow_address, target_id, seller, price_wei, commitment, terms_hash, public_summary, status, register_tx, demo_tamper, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
const t0 = Date.parse("2026-09-11T00:00:00.000Z");
const at = (i: number) => new Date(t0 + i * 1000).toISOString();
insert.run(HONEST, chainMode, chainId, ESCROW, "cart", SELLER, PRICE.toString(), commitmentOf(HONEST), TERMS, dumps(REGISTERED), "LISTED", null, 0, at(0));
insert.run(ALTERED, chainMode, chainId, ESCROW, "cart", SELLER, PRICE.toString(), commitmentOf(ALTERED), TERMS, dumps(summaryFor("high")), "LISTED", null, 0, at(1));
insert.run(SELLER_SWAP, chainMode, chainId, ESCROW, "cart", OTHER_SELLER, PRICE.toString(), commitmentOf(SELLER_SWAP), TERMS, dumps(REGISTERED), "LISTED", null, 0, at(2));
insert.run(PRICE_SWAP, chainMode, chainId, ESCROW, "cart", SELLER, (PRICE / 2n).toString(), commitmentOf(PRICE_SWAP), TERMS, dumps(REGISTERED), "LISTED", null, 0, at(3));
insert.run(COMMIT_SWAP, chainMode, chainId, ESCROW, "cart", SELLER, PRICE.toString(), "0x" + "99".repeat(32), TERMS, dumps(REGISTERED), "LISTED", null, 0, at(4));
const row = (listing: string) => db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listing) as unknown as ListingRow;

const policy = (): BuyerPolicy => ({ target_ids: null, target_controller_id: null, target_controller_hash: null, target_envelope_id: null, per_purchase_cap_wei: PRICE * 10n, remaining_budget_wei: PRICE * 10n });

test("an altered public summary is skipped with the terms-hash reason, and the unaltered listing is the one chosen", async () => {
  const sel = await selectListing(policy(), quiet);
  const by = Object.fromEntries(sel.considered.map((c) => [c.listing_id, c]));
  assert.equal(by[HONEST].eligible, true, by[HONEST].why);
  assert.equal(by[HONEST].why, "eligible");
  assert.equal(by[ALTERED].eligible, false, "the edited summary claims a high band; it must not rank");
  assert.match(by[ALTERED].why, /stored terms are not the on-chain terms/);
  assert.match(by[ALTERED].why, /terms hash mismatch/);
  assert.match(by[ALTERED].why, /altered or stale/);
  assert.equal(by[SELLER_SWAP].eligible, false);
  assert.match(by[SELLER_SWAP].why, /seller mismatch/);
  assert.equal(by[PRICE_SWAP].eligible, false);
  assert.match(by[PRICE_SWAP].why, /price mismatch/);
  assert.equal(by[COMMIT_SWAP].eligible, false);
  assert.match(by[COMMIT_SWAP].why, /commitment mismatch/);
  // Ranking is severity band first, so the ALTERED row ("high") would have been chosen over the
  // honest one ("low") had its terms been believed. It was not.
  assert.equal(sel.chosen?.listing_id, HONEST);
});

test("checkTermsBinding names exactly the fact that differs, and passes when all four bind", () => {
  const onChain = (listing: string) => {
    const v = chainView[listing];
    return { seller: v.seller as Hex, buyer: ("0x" + "0".repeat(40)) as Hex, price: v.price, commitment: v.commitment as Hex, termsHash: v.termsHash as Hex, deliveryHash: ("0x" + "0".repeat(64)) as Hex, fundedAt: 0n, deliveryDeadline: 0n, settlementDeadline: 0n, status: 1 };
  };
  assert.equal(checkTermsBinding(row(HONEST), onChain(HONEST)), null);
  assert.match(checkTermsBinding(row(ALTERED), onChain(ALTERED)) ?? "", /terms hash mismatch/);
  assert.match(checkTermsBinding(row(SELLER_SWAP), onChain(SELLER_SWAP)) ?? "", /seller mismatch: stored 0x1B27/);
  assert.match(checkTermsBinding(row(PRICE_SWAP), onChain(PRICE_SWAP)) ?? "", /price mismatch: stored 500000000000000 wei vs on-chain 1000000000000000 wei/);
  assert.match(checkTermsBinding(row(COMMIT_SWAP), onChain(COMMIT_SWAP)) ?? "", /commitment mismatch/);
  // The recomputation is the registration function itself: the honest row's stored column agrees with it.
  assert.equal(termsHashOf(JSON.parse(row(HONEST).public_summary)), row(HONEST).terms_hash);
  assert.notEqual(termsHashOf(JSON.parse(row(ALTERED).public_summary)), row(ALTERED).terms_hash, "the edit changed the hash; only the chain copy is trusted");
  // Case of the hex does not matter; the values do.
  assert.equal(checkTermsBinding(row(HONEST), { ...onChain(HONEST), termsHash: TERMS.toUpperCase().replace("0X", "0x") as Hex }), null);
});

test("buyerFund re-checks the binding immediately before fund() and refuses without broadcasting", async () => {
  writes.length = 0;
  await assert.rejects(buyerFund(row(ALTERED), quiet), /refusing to fund .*terms hash mismatch/);
  await assert.rejects(buyerFund(row(PRICE_SWAP), quiet), /refusing to fund .*price mismatch/);
  assert.equal(writes.length, 0, "nothing was broadcast");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as any).n), 0, "no order was written");
  for (const l of [ALTERED, PRICE_SWAP]) assert.equal(row(l).status, "LISTED");
  // The honest row funds as before: one fund() broadcast, a FUNDED order, the listing marked FUNDED.
  const order = await buyerFund(row(HONEST), quiet);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].functionName, "fund");
  assert.deepEqual({ status: order.status, listing: order.listing_id, price: order.price_wei }, { status: "FUNDED", listing: HONEST, price: PRICE.toString() });
  assert.equal(row(HONEST).status, "FUNDED");
});

test("cleanup", () => {
  setChainClientsForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
