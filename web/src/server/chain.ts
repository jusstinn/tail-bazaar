// viem wrapper around FailureEscrow. Every write waits for the receipt and returns hash/block/status.
// Local anvil transactions and Base Sepolia transactions go through the same code; the chain mode
// is stamped on every stored event so the UI can label them correctly.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, fallback, http, type Hex, type Account, type Chain, defineChain } from "viem";
import { baseSepolia } from "viem/chains";
import { chainId, chainMode, escrowAddress, rpcUrls, REPO_ROOT } from "./config.js";

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

export function walletFor(account: Account) {
  return createWalletClient({ account, chain, transport });
}

export const STATUS_NAMES = ["None", "Listed", "Funded", "Delivered", "SettledValid", "SettledInvalid", "Refunded"] as const;
export type OnChainListing = {
  seller: Hex; buyer: Hex; price: bigint; commitment: Hex; termsHash: Hex; deliveryHash: Hex;
  fundedAt: bigint; deliveryDeadline: bigint; settlementDeadline: bigint; status: number;
};

export type TxResult = { hash: Hex; block_number: number; status: "success" | "reverted"; gas_used: string; chain_mode: string; chain_id: number };

export function requireEscrow(): Hex {
  if (!escrowAddress || escrowAddress.length !== 42) throw new Error(`no escrow address configured for chain mode ${chainMode} (run scripts/local-deploy.sh or scripts/testnet-deploy.sh)`);
  return escrowAddress;
}

export async function getListing(listingId: Hex): Promise<OnChainListing> {
  const r = (await publicClient.readContract({ address: requireEscrow(), abi: escrowAbi as any, functionName: "getListing", args: [listingId] })) as any;
  return {
    seller: r.seller, buyer: r.buyer, price: r.price, commitment: r.commitment, termsHash: r.termsHash, deliveryHash: r.deliveryHash,
    fundedAt: r.fundedAt, deliveryDeadline: r.deliveryDeadline, settlementDeadline: r.settlementDeadline, status: Number(r.status),
  };
}

export async function settledOrders(seller: Hex): Promise<number> {
  const n = (await publicClient.readContract({ address: requireEscrow(), abi: escrowAbi as any, functionName: "settledOrders", args: [seller] })) as bigint;
  return Number(n);
}

export async function withdrawable(account: Hex): Promise<bigint> {
  return (await publicClient.readContract({ address: requireEscrow(), abi: escrowAbi as any, functionName: "balances", args: [account] })) as bigint;
}

export async function verifierOf(): Promise<Hex> {
  return (await publicClient.readContract({ address: requireEscrow(), abi: escrowAbi as any, functionName: "verifier", args: [] })) as Hex;
}

export async function balanceOf(account: Hex): Promise<bigint> {
  return publicClient.getBalance({ address: account });
}

async function write(account: Account, functionName: string, args: unknown[], value?: bigint): Promise<TxResult> {
  const wallet = walletFor(account);
  const { request } = await publicClient.simulateContract({ account, address: requireEscrow(), abi: escrowAbi as any, functionName, args, value } as any);
  const hash = await wallet.writeContract(request as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
  return { hash, block_number: Number(receipt.blockNumber), status: receipt.status, gas_used: receipt.gasUsed.toString(), chain_mode: chainMode, chain_id: chainId };
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
