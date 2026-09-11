// Configuration from the repository .env (never committed). All keys here are TEST-ONLY role keys
// used by the server-side agents in LOCAL DEMONSTRATION MODE.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server/config.js -> repo root is three levels up; src/server/config.ts -> also three levels up
export const REPO_ROOT = path.resolve(here, "..", "..", "..");
export const WEB_ROOT = path.join(REPO_ROOT, "web");
export const SIM_ROOT = path.join(REPO_ROOT, "sim");
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true } as any);

export type ChainMode = "local" | "testnet";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing environment variable ${name}`);
  }
  return v;
}

const ZERO_KEY = "0x" + "0".repeat(64);
function key(name: string): Hex {
  const v = env(name, ZERO_KEY);
  if (v === ZERO_KEY) throw new Error(`${name} is not set in .env (generate a TEST-ONLY key with 'cast wallet new')`);
  return v as Hex;
}

export const chainMode: ChainMode = (env("CHAIN_MODE", "local") === "testnet" ? "testnet" : "local");
export const chainId = chainMode === "testnet" ? Number(env("BASE_SEPOLIA_CHAIN_ID", "84532")) : Number(env("LOCAL_CHAIN_ID", "31337"));
export const rpcUrls: string[] =
  chainMode === "testnet"
    ? [env("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"), env("BASE_SEPOLIA_RPC_FALLBACK", "https://base-sepolia-rpc.publicnode.com")]
    : [env("LOCAL_RPC_URL", "http://127.0.0.1:8545")];
export const escrowAddress = (chainMode === "testnet" ? env("ESCROW_ADDRESS_BASE_SEPOLIA", "") : env("ESCROW_ADDRESS_LOCAL", "")) as Hex;
export const explorerBase: string | null = chainMode === "testnet" ? "https://sepolia.basescan.org" : null;
export const chainLabel = chainMode === "testnet" ? "Base Sepolia (public testnet, chain id 84532)" : "local anvil (chain id 31337, not a public network)";

export const port = Number(env("PORT", "3100"));
export const publicBaseUrl = env("PUBLIC_BASE_URL", `http://127.0.0.1:${port}`);

/** HOSTED MODE. Setting PUBLIC_BASE_URL means "this instance is reachable at a public URL", and every
 *  route that can return private package bytes, private scenario parameters, private trajectories or
 *  salts then requires authentication (see requirePrivateAccess in index.ts). Unset (the default in
 *  .env.example) keeps LOCAL DEMONSTRATION MODE exactly as it was: the buyer console reveals packages
 *  the local buyer agent already retrieved to anyone who can reach 127.0.0.1.
 *  Read at call time, not at import time, so a test (or an operator) can toggle it. */
export function hostedMode(): boolean {
  return (process.env.PUBLIC_BASE_URL ?? "").trim() !== "";
}

/** Optional operator bearer token. Empty means "no operator path exists" (hosted mode then only
 *  honours buyer sessions from the signed-challenge retrieval route). Never logged. */
export function operatorToken(): string {
  return (process.env.OPERATOR_TOKEN ?? "").trim();
}

/** PUBLIC DEMONSTRATION FIXTURES. A comma-separated list of order ids whose evidence this host
 *  publishes deliberately, so a reader who opens the public URL cold sees purchase -> reveal ->
 *  replay without holding a key. It is a NARROW, EXPLICIT exception to hosted mode: only these ids,
 *  only their reveal (and the nominal baseline run their replay draws behind them), and every other
 *  order keeps its 401. Their packages are in the repository as evidence, so nothing secret is being
 *  opened — the UI says so on the page. Read at call time so it can be changed without a rebuild. */
export function demoPublicOrderIds(): string[] {
  return (process.env.DEMO_PUBLIC_ORDERS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** Convenience for a host that runs the demonstration pipeline itself and does not want to copy order
 *  ids by hand: publish the deliberately-tampered order and the paired valid one of the same target,
 *  which together are the two halves of the settlement story. */
export function demoPublicTamperFixtures(): boolean {
  return (process.env.DEMO_PUBLIC_TAMPER_FIXTURES ?? "").trim() === "1";
}
export const appDomain = env("APP_DOMAIN", "tail-bazaar.local");
export const buyerBudgetWei = BigInt(env("BUYER_BUDGET_WEI", "2000000000000000"));
export const listingPriceWei = BigInt(env("LISTING_PRICE_WEI", chainMode === "testnet" ? "200000000000000" : "1000000000000000"));
// One database per chain mode so local-anvil and Base Sepolia listings, ledgers and orders never mix.
export const databasePath = path.resolve(WEB_ROOT, env("DATABASE_PATH", "./data/tail-bazaar-{mode}.sqlite").replace("{mode}", chainMode));
export const dataDir = path.dirname(databasePath);
export const demoTriggerEnabled = env("DEMO_TRIGGER_ENABLED", "1") !== "0";
export const buyerConsoleEnabled = env("DEMO_BUYER_CONSOLE", "1") !== "0";
export const uvBin = env("UV_BIN", "uv");

export const roles = {
  verifier: () => privateKeyToAccount(key("VERIFIER_PRIVATE_KEY")),
  seller: () => privateKeyToAccount(key("SELLER_PRIVATE_KEY")),
  buyer: () => privateKeyToAccount(key("BUYER_PRIVATE_KEY")),
};

export function roleAddresses() {
  return { verifier: roles.verifier().address, seller: roles.seller().address, buyer: roles.buyer().address };
}
