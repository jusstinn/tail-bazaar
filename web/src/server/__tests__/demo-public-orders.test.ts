// PUBLIC DEMONSTRATION FIXTURES. On a hosted instance a reader who opens the link cold should be
// able to follow purchase -> reveal -> replay, so a short, explicit list of order ids has its
// evidence served without a token. This suite pins BOTH sides of that line: the listed order opens
// anonymously and says on the record that it is a fixture, and every other order still returns the
// hosted-mode 401 with nothing of the package in the body. It also pins the two things the exception
// must NOT widen: the pre-purchase summary is byte-for-byte what it was, and the operator-only
// pipeline log stays operator-only.
//
// Throwaway database in a temp directory; no chain, no simulator, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-fixture-"));
process.env.DATABASE_PATH = path.join(tmp, "demo-public-orders-test.sqlite");
delete process.env.PUBLIC_BASE_URL;
delete process.env.OPERATOR_TOKEN;
delete process.env.DEMO_PUBLIC_ORDERS;
delete process.env.DEMO_PUBLIC_TAMPER_FIXTURES;

const { buildApp, DEMO_FIXTURE_NOTE } = await import("../index.js");
const { getDb, nowIso } = await import("../db.js");
const { REPO_ROOT, chainMode, chainId } = await import("../config.js");

const app = buildApp();
const BUYER = "0x1B27C90FcD738E960D3D505682EC2732A08c7f99";
const SELLER = "0x28dAA9F3F9468382fFeD53cc339418403337cDeD";
const id = (n: number): string => "0x" + String(n).repeat(64);

/** Three orders with the shape the demo pipeline produces: a settled-valid cart order, the cart order
 *  whose delivery was deliberately tampered, and an unrelated humanoid order. */
const VALID = id(1);      // cart, SETTLED_VALID
const TAMPERED = id(2);   // cart, SETTLED_INVALID, listing.demo_tamper = 1
const OTHER = id(3);      // humanoid, SETTLED_VALID — never a fixture unless named explicitly
const secretOf = (n: string) => `{"salt_hex":"0x${n}","scenario":{"grip_friction":0.25,"init_seed":3}}`;

const summary = (target: string) => JSON.stringify({
  schema: "tb-summary-2", format: "tb-cjson-1",
  target: { id: target, label: target, machine: target, subject_label: "Policy", replay_renderer: `${target}-3d` },
  failure_class: { id: "DROPPED", label: "Dropped", detected_by: "the simulator's own predicate" },
  controller: { id: "c", hash: "sha256:" + "0".repeat(64) }, envelope_id: "tb-arm-envelope-1", admissible: true,
  claim_kind: "k", verification: { status: "VERIFIED", verdict: "VALID", method: "exact-trajectory-hash" },
  operating_context: {}, severity: { proxy: "p", band: "high", definition: "d" }, seller: SELLER,
  seller_settled_orders_at_listing: 0, price_wei: "1", chain: { mode: chainMode, chain_id: chainId, escrow: "0x" }, hidden: "h",
});

const db = getDb();
for (const [order, target, status, tamper] of [[VALID, "cart", "SETTLED_VALID", 0], [TAMPERED, "cart", "SETTLED_INVALID", 1], [OTHER, "humanoid", "SETTLED_VALID", 0]] as const) {
  db.prepare("INSERT INTO listings(listing_id, chain_mode, chain_id, escrow_address, target_id, seller, price_wei, commitment, terms_hash, public_summary, status, register_tx, demo_tamper, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(order, chainMode, chainId, "0x" + "e".repeat(40), target, SELLER, "1000", "0xcc", "0xtt", summary(target), status, null, tamper, nowIso());
  db.prepare("INSERT INTO orders(order_id, listing_id, buyer, price_wei, status, created_at) VALUES (?,?,?,?,?,?)")
    .run(order, order, BUYER, "1000", status, nowIso());
  db.prepare("INSERT INTO retrievals(order_id, package_bytes, signer, retrieved_at) VALUES (?,?,?,?)")
    .run(order, new TextEncoder().encode(secretOf(order.slice(2, 6))), BUYER, nowIso());
}
// The public baseline run the reveal view draws behind a failure, so the fixture's replay is complete.
const baselineDir = path.join(tmp, "sim", "public", "runs");
fs.mkdirSync(baselineDir, { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, "evidence", "milestone", "runs", "baseline.json"), path.join(baselineDir, "baseline.json"));

function hosted(on: boolean): void {
  if (on) process.env.PUBLIC_BASE_URL = "https://tail-bazaar.example";
  else delete process.env.PUBLIC_BASE_URL;
}
function fixtures(ids: string | null, auto = false): void {
  if (ids === null) delete process.env.DEMO_PUBLIC_ORDERS;
  else process.env.DEMO_PUBLIC_ORDERS = ids;
  if (auto) process.env.DEMO_PUBLIC_TAMPER_FIXTURES = "1";
  else delete process.env.DEMO_PUBLIC_TAMPER_FIXTURES;
}
const reveal = (o: string) => `/api/orders/${o}/reveal`;
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

test("a listed order is readable anonymously on a hosted instance, and says it is a fixture", async () => {
  hosted(true);
  fixtures(VALID);
  const res = await app.request(reveal(VALID));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), secretOf(VALID.slice(2, 6)));
  assert.equal(res.headers.get("x-access-via"), "public-demo-fixture");
  assert.equal(res.headers.get("x-tb-demo-fixture"), DEMO_FIXTURE_NOTE);
  assert.equal(DEMO_FIXTURE_NOTE, "DEMONSTRATION FIXTURE, published in the repository, not a secret");
  // The order document carries the badge the page renders, and stops claiming the reveal is gated.
  const doc = (await (await app.request(`/api/orders/${VALID}`)).json()) as any;
  assert.equal(doc.public_demo_fixture, true);
  assert.equal(doc.public_demo_fixture_note, DEMO_FIXTURE_NOTE);
  assert.equal(doc.reveal_requires_auth, false);
  // The nominal baseline the replay draws behind it opens too, or the fixture shows half a story.
  const base = await app.request("/api/runs/baseline");
  assert.equal(base.status, 200);
  assert.equal(base.headers.get("x-access-via"), "public-demo-fixture");
  hosted(false);
  fixtures(null);
});

test("every order that is not on the list keeps its 401, and the refusal leaks nothing", async () => {
  hosted(true);
  fixtures(VALID);
  for (const other of [TAMPERED, OTHER]) {
    const res = await app.request(reveal(other));
    assert.equal(res.status, 401, other);
    const body = await res.text();
    assert.ok(!body.includes("salt_hex") && !body.includes("grip_friction"), "the 401 body leaks nothing");
    const doc = (await (await app.request(`/api/orders/${other}`)).json()) as any;
    assert.equal(doc.public_demo_fixture, false);
    assert.equal(doc.public_demo_fixture_note, null);
    assert.equal(doc.reveal_requires_auth, true);
  }
  // A junk token is still a junk token: publishing one order does not soften the gate for the rest.
  assert.equal((await app.request(reveal(OTHER), auth("not-a-token"))).status, 401);
  hosted(false);
  fixtures(null);
});

test("the pre-purchase summary is unchanged by publishing a fixture", async () => {
  const keysWhenClosed = async (): Promise<string[][]> => {
    const rows = (await (await app.request("/api/listings")).json()) as any[];
    return rows.map((r) => Object.keys(r.public_summary).sort());
  };
  hosted(true);
  fixtures(null);
  const before = await keysWhenClosed();
  fixtures(`${VALID},${TAMPERED}`);
  const after = await keysWhenClosed();
  assert.deepEqual(after, before, "the sealed summary is the bytes whose hash is on chain; nothing may be added to it");
  const rows = (await (await app.request("/api/listings")).json()) as any[];
  assert.ok(!JSON.stringify(rows.map((r) => r.public_summary)).includes("FIXTURE"), "no fixture marker reaches the sealed summary");
  hosted(false);
  fixtures(null);
});

test("the exception is per order id and does not widen to the operator-only routes", async () => {
  getDb().prepare("INSERT OR REPLACE INTO pipeline_runs(run_id, started_at, status, log) VALUES (?,?,?,?)")
    .run("run-fixture-test", nowIso(), "done", JSON.stringify([{ ts: "t", msg: "seller: re-ran finding-1: DROPPED, impact 3.150862 m/s" }]));
  hosted(true);
  fixtures(`${VALID},${TAMPERED},${OTHER}`);
  const doc = (await (await app.request("/api/demo/status")).json()) as any;
  assert.equal(doc.log_redacted, true, "publishing evidence never publishes the pipeline log");
  assert.deepEqual(doc.run.log, []);
  assert.equal((await app.request("/api/demo/run", { method: "POST" })).status, 401, "and never the pipeline trigger");
  hosted(false);
  fixtures(null);
});

test("DEMO_PUBLIC_TAMPER_FIXTURES publishes the tampered order and the paired valid one of its target", async () => {
  hosted(true);
  fixtures(null, true);
  assert.equal((await app.request(reveal(TAMPERED))).status, 200, "the deliberately tampered delivery");
  assert.equal((await app.request(reveal(VALID))).status, 200, "and the valid settlement of the same robot");
  assert.equal((await app.request(reveal(OTHER))).status, 401, "a different robot's order is not implied by it");
  const st = (await (await app.request("/api/status")).json()) as any;
  assert.deepEqual([...st.public_demo_orders].sort(), [VALID, TAMPERED].sort());
  hosted(false);
  fixtures(null);
});

test("with nothing published, hosted mode is exactly as it was", async () => {
  hosted(true);
  fixtures(null);
  for (const o of [VALID, TAMPERED, OTHER]) assert.equal((await app.request(reveal(o))).status, 401, o);
  assert.equal((await app.request("/api/runs/baseline")).status, 401);
  const st = (await (await app.request("/api/status")).json()) as any;
  assert.deepEqual(st.public_demo_orders, []);
  // The operator token still opens everything it always did.
  process.env.OPERATOR_TOKEN = "op-token-for-this-test";
  const opened = await app.request(reveal(OTHER), auth("op-token-for-this-test"));
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("x-access-via"), "operator");
  assert.equal(opened.headers.get("x-tb-demo-fixture"), null, "an operator read is not a published fixture");
  delete process.env.OPERATOR_TOKEN;
  hosted(false);
  // And in local demonstration mode nothing about any of this applies.
  assert.equal((await app.request(reveal(OTHER))).status, 200);
});

test("cleanup", () => {
  hosted(false);
  fixtures(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
