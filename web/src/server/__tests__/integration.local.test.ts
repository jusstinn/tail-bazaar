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
// Envelope-axis identifiers for EVERY target, plus the private structures. None of these may appear
// in any public projection. (GET /api/envelope publishes the axis names on purpose — that is the
// point of publishing an envelope — so it is deliberately not in the list of routes checked below.)
const PRIVATE_MARKERS = [
  "sensor_delay_ms", "actuator_delay_ms", "floor_friction", "payload_kg", "load_friction",
  "push_impulse_ns", "push_heading_deg", "push_time_s", "body_mass_scale", "actuator_noise_frac", "control_latency_ms", "init_seed",
  "object_mass_kg", "grip_friction", "object_offset_x_m", "object_offset_y_m", "action_noise_frac", "gripper_latency_ms", "goal_m",
  "cmd_vx_mps",
  "salt_hex", "\"frames\"", "\"ticks\"", "trajectory_hash", "reproduce",
];
/** Every target the registry publishes, in registry order, and sorted for set comparisons. */
const ALL_TARGETS = ["cart", "humanoid", "arm", "g1"];
const ALL_SORTED = [...ALL_TARGETS].sort();

function orders(): OrderRow[] {
  return getDb().prepare("SELECT * FROM orders ORDER BY created_at ASC").all() as unknown as OrderRow[];
}

test("public listing and order endpoints never expose private package fields", async () => {
  for (const url of ["/api/listings", "/api/orders", "/api/market", `/api/orders/${orders()[0].order_id}`, `/api/listings/${orders()[0].listing_id}`]) {
    const res = await app.request(url);
    assert.equal(res.status, 200, url);
    const text = await res.text();
    for (const m of PRIVATE_MARKERS) assert.ok(!text.includes(m), `${url} leaks ${m}`);
  }
});

test("pre-purchase summary carries only the allowed fields, for every target", async () => {
  const res = await app.request("/api/listings");
  const rows = (await res.json()) as any[];
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    const s = row.public_summary;
    // WHAT A BUYER SEES BEFORE PAYING: target, failure class, severity band, verification status and
    // seller history. Nothing derived from the exact scenario parameters.
    assert.deepEqual(Object.keys(s).sort(), ["admissible", "chain", "claim_kind", "controller", "envelope_id", "failure_class", "format", "hidden", "operating_context", "price_wei", "schema", "seller", "seller_settled_orders_at_listing", "severity", "target", "verification"]);
    assert.deepEqual(Object.keys(s.target).sort(), ["id", "label", "machine", "replay_renderer", "subject_label"]);
    assert.deepEqual(Object.keys(s.failure_class).sort(), ["detected_by", "id", "label"]);
    assert.ok(["low", "medium", "high", "none"].includes(s.severity.band));
    assert.equal(typeof row.seller_settled_orders, "number");
    assert.equal(s.verification.verdict, "VALID");
    // The buyer's real question and both ranges are stated before purchase, in prose that names no
    // parameter and no value of this scenario (the leak test above covers the parameter names).
    assert.ok(String(s.operating_context.question).length > 20);
    assert.ok(String(s.operating_context.controller_tuned_range).length > 10);
    assert.ok(String(s.operating_context.searched_envelope).length > 10);
  }
});

test("the marketplace carries every target, and each listing declares which robot it is about", async () => {
  const rows = (await (await app.request("/api/listings")).json()) as any[];
  const byTarget = new Set(rows.map((r) => r.public_summary.target.id));
  assert.deepEqual([...byTarget].sort(), ALL_SORTED, "every target in the registry is on the market");
  const g1 = rows.find((r) => r.public_summary.target.id === "g1")!;
  assert.equal(g1.public_summary.envelope_id, "tb-g1-envelope-1");
  assert.equal(g1.public_summary.failure_class.id, "FELL");
  // The G1's fall is the one FELL this project decides itself, and the sealed summary says so.
  assert.match(g1.public_summary.failure_class.detected_by, /THIS PROJECT'S predicate/);
  assert.equal(g1.public_summary.target.replay_renderer, "g1-3d");
  for (const r of rows) assert.equal(r.target_id, r.public_summary.target.id, "the listing row and its sealed summary agree");
  const cart = rows.find((r) => r.public_summary.target.id === "cart")!;
  const humanoid = rows.find((r) => r.public_summary.target.id === "humanoid")!;
  const arm = rows.find((r) => r.public_summary.target.id === "arm")!;
  assert.equal(cart.public_summary.envelope_id, "tb-envelope-1");
  assert.equal(humanoid.public_summary.envelope_id, "tb-humanoid-envelope-1");
  assert.equal(humanoid.public_summary.failure_class.id, "FELL");
  assert.match(humanoid.public_summary.failure_class.detected_by, /health predicate/i);
  assert.equal(humanoid.public_summary.target.replay_renderer, "humanoid-3d");
  assert.equal(arm.public_summary.envelope_id, "tb-arm-envelope-1");
  assert.ok(["DROPPED", "NOT_PLACED"].includes(arm.public_summary.failure_class.id));
  assert.equal(arm.public_summary.target.replay_renderer, "arm-3d");
  // The arm is the one target whose primary failure predicate this project owns, and the sealed
  // summary says so in the same field the other two use to name the environment's own detector.
  if (arm.public_summary.failure_class.id === "DROPPED") assert.match(arm.public_summary.failure_class.detected_by, /contact list/i);
});

test("the published envelope endpoint carries one envelope per target in GUARD's axis shape", async () => {
  const doc = (await (await app.request("/api/envelope")).json()) as any;
  assert.equal(doc.schema, "tb-envelopes-1");
  assert.deepEqual(doc.targets.map((t: any) => t.target_id), ALL_TARGETS);
  for (const env of doc.targets) {
    for (const a of env.axes) assert.deepEqual(Object.keys(a).sort(), ["group", "high", "low", "marginal", "name", "nominal", "quantization", "scale", "tuned_range", "units"]);
    assert.equal(env.axes.every((a: any) => a.marginal === null && a.scale === null), true, "no distribution D is stated");
    // GUARD's three groups plus `command` (the G1's forward-velocity command: what the policy is asked to do).
    assert.ok(env.axes.every((a: any) => ["physical", "systems", "visual", "command"].includes(a.group)));
    assert.deepEqual(Object.keys(env.verdicts).sort(), ["INCONCLUSIVE", "INVALID", "VALID"]);
    assert.ok(env.failure_classes.length >= 1);
  }
  const cart = doc.targets[0], humanoid = doc.targets[1], arm = doc.targets[2];
  assert.equal(cart.envelope_id, "tb-envelope-1");
  assert.equal(cart.axes.length, 5);
  assert.match(cart.controller_tuned_range.prose, /sensor latency <= 40 ms/);
  assert.equal(humanoid.envelope_id, "tb-humanoid-envelope-1");
  assert.equal(humanoid.axes.length, 7);
  assert.match(humanoid.controller_tuned_range.prose, /unmodified Gymnasium Humanoid-v5/);
  assert.equal(arm.envelope_id, "tb-arm-envelope-1");
  assert.equal(arm.axes.length, 7);
  assert.match(arm.controller_tuned_range.prose, /unmodified Gymnasium-Robotics FetchPickAndPlace-v4/);
  assert.equal(arm.failure_classes.length, 2, "DROPPED and NOT_PLACED are both published");
  const g1 = doc.targets[3];
  assert.equal(g1.envelope_id, "tb-g1-envelope-1");
  assert.equal(g1.axes.length, 8);
  assert.match(g1.controller_tuned_range.prose, /Unitree's own MuJoCo deployment configuration/);
  assert.match(g1.failure_classes[0].detected_by, /THIS PROJECT'S predicate/);
  // ?target= returns exactly one of them
  const one = (await (await app.request("/api/envelope?target=humanoid")).json()) as any;
  assert.equal(one.envelope_id, "tb-humanoid-envelope-1");
  assert.equal(((await (await app.request("/api/envelope?target=arm")).json()) as any).envelope_id, "tb-arm-envelope-1");
  assert.equal((await app.request("/api/envelope?target=nope")).status, 404);
});

test("search cost is published as a market-wide aggregate, with no scenario in it", async () => {
  const m = (await (await app.request("/api/market")).json()) as any;
  assert.ok(m.search_cost_total.simulations > 0, "the hunters actually ran simulations");
  assert.ok(m.search_cost_total.hunts >= ALL_TARGETS.length, "at least one hunt per target");
  const cart = m.targets.find((t: any) => t.target_id === "cart");
  const humanoid = m.targets.find((t: any) => t.target_id === "humanoid");
  const arm = m.targets.find((t: any) => t.target_id === "arm");
  const g1 = m.targets.find((t: any) => t.target_id === "g1");
  assert.ok(cart.search_cost.simulations > 0 && humanoid.search_cost.simulations > 0 && arm.search_cost.simulations > 0 && g1.search_cost.simulations > 0);
  assert.ok(cart.failures_by_class.COLLISION > 0, "the cart sweep produced collisions");
  assert.ok(humanoid.failures_by_class.FELL > 0, "the humanoid sweep produced falls");
  assert.ok(arm.failures_by_class.DROPPED > 0, "the arm sweep produced drops");
  assert.ok(g1.failures_by_class.FELL > 0, "the G1 sweep produced falls");
  assert.ok(cart.listings > 0 && humanoid.listings > 0 && arm.listings > 0 && g1.listings > 0);
});

test("the failure ledger export carries the target id on every row", async () => {
  const { buildLedger } = await import("../ledger.js");
  const led = buildLedger();
  assert.ok(led.findings.length >= 3);
  for (const row of led.findings) {
    assert.ok(ALL_TARGETS.includes(row.target_id), `row ${row.finding_id} names a known target`);
    assert.equal(typeof row.severity.proxy, "string");
    assert.ok(row.severity.value === null || typeof row.severity.value === "number");
  }
  assert.deepEqual(Object.keys(led.findings_by_target).sort(), ALL_SORTED);
  assert.ok(led.findings_by_target.cart > 0 && led.findings_by_target.humanoid > 0 && led.findings_by_target.arm > 0 && led.findings_by_target.g1 > 0);
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

// The public-demonstration-fixture exception, against a real order from a real pipeline run.
// demo-public-orders.test.ts pins the rule in isolation; this checks it on the actual data.
test("hosted mode: a published fixture order opens anonymously and its neighbours do not", async () => {
  const all = orders();
  const valid = all.find((o) => o.status === "SETTLED_VALID")!;
  const other = all.find((o) => o.order_id !== valid.order_id)!;
  process.env.PUBLIC_BASE_URL = "https://tail-bazaar.example";
  process.env.DEMO_PUBLIC_ORDERS = valid.order_id;
  try {
    const opened = await app.request(`/api/orders/${valid.order_id}/reveal`);
    assert.equal(opened.status, 200, "the published fixture is readable with no token");
    assert.equal(opened.headers.get("x-access-via"), "public-demo-fixture");
    assert.match(opened.headers.get("x-tb-demo-fixture") ?? "", /DEMONSTRATION FIXTURE/);
    const listing = getDb().prepare("SELECT commitment FROM listings WHERE listing_id = ?").get(valid.listing_id) as { commitment: string };
    assert.equal(keccakHex(new Uint8Array(await opened.arrayBuffer())), listing.commitment, "and it is the committed package, not a redaction");
    const target = (getDb().prepare("SELECT target_id FROM listings WHERE listing_id = ?").get(valid.listing_id) as { target_id: string | null }).target_id ?? "cart";
    assert.equal((await app.request(`/api/runs/baseline?target=${target}`)).status, 200, "so is the baseline its replay draws behind it");
    const closed = await app.request(`/api/orders/${other.order_id}/reveal`);
    assert.equal(closed.status, 401, "every other order keeps the hosted-mode 401");
    assert.ok(!(await closed.text()).includes("salt_hex"));
  } finally {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.DEMO_PUBLIC_ORDERS;
  }
});

test("the replay renderer a package declares is the one its target publishes", async () => {
  const valid = orders().find((o) => o.status === "SETTLED_VALID")!;
  const res = await app.request(`/api/orders/${valid.order_id}/reveal`);
  assert.equal(res.status, 200);
  const pkg = JSON.parse(Buffer.from(await res.arrayBuffer()).toString("utf8"));
  const doc = (await (await app.request(`/api/envelope?target=${pkg.target_id}`)).json()) as any;
  assert.equal(pkg.replay.renderer, doc.replay_renderer);
  assert.ok(Array.isArray(pkg.replay.frames.data) && pkg.replay.frames.data.length > 1, "the package carries recorded transforms");
  assert.ok(pkg.hunter && pkg.hunter.search_cost.simulations > 0, "the aggregate search cost travels post-purchase only");
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
