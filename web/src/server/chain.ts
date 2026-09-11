// viem wrapper around FailureEscrow. Every write waits for the receipt and returns hash/block/status.
// Local anvil transactions and Base Sepolia transactions go through the same code; the chain mode
// is stamped on every stored event so the UI can label them correctly.
//
// A REVERTED RECEIPT IS AN ERROR. write() throws TxRevertedError when the receipt status is anything
// but "success", so no caller ever records a failed fund/deliver/settle as if it had happened. The
// transaction hash is written to the pending_txs table BEFORE the receipt wait starts, and the row is
// updated when the receipt arrives (confirmed / reverted) or the wait throws (timeout); an operator
// can list the unresolved rows and reconcile them against the chain later (reconcilePendingTxs).
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, fallback, http, type Hex, type Account, type Chain, defineChain } from "viem";
import { baseSepolia } from "viem/chains";
import { chainId, chainMode, escrowAddress, rpcUrls, REPO_ROOT } from "./config.js";
import { insertPendingTx, listPendingTxs, updatePendingTx, type PendingTxRow } from "./db.js";

const abiPath = path.join(REPO_ROOT, "web", "abi", "FailureEscrow.json");
export const escrowAbi = JSON.parse(fs.readFileSync(abiPath, "utf8")) as readonly unknown[];

export const localAnvil: Chain = defineChain({
  id: 31337,
  name: "Local anvil",
  nativeCurrency: { name: "Local test ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrls[0]] } },
});

export const chain: Chain = chainMode === "testnet" ? baseSepolia : localAnvil;
if (chain.id !== chainId) throw new Error(`configured chain id ${chainId} does not match ${chain.name} (${chain.id})`);

const transport = rpcUrls.length > 1 ? fallback(rpcUrls.map((u) => http(u, { timeout: 30_000 }))) : http(rpcUrls[0], { timeout: 30_000 });
export const publicClient = createPublicClient({ chain, transport });

// Writes never use the fallback transport and never auto-retry: a broadcast that times out on one
// backend may already be in its mempool, and re-sending the same signed transaction elsewhere is
// rejected as an underpriced replacement (observed on Base Sepolia: the pipeline aborted mid-run).
// Reads keep the fallback; a failed send surfaces once and the caller decides.
const writeTransport = http(rpcUrls[0], { timeout: 60_000, retryCount: 0 });
export function walletFor(account: Account) {
  return createWalletClient({ account, chain, transport: writeTransport });
}

// ------------------------------------------------------------------ injectable client pair
// Every read and write in this module goes through `clients`, never through the module-level viem
// objects directly, so a test can substitute a stub pair with setChainClientsForTests() instead of
// monkey-patching viem. The shapes are the narrow subset this module actually calls.
export type ReceiptLike = { status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint };
export type ChainPublicClient = {
  readContract: (args: { address: Hex; abi: any; functionName: string; args: unknown[] }) => Promise<unknown>;
  simulateContract: (args: any) => Promise<{ request: unknown }>;
  waitForTransactionReceipt: (args: { hash: Hex; confirmations?: number; timeout?: number }) => Promise<ReceiptLike>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<ReceiptLike>;
  getBalance: (args: { address: Hex }) => Promise<bigint>;
  getBlockNumber: () => Promise<bigint>;
};
export type ChainWallet = { writeContract: (request: any) => Promise<Hex> };
export type ChainClients = { publicClient: ChainPublicClient; walletFor: (account: Account) => ChainWallet };

const REAL_CLIENTS: ChainClients = {
  publicClient: publicClient as unknown as ChainPublicClient,
  walletFor: (account) => walletFor(account) as unknown as ChainWallet,
};
let clients: ChainClients = REAL_CLIENTS;

/** TESTS ONLY. Replace one or both clients with stubs; pass null to restore the real pair. */
export function setChainClientsForTests(override: Partial<ChainClients> | null): void {
  clients = override ? { ...REAL_CLIENTS, ...override } : REAL_CLIENTS;
}

export const STATUS_NAMES = ["None", "Listed", "Funded", "Delivered", "SettledValid", "SettledInvalid", "Refunded"] as const;
export type OnChainListing = {
  seller: Hex; buyer: Hex; price: bigint; commitment: Hex; termsHash: Hex; deliveryHash: Hex;
  fundedAt: bigint; deliveryDeadline: bigint; settlementDeadline: bigint; status: number;
};

export type TxResult = { hash: Hex; block_number: number; status: "success" | "reverted"; gas_used: string; chain_mode: string; chain_id: number };

/** Thrown by write() when the mined receipt is not "success". Carries everything a caller or an
 *  operator needs to find the transaction; no database state is updated before it is thrown. */
export class TxRevertedError extends Error {
  readonly hash: Hex;
  readonly function_name: string;
  readonly block_number: number;
  readonly receipt_status: string;
  constructor(hash: Hex, functionName: string, blockNumber: number, receiptStatus: string) {
    super(`transaction ${functionName} ${hash} was mined with status "${receiptStatus}" in block ${blockNumber}; no state was recorded for it`);
    this.name = "TxRevertedError";
    this.hash = hash;
    this.function_name = functionName;
    this.block_number = blockNumber;
    this.receipt_status = receiptStatus;
  }
}

export function requireEscrow(): Hex {
  if (!escrowAddress || escrowAddress.length !== 42) throw new Error(`no escrow address configured for chain mode ${chainMode} (run scripts/local-deploy.sh or scripts/testnet-deploy.sh)`);
  return escrowAddress;
}

export async function getListing(listingId: Hex): Promise<OnChainListing> {
  const r = (await clients.publicClient.readContract({ address: requireEscrow(), abi: escrowAbi as any, functionName: "getListing", args: [listingId] })) as any;
  return {
    seller: r.seller, buyer: r.buyer, price: r.price, commitment: r.commitment, termsHash: r.termsHash, deliveryHash: r.deliveryHash,
    fundedAt: r.fundedAt, deliveryDeadline: r.deliveryDeadline, settlementDeadline: r.settlementDeadline, status: Number(r.status),
  };
}

export async function settledOrders(seller: Hex): Promise<number> {
  const n = (await clients.publicClient.readContract({ address: requireEscrow(), abi: escrowAbi as any, functionName: "settledOrders", args: [seller] })) as bigint;
  return Number(n);
}

export async function withdrawable(account: Hex): Promise<bigint> {
  return (await clients.publicClient.readContract({ address: requireEscrow(), abi: escrowAbi as any, functionName: "balances", args: [account] })) as bigint;
}

export async function verifierOf(): Promise<Hex> {
  return (await clients.publicClient.readContract({ address: requireEscrow(), abi: escrowAbi as any, functionName: "verifier", args: [] })) as Hex;
}

export async function balanceOf(account: Hex): Promise<bigint> {
  return clients.publicClient.getBalance({ address: account });
}

export async function blockNumber(): Promise<number> {
  return Number(await clients.publicClient.getBlockNumber());
}

/** Reject after `ms` if `p` has not settled. The timer is cleared either way, and a late rejection of
 *  `p` is still handled (race attached to it), so a slow RPC never becomes an unhandled rejection. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Public RPCs are load-balanced and a backend can lag a block behind a receipt we just saw; retry reads. */
export async function retry<T>(fn: () => Promise<T>, tries = 6, delayMs = 2500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs)); }
  }
  throw last;
}

/** Read a listing until `expect` holds (or return the last read after `tries`). */
export async function getListingExpecting(listingId: Hex, expect: (l: OnChainListing) => boolean, tries = 8, delayMs = 2500): Promise<OnChainListing> {
  let l = await getListing(listingId);
  for (let i = 1; i < tries && !expect(l); i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    l = await getListing(listingId);
  }
  return l;
}

const jsonWithBigints = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function write(account: Account, functionName: string, args: unknown[], value?: bigint): Promise<TxResult> {
  const pub = clients.publicClient;
  // Simulation may fail transiently against a lagging backend; retry it. The broadcast itself is never retried.
  const { request } = await retry(() => pub.simulateContract({ account, address: requireEscrow(), abi: escrowAbi as any, functionName, args, value } as any), 6, 3000);
  const hash = await clients.walletFor(account).writeContract(request as any);
  // The hash is on record BEFORE the wait: a crash, a timeout or a dropped connection leaves a row an
  // operator can reconcile, instead of a transaction nobody remembers sending. Recording it must not
  // itself abandon the wait, so a storage error is reported and the wait goes ahead.
  try {
    insertPendingTx({ hash, function_name: functionName, args_json: jsonWithBigints({ args, value: value ?? null }), from_address: account.address, chain_mode: chainMode });
  } catch (e: any) {
    console.error(`chain: could not record pending transaction ${hash} (${functionName}): ${String(e?.message ?? e)}`);
  }
  let receipt: ReceiptLike;
  try {
    receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
  } catch (e: any) {
    // No receipt within the wait (viem timeout or transport error): the transaction may still be
    // mined later, so the row stays unresolved as "timeout" until reconcilePendingTxs() re-checks it.
    updatePendingTx(hash, "timeout", null, String(e?.shortMessage ?? e?.message ?? e));
    throw e;
  }
  const block = Number(receipt.blockNumber);
  if (receipt.status !== "success") {
    updatePendingTx(hash, "reverted", block, null);
    throw new TxRevertedError(hash, functionName, block, String(receipt.status));
  }
  updatePendingTx(hash, "confirmed", block, null);
  return { hash, block_number: block, status: "success", gas_used: receipt.gasUsed.toString(), chain_mode: chainMode, chain_id: chainId };
}

export const escrow = {
  registerListing: (verifier: Account, listingId: Hex, seller: Hex, price: bigint, commitment: Hex, termsHash: Hex) =>
    write(verifier, "registerListing", [listingId, seller, price, commitment, termsHash]),
  fund: (buyer: Account, listingId: Hex, price: bigint) => write(buyer, "fund", [listingId], price),
  markDelivered: (seller: Account, listingId: Hex, deliveryHash: Hex) => write(seller, "markDelivered", [listingId, deliveryHash]),
  settle: (verifier: Account, listingId: Hex, valid: boolean) => write(verifier, "settle", [listingId, valid]),
  claimTimeout: (anyone: Account, listingId: Hex) => write(anyone, "claimTimeout", [listingId]),
  requestRecheck: (buyer: Account, listingId: Hex, reason: string) => write(buyer, "requestRecheck", [listingId, reason]),
  withdraw: (account: Account) => write(account, "withdraw", []),
};

export { listPendingTxs, type PendingTxRow };

/** Re-check every unresolved pending_txs row (status pending or timeout) against the chain. A receipt
 *  resolves the row to confirmed or reverted; no receipt yet (not mined, or dropped) or a transport
 *  error leaves it unresolved with the error on record. Reads only; never re-broadcasts anything. */
export async function reconcilePendingTxs(): Promise<{ checked: number; confirmed: number; reverted: number; unresolved: number }> {
  const rows = listPendingTxs();
  let confirmed = 0, reverted = 0;
  for (const row of rows) {
    try {
      const r = await clients.publicClient.getTransactionReceipt({ hash: row.hash as Hex });
      const status = r.status === "success" ? "confirmed" : "reverted";
      updatePendingTx(row.hash, status, Number(r.blockNumber), null);
      if (status === "confirmed") confirmed++; else reverted++;
    } catch (e: any) {
      updatePendingTx(row.hash, row.status, row.block_number, String(e?.shortMessage ?? e?.message ?? e));
    }
  }
  return { checked: rows.length, confirmed, reverted, unresolved: rows.length - confirmed - reverted };
}

/** Save a full receipt (testnet evidence). */
export async function saveReceipt(dir: string, name: string, hash: Hex): Promise<string> {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  const tx = await publicClient.getTransaction({ hash });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  const doc = {
    chain_mode: chainMode, chain_id: chainId, hash, block_number: Number(receipt.blockNumber), status: receipt.status,
    from: receipt.from, to: receipt.to, gas_used: receipt.gasUsed.toString(), effective_gas_price: receipt.effectiveGasPrice.toString(),
    value: tx.value.toString(), input: tx.input, logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    explorer: chainMode === "testnet" ? `https://sepolia.basescan.org/tx/${hash}` : null,
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return file;
}
