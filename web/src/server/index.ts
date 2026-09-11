// Tail Bazaar server: public marketplace API, authenticated delivery route, local-demonstration
// agent trigger, and the static replay UI.
//
// PRIVATE-DATA ROUTES. Only three routes can return private package bytes, private scenario
// parameters, private trajectories or salts:
//   POST /api/retrieve          signed single-use challenge, always (both modes)
//   GET  /api/orders/:id/reveal buyer console: package bytes of an already-retrieved order
//   GET  /api/runs/baseline     the public nominal run, but a full trajectory, used by the reveal view
// In HOSTED MODE (PUBLIC_BASE_URL set) the last two require a bearer token: the buyer session issued
// by a successful /api/retrieve, or the operator token. Unset PUBLIC_BASE_URL keeps local
// demonstration mode exactly as before. Every other route serves public projections only
// (publicListing / publicOrder in db.ts, the verifier's public summary), which is asserted by
// __tests__/integration.local.test.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hex } from "viem";
import { AuthError, createChallenge, lookupSession, redeemChallenge } from "./auth.js";
import { keccakHex } from "./canonical.js";
import { publicClient, getListing, settledOrders, STATUS_NAMES, balanceOf } from "./chain.js";
import { appDomain, buyerBudgetWei, buyerConsoleEnabled, chainId, chainLabel, chainMode, demoTriggerEnabled, escrowAddress, explorerBase, hostedMode, operatorToken, port, publicBaseUrl, roleAddresses, WEB_ROOT } from "./config.js";
import { getDb, listEvents, publicListing, publicOrder, type ListingRow, type OrderRow } from "./db.js";
import { ENVELOPE_DOC } from "./envelope.js";
import { provenance } from "./provenance.js";
import { ensureBaseline, pipelineStatus, PUBLIC_OUT, runDemoPipeline } from "./pipeline.js";

function bearerToken(c: Context): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((c.req.header("authorization") ?? "").trim());
  return m ? m[1] : null;
}

function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

export type Access = { ok: boolean; via: string; error?: string };

/** Gate for every route that can return private package bytes, scenario parameters, trajectories or
 *  salts. `orderId` null means "any live buyer session is enough" (the shared public baseline run);
 *  otherwise the session must be bound to that order. Operator-only routes pass operatorOnly. */
export function privateAccess(c: Context, orderId: string | null, operatorOnly = false): Access {
  if (!hostedMode()) return { ok: true, via: "local-demonstration-mode" };
  const token = bearerToken(c);
  const op = operatorToken();
  if (!token) return { ok: false, via: "none", error: "hosted mode: this route returns private data and requires an Authorization: Bearer token (the buyer session returned by POST /api/retrieve, or the operator token)" };
  if (op && tokenEquals(token, op)) return { ok: true, via: "operator" };
  if (operatorOnly) return { ok: false, via: "none", error: "hosted mode: this route requires the operator token" };
  if (lookupSession(token, orderId)) return { ok: true, via: "buyer-session" };
  return { ok: false, via: "none", error: "unknown, expired, or wrongly bound token" };
}

export function buildApp() {
  const app = new Hono();

  app.get("/api/status", async (c) => {
    let block: number | null = null;
    try { block = Number(await publicClient.getBlockNumber()); } catch { block = null; }
    const addrs = roleAddresses();
    const hosted = hostedMode();
    return c.json({
      app: "tail-bazaar",
      mode: hosted
        ? "HOSTED MODE (public URL): private package bytes, scenario parameters, trajectories and salts require a buyer session or the operator token"
        : "LOCAL DEMONSTRATION MODE (all three role keys are server-side test keys)",
      chain_mode: chainMode, chain_id: chainId, chain_label: chainLabel, explorer_base: explorerBase, escrow_address: escrowAddress || null,
      latest_block: block, roles: addrs, app_domain: appDomain, buyer_budget_wei: buyerBudgetWei.toString(),
      demo_trigger_enabled: demoTriggerEnabled, buyer_console_enabled: buyerConsoleEnabled, public_base_url: publicBaseUrl,
      hosted_mode: hosted, private_routes_require_auth: hosted, operator_token_configured: hosted && operatorToken() !== "",
      provenance: provenance(),
    });
  });

  app.get("/api/listings", async (c) => {
    const rows = getDb().prepare("SELECT * FROM listings ORDER BY created_at DESC").all() as unknown as ListingRow[];
    const out = [];
    for (const r of rows) {
      let onChain: any = null;
      let sellerSettled: number | null = null;
      try {
        const l = await getListing(r.listing_id as Hex);
        onChain = { status: STATUS_NAMES[l.status], buyer: l.buyer, price: l.price.toString(), commitment: l.commitment, terms_hash: l.termsHash, delivery_hash: l.deliveryHash, delivery_deadline: Number(l.deliveryDeadline), settlement_deadline: Number(l.settlementDeadline) };
        sellerSettled = await settledOrders(r.seller as Hex);
      } catch { /* chain unreachable: show stored state only */ }
      out.push({ ...publicListing(r), on_chain: onChain, seller_settled_orders: sellerSettled });
    }
    return c.json(out);
  });

  app.get("/api/listings/:id", async (c) => {
    const r = getDb().prepare("SELECT * FROM listings WHERE listing_id = ?").get(c.req.param("id")) as unknown as ListingRow | undefined;
    if (!r) return c.json({ error: "not found" }, 404);
    const l = await getListing(r.listing_id as Hex);
    return c.json({ ...publicListing(r), on_chain: { status: STATUS_NAMES[l.status], buyer: l.buyer, commitment: l.commitment, terms_hash: l.termsHash, delivery_hash: l.deliveryHash }, seller_settled_orders: await settledOrders(r.seller as Hex), events: listEvents(r.listing_id) });
  });

  app.get("/api/orders", (c) => {
    const rows = getDb().prepare("SELECT o.*, l.chain_mode FROM orders o JOIN listings l ON l.listing_id = o.listing_id ORDER BY o.created_at DESC").all() as unknown as (OrderRow & { chain_mode: string })[];
    return c.json(rows.map((r) => ({ ...publicOrder(r), chain_mode: r.chain_mode })));
  });

  app.get("/api/orders/:id", async (c) => {
    const db = getDb();
    const o = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(c.req.param("id")) as unknown as OrderRow | undefined;
    if (!o) return c.json({ error: "not found" }, 404);
    const l = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(o.listing_id) as unknown as ListingRow;
    let onChain: any = null;
    try {
      const oc = await getListing(o.listing_id as Hex);
      onChain = { status: STATUS_NAMES[oc.status], buyer: oc.buyer, commitment: oc.commitment, terms_hash: oc.termsHash, delivery_hash: oc.deliveryHash, delivery_deadline: Number(oc.deliveryDeadline), settlement_deadline: Number(oc.settlementDeadline) };
    } catch { /* unreachable chain */ }
    const revealed = !!db.prepare("SELECT 1 FROM retrievals WHERE order_id = ?").get(o.order_id);
    let sellerSettled: number | null = null;
    try { sellerSettled = await settledOrders(l.seller as Hex); } catch { /* unreachable chain */ }
    return c.json({ ...publicOrder(o), listing: { ...publicListing(l), seller_settled_orders: sellerSettled }, on_chain: onChain, events: listEvents(o.listing_id), revealed_in_buyer_console: revealed && buyerConsoleEnabled, reveal_requires_auth: hostedMode(), chain_mode: l.chain_mode, explorer_base: l.chain_mode === "testnet" ? "https://sepolia.basescan.org" : null });
  });

  // Buyer console. Local demonstration mode: the browser IS the buyer's console, so it may view
  // packages this buyer already retrieved through the authenticated route. HOSTED MODE: the same
  // bytes require the buyer session issued by the signed-challenge retrieval route (or the operator
  // token) — without it a visitor to the public URL cannot read paid evidence.
  app.get("/api/orders/:id/reveal", (c) => {
    if (!buyerConsoleEnabled) return c.json({ error: "buyer console disabled" }, 403);
    const orderId = c.req.param("id");
    const access = privateAccess(c, orderId);
    if (!access.ok) return c.json({ error: access.error, hosted_mode: true, how: "POST /api/challenges then POST /api/retrieve with the buyer's signature returns x-tb-session; send it as Authorization: Bearer <token>" }, 401);
    const r = getDb().prepare("SELECT package_bytes, signer, retrieved_at FROM retrievals WHERE order_id = ?").get(orderId) as { package_bytes: Uint8Array; signer: string; retrieved_at: string } | undefined;
    if (!r) return c.json({ error: "this order has not been retrieved by the local buyer agent" }, 404);
    const bytes = new Uint8Array(r.package_bytes);
    return new Response(bytes, { headers: { "content-type": "application/json", "x-package-keccak256": keccakHex(bytes), "x-retrieved-by": r.signer, "x-retrieved-at": r.retrieved_at, "x-access-via": access.via } });
  });

  // The nominal baseline run is public by design (its scenario is the published nominal operating
  // point), but it is still a full recorded trajectory and it is only used by the reveal view, so it
  // is gated with the rest of the private-data routes in hosted mode.
  app.get("/api/runs/baseline", async (c) => {
    const access = privateAccess(c, null);
    if (!access.ok) return c.json({ error: access.error, hosted_mode: true }, 401);
    const { file } = await ensureBaseline();
    return new Response(fs.readFileSync(file), { headers: { "content-type": "application/json" } });
  });

  // Published operating envelope and the controller's tuned range (both public constants, identical
  // for every listing: they say nothing about any individual scenario).
  app.get("/api/envelope", (c) => c.json(ENVELOPE_DOC));

  app.post("/api/challenges", async (c) => {
    try {
      const body = (await c.req.json()) as { order_id?: string; buyer?: string };
      if (!body.order_id || !body.buyer) return c.json({ error: "order_id and buyer required" }, 400);
      return c.json(createChallenge(body.order_id, body.buyer));
    } catch (e: any) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status as any);
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  app.post("/api/retrieve", async (c) => {
    try {
      const body = (await c.req.json()) as { order_id?: string; nonce?: string; signature?: string };
      if (!body.order_id || !body.nonce || !body.signature) return c.json({ error: "order_id, nonce and signature required" }, 400);
      const r = await redeemChallenge(body.order_id, body.nonce, body.signature);
      return new Response(r.bytes, { headers: { "content-type": "application/json", "x-package-keccak256": keccakHex(r.bytes), "x-signer": r.signer, "x-tb-session": r.session.token, "x-tb-session-expires": String(r.session.expires_at) } });
    } catch (e: any) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status as any);
      return c.json({ error: String(e?.message ?? e) }, 500);
    }
  });

  // The pipeline log is the demo's "show your work" panel. It carries no package bytes, scenario
  // parameters or salts, but it does print a finding's exact impact speed and trajectory hash (and,
  // for a REJECTED submission, the admissibility problem, which names a parameter value). That is
  // finer-grained than the public summary, so in hosted mode the log itself is operator-only; the run
  // id and status stay public so the page still shows whether a run is in progress.
  app.get("/api/demo/status", (c) => {
    const run = pipelineStatus();
    const access = privateAccess(c, null, true);
    if (run && !access.ok) return c.json({ enabled: demoTriggerEnabled, run: { ...run, log: [], error: null }, log_redacted: true });
    return c.json({ enabled: demoTriggerEnabled, run });
  });
  app.post("/api/demo/run", async (c) => {
    if (!demoTriggerEnabled) return c.json({ error: "demo trigger disabled on this host" }, 403);
    // Not a data leak, but in hosted mode it spends the operator's test ETH and writes to the chain.
    const access = privateAccess(c, null, true);
    if (!access.ok) return c.json({ error: access.error, hosted_mode: true }, 401);
    const st = pipelineStatus();
    if (st && st.status === "running") return c.json({ error: "already running", run: st }, 409);
    runDemoPipeline({ baseUrl: `http://127.0.0.1:${port}` }).catch(() => { /* recorded in run status */ });
    await new Promise((r) => setTimeout(r, 200));
    return c.json({ started: true, run: pipelineStatus() });
  });

  app.get("/api/balances", async (c) => {
    const addrs = roleAddresses();
    const out: Record<string, string> = {};
    for (const [k, a] of Object.entries(addrs)) { try { out[k] = (await balanceOf(a as Hex)).toString(); } catch { out[k] = "unreachable"; } }
    return c.json(out);
  });

  const clientDir = path.join(WEB_ROOT, "dist", "client");
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), clientDir) || "." }));
  app.get("*", (c) => c.html(fs.readFileSync(path.join(clientDir, "index.html"), "utf8")));
  return app;
}

export function startServer(listenPort = port) {
  const app = buildApp();
  fs.mkdirSync(PUBLIC_OUT, { recursive: true });
  const server = serve({ fetch: app.fetch, port: listenPort, hostname: "0.0.0.0" }, (info) => {
    console.log(`tail-bazaar server listening on http://0.0.0.0:${info.port} (${chainLabel}; escrow ${escrowAddress || "not configured"})`);
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) startServer();
