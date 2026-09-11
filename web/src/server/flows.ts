// LIVE FLOWS: one purchase or one listing at a time, started from the web page and watched step by
// step while it happens. The steps are the very same agent functions the demonstration pipeline
// runs, in the same order (pipeline.ts); only the bookkeeping around them is new. The running flow
// lives in memory and every change is persisted to the `flows` table, so a page reload — or a
// later reader — can still see what happened.
//
// WHAT A FLOW RECORD CARRIES: step names, statuses, transaction hashes, block numbers and one-line
// details written here by hand. Never package bytes, scenario parameters, salts, or the verifier's
// log beyond its verdict word. The record is public in both modes for that reason.
import { buyerBudgetWei, roleAddresses } from "./config.js";
import { getDb, nowIso, type ListingRow, type OrderRow } from "./db.js";
import { TARGETS, type TargetId, type TargetSpec } from "./targets.js";
import { buyerFund, buyerRetrieveAndCheck } from "./agents/buyer.js";
import { sellerDeliver, sellerDiscover } from "./agents/seller.js";
import { verifierCheckDeliveryAndSettle, VERDICT } from "./agents/verifier.js";
import { ensureBaseline, pipelineStatus, submitFinding, withdrawAfterSettlement } from "./pipeline.js";

export type FlowKind = "buy" | "list";
export type StepStatus = "pending" | "running" | "done" | "failed";
export type FlowStatus = "running" | "done" | "failed";
export type FlowStep = { name: string; status: StepStatus; tx_hash: string | null; block_number: number | null; detail: string | null; at: string | null };
export type Flow = {
  flow_id: string; kind: FlowKind; target_id: string; listing_id: string | null; status: FlowStatus;
  started_at: string; finished_at: string | null; error: string | null; steps: FlowStep[];
};

export const BUY_STEPS = ["fund", "deliver", "retrieve", "verify-and-settle", "withdraw"] as const;
export const LIST_STEPS = ["baseline", "hunt", "verify", "register"] as const;

// ------------------------------------------------------------------ injectable step functions
// Every agent call goes through `deps`, so a test can replace the whole sequence with stubs and
// still exercise the registry, the gating and the persisted record (setFlowDepsForTests).
export type FlowDeps = {
  buyerFund: typeof buyerFund; sellerDeliver: typeof sellerDeliver; buyerRetrieveAndCheck: typeof buyerRetrieveAndCheck;
  verifierCheckDeliveryAndSettle: typeof verifierCheckDeliveryAndSettle; withdrawAfterSettlement: typeof withdrawAfterSettlement;
  ensureBaseline: typeof ensureBaseline; sellerDiscover: typeof sellerDiscover; submitFinding: typeof submitFinding;
};
const REAL_DEPS: FlowDeps = { buyerFund, sellerDeliver, buyerRetrieveAndCheck, verifierCheckDeliveryAndSettle, withdrawAfterSettlement, ensureBaseline, sellerDiscover, submitFinding };
let deps: FlowDeps = REAL_DEPS;

/** TESTS ONLY. Replace some or all of the step functions; pass null to restore the real ones. */
export function setFlowDepsForTests(override: Partial<FlowDeps> | null): void {
  deps = override ? { ...REAL_DEPS, ...override } : REAL_DEPS;
}

// ------------------------------------------------------------------ registry
let current: Flow | null = null;

function persist(f: Flow): void {
  getDb().prepare("INSERT OR REPLACE INTO flows(flow_id, kind, target_id, listing_id, status, started_at, finished_at, error, steps) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(f.flow_id, f.kind, f.target_id, f.listing_id, f.status, f.started_at, f.finished_at, f.error, JSON.stringify(f.steps));
}

type FlowRow = { flow_id: string; kind: string; target_id: string; listing_id: string | null; status: string; started_at: string; finished_at: string | null; error: string | null; steps: string };
function fromRow(r: FlowRow): Flow {
  const f: Flow = { flow_id: r.flow_id, kind: r.kind as FlowKind, target_id: r.target_id, listing_id: r.listing_id, status: r.status as FlowStatus, started_at: r.started_at, finished_at: r.finished_at, error: r.error, steps: JSON.parse(r.steps) as FlowStep[] };
  // A persisted row still "running" belongs to a process that is gone: it did not finish.
  if (f.status === "running" && (!current || current.flow_id !== f.flow_id)) {
    f.status = "failed";
    f.error = f.error ?? "the server stopped while this flow was running";
    for (const s of f.steps) if (s.status === "running") s.status = "failed";
  }
  return f;
}

/** A copy safe to hand out: the record holds nothing private by construction (see the header). */
export function publicFlow(f: Flow): Flow {
  return { ...f, steps: f.steps.map((s) => ({ ...s })) };
}

export function flowStatus(flowId: string): Flow | null {
  if (current && current.flow_id === flowId) return publicFlow(current);
  const row = getDb().prepare("SELECT * FROM flows WHERE flow_id = ?").get(flowId) as FlowRow | undefined;
  return row ? fromRow(row) : null;
}

/** The running flow, or the most recent one on record. */
export function currentFlow(): Flow | null {
  if (current) return publicFlow(current);
  const row = getDb().prepare("SELECT * FROM flows ORDER BY started_at DESC LIMIT 1").get() as FlowRow | undefined;
  return row ? fromRow(row) : null;
}

/** Why a new flow cannot start right now, or null. One flow at a time per process, and never
 *  alongside the demonstration pipeline, which drives the same three wallets. */
export function flowBusyReason(): string | null {
  if (current && current.status === "running") return `a ${current.kind === "buy" ? "purchase" : "listing"} is already running (${current.flow_id}); wait for it to finish`;
  const p = pipelineStatus();
  if (p && p.status === "running") return "the demonstration pipeline is running; wait for it to finish";
  return null;
}

function begin(kind: FlowKind, target_id: string, listing_id: string | null, names: readonly string[]): Flow {
  const busy = flowBusyReason();
  if (busy) throw new Error(busy);
  const f: Flow = {
    flow_id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, kind, target_id, listing_id, status: "running",
    started_at: nowIso(), finished_at: null, error: null,
    steps: names.map((name) => ({ name, status: "pending", tx_hash: null, block_number: null, detail: null, at: null })),
  };
  current = f;
  persist(f);
  return f;
}

const plain = (e: unknown): string => String((e as { message?: unknown })?.message ?? e);
const stepOf = (f: Flow, name: string): FlowStep => f.steps.find((s) => s.name === name)!;
/** The block a broadcast landed in, from the transaction ledger chain.ts keeps. */
const blockOf = (hash: string | null | undefined): number | null => {
  if (!hash) return null;
  const r = getDb().prepare("SELECT block_number FROM pending_txs WHERE hash = ?").get(hash) as { block_number: number | null } | undefined;
  return r?.block_number ?? null;
};

type Mark = (patch: Partial<Pick<FlowStep, "tx_hash" | "block_number" | "detail">>) => void;
function markStep(f: Flow, name: string, status: StepStatus, patch: Partial<Pick<FlowStep, "tx_hash" | "block_number" | "detail">> = {}): void {
  const s = stepOf(f, name);
  Object.assign(s, patch);
  if (patch.tx_hash && s.block_number === null) s.block_number = blockOf(patch.tx_hash);
  s.status = status;
  s.at = nowIso();
  persist(f);
}

async function step<T>(f: Flow, name: string, fn: (mark: Mark) => Promise<T>): Promise<T> {
  markStep(f, name, "running");
  try {
    const out = await fn((patch) => markStep(f, name, "running", patch));
    markStep(f, name, "done");
    return out;
  } catch (e) {
    markStep(f, name, "failed", { detail: plain(e) });
    throw e;
  }
}

function finish(f: Flow, error: unknown = null): void {
  f.status = error === null ? "done" : "failed";
  f.error = error === null ? null : plain(error);
  f.finished_at = nowIso();
  for (const s of f.steps) if (s.status === "running") s.status = "failed";
  persist(f);
  console.log(`[flow] ${f.flow_id} ${f.status}${f.error ? ": " + f.error : ""}`);
}

const logFor = (f: Flow) => (m: string): void => { console.log(`[flow ${f.flow_id}] ${m}`); };

// ------------------------------------------------------------------ the purchase flow
// fund -> deliver -> retrieve -> verify-and-settle -> withdraw: the pipeline's per-order sequence.
async function runPurchase(f: Flow, listing: ListingRow, baseUrl: string): Promise<void> {
  const L = logFor(f);
  const db = getDb();
  const fresh = (): OrderRow => db.prepare("SELECT * FROM orders WHERE order_id = ?").get(listing.listing_id) as unknown as OrderRow;
  try {
    if (BigInt(listing.price_wei) > buyerBudgetWei) throw new Error(`this listing costs ${listing.price_wei} wei and the buyer's per-purchase cap is ${buyerBudgetWei} wei`);
    // buyerFund re-reads the listing from the chain and refuses unless the stored terms are the
    // registered ones (checkTermsBinding), immediately before the money moves.
    const order = await step(f, "fund", async (mark) => {
      const o = await deps.buyerFund(listing, L);
      mark({ tx_hash: o.fund_tx, detail: `${o.price_wei} wei paid into escrow` });
      return o;
    });
    await step(f, "deliver", async (mark) => {
      const d = await deps.sellerDeliver(order, L);
      mark({ tx_hash: d.tx, detail: d.tampered ? "delivered — this listing's delivery is deliberately tampered (demo)" : "sealed package delivered" });
    });
    await step(f, "retrieve", async (mark) => {
      const r = await deps.buyerRetrieveAndCheck(fresh(), baseUrl, L);
      const o = fresh();
      mark({ tx_hash: o.recheck_tx, detail: r.check.ok ? "retrieved; the bytes hash to the seal and match the advertised terms" : "retrieved; the buyer's own check failed, so it asked for a recheck on chain" });
    });
    const settled = await step(f, "verify-and-settle", async (mark) => {
      const s = await deps.verifierCheckDeliveryAndSettle(fresh(), L);
      mark({ tx_hash: s.tx, detail: s.check.valid ? "VALID" : "INVALID" });
      return s;
    });
    await step(f, "withdraw", async (mark) => {
      const w = await deps.withdrawAfterSettlement(fresh(), settled.check.valid, L);
      mark({ tx_hash: w.hash, block_number: w.block_number, detail: settled.check.valid ? "Settled: seller paid" : "Settled: buyer refunded" });
    });
    finish(f);
  } catch (e) {
    finish(f, e);
  }
}

/** Start buying a listing. Returns at once with the flow record; `done` resolves when it finishes
 *  (it never rejects: a failure is recorded on the flow). The order id equals the listing id. */
export function purchaseFlow(listingId: string, baseUrl: string): { flow: Flow; done: Promise<Flow> } {
  const listing = getDb().prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId) as unknown as ListingRow | undefined;
  if (!listing) throw new Error(`unknown listing ${listingId}`);
  if (listing.status !== "LISTED") throw new Error(`listing ${listingId.slice(0, 12)}... is ${listing.status}, not LISTED`);
  const flow = begin("buy", listing.target_id ?? "cart", listing.listing_id, BUY_STEPS);
  const done = runPurchase(flow, listing, baseUrl).then(() => publicFlow(flow));
  return { flow: publicFlow(flow), done };
}

// ------------------------------------------------------------------ the listing flow
// baseline -> hunt (ONE finding) -> verify -> register: the pipeline's per-target sequence, never
// tampered. The verify and register steps are one agent call (verifyAndList); the verifier's own
// "VERIFIED ... registering" log line is where the first ends and the second begins.
async function runListing(f: Flow, target: TargetSpec): Promise<void> {
  const L = logFor(f);
  try {
    await step(f, "baseline", async (mark) => {
      await deps.ensureBaseline(target);
      mark({ detail: "the nominal run this robot survives is on record" });
    });
    const disc = await step(f, "hunt", async (mark) => {
      const d = await deps.sellerDiscover(target, L, 1);
      if (d.findings.length === 0) throw new Error("the hunter found no failure inside the envelope that is not already listed for this robot");
      mark({ detail: `${d.hunter.search_cost.simulations} simulations over the published envelope; one new ${d.findings[0].run.outcome.toLowerCase()} finding, re-run with full recording` });
      return d;
    });
    markStep(f, "verify", "running");
    const hook = (m: string): void => {
      L(m);
      if (m.startsWith("verifier: VERIFIED")) { markStep(f, "verify", "done", { detail: "VALID" }); markStep(f, "register", "running"); }
    };
    let res: Awaited<ReturnType<typeof submitFinding>>;
    try {
      res = await deps.submitFinding(target, disc.findings[0], disc.hunter, roleAddresses().seller, { tamper: false }, hook);
    } catch (e) {
      const failing = stepOf(f, "register").status === "running" ? "register" : "verify";
      markStep(f, failing, "failed", { detail: plain(e) });
      throw e;
    }
    if (!res.listingId) {
      const verdict = VERDICT[res.result.status] ?? res.result.status;
      markStep(f, "verify", "failed", { detail: verdict });
      throw new Error(`the verifier's verdict was ${verdict}, so nothing was listed`);
    }
    if (stepOf(f, "verify").status !== "done") markStep(f, "verify", "done", { detail: "VALID" });
    f.listing_id = res.listingId;
    markStep(f, "register", "done", { tx_hash: res.registerTx?.hash ?? null, block_number: res.registerTx?.block_number ?? null, detail: "listed on chain, sealed" });
    finish(f);
  } catch (e) {
    finish(f, e);
  }
}

/** Start listing one new verified finding for a robot. Returns at once; `done` resolves when the
 *  flow finishes and, on success, the flow carries the new listing id. */
export function listingFlow(targetId: TargetId, _baseUrl: string): { flow: Flow; done: Promise<Flow> } {
  const target = TARGETS[targetId];
  if (!target) throw new Error(`unknown target ${targetId}`);
  const flow = begin("list", targetId, null, LIST_STEPS);
  const done = runListing(flow, target).then(() => publicFlow(flow));
  return { flow: publicFlow(flow), done };
}
