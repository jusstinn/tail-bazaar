// Durable local storage (SQLite via node:sqlite). Private packages live only in private_packages,
// orders.delivered_bytes and retrievals; no public endpoint reads those columns.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { databasePath } from "./config.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      listing_id TEXT PRIMARY KEY,
      chain_mode TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      escrow_address TEXT NOT NULL,
      target_id TEXT,
      seller TEXT NOT NULL,
      price_wei TEXT NOT NULL,
      commitment TEXT NOT NULL,
      terms_hash TEXT NOT NULL,
      public_summary TEXT NOT NULL,
      status TEXT NOT NULL,
      register_tx TEXT,
      demo_tamper INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_packages (
      listing_id TEXT PRIMARY KEY REFERENCES listings(listing_id),
      package_bytes BLOB NOT NULL,
      submission TEXT NOT NULL,
      verification TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(listing_id),
      buyer TEXT NOT NULL,
      price_wei TEXT NOT NULL,
      status TEXT NOT NULL,
      fund_tx TEXT, deliver_tx TEXT, recheck_tx TEXT, settle_tx TEXT, withdraw_tx TEXT, timeout_tx TEXT,
      delivered_bytes BLOB,
      delivery_hash TEXT,
      retrieved_at TEXT,
      delivery_check TEXT,
      buyer_check TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      nonce TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      buyer TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      tx_hash TEXT,
      block_number INTEGER,
      chain_mode TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      buyer TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retrievals (
      order_id TEXT PRIMARY KEY,
      package_bytes BLOB NOT NULL,
      signer TEXT NOT NULL,
      retrieved_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger (
      finding_id TEXT PRIMARY KEY,
      listing_id TEXT,
      target_id TEXT,
      controller_id TEXT NOT NULL,
      controller_hash TEXT NOT NULL,
      envelope_id TEXT NOT NULL,
      scenario TEXT NOT NULL,
      outcome TEXT NOT NULL,
      impact_speed_mps REAL,
      trajectory_hash TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      verification_method TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      log TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_txs (
      hash TEXT PRIMARY KEY,
      function_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      from_address TEXT,
      chain_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      status TEXT NOT NULL,
      block_number INTEGER,
      error TEXT
    );
  `);
  // Additive migration for databases created before the marketplace became multi-target. A listing
  // or ledger row with no target id is a cart row, because the cart was the only target then.
  for (const [table, column] of [["listings", "target_id"], ["ledger", "target_id"]] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  db.exec("UPDATE listings SET target_id = 'cart' WHERE target_id IS NULL");
  db.exec("UPDATE ledger SET target_id = 'cart' WHERE target_id IS NULL");
  return db;
}

export type ListingRow = {
  listing_id: string; chain_mode: string; chain_id: number; escrow_address: string; target_id: string | null; seller: string; price_wei: string;
  commitment: string; terms_hash: string; public_summary: string; status: string; register_tx: string | null;
  demo_tamper: number; created_at: string;
};
export type OrderRow = {
  order_id: string; listing_id: string; buyer: string; price_wei: string; status: string;
  fund_tx: string | null; deliver_tx: string | null; recheck_tx: string | null; settle_tx: string | null;
  withdraw_tx: string | null; timeout_tx: string | null; delivered_bytes: Uint8Array | null; delivery_hash: string | null;
  retrieved_at: string | null; delivery_check: string | null; buyer_check: string | null; created_at: string;
};
export type EventRow = { id: number; listing_id: string; ts: string; actor: string; kind: string; detail: string; tx_hash: string | null; block_number: number | null; chain_mode: string };

export function nowIso(): string {
  return new Date().toISOString();
}

export function addEvent(listingId: string, actor: string, kind: string, detail: unknown, chainMode: string, txHash?: string | null, blockNumber?: number | null): void {
  getDb()
    .prepare("INSERT INTO events(listing_id, ts, actor, kind, detail, tx_hash, block_number, chain_mode) VALUES (?,?,?,?,?,?,?,?)")
    .run(listingId, nowIso(), actor, kind, JSON.stringify(detail ?? {}), txHash ?? null, blockNumber ?? null, chainMode);
}

export function listEvents(listingId: string): EventRow[] {
  return getDb().prepare("SELECT * FROM events WHERE listing_id = ? ORDER BY id ASC").all(listingId) as unknown as EventRow[];
}

// ------------------------------------------------------------------ broadcast transaction ledger
// Every hash chain.ts broadcasts is written here BEFORE the receipt wait, then resolved:
//   pending    broadcast, receipt not seen yet
//   confirmed  receipt status "success"
//   reverted   receipt status "reverted" (the caller was thrown at; no marketplace state was written)
//   timeout    the receipt wait ended without a receipt (viem timeout or transport error); the
//              transaction may still be mined, so reconcilePendingTxs() in chain.ts re-checks it
export type PendingTxStatus = "pending" | "confirmed" | "reverted" | "timeout";
export type PendingTxRow = {
  hash: string; function_name: string; args_json: string; from_address: string | null; chain_mode: string;
  created_at: string; updated_at: string | null; status: PendingTxStatus; block_number: number | null; error: string | null;
};
export const UNRESOLVED_TX_STATUSES: PendingTxStatus[] = ["pending", "timeout"];

export function insertPendingTx(row: { hash: string; function_name: string; args_json: string; from_address: string | null; chain_mode: string }): void {
  getDb().prepare("INSERT OR REPLACE INTO pending_txs(hash, function_name, args_json, from_address, chain_mode, created_at, updated_at, status, block_number, error) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(row.hash, row.function_name, row.args_json, row.from_address, row.chain_mode, nowIso(), null, "pending", null, null);
}

export function updatePendingTx(hash: string, status: PendingTxStatus, blockNumber: number | null, error: string | null): void {
  getDb().prepare("UPDATE pending_txs SET status = ?, block_number = ?, error = ?, updated_at = ? WHERE hash = ?").run(status, blockNumber, error, nowIso(), hash);
}

/** Rows in the given statuses (default: the unresolved ones), oldest first. */
export function listPendingTxs(statuses: PendingTxStatus[] = UNRESOLVED_TX_STATUSES): PendingTxRow[] {
  if (statuses.length === 0) return [];
  return getDb().prepare(`SELECT * FROM pending_txs WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at ASC`).all(...statuses) as unknown as PendingTxRow[];
}

/** Public projection of a listing: never includes private package data. */
export function publicListing(row: ListingRow) {
  return {
    listing_id: row.listing_id,
    chain_mode: row.chain_mode,
    chain_id: row.chain_id,
    escrow_address: row.escrow_address,
    target_id: row.target_id ?? "cart",
    seller: row.seller,
    price_wei: row.price_wei,
    commitment: row.commitment,
    terms_hash: row.terms_hash,
    public_summary: JSON.parse(row.public_summary),
    status: row.status,
    register_tx: row.register_tx,
    created_at: row.created_at,
    demo_note: row.demo_tamper ? "LOCAL DEMONSTRATION: the seller agent is configured to deliver a tampered package for this listing" : null,
  };
}

/** Public projection of an order: transaction hashes and statuses, never delivered bytes. */
export function publicOrder(row: OrderRow) {
  return {
    order_id: row.order_id,
    listing_id: row.listing_id,
    buyer: row.buyer,
    price_wei: row.price_wei,
    status: row.status,
    fund_tx: row.fund_tx,
    deliver_tx: row.deliver_tx,
    recheck_tx: row.recheck_tx,
    settle_tx: row.settle_tx,
    withdraw_tx: row.withdraw_tx,
    timeout_tx: row.timeout_tx,
    delivery_hash: row.delivery_hash,
    retrieved_at: row.retrieved_at,
    delivery_check: row.delivery_check ? JSON.parse(row.delivery_check) : null,
    buyer_check: row.buyer_check ? JSON.parse(row.buyer_check) : null,
    created_at: row.created_at,
  };
}
