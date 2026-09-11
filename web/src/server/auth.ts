// Delivery authentication: single-use, expiring challenge bound to order id, buyer address, chain id
// and application domain, signed by the buyer as an EIP-191 personal message. The server recovers
// the signer, checks ON CHAIN that the order's buyer is the signer and the order is Funded or
// Delivered, consumes the nonce, and only then returns the private package. An address or a
// transaction hash alone never unlocks anything.
import { recoverMessageAddress, type Hex } from "viem";
import { appDomain, chainId } from "./config.js";
import { getListingExpecting } from "./chain.js";
import { getDb, nowIso, type OrderRow } from "./db.js";
import { randomSaltHex } from "./canonical.js";

export const CHALLENGE_TTL_S = 300;

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function challengeMessage(p: { domain: string; chainId: number; orderId: string; buyer: string; nonce: string; expiresAt: number }): string {
  return [
    "Tail Bazaar retrieval challenge",
    `domain: ${p.domain}`,
    `chain_id: ${p.chainId}`,
    `order_id: ${p.orderId}`,
    `buyer: ${p.buyer.toLowerCase()}`,
    `nonce: ${p.nonce}`,
    `expires_at: ${p.expiresAt}`,
    "Signing this message only authorizes retrieval of the package for this order. It moves no funds.",
  ].join("\n");
}

export function createChallenge(orderId: string, buyer: string): { nonce: string; message: string; expires_at: number; chain_id: number; domain: string } {
  const db = getDb();
  const order = db.prepare("SELECT order_id, buyer FROM orders WHERE order_id = ?").get(orderId) as { order_id: string; buyer: string } | undefined;
  if (!order) throw new AuthError(404, "unknown order");
  if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) throw new AuthError(400, "buyer must be an address");
  const nonce = randomSaltHex();
  const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_S;
  const message = challengeMessage({ domain: appDomain, chainId, orderId, buyer, nonce, expiresAt });
  db.prepare("INSERT INTO challenges(nonce, order_id, buyer, chain_id, domain, message, expires_at) VALUES (?,?,?,?,?,?,?)").run(
    nonce, orderId, buyer.toLowerCase(), chainId, appDomain, message, expiresAt,
  );
  return { nonce, message, expires_at: expiresAt, chain_id: chainId, domain: appDomain };
}

export type Redeemed = { bytes: Uint8Array; signer: Hex; on_chain_status: number; delivery_hash: string | null };

export async function redeemChallenge(orderId: string, nonce: string, signature: string, now = Math.floor(Date.now() / 1000)): Promise<Redeemed> {
  const db = getDb();
  const ch = db.prepare("SELECT * FROM challenges WHERE nonce = ?").get(nonce) as
    | { nonce: string; order_id: string; buyer: string; chain_id: number; domain: string; message: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!ch) throw new AuthError(401, "unknown challenge nonce");
  if (ch.order_id !== orderId) throw new AuthError(401, "challenge is bound to a different order");
  if (ch.used_at !== null) throw new AuthError(401, "challenge already used");
  if (ch.expires_at < now) throw new AuthError(401, "challenge expired");
  if (ch.chain_id !== chainId || ch.domain !== appDomain) throw new AuthError(401, "challenge bound to another chain or domain");
  let signer: Hex;
  try {
    signer = await recoverMessageAddress({ message: ch.message, signature: signature as Hex });
  } catch {
    throw new AuthError(401, "signature does not recover to an address");
  }
  if (signer.toLowerCase() !== ch.buyer) throw new AuthError(403, `signer ${signer} is not the challenged buyer`);
  // On-chain ownership check: the escrow's bound buyer must be the signer and the order must be funded.
  const onChain = await getListingExpecting(orderId as Hex, (l) => l.status === 2 || l.status === 3 || l.status === 4, 4, 2000);
  if (onChain.buyer.toLowerCase() !== signer.toLowerCase()) throw new AuthError(403, "signer is not the buyer bound to this order on chain");
  // Funded (2), Delivered (3) or SettledValid (4): a buyer who paid for a valid package may re-download it.
  if (onChain.status !== 2 && onChain.status !== 3 && onChain.status !== 4) throw new AuthError(403, `order is not funded, delivered or validly settled on chain (status ${onChain.status})`);
  const order = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) as unknown as OrderRow | undefined;
  if (!order) throw new AuthError(404, "unknown order");
  if (!order.delivered_bytes) throw new AuthError(409, "the seller has not made the package available yet");
  db.prepare("UPDATE challenges SET used_at = ? WHERE nonce = ?").run(now, nonce);
  db.prepare("UPDATE orders SET retrieved_at = COALESCE(retrieved_at, ?) WHERE order_id = ?").run(nowIso(), orderId);
  return { bytes: new Uint8Array(order.delivered_bytes), signer, on_chain_status: onChain.status, delivery_hash: order.delivery_hash };
}
