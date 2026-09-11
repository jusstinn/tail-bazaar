// Integration test against the LOCAL anvil chain and the database produced by `npm run demo`.
// Run with: npm run test:integration  (requires scripts/anvil-start.sh, local-deploy.sh and a demo run)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../index.js";
import { getDb, type OrderRow } from "../db.js";
import { roles } from "../config.js";
import { walletFor } from "../chain.js";
import { keccakHex } from "../canonical.js";
import { createChallenge, redeemChallenge } from "../auth.js";

const app = buildApp();
const PRIVATE_MARKERS = ["sensor_delay_ms", "floor_friction", "payload_kg", "actuator_delay_ms", "salt_hex", "\"frames\"", "\"ticks\"", "trajectory_hash", "reproduce"];

function orders(): OrderRow[] {
  return getDb().prepare("SELECT * FROM orders ORDER BY created_at ASC").all() as unknown as OrderRow[];
}

test("public listing and order endpoints never expose private package fields", async () => {
  for (const url of ["/api/listings", "/api/orders", `/api/orders/${orders()[0].order_id}`, `/api/listings/${orders()[0].listing_id}`]) {
    const res = await app.request(url);
    assert.equal(res.status, 200, url);
    const text = await res.text();
    for (const m of PRIVATE_MARKERS) assert.ok(!text.includes(m), `${url} leaks ${m}`);
  }
});

test("pre-purchase summary carries only the allowed fields", async () => {
  const res = await app.request("/api/listings");
  const rows = (await res.json()) as any[];
  assert.ok(rows.length >= 2);
  const s = rows[0].public_summary;
  assert.deepEqual(Object.keys(s).sort(), ["admissible", "chain", "claim_kind", "controller", "envelope_id", "format", "hidden", "price_wei", "schema", "seller", "seller_settled_orders_at_listing", "severity", "verification"]);
  assert.equal(typeof rows[0].seller_settled_orders, "number");
});

test("retrieval requires the bound buyer's signature over a fresh challenge", async () => {
  const valid = orders().find((o) => o.status === "SETTLED_VALID")!;
  const buyer = roles.buyer();
  // wrong signer (the seller) -> 403
  let ch = createChallenge(valid.order_id, buyer.address);
  const bad = await walletFor(roles.seller()).signMessage({ message: ch.message });
  let res = await app.request("/api/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: valid.order_id, nonce: ch.nonce, signature: bad }) });
  assert.equal(res.status, 403);
  // challenge issued for a different address than the signer -> 403 even with a valid buyer signature
  ch = createChallenge(valid.order_id, roles.seller().address);
  const sigWrongBinding = await walletFor(buyer).signMessage({ message: ch.message });
  res = await app.request("/api/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: valid.order_id, nonce: ch.nonce, signature: sigWrongBinding }) });
  assert.equal(res.status, 403);
  // correct buyer -> 200 and the bytes hash to the on-chain commitment
  ch = createChallenge(valid.order_id, buyer.address);
  const good = await walletFor(buyer).signMessage({ message: ch.message });
  res = await app.request("/api/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: valid.order_id, nonce: ch.nonce, signature: good }) });
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const listing = getDb().prepare("SELECT commitment FROM listings WHERE listing_id = ?").get(valid.listing_id) as { commitment: string };
  assert.equal(keccakHex(bytes), listing.commitment);
  // nonce is single-use -> 401 on replay
  res = await app.request("/api/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: valid.order_id, nonce: ch.nonce, signature: good }) });
  assert.equal(res.status, 401);
  // challenge bound to another order -> 401
  const other = orders().find((o) => o.order_id !== valid.order_id)!;
  ch = createChallenge(other.order_id, buyer.address);
  const sigOther = await walletFor(buyer).signMessage({ message: ch.message });
  res = await app.request("/api/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: valid.order_id, nonce: ch.nonce, signature: sigOther }) });
  assert.equal(res.status, 401);
  // expired challenge -> 401 (direct call with a clock past expiry)
  ch = createChallenge(valid.order_id, buyer.address);
  const sigExp = await walletFor(buyer).signMessage({ message: ch.message });
  await assert.rejects(() => redeemChallenge(valid.order_id, ch.nonce, sigExp, ch.expires_at + 1), /expired/);
});

test("a refunded order cannot be retrieved even by its buyer", async () => {
  const invalid = orders().find((o) => o.status === "SETTLED_INVALID")!;
  const buyer = roles.buyer();
  const ch = createChallenge(invalid.order_id, buyer.address);
  const sig = await walletFor(buyer).signMessage({ message: ch.message });
  const res = await app.request("/api/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: invalid.order_id, nonce: ch.nonce, signature: sig }) });
  assert.equal(res.status, 403);
});

test("the tampered order's verifier check recorded a commitment mismatch and a refund", async () => {
  const invalid = orders().find((o) => o.status === "SETTLED_INVALID")!;
  const res = await app.request(`/api/orders/${invalid.order_id}`);
  const doc = (await res.json()) as any;
  assert.equal(doc.delivery_check.valid, false);
  assert.match(doc.delivery_check.reason, /COMMITMENT MISMATCH/);
  assert.ok(doc.recheck_tx && doc.settle_tx && doc.withdraw_tx);
  assert.equal(doc.on_chain.status, "SettledInvalid");
});
