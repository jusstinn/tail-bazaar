// The live panel: one purchase or one listing, watched while it happens. A checklist of the steps
// the agents take, each with its state, its transaction hash (linked to the explorer when the chain
// has one) and the block it landed in, polled from /api/flows/:id every 1.5 s. The copy is the
// page's own plain language; the server's one-line detail is shown under it when there is one.
import { getJSON, type Flow, type FlowStep, type Status } from "./api.js";
import { esc, short } from "./format.js";

const COPY: Record<string, [string, string]> = {
  fund: ["The buyer's wallet is funding the escrow…", "The buyer's wallet funded the escrow."],
  deliver: ["The seller is delivering the sealed package…", "The seller delivered the sealed package."],
  retrieve: ["The buyer is retrieving it with a signed challenge…", "The buyer retrieved it with a signed challenge and checked it."],
  "verify-and-settle": ["The verifier is checking the bytes against the seal…", "The verifier checked the bytes against the seal and settled."],
  withdraw: ["The credited party is withdrawing from the escrow…", "Withdrawn from the escrow."],
  baseline: ["Checking this robot's nominal baseline run…", "This robot's nominal baseline run is on record."],
  hunt: ["The hunter is sweeping the published envelope for a new failure…", "The hunter found a new failure and re-ran it with full recording."],
  verify: ["The verifier is re-running the claim in its own pinned environment…", "The verifier re-ran the claim and accepted it."],
  register: ["The verifier is registering the listing on chain…", "The listing is registered on chain, sealed."],
};

const MARK: Record<FlowStep["status"], string> = { pending: "", running: "…", done: "✓", failed: "✕" };

/** The server's own words for a refused request (its JSON `error`), without the URL and status
 *  code the HttpError message carries. */
export function plainError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  const json = m.indexOf("{");
  if (json >= 0) { try { const d = JSON.parse(m.slice(json)) as { error?: string }; if (d.error) return d.error; } catch { /* not JSON */ } }
  return m;
}

function txLink(hash: string, st: Status): string {
  const t = `<span class="mono" title="${esc(hash)}">${esc(short(hash, 12, 8))}</span>`;
  return st.explorer_base ? `<a class="mono" href="${esc(st.explorer_base)}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(short(hash, 12, 8))}</a>` : t;
}

function elapsed(f: Flow): string {
  const end = f.finished_at ? new Date(f.finished_at).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(f.started_at).getTime()) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function stepLine(s: FlowStep, st: Status): string {
  const [running, done] = COPY[s.name] ?? [s.name, s.name];
  const sentence = s.status === "done" ? done : s.status === "failed" ? `This step failed.` : running;
  const meta: string[] = [];
  if (s.tx_hash) meta.push(`tx ${txLink(s.tx_hash, st)}`);
  if (s.block_number !== null && s.block_number !== undefined) meta.push(`block ${esc(s.block_number)}`);
  if (s.detail) meta.push(esc(s.detail));
  return `<li class="live-step ${esc(s.status)}"><span class="live-mark">${MARK[s.status]}</span><div><p class="live-t">${esc(sentence)}</p>${meta.length ? `<div class="live-meta">${meta.join(" · ")}</div>` : ""}</div></li>`;
}

export function livePanelMarkup(f: Flow, st: Status): string {
  const title = f.kind === "buy" ? "Buying this finding, live" : "Listing a new finding, live";
  const settled = f.steps.find((s) => s.name === "withdraw" && s.status === "done")?.detail;
  const foot = f.status === "failed"
    ? `<p class="live-note bad">Stopped: ${esc(f.error ?? "this flow did not finish")}.</p>`
    : f.status === "done"
      ? `<p class="live-note ok">${esc(settled ?? (f.kind === "list" ? "Listed. The new finding is on the market with its Buy button." : "Done."))}</p>`
      : `<p class="live-note">Every step is a real transaction on ${esc(st.chain_label)}. The page polls this record every 1.5 s.</p>`;
  return `<div class="live ${esc(f.status)}" data-flow="${esc(f.flow_id)}">
    <div class="live-head"><span class="live-pulse"></span><strong>${esc(title)}</strong><span class="live-id mono">${esc(f.flow_id)}</span><span class="live-elapsed mono">${esc(elapsed(f))}</span></div>
    <ol class="live-steps">${f.steps.map((s) => stepLine(s, st)).join("")}</ol>
    ${foot}
  </div>`;
}

let timer: number | null = null;
let tick: number | null = null;
export function stopLive(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (tick) { clearInterval(tick); tick = null; }
}

/** Render the panel into `host` and keep it current until the flow finishes; then call `onDone`. */
export function mountLive(host: HTMLElement, first: Flow, st: Status, onDone: (f: Flow) => void): void {
  stopLive();
  let last = first;
  const paint = (f: Flow): void => { host.innerHTML = livePanelMarkup(f, st); };
  paint(first);
  tick = window.setInterval(() => { const el = host.querySelector(".live-elapsed"); if (el && last.status === "running") el.textContent = elapsed(last); }, 1000);
  const poll = async (): Promise<void> => {
    let f: Flow;
    try { f = await getJSON<Flow>(`/api/flows/${encodeURIComponent(first.flow_id)}`); } catch { return; }
    last = f;
    paint(f);
    if (f.status !== "running") { stopLive(); onDone(f); }
  };
  timer = window.setInterval(poll, 1500);
  if (first.status !== "running") { stopLive(); onDone(first); }
}
