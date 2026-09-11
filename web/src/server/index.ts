// Tail Bazaar server: public marketplace API, authenticated delivery route, local-demonstration
// agent trigger, and the static replay UI. Private packages are only ever returned by /api/retrieve
// (signed challenge) and, for the local buyer console, /api/orders/:id/reveal (purchased orders only).
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hex } from "viem";
import { AuthError, createChallenge, redeemChallenge } from "./auth.js";
import { keccakHex } from "./canonical.js";
import { publicClient, getListing, settledOrders, STATUS_NAMES, balanceOf } from "./chain.js";
import { appDomain, buyerBudgetWei, buyerConsoleEnabled, chainId, chainLabel, chainMode, demoTriggerEnabled, escrowAddress, explorerBase, port, publicBaseUrl, roleAddresses, WEB_ROOT } from "./config.js";
import { getDb, listEvents, publicListing, publicOrder, type ListingRow, type OrderRow } from "./db.js";
import { ensureBaseline, pipelineStatus, PUBLIC_OUT, runDemoPipeline } from "./pipeline.js";

export function buildApp() {
  const app = new Hono();

  app.get("/api/status", async (c) => {
    let block: number | null = null;
    try { block = Number(await publicClient.getBlockNumber()); } catch { block = null; }
    const addrs = roleAddresses();
    return c.json({
      app: "tail-bazaar", mode: "LOCAL DEMONSTRATION MODE (all three role keys are server-side test keys)",
      chain_mode: chainMode, chain_id: chainId, chain_label: chainLabel, explorer_base: explorerBase, escrow_address: escrowAddress || null,
      latest_block: block, roles: addrs, app_domain: appDomain, buyer_budget_wei: buyerBudgetWei.toString(),
      demo_trigger_enabled: demoTriggerEnabled, buyer_console_enabled: buyerConsoleEnabled, public_base_url: publicBaseUrl,
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
    return c.json({ ...publicOrder(o), listing: { ...publicListing(l), seller_settled_orders: sellerSettled }, on_chain: onChain, events: listEvents(o.listing_id), revealed_in_buyer_console: revealed && buyerConsoleEnabled, chain_mode: l.chain_mode, explorer_base: l.chain_mode === "testnet" ? "https://sepolia.basescan.org" : null });
  });

  // Buyer console (LOCAL DEMONSTRATION MODE): the browser acts as the buyer's own console, so it may
  // view packages this buyer already retrieved through the authenticated route. A multi-user deployment
  // would require the same signed challenge from the browser wallet instead.
  app.get("/api/orders/:id/reveal", (c) => {
    if (!buyerConsoleEnabled) return c.json({ error: "buyer console disabled" }, 403);
    const r = getDb().prepare("SELECT package_bytes, signer, retrieved_at FROM retrievals WHERE order_id = ?").get(c.req.param("id")) as { package_bytes: Uint8Array; signer: string; retrieved_at: string } | undefined;
    if (!r) return c.json({ error: "this order has not been retrieved by the local buyer agent" }, 404);
    const bytes = new Uint8Array(r.package_bytes);
    return new Response(bytes, { headers: { "content-type": "application/json", "x-package-keccak256": keccakHex(bytes), "x-retrieved-by": r.signer, "x-retrieved-at": r.retrieved_at } });
  });

  app.get("/api/runs/baseline", async (c) => {
    const { file } = await ensureBaseline();
    return new Response(fs.readFileSync(file), { headers: { "content-type": "application/json" } });
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
      return new Response(r.bytes, { headers: { "content-type": "application/json", "x-package-keccak256": keccakHex(r.bytes), "x-signer": r.signer } });
    } catch (e: any) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status as any);
      return c.json({ error: String(e?.message ?? e) }, 500);
    }
  });

  app.get("/api/demo/status", (c) => c.json({ enabled: demoTriggerEnabled, run: pipelineStatus() }));
  app.post("/api/demo/run", async (c) => {
    if (!demoTriggerEnabled) return c.json({ error: "demo trigger disabled on this host" }, 403);
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
