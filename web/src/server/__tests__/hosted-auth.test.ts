// HOSTED-MODE ACCESS CONTROL (P1). When PUBLIC_BASE_URL is set the app is reachable at a public URL,
// and every route that can return private package bytes, private scenario parameters, private
// trajectories or salts must require authentication. This suite runs against a throwaway database in
// a temp directory (no chain, no simulator) and toggles PUBLIC_BASE_URL around each case.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-hosted-"));
process.env.DATABASE_PATH = path.join(tmp, "hosted-auth-test.sqlite");
delete process.env.PUBLIC_BASE_URL;
delete process.env.OPERATOR_TOKEN;

const { buildApp } = await import("../index.js");
const { getDb, nowIso } = await import("../db.js");
const { issueSession } = await import("../auth.js");
const { REPO_ROOT } = await import("../config.js");

const app = buildApp();
const ORDER = "0x" + "11".repeat(32);
const OTHER_ORDER = "0x" + "22".repeat(32);
const BUYER = "0x1B27C90FcD738E960D3D505682EC2732A08c7f99";
const SECRET = '{"salt_hex":"0xdeadbeef","scenario":{"sensor_delay_ms":200,"floor_friction":0.3}}';
const PACKAGE_BYTES = new TextEncoder().encode(SECRET);

// A retrieved order (the buyer console's precondition) and a public baseline run for the reveal view.
getDb().prepare("INSERT OR REPLACE INTO retrievals(order_id, package_bytes, signer, retrieved_at) VALUES (?,?,?,?)").run(ORDER, PACKAGE_BYTES, BUYER, nowIso());
const baselineDir = path.join(tmp, "sim", "public", "runs");
fs.mkdirSync(baselineDir, { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, "evidence", "milestone", "runs", "baseline.json"), path.join(baselineDir, "baseline.json"));

function hosted(on: boolean): void {
  if (on) process.env.PUBLIC_BASE_URL = "https://tail-bazaar.example";
  else delete process.env.PUBLIC_BASE_URL;
}
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const REVEAL = `/api/orders/${ORDER}/reveal`;

test("local demonstration mode is unchanged: the buyer console reveals a retrieved package", async () => {
  hosted(false);
  const res = await app.request(REVEAL);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), SECRET);
  const st = (await (await app.request("/api/status")).json()) as any;
  assert.equal(st.hosted_mode, false);
  assert.equal(st.private_routes_require_auth, false);
  assert.equal((await app.request("/api/runs/baseline")).status, 200);
});

test("hosted mode: an unauthenticated visitor cannot read a revealed order's private package", async () => {
  hosted(true);
  const res = await app.request(REVEAL);
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.ok(!body.includes("salt_hex") && !body.includes("sensor_delay_ms") && !body.includes("floor_friction"), "the 401 body leaks nothing");
  const st = (await (await app.request("/api/status")).json()) as any;
  assert.equal(st.hosted_mode, true);
  assert.equal(st.private_routes_require_auth, true);
  hosted(false);
});

test("hosted mode: every private-data route refuses an unauthenticated request", async () => {
  hosted(true);
  for (const url of [REVEAL, "/api/runs/baseline"]) {
    assert.equal((await app.request(url)).status, 401, url);
    assert.equal((await app.request(url, auth("not-a-token"))).status, 401, `${url} with a junk token`);
    assert.equal((await app.request(url, { headers: { authorization: "Basic abc" } })).status, 401, `${url} with a non-bearer header`);
  }
  // The pipeline trigger writes transactions with the operator's funds: operator token only.
  assert.equal((await app.request("/api/demo/run", { method: "POST" })).status, 401);
  hosted(false);
});

test("hosted mode: the buyer session issued by the signed-challenge retrieval unlocks the package", async () => {
  const session = issueSession(ORDER, BUYER);
  hosted(true);
  const res = await app.request(REVEAL, auth(session.token));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), SECRET);
  assert.equal(res.headers.get("x-access-via"), "buyer-session");
  // A live session also unlocks the shared public baseline run used by the reveal view.
  assert.equal((await app.request("/api/runs/baseline", auth(session.token))).status, 200);
  hosted(false);
});

test("hosted mode: a session bound to another order does not unlock this one", async () => {
  const other = issueSession(OTHER_ORDER, BUYER);
  hosted(true);
  assert.equal((await app.request(REVEAL, auth(other.token))).status, 401);
  hosted(false);
});

test("hosted mode: an expired buyer session is refused", async () => {
  const stale = issueSession(ORDER, BUYER, Math.floor(Date.now() / 1000) - 7200);
  hosted(true);
  assert.equal((await app.request(REVEAL, auth(stale.token))).status, 401);
  hosted(false);
});

test("hosted mode: the operator token is accepted when one is configured", async () => {
  hosted(true);
  process.env.OPERATOR_TOKEN = "operator-token-for-this-test";
  const res = await app.request(REVEAL, auth("operator-token-for-this-test"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-access-via"), "operator");
  assert.equal((await app.request(REVEAL, auth("operator-token-for-this-tesT"))).status, 401, "token comparison is exact");
  delete process.env.OPERATOR_TOKEN;
  assert.equal((await app.request(REVEAL, auth("operator-token-for-this-test"))).status, 401, "no operator path exists when no token is configured");
  hosted(false);
});

test("cleanup", () => {
  hosted(false);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
  assert.ok(fileURLToPath(import.meta.url).endsWith("hosted-auth.test.js"));
});
