// SINGLE-USE RETRIEVAL NONCE, UNDER CONCURRENCY. The retrieval challenge is meant to be redeemable
// exactly once. It used to be read ("is used_at still null?") and written ("set used_at") with several
// awaits in between - a signature recovery and an on-chain lookup - and the write checked neither that
// the row was still unused nor how many rows it had changed. Two requests carrying the same signed
// challenge could therefore both pass the read and both be served the private package, which is
// precisely the replay the nonce exists to prevent.
//
// These tests hold the door shut: the mark-as-used is now the same statement as the test of whether it
// was unused, and exactly one row must change. The suite runs against a throwaway database in a temp
// directory. No chain is involved - the on-chain ownership lookup is injected, which is what lets the
// two redemptions be held inside the critical section at the same time and makes the race
// deterministic rather than a matter of luck. The signing key is generated in memory for this process,
// is never written down and never leaves it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-nonce-"));
process.env.DATABASE_PATH = path.join(tmp, "auth-nonce-race-test.sqlite");
delete process.env.PUBLIC_BASE_URL;

const { AuthError, consumeChallenge, createChallenge, redeemChallenge } = await import("../auth.js");
const { getDb, nowIso } = await import("../db.js");
const { chainMode, chainId } = await import("../config.js");

const account = privateKeyToAccount(generatePrivateKey()); // TEST-ONLY, in memory, never printed
const BUYER = account.address;
const LISTING = "0x" + "31".repeat(32);
const ORDER = LISTING; // an order is keyed by its listing id, as the escrow does
const SECRET = '{"salt_hex":"0xfeed","scenario":{"sensor_delay_ms":200}}';
const PACKAGE = new TextEncoder().encode(SECRET);
/** Delivered (3) on chain, bound to this buyer: what the real lookup would return for a funded order. */
const onChainDelivered = async () => ({ buyer: BUYER, status: 3 });

const db = getDb();
db.prepare("INSERT INTO listings(listing_id, chain_mode, chain_id, escrow_address, seller, price_wei, commitment, terms_hash, public_summary, status, demo_tamper, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(LISTING, chainMode, chainId, "0x" + "00".repeat(20), "0x" + "11".repeat(20), "1", "0x" + "22".repeat(32), "0x" + "33".repeat(32), "{}", "DELIVERED", 0, nowIso());
db.prepare("INSERT INTO orders(order_id, listing_id, buyer, price_wei, status, delivered_bytes, delivery_hash, created_at) VALUES (?,?,?,?,?,?,?,?)")
  .run(ORDER, LISTING, BUYER.toLowerCase(), "1", "DELIVERED", PACKAGE, "0x" + "44".repeat(32), nowIso());

/** Resolves for everyone only once `n` callers have arrived: it parks both redemptions past their
 *  asynchronous checks, so both are inside the window the old code left open. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    if (++arrived >= n) open();
    await gate;
  };
}

async function freshChallenge(): Promise<{ nonce: string; signature: string }> {
  const ch = createChallenge(ORDER, BUYER);
  return { nonce: ch.nonce, signature: await account.signMessage({ message: ch.message }) };
}

const usedAt = (nonce: string) => (getDb().prepare("SELECT used_at FROM challenges WHERE nonce = ?").get(nonce) as { used_at: number | null }).used_at;
const sessionCount = () => Number((getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE order_id = ?").get(ORDER) as { n: number | bigint }).n);

test("two concurrent retrievals of the same challenge: exactly one is served, the other is refused", async () => {
  const { nonce, signature } = await freshChallenge();
  const sessionsBefore = sessionCount();
  const both = barrier(2);
  const lookupOnChain = async () => {
    await both(); // neither call proceeds until both have passed every check before this point
    return onChainDelivered();
  };
  const now = Math.floor(Date.now() / 1000);
  const settled = await Promise.allSettled([
    redeemChallenge(ORDER, nonce, signature, now, { lookupOnChain }),
    redeemChallenge(ORDER, nonce, signature, now, { lookupOnChain }),
  ]);

  const served = settled.filter((r) => r.status === "fulfilled");
  const refused = settled.filter((r) => r.status === "rejected");
  assert.equal(served.length, 1, `exactly one retrieval may be served, got ${served.length}`);
  assert.equal(refused.length, 1);

  const bytes = (served[0] as PromiseFulfilledResult<{ bytes: Uint8Array }>).value.bytes;
  assert.equal(new TextDecoder().decode(bytes), SECRET, "the winner gets the package");
  const err = (refused[0] as PromiseRejectedResult).reason;
  assert.ok(err instanceof AuthError, `the loser is refused with an AuthError, got ${err}`);
  assert.equal(err.status, 401);
  assert.match(err.message, /already used/, "and with the message an already-used nonce has always produced");

  assert.equal(usedAt(nonce), now, "the nonce is consumed exactly once");
  assert.equal(sessionCount(), sessionsBefore + 1, "the loser is issued no session, so it cannot re-read the package either");
});

test("eight concurrent retrievals of one challenge still serve exactly one", async () => {
  const { nonce, signature } = await freshChallenge();
  const N = 8;
  const all = barrier(N);
  const lookupOnChain = async () => {
    await all();
    return onChainDelivered();
  };
  const settled = await Promise.allSettled(Array.from({ length: N }, () => redeemChallenge(ORDER, nonce, signature, Math.floor(Date.now() / 1000), { lookupOnChain })));
  assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of settled.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
    assert.equal((r.reason as InstanceType<typeof AuthError>).status, 401);
    assert.match((r.reason as Error).message, /already used/);
  }
  assert.notEqual(usedAt(nonce), null);
});

test("the sequential case is unchanged: a redeemed nonce is refused with the same clear error", async () => {
  const { nonce, signature } = await freshChallenge();
  const first = await redeemChallenge(ORDER, nonce, signature, Math.floor(Date.now() / 1000), { lookupOnChain: onChainDelivered });
  assert.equal(new TextDecoder().decode(first.bytes), SECRET);
  await assert.rejects(
    () => redeemChallenge(ORDER, nonce, signature, Math.floor(Date.now() / 1000), { lookupOnChain: onChainDelivered }),
    (e: unknown) => e instanceof AuthError && e.status === 401 && /already used/.test(e.message),
  );
});

test("the nonce is consumed before any package byte is produced", async () => {
  const { nonce, signature } = await freshChallenge();
  let consumedBeforeReturn: number | null = null;
  const lookupOnChain = async () => onChainDelivered();
  const r = await redeemChallenge(ORDER, nonce, signature, Math.floor(Date.now() / 1000), { lookupOnChain });
  consumedBeforeReturn = usedAt(nonce);
  assert.notEqual(consumedBeforeReturn, null, "by the time bytes are returned the nonce is already spent");
  assert.ok(r.bytes.length > 0);
});

test("consumeChallenge is the single-statement guard: it succeeds once and refuses after", () => {
  const ch = createChallenge(ORDER, BUYER);
  const now = Math.floor(Date.now() / 1000);
  consumeChallenge(ch.nonce, now);
  assert.equal(usedAt(ch.nonce), now);
  assert.throws(() => consumeChallenge(ch.nonce, now + 1), (e: unknown) => e instanceof AuthError && e.status === 401 && /already used/.test(e.message));
  assert.equal(usedAt(ch.nonce), now, "a refused consumption changes nothing");
  assert.throws(() => consumeChallenge("0x" + "ff".repeat(32), now), (e: unknown) => e instanceof AuthError && e.status === 401);
});

test("cleanup", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
