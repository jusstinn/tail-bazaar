// REVERTED TRANSACTIONS ARE NOT SUCCESSES (review round 3, finding 2). chain.ts write() used to
// return `{ status: receipt.status }` and never throw, so a buyer whose fund() reverted still got a
// FUNDED order row, and the seller and verifier agents recorded deliveries and settlements that never
// happened. These tests pin the central fix: a receipt whose status is not "success" makes write()
// throw TxRevertedError (hash, function name, block on the error), so no caller writes state; the
// broadcast hash is on record in pending_txs BEFORE the receipt wait; a wait that throws leaves a
// reconcilable row; and reconcilePendingTxs() resolves it from the chain later.
//
// The viem clients are replaced through chain.ts's own injection point (setChainClientsForTests),
// never by monkey-patching viem. Throwaway database in a temp directory; no chain, no real keys (the
// role key is generated for this process and signs nothing, because writeContract is a stub).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-reverted-"));
process.env.DATABASE_PATH = path.join(tmp, "chain-reverted-test.sqlite");
process.env.CHAIN_MODE = "local";
const ESCROW = "0x" + "e".repeat(40);
process.env.ESCROW_ADDRESS_LOCAL = ESCROW;
process.env.BUYER_PRIVATE_KEY = generatePrivateKey(); // this process only; never persisted, never used to sign
delete process.env.PUBLIC_BASE_URL;
delete process.env.OPERATOR_TOKEN;

const { escrow, setChainClientsForTests, TxRevertedError, listPendingTxs, reconcilePendingTxs } = await import("../chain.js");
const { getDb, nowIso } = await import("../db.js");
const { buyerFund } = await import("../agents/buyer.js");
const { termsHashOf } = await import("../agents/verifier.js");
const { dumps } = await import("../canonical.js");
const { buildApp } = await import("../index.js");
const { chainMode, chainId } = await import("../config.js");

const quiet = () => {};
const HASH = ("0x" + "ab".repeat(32)) as Hex;
const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const LISTING = "0x" + "11".repeat(32);
const COMMITMENT = "0x" + "cc".repeat(32);
const PRICE = 1000000000000000n;
const verifierAccount = privateKeyToAccount(generatePrivateKey());

// The public summary the demo pipeline would have registered, and the terms hash the chain holds for it.
const summary = {
  schema: "tb-summary-2", format: "tb-cjson-1",
  target: { id: "cart", label: "Warehouse cart", machine: "a braking warehouse cart carrying a payload", subject_label: "Controller", replay_renderer: "cart-3d" },
  failure_class: { id: "COLLISION", label: "Collision", detected_by: "the simulator's own contact flag" },
  controller: { id: "stop-before-obstacle-v1", hash: "sha256:" + "0".repeat(64) }, envelope_id: "tb-envelope-1", admissible: true,
  claim_kind: "k", verification: { status: "VERIFIED", verdict: "VALID", method: "exact-trajectory-hash" },
  operating_context: {}, severity: { proxy: "impact_speed_mps", band: "low", definition: "d" }, seller: SELLER,
  seller_settled_orders_at_listing: 0, price_wei: PRICE.toString(), chain: { mode: chainMode, chain_id: chainId, escrow: ESCROW }, hidden: "h",
};
const TERMS = termsHashOf(summary);

// ------------------------------------------------------------------------- the stubbed clients
type Receipt = { status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint };
const state = {
  receipt: null as null | (() => Promise<Receipt>),          // what waitForTransactionReceipt does
  lookup: null as null | (() => Promise<Receipt>),           // what getTransactionReceipt does
  writes: [] as { functionName: string; args: unknown[]; value?: bigint }[],
  seenDuringWait: null as null | ReturnType<typeof listPendingTxs>,
};
const onChainListing = () => ({ seller: SELLER, buyer: "0x" + "0".repeat(40), price: PRICE, commitment: COMMITMENT, termsHash: TERMS, deliveryHash: "0x" + "0".repeat(64), fundedAt: 0n, deliveryDeadline: 0n, settlementDeadline: 0n, status: 1n });
setChainClientsForTests({
  publicClient: {
    readContract: async ({ functionName }) => {
      if (functionName === "getListing") return onChainListing();
      if (functionName === "settledOrders") return 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: async (a: any) => ({ request: { functionName: a.functionName, args: a.args, value: a.value } }),
    waitForTransactionReceipt: async () => {
      state.seenDuringWait = listPendingTxs();
      if (!state.receipt) throw new Error("test did not script a receipt");
      return state.receipt();
    },
    getTransactionReceipt: async () => {
      if (!state.lookup) throw new Error("test did not script a receipt lookup");
      return state.lookup();
    },
    getBalance: async () => 0n,
    getBlockNumber: async () => 1n,
  },
  walletFor: () => ({ writeContract: async (req: any) => { state.writes.push(req); return HASH; } }),
});
const rows = (table: string, where = "1=1") => Number((getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number | bigint }).n);
const txRow = () => getDb().prepare("SELECT * FROM pending_txs WHERE hash = ?").get(HASH) as any;
const resetTx = () => { getDb().prepare("DELETE FROM pending_txs").run(); state.writes = []; state.seenDuringWait = null; };

test("a reverted receipt makes write() throw, with the hash, function name and block on the error", async () => {
  resetTx();
  state.receipt = async () => ({ status: "reverted", blockNumber: 7n, gasUsed: 21000n });
  await assert.rejects(
    escrow.registerListing(verifierAccount, LISTING as Hex, SELLER as Hex, PRICE, COMMITMENT as Hex, TERMS),
    (e: any) => {
      assert.ok(e instanceof TxRevertedError, `expected TxRevertedError, got ${e?.constructor?.name}: ${e?.message}`);
      assert.equal(e.hash, HASH);
      assert.equal(e.function_name, "registerListing");
      assert.equal(e.block_number, 7);
      assert.match(e.message, /registerListing/);
      assert.match(e.message, new RegExp(HASH));
      assert.match(e.message, /block 7/);
      assert.match(e.message, /no state was recorded/);
      return true;
    },
  );
  assert.equal(state.writes.length, 1, "the transaction was broadcast once");
  assert.equal(state.writes[0].functionName, "registerListing");
  // The ledger says what happened, and the row is resolved: nothing is left for reconciliation.
  assert.deepEqual({ status: txRow().status, block: txRow().block_number, fn: txRow().function_name }, { status: "reverted", block: 7, fn: "registerListing" });
  assert.deepEqual(listPendingTxs(), [], "a reverted row is resolved, not pending");
  assert.equal(listPendingTxs(["reverted"]).length, 1);
});

test("a successful receipt returns the result and resolves the row to confirmed", async () => {
  resetTx();
  state.receipt = async () => ({ status: "success", blockNumber: 8n, gasUsed: 50000n });
  const tx = await escrow.settle(verifierAccount, LISTING as Hex, true);
  assert.deepEqual({ hash: tx.hash, block: tx.block_number, status: tx.status, gas: tx.gas_used }, { hash: HASH, block: 8, status: "success", gas: "50000" });
  assert.deepEqual({ status: txRow().status, block: txRow().block_number, fn: txRow().function_name }, { status: "confirmed", block: 8, fn: "settle" });
  assert.match(txRow().args_json, /true/);
  assert.equal(txRow().from_address, verifierAccount.address);
  assert.deepEqual(listPendingTxs(), []);
});

test("buyerFund against a reverted fund leaves no FUNDED order and no orders row", async () => {
  resetTx();
  const db = getDb();
  db.prepare("INSERT INTO listings(listing_id, chain_mode, chain_id, escrow_address, target_id, seller, price_wei, commitment, terms_hash, public_summary, status, register_tx, demo_tamper, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(LISTING, chainMode, chainId, ESCROW, "cart", SELLER, PRICE.toString(), COMMITMENT, TERMS, dumps(summary), "LISTED", null, 0, nowIso());
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(LISTING) as any;
  state.receipt = async () => ({ status: "reverted", blockNumber: 9n, gasUsed: 21000n });
  await assert.rejects(buyerFund(listing, quiet), (e: any) => e instanceof TxRevertedError && e.function_name === "fund");
  assert.equal(state.writes.length, 1, "fund was broadcast");
  assert.equal(state.writes[0].functionName, "fund");
  assert.equal(state.writes[0].value, PRICE, "with the price as value");
  assert.equal(rows("orders"), 0, "no orders row");
  assert.equal(rows("orders", "status = 'FUNDED'"), 0, "no FUNDED order");
  assert.equal((db.prepare("SELECT status FROM listings WHERE listing_id = ?").get(LISTING) as any).status, "LISTED", "the listing is still LISTED");
  assert.equal(rows("events", "kind = 'funded'"), 0, "no funded event");
  assert.deepEqual({ status: txRow().status, fn: txRow().function_name, block: txRow().block_number }, { status: "reverted", fn: "fund", block: 9 });
  db.prepare("DELETE FROM listings WHERE listing_id = ?").run(LISTING);
});

test("the hash is on record before the receipt wait, a wait that throws leaves a reconcilable row, and reconcile resolves it", async () => {
  resetTx();
  state.receipt = async () => { throw new Error("Timed out while waiting for transaction receipt"); };
  await assert.rejects(escrow.withdraw(verifierAccount), /Timed out/);
  // Seen from inside the wait: the row already existed with status pending.
  assert.equal(state.seenDuringWait?.length, 1, "the pending row was written before the wait started");
  assert.equal(state.seenDuringWait?.[0].hash, HASH);
  assert.equal(state.seenDuringWait?.[0].status, "pending");
  assert.equal(state.seenDuringWait?.[0].function_name, "withdraw");
  // After the throw: unresolved, with the error on record.
  assert.equal(txRow().status, "timeout");
  assert.match(txRow().error, /Timed out/);
  assert.equal(listPendingTxs().length, 1, "still listed as unresolved");
  // Reconcile while the chain still has no receipt: the row stays unresolved.
  state.lookup = async () => { throw new Error("Transaction receipt with hash could not be found"); };
  let r = await reconcilePendingTxs();
  assert.deepEqual(r, { checked: 1, confirmed: 0, reverted: 0, unresolved: 1 });
  assert.equal(txRow().status, "timeout");
  assert.match(txRow().error, /could not be found/);
  // Reconcile once the receipt exists: resolved from the chain, with its block.
  state.lookup = async () => ({ status: "success", blockNumber: 12n, gasUsed: 1n });
  r = await reconcilePendingTxs();
  assert.deepEqual(r, { checked: 1, confirmed: 1, reverted: 0, unresolved: 0 });
  assert.deepEqual({ status: txRow().status, block: txRow().block_number, error: txRow().error }, { status: "confirmed", block: 12, error: null });
  assert.deepEqual(listPendingTxs(), []);
  // A late receipt that reverted resolves the same way, to reverted.
  resetTx();
  state.receipt = async () => { throw new Error("socket hang up"); };
  await assert.rejects(escrow.withdraw(verifierAccount), /socket hang up/);
  state.lookup = async () => ({ status: "reverted", blockNumber: 13n, gasUsed: 1n });
  r = await reconcilePendingTxs();
  assert.deepEqual(r, { checked: 1, confirmed: 0, reverted: 1, unresolved: 0 });
  assert.equal(txRow().status, "reverted");
});

test("GET /api/txs/pending is operator-gated in hosted mode and lists unresolved rows", async () => {
  resetTx();
  state.receipt = async () => { throw new Error("Timed out"); };
  await assert.rejects(escrow.withdraw(verifierAccount));
  const app = buildApp();
  let res = await app.request("/api/txs/pending");
  assert.equal(res.status, 200, "local demonstration mode");
  let doc = (await res.json()) as any;
  assert.equal(doc.pending.length, 1);
  assert.deepEqual({ hash: doc.pending[0].hash, status: doc.pending[0].status, fn: doc.pending[0].function_name }, { hash: HASH, status: "timeout", fn: "withdraw" });
  assert.equal(doc.reconciled, null);
  process.env.PUBLIC_BASE_URL = "https://tail-bazaar.example";
  try {
    assert.equal((await app.request("/api/txs/pending")).status, 401, "hosted mode: no token");
    assert.equal((await app.request("/api/txs/pending", { headers: { authorization: "Bearer nope" } })).status, 401, "hosted mode: junk token");
    process.env.OPERATOR_TOKEN = "op-token-for-this-test";
    state.lookup = async () => ({ status: "success", blockNumber: 14n, gasUsed: 1n });
    res = await app.request("/api/txs/pending?reconcile=1", { headers: { authorization: "Bearer op-token-for-this-test" } });
    assert.equal(res.status, 200, "hosted mode: operator token");
    doc = (await res.json()) as any;
    assert.deepEqual(doc.reconciled, { checked: 1, confirmed: 1, reverted: 0, unresolved: 0 });
    assert.deepEqual(doc.pending, [], "resolved by the reconcile the operator asked for");
  } finally {
    delete process.env.OPERATOR_TOKEN;
    delete process.env.PUBLIC_BASE_URL;
  }
});

test("cleanup", () => {
  setChainClientsForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
