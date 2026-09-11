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
  assert.deepEqual(Object.keys(s).sort(), ["admissible", "chain", "claim_kind", "controller", "envelope_id", "format", "hidden", "operating_context", "price_wei", "schema", "seller", "seller_settled_orders_at_listing", "severity", "verification"]);
  assert.equal(typeof rows[0].seller_settled_orders, "number");
  // P3: the buyer's real question and both ranges are stated before purchase, in prose that names no
  // parameter and no value of this scenario (the leak test above covers the parameter names).
  assert.match(s.operating_context.controller_tuned_range, /sensor latency <= 40 ms/);
  assert.match(s.operating_context.searched_envelope, /sensor latency 0-300 ms/);
  assert.match(s.operating_context.question, /wider operating range than it was tuned for/);
  assert.equal(s.verification.verdict, "VALID");
});

test("the published envelope endpoint carries both ranges in GUARD's axis shape", async () => {
  const env = (await (await app.request("/api/envelope")).json()) as any;
  assert.equal(env.envelope_id, "tb-envelope-1");
  assert.equal(env.axes.length, 4);
  for (const a of env.axes) assert.deepEqual(Object.keys(a).sort(), ["group", "high", "low", "marginal", "name", "nominal", "quantization", "scale", "tuned_range", "units"]);
  assert.deepEqual(env.axes.map((a: any) => a.group).sort(), ["physical", "physical", "systems", "systems"]);
  assert.equal(env.axes.every((a: any) => a.marginal === null && a.scale === null), true, "no distribution D is stated");
  assert.deepEqual(Object.keys(env.verdicts).sort(), ["INCONCLUSIVE", "INVALID", "VALID"]);
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

// P1 end to end: in hosted mode the paid evidence is not public, and the session a real signed
// retrieval hands back is what unlocks it. (hosted-auth.test.ts covers the gate in isolation.)
test("hosted mode: the reveal route is closed to visitors and opened by a real retrieval session", async () => {
  const valid = orders().find((o) => o.status === "SETTLED_VALID")!;
  const buyer = roles.buyer();
  const reveal = `/api/orders/${valid.order_id}/reveal`;
  assert.equal((await app.request(reveal)).status, 200, "local demonstration mode is unchanged");
  process.env.PUBLIC_BASE_URL = "https://tail-bazaar.example";
  try {
    const anon = await app.request(reveal);
    assert.equal(anon.status, 401, "an anonymous visitor to the public URL cannot read paid evidence");
    assert.ok(!(await anon.text()).includes("salt_hex"));
    assert.equal((await app.request("/api/runs/baseline")).status, 401);

    const ch = createChallenge(valid.order_id, buyer.address);
    const sig = await walletFor(buyer).signMessage({ message: ch.message });
    const got = await app.request("/api/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: valid.order_id, nonce: ch.nonce, signature: sig }) });
    assert.equal(got.status, 200, "the signed-challenge route still works in hosted mode");
    const token = got.headers.get("x-tb-session")!;
    assert.match(token, /^[0-9a-f]{64}$/);

    const opened = await app.request(reveal, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get("x-access-via"), "buyer-session");
    const bytes = new Uint8Array(await opened.arrayBuffer());
    const listing = getDb().prepare("SELECT commitment FROM listings WHERE listing_id = ?").get(valid.listing_id) as { commitment: string };
    assert.equal(keccakHex(bytes), listing.commitment, "the authenticated path returns the committed package");
    assert.equal((await app.request(reveal, { headers: { authorization: "Bearer " + "0".repeat(64) } })).status, 401);
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
  assert.equal((await app.request(reveal)).status, 200, "unsetting PUBLIC_BASE_URL restores local demonstration mode");
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
