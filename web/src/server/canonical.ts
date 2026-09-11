// Canonical JSON "tb-cjson-1" — TypeScript port of sim/tailbazaar_sim/canonical.py (the specification
// lives there). Byte-for-byte equality with the Python implementation is checked by the test suite
// against documents the Python side wrote.
import { keccak256, toBytes } from "viem";

export const FORMAT_ID = "tb-cjson-1";

function expandExponent(s: string): string {
  if (!/[eE]/.test(s)) return s;
  const [mantRaw, expRaw] = s.toLowerCase().split("e");
  const exp = parseInt(expRaw, 10);
  let mant = mantRaw;
  const neg = mant.startsWith("-");
  if (neg) mant = mant.slice(1);
  const [ip, fp = ""] = mant.split(".");
  const digits = ip + fp;
  const point = ip.length + exp;
  let out: string;
  if (point <= 0) out = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = digits.slice(0, point) + "." + digits.slice(point);
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  const [ip2raw, fp2] = out.split(".");
  const ip2 = ip2raw.replace(/^0+/, "") || "0";
  out = ip2 + (fp2 ? "." + fp2 : "");
  return (neg ? "-" : "") + out;
}

export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) throw new Error("NaN/Infinity are not allowed in canonical JSON");
  if (Number.isInteger(x)) return x === 0 ? "0" : BigInt(x).toString(); // -0 -> "0"; large integers without exponent
  return expandExponent(String(x)); // ECMAScript shortest round-trip digits
}

function write(v: unknown, out: string[]): void {
  if (v === null) out.push("null");
  else if (v === true) out.push("true");
  else if (v === false) out.push("false");
  else if (typeof v === "number") out.push(formatNumber(v));
  else if (typeof v === "bigint") out.push(v.toString());
  else if (typeof v === "string") out.push(JSON.stringify(v));
  else if (Array.isArray(v)) {
    out.push("[");
    v.forEach((item, i) => {
      if (i) out.push(",");
      write(item, out);
    });
    out.push("]");
  } else if (typeof v === "object") {
    const keys = Object.keys(v as object);
    for (const k of keys) if (!/^[\x00-\x7f]*$/.test(k)) throw new Error(`object keys must be ASCII strings, got ${k}`);
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // code-point order (ASCII keys)
    out.push("{");
    keys.forEach((k, i) => {
      if (i) out.push(",");
      out.push(JSON.stringify(k), ":");
      write((v as Record<string, unknown>)[k], out);
    });
    out.push("}");
  } else throw new Error(`unsupported type ${typeof v}`);
}

export function dumps(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join("");
}

export function dumpsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(dumps(value));
}

export function keccakHex(bytes: Uint8Array): `0x${string}` {
  return keccak256(bytes);
}

/** keccak256 over the canonical bytes of a document, 0x-prefixed lowercase hex. */
export function commitment(value: unknown): `0x${string}` {
  return keccak256(dumpsBytes(value));
}

export function keccakOfString(s: string): `0x${string}` {
  return keccak256(toBytes(s));
}

/** True if `raw` is exactly the canonical serialization of the document it encodes. */
export function isCanonical(raw: Uint8Array): boolean {
  try {
    const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    const again = dumpsBytes(doc);
    if (again.length !== raw.length) return false;
    for (let i = 0; i < raw.length; i++) if (again[i] !== raw[i]) return false;
    return true;
  } catch {
    return false;
  }
}

export function randomSaltHex(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}
