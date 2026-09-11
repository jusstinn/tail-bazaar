// LIVE FLOWS (flows.ts): buying a listing or listing a new finding from the page, one step at a
// time. This suite pins the gating (404 / 409 / 401), the one-flow-at-a-time rule, the step
// transitions with their transaction hashes and block numbers, the persisted record, and the
// failure path — with the agent step functions replaced through flows.ts's own injection point
// (setFlowDepsForTests). Throwaway database in a temp directory; no chain, no simulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrderRow } from "../db.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-flows-"));
process.env.DATABASE_PATH = path.join(tmp, "flows-test.sqlite");
process.env.CHAIN_MODE = "local";
process.env.ESCROW_ADDRESS_LOCAL = "0x" + "e".repeat(40);
delete process.env.PUBLIC_BASE_URL;
delete process.env.OPERATOR_TOKEN;

const { buildApp } = await import("../index.js");
const { getDb, nowIso } = await import("../db.js");
const { setFlowDepsForTests, flowStatus, currentFlow, flowBusyReason, BUY_STEPS, LIST_STEPS } = await import("../flows.js");
const { chainMode, chainId } = await import("../config.js");

const app = buildApp();
const db = getDb();
const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const BUYER = "0x1B27C90FcD738E960D3D505682EC2732A08c7f99";
const LISTED = "0x" + "11".repeat(32);
const LISTED_2 = "0x" + "33".repeat(32);
const SOLD = "0x" + "22".repeat(32);
const H = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const summary = JSON.stringify({ target: { id: "cart", label: "Warehouse cart" }, controller: { id: "c", hash: "h" }, verification: { status: "VERIFIED", verdict: "VALID" }, severity: { band: "low" }, claim_kind: "k", hidden: "h" });
const insertListing = (id: string, status: string) =>
  db.prepare("INSERT INTO listings(listing_id, chain_mode, chain_id, escrow_address, target_id, seller, price_wei, commitment, terms_hash, public_summary, status, register_tx, demo_tamper, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, chainMode, chainId, process.env.ESCROW_ADDRESS_LOCAL!, "cart", SELLER, "1000000000000000", "0x" + "cc".repeat(32), "0x" + "dd".repeat(32), summary, status, null, 0, nowIso());
insertListing(LISTED, "LISTED");
insertListing(LISTED_2, "LISTED");
insertListing(SOLD, "SETTLED_VALID");
// The transaction ledger chain.ts keeps: the flow reads a step's block number from it.
const ledger = (hash: string, block: number) =>
  db.prepare("INSERT OR REPLACE INTO pending_txs(hash, function_name, args_json, from_address, chain_mode, created_at, updated_at, status, block_number, error) VALUES (?,?,?,?,?,?,?,?,?,?)").run(hash, "fn", "[]", BUYER, chainMode, nowIso(), nowIso(), "confirmed", block, null);
ledger(H(1), 41); ledger(H(2), 42); ledger(H(3), 43);

// ------------------------------------------------------------------ stubbed steps
let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
const armGate = () => { gate = new Promise<void>((r) => { release = r; }); };
let settleThrows = false;
const orderRow = (id: string) => db.prepare("SELECT * FROM orders WHERE order_id = ?").get(id) as unknown as OrderRow;
setFlowDepsForTests({
  buyerFund: async (listing) => {
    await gate;
    db.prepare("INSERT INTO orders(order_id, listing_id, buyer, price_wei, status, fund_tx, created_at) VALUES (?,?,?,?,?,?,?)").run(listing.listing_id, listing.listing_id, BUYER, listing.price_wei, "FUNDED", H(1), nowIso());
    db.prepare("UPDATE listings SET status = 'FUNDED' WHERE listing_id = ?").run(listing.listing_id);
    return orderRow(listing.listing_id);
  },
  sellerDeliver: async (order) => {
    db.prepare("UPDATE orders SET deliver_tx = ?, status = 'DELIVERED' WHERE order_id = ?").run(H(2), order.order_id);
    return { tx: H(2), delivery_hash: "0x" + "cc".repeat(32), tampered: false };
  },
  buyerRetrieveAndCheck: async () => ({ bytes: new Uint8Array(), check: { ok: true, reason: "package matches commitment and advertised terms", delivered_hash: "", on_chain_commitment: "", checks: [] } }),
  verifierCheckDeliveryAndSettle: async (order) => {
    if (settleThrows) throw new Error("settle reverted (scripted by the test)");
    db.prepare("UPDATE orders SET settle_tx = ?, status = 'SETTLED_VALID' WHERE order_id = ?").run(H(3), order.order_id);
    db.prepare("UPDATE listings SET status = 'SETTLED_VALID' WHERE listing_id = ?").run(order.listing_id);
    return { check: { valid: true, verdict: "VALID", reason: "ok", on_chain_commitment: "", delivered_hash: "", asserted_delivery_hash: null, checks: [], checked_at: nowIso() }, tx: H(3) };
  },
  withdrawAfterSettlement: async () => ({ hash: H(4) as `0x${string}`, block_number: 44, status: "success", gas_used: "1", chain_mode: chainMode, chain_id: chainId }),
  ensureBaseline: async () => ({ file: "baseline.json", trajectory_hash: "0x00" }),
  sellerDiscover: async (target) => ({
    hunter: { id: "hunter", mode: "grid", target_id: target.id, search_cost: { simulations: 40, sim_steps: 1, wall_time_s: 1 }, counts: { simulations: 40, failures: 1, survived: 39, inconclusive: 0, by_class: {} }, distinct_findings: 1, near_duplicates: 0 },
    huntFile: "hunt.json",
    findings: [{ rank: 1, target, scenario: {}, run: { outcome: "COLLISION" } as any, runBytes: new Uint8Array(), runFile: "f.json" }],
  }),
  submitFinding: async (_t, _f, _h, _s, _o, log) => {
    log("verifier: VERIFIED (exact-trajectory-hash); registering cart listing");
    insertListing(H(9), "LISTED");
    return { result: { status: "VERIFIED" } as any, listingId: H(9) as `0x${string}`, summary: null as any, registerTx: { hash: H(5) as `0x${string}`, block_number: 45, status: "success", gas_used: "1", chain_mode: chainMode, chain_id: chainId } };
  },
});

const post = (url: string, headers: Record<string, string> = {}) => app.request(url, { method: "POST", headers });
const until = async (pred: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 15)); } };

test("(a) buying refuses an unknown listing with 404 and a listing that is not LISTED with 409", async () => {
  assert.equal((await post(`/api/listings/${"0x" + "ff".repeat(32)}/buy`)).status, 404);
  const res = await post(`/api/listings/${SOLD}/buy`);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as any).error, /SETTLED_VALID, not LISTED/);
  assert.equal((await post("/api/targets/nope/list")).status, 404);
  assert.equal(currentFlow(), null, "nothing started");
});

test("(b) hosted mode requires the operator token to start a flow; local mode starts at once", async () => {
  process.env.PUBLIC_BASE_URL = "https://tail-bazaar.example";
  try {
    assert.equal((await post(`/api/listings/${LISTED}/buy`)).status, 401, "hosted: no token");
    assert.equal((await post(`/api/listings/${LISTED}/buy`, { authorization: "Bearer nope" })).status, 401, "hosted: junk token");
    assert.equal((await post("/api/targets/cart/list")).status, 401, "hosted: listing needs the token too");
    assert.equal((await app.request("/api/flows/current")).status, 200, "reading flows stays public");
    assert.equal(currentFlow(), null, "nothing started");
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
  armGate();
  const res = await post(`/api/listings/${LISTED}/buy`);
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as any;
  assert.equal(body.order_id, LISTED, "the order id is the listing id");
  assert.match(body.flow_id, /^buy-/);
  const f = flowStatus(body.flow_id)!;
  assert.equal(f.status, "running");
  assert.deepEqual(f.steps.map((s) => s.name), [...BUY_STEPS]);
  assert.equal(f.steps[0].status, "running", "fund is in progress");
  assert.deepEqual(f.steps.slice(1).map((s) => s.status), ["pending", "pending", "pending", "pending"]);
  (globalThis as any).__flow = body.flow_id;
});

test("(d) one flow at a time: a second buy, a listing and the pipeline trigger are all refused while it runs", async () => {
  assert.match(flowBusyReason() ?? "", /already running/);
  let res = await post(`/api/listings/${LISTED_2}/buy`);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as any).error, /already running/);
  res = await post("/api/targets/cart/list");
  assert.equal(res.status, 409);
  res = await post("/api/demo/run");
  assert.equal(res.status, 409, "the demonstration pipeline waits for the flow too");
  const cur = (await (await app.request("/api/flows/current")).json()) as any;
  assert.equal(cur.flow.flow_id, (globalThis as any).__flow);
  assert.match(cur.busy, /already running/);
});

test("(c) the steps transition in order with hashes and blocks, and the record persists and stays public", async () => {
  const id = (globalThis as any).__flow as string;
  release();
  await until(() => flowStatus(id)!.status !== "running");
  const f = flowStatus(id)!;
  assert.equal(f.status, "done", f.error ?? "");
  assert.equal(f.finished_at !== null, true);
  assert.deepEqual(f.steps.map((s) => s.status), ["done", "done", "done", "done", "done"]);
  assert.deepEqual(f.steps.map((s) => s.tx_hash), [H(1), H(2), null, H(3), H(4)], "fund, deliver, settle and withdraw each carry their hash; a clean retrieval has none");
  assert.deepEqual(f.steps.map((s) => s.block_number), [41, 42, null, 43, 44], "blocks come from the transaction ledger, or from the withdraw result");
  assert.equal(f.steps[3].detail, "VALID");
  assert.equal(f.steps[4].detail, "Settled: seller paid");
  assert.equal(orderRow(LISTED).status, "SETTLED_VALID");
  // Persisted: the row is readable without the in-memory registry.
  const row = db.prepare("SELECT * FROM flows WHERE flow_id = ?").get(id) as any;
  assert.equal(row.status, "done");
  assert.equal(JSON.parse(row.steps).length, 5);
  // Public in both modes, and carrying nothing private.
  process.env.PUBLIC_BASE_URL = "https://tail-bazaar.example";
  try {
    const res = await app.request(`/api/flows/${id}`);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const m of ["salt", "scenario", "package_bytes", "frames", "verifier:", "log"]) assert.ok(!text.includes(m), `flow record carries ${m}`);
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["error", "finished_at", "flow_id", "kind", "listing_id", "started_at", "status", "steps", "target_id"]);
    assert.deepEqual(Object.keys(JSON.parse(text).steps[0]).sort(), ["at", "block_number", "detail", "name", "status", "tx_hash"]);
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
  assert.equal((await app.request("/api/flows/nope")).status, 404);
  assert.equal(flowBusyReason(), null, "free again");
});

test("a step that throws fails the flow in plain words and frees the slot", async () => {
  settleThrows = true;
  const res = await post(`/api/listings/${LISTED_2}/buy`);
  assert.equal(res.status, 200);
  const id = ((await res.json()) as any).flow_id as string;
  await until(() => flowStatus(id)!.status !== "running");
  const f = flowStatus(id)!;
  assert.equal(f.status, "failed");
  assert.match(f.error!, /settle reverted/);
  assert.deepEqual(f.steps.map((s) => s.status), ["done", "done", "done", "failed", "pending"]);
  assert.match(f.steps[3].detail!, /settle reverted/);
  assert.equal(flowBusyReason(), null);
  settleThrows = false;
});

test("the listing flow runs baseline, hunt, verify and register, and ends carrying the new listing id", async () => {
  const res = await post("/api/targets/cart/list");
  assert.equal(res.status, 200, await res.clone().text());
  const id = ((await res.json()) as any).flow_id as string;
  assert.match(id, /^list-/);
  await until(() => flowStatus(id)!.status !== "running");
  const f = flowStatus(id)!;
  assert.equal(f.status, "done", f.error ?? "");
  assert.equal(f.kind, "list");
  assert.equal(f.listing_id, H(9));
  assert.deepEqual(f.steps.map((s) => s.name), [...LIST_STEPS]);
  assert.deepEqual(f.steps.map((s) => s.status), ["done", "done", "done", "done"]);
  assert.equal(f.steps[2].detail, "VALID", "the verify step carries the verdict word and nothing else of the verifier's log");
  assert.deepEqual({ tx: f.steps[3].tx_hash, block: f.steps[3].block_number }, { tx: H(5), block: 45 });
  assert.equal((db.prepare("SELECT status FROM listings WHERE listing_id = ?").get(H(9)) as any).status, "LISTED", "the new listing is on the market with its Buy button");
});

test("cleanup", () => {
  setFlowDepsForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
