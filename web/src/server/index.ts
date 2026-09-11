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
//
// ONE DELIBERATE EXCEPTION, per order id: DEMO_PUBLIC_ORDERS names orders this host PUBLISHES as
// demonstration fixtures, so a reader who opens the public URL cold can follow purchase -> reveal ->
// replay without holding a key. Their packages are committed to this repository as evidence, so
// nothing secret is opened; the API and the page both carry the DEMONSTRATION FIXTURE badge, and
// every other order still returns 401. See publicDemoOrderIds below and
// __tests__/demo-public-orders.test.ts, which pins both sides of that line.
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
import { appDomain, buyerBudgetWei, buyerConsoleEnabled, chainId, chainLabel, chainMode, demoPublicOrderIds, demoPublicTamperFixtures, demoTriggerEnabled, escrowAddress, explorerBase, hostedMode, operatorToken, port, publicBaseUrl, roleAddresses, WEB_ROOT } from "./config.js";
import { getDb, listEvents, publicListing, publicOrder, type ListingRow, type OrderRow } from "./db.js";
import { DEFAULT_TARGET, envelopesDoc, isTargetId, TARGET_IDS, TARGETS, targetFor } from "./targets.js";
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

/** The badge every public demonstration fixture carries, in the API and on the page. It is the whole
 *  justification for the exception: these packages are committed to the repository as evidence, so
 *  serving them without a token opens nothing that is not already published. */
export const DEMO_FIXTURE_NOTE = "DEMONSTRATION FIXTURE, published in the repository, not a secret";

/** Order ids this host publishes as demonstration fixtures. Explicit ids from DEMO_PUBLIC_ORDERS,
 *  plus — only when DEMO_PUBLIC_TAMPER_FIXTURES=1 — the deliberately tampered order of each target
 *  and the paired valid order of that same target, which together are the two halves of the
 *  settlement story. Everything not in this set keeps the hosted-mode 401. */
export function publicDemoOrderIds(): Set<string> {
  const out = new Set(demoPublicOrderIds().map((s) => s.toLowerCase()));
  if (demoPublicTamperFixtures()) {
    try {
      const rows = getDb().prepare("SELECT o.order_id, o.status, l.target_id, l.demo_tamper FROM orders o JOIN listings l ON l.listing_id = o.listing_id ORDER BY o.created_at ASC")
        .all() as { order_id: string; status: string; target_id: string | null; demo_tamper: number }[];
      for (const tampered of rows.filter((r) => r.demo_tamper === 1)) {
        out.add(tampered.order_id.toLowerCase());
        const paired = rows.find((r) => r.demo_tamper !== 1 && r.status === "SETTLED_VALID" && (r.target_id ?? "cart") === (tampered.target_id ?? "cart"));
        if (paired) out.add(paired.order_id.toLowerCase());
      }
    } catch { /* no database yet: only the explicit ids are published */ }
  }
  return out;
}

export function isPublicDemoOrder(orderId: string | null | undefined): boolean {
  return typeof orderId === "string" && publicDemoOrderIds().has(orderId.toLowerCase());
}

/** Gate for every route that can return private package bytes, scenario parameters, trajectories or
 *  salts. `orderId` null means "any live buyer session is enough" (the shared public baseline run);
 *  otherwise the session must be bound to that order. Operator-only routes pass operatorOnly. */
export function privateAccess(c: Context, orderId: string | null, operatorOnly = false): Access {
  if (!hostedMode()) return { ok: true, via: "local-demonstration-mode" };
  // PUBLIC DEMONSTRATION FIXTURE: this exact order is on this host's published list, so its evidence
  // is served to anyone. It is the only hole in the gate, it is per order id, and it is never opened
  // for an operator-only route.
  if (!operatorOnly && isPublicDemoOrder(orderId)) return { ok: true, via: "public-demo-fixture" };
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
      targets: TARGET_IDS.map((id) => ({ id, label: TARGETS[id].label, short_label: TARGETS[id].short_label, machine: TARGETS[id].machine, one_liner: TARGETS[id].one_liner, envelope_id: TARGETS[id].envelope_id, subject_label: TARGETS[id].subject_label, failure_classes: TARGETS[id].failure_classes.map((c) => ({ id: c.id, label: c.label })), replay_renderer: TARGETS[id].replay_renderer })),
      hosted_mode: hosted, private_routes_require_auth: hosted, operator_token_configured: hosted && operatorToken() !== "",
      // Which orders, if any, this host deliberately publishes. Ids only: they are already public.
      public_demo_orders: [...publicDemoOrderIds()], public_demo_fixture_note: DEMO_FIXTURE_NOTE,
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
    // PUBLIC DEMONSTRATION FIXTURE: this order's evidence is served without a token on this host, and
    // the page says so rather than letting a reader assume the gate is broken.
    const fixture = isPublicDemoOrder(o.order_id);
    return c.json({ ...publicOrder(o), listing: { ...publicListing(l), seller_settled_orders: sellerSettled }, on_chain: onChain, events: listEvents(o.listing_id), revealed_in_buyer_console: revealed && buyerConsoleEnabled, reveal_requires_auth: hostedMode() && !fixture, public_demo_fixture: fixture, public_demo_fixture_note: fixture ? DEMO_FIXTURE_NOTE : null, chain_mode: l.chain_mode, explorer_base: l.chain_mode === "testnet" ? "https://sepolia.basescan.org" : null });
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
    const fixture = access.via === "public-demo-fixture" ? { "x-tb-demo-fixture": DEMO_FIXTURE_NOTE } : {};
    return new Response(bytes, { headers: { "content-type": "application/json", "x-package-keccak256": keccakHex(bytes), "x-retrieved-by": r.signer, "x-retrieved-at": r.retrieved_at, "x-access-via": access.via, ...fixture } });
  });

  // The nominal baseline run is public by design (its scenario is the published nominal operating
  // point), but it is still a full recorded trajectory and it is only used by the reveal view, so it
  // is gated with the rest of the private-data routes in hosted mode. When this host publishes
  // demonstration fixtures it is opened too, because it is the surviving run their replay draws
  // behind the failure and a fixture whose ghost 401s is not a demonstration of anything.
  app.get("/api/runs/baseline", async (c) => {
    const access = privateAccess(c, null);
    const viaFixture = !access.ok && publicDemoOrderIds().size > 0;
    if (!access.ok && !viaFixture) return c.json({ error: access.error, hosted_mode: true }, 401);
    const want = c.req.query("target");
    if (want !== undefined && !isTargetId(want)) return c.json({ error: `unknown target ${want}`, known: TARGET_IDS }, 404);
    const { file } = await ensureBaseline(targetFor(want ?? DEFAULT_TARGET));
    const fixture = viaFixture ? { "x-access-via": "public-demo-fixture", "x-tb-demo-fixture": DEMO_FIXTURE_NOTE } : { "x-access-via": access.via };
    return new Response(fs.readFileSync(file), { headers: { "content-type": "application/json", ...fixture } });
  });

  // Published operating envelopes — ONE PER TARGET — and, for each, the range its author published.
  // All of it is public constants, identical for every listing of that target: it says nothing about
  // any individual scenario. `?target=<id>` returns just that target's document.
  app.get("/api/envelope", (c) => {
    const doc = envelopesDoc();
    const want = c.req.query("target");
    if (want === undefined) return c.json(doc);
    const one = doc.targets.find((t) => t.target_id === want);
    return one ? c.json(one) : c.json({ error: `unknown target ${want}`, known: TARGET_IDS }, 404);
  });

  // MARKETPLACE AGGREGATES. Search cost is published here as a market-wide total and per target:
  // how many simulations the hunters ran and how many produced each failure class. It is an
  // aggregate over every hunt on this instance, identical for every listing, so it narrows no hidden
  // scenario — and it carries no scenario parameter, no trajectory and no per-listing figure.
  app.get("/api/market", (c) => {
    const db = getDb();
    const rows = db.prepare("SELECT listing_id, target_id, public_summary, status FROM listings WHERE chain_mode = ?").all(chainMode) as { listing_id: string; target_id: string | null; public_summary: string; status: string }[];
    const priv = db.prepare("SELECT p.submission FROM private_packages p JOIN listings l ON l.listing_id = p.listing_id WHERE l.chain_mode = ?").all(chainMode) as { submission: string }[];
    const hunts = new Map<string, { target_id: string; mode: string; simulations: number; sim_steps: number; wall_time_s: number; by_class: Record<string, number> }>();
    for (const r of priv) {
      try {
        const sub = JSON.parse(r.submission) as { target_id?: string; hunter?: { id: string; mode: string; search_cost: { simulations: number; sim_steps: number; wall_time_s: number }; counts: { by_class?: Record<string, number> } } };
        if (!sub.hunter) continue;
        const key = `${sub.target_id ?? "cart"}:${sub.hunter.id}:${sub.hunter.mode}:${sub.hunter.search_cost.simulations}:${sub.hunter.search_cost.sim_steps}`;
        hunts.set(key, { target_id: sub.target_id ?? "cart", mode: sub.hunter.mode, ...sub.hunter.search_cost, by_class: sub.hunter.counts?.by_class ?? {} });
      } catch { /* unreadable record: left out of the aggregate rather than guessed */ }
    }
    const all = [...hunts.values()];
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const perTarget = TARGET_IDS.map((id) => {
      const mine = all.filter((h) => h.target_id === id);
      const by_class: Record<string, number> = {};
      for (const h of mine) for (const [k, v] of Object.entries(h.by_class)) by_class[k] = (by_class[k] ?? 0) + v;
      return {
        target_id: id, label: TARGETS[id].label, short_label: TARGETS[id].short_label, machine: TARGETS[id].machine, one_liner: TARGETS[id].one_liner,
        envelope_id: TARGETS[id].envelope_id, subject_label: TARGETS[id].subject_label, replay_renderer: TARGETS[id].replay_renderer,
        failure_classes: TARGETS[id].failure_classes,
        listings: rows.filter((r) => (r.target_id ?? "cart") === id).length,
        hunts: mine.length,
        search_cost: { simulations: sum(mine.map((h) => h.simulations)), sim_steps: sum(mine.map((h) => h.sim_steps)), wall_time_s: Number(sum(mine.map((h) => h.wall_time_s)).toFixed(3)) },
        failures_by_class: by_class,
      };
    });
    return c.json({
      schema: "tb-market-1",
      chain_mode: chainMode,
      listings: rows.length,
      targets: perTarget,
      search_cost_total: { hunts: all.length, simulations: sum(all.map((h) => h.simulations)), sim_steps: sum(all.map((h) => h.sim_steps)), wall_time_s: Number(sum(all.map((h) => h.wall_time_s)).toFixed(3)) },
      note: "Aggregate search cost over every hunt recorded on this instance. It is a market-wide total, not a per-listing disclosure: it carries no scenario parameter and narrows no hidden finding.",
    });
  });

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
