export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const short = (h: string | null | undefined, head = 10, tail = 6): string => (h ? (h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h) : "—");
export function eth(wei: string | number | null | undefined): string {
  if (wei === null || wei === undefined) return "—";
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ETH`;
}
export const explorerFor = (chainMode: string | null | undefined): string | null => (chainMode === "testnet" ? "https://sepolia.basescan.org" : null);
export function txCell(hash: string | null | undefined, chainMode: string | null | undefined): string {
  if (!hash) return `<span class="muted">—</span>`;
  const ex = explorerFor(chainMode);
  if (ex) return `<a class="mono" href="${esc(ex)}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(short(hash, 12, 8))}</a> <span class="tag tag-testnet">Base Sepolia</span>`;
  return `<span class="mono" title="${esc(hash)}">${esc(short(hash, 12, 8))}</span> <span class="tag tag-local">local anvil</span>`;
}
export function addrCell(addr: string | null | undefined, chainMode: string | null | undefined): string {
  if (!addr) return "—";
  const ex = explorerFor(chainMode);
  if (ex) return `<a class="mono" href="${esc(ex)}/address/${esc(addr)}" target="_blank" rel="noopener">${esc(short(addr, 8, 6))}</a>`;
  return `<span class="mono" title="${esc(addr)}">${esc(short(addr, 8, 6))}</span>`;
}
export const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : "—");
export const num = (x: unknown, d = 3): string => (typeof x === "number" ? x.toFixed(d) : x === null || x === undefined ? "—" : String(x));
