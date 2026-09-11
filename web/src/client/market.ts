// Marketplace page. Leads with one plain-language sentence, then the mechanism, then the findings.
// Everything dense (roles, raw pipeline log, limitations) sits behind a labelled disclosure.
import { getJSON, postJSON, type DemoRun, type EnvelopeDoc, type Listing, type Order, type Status } from "./api.js";
import { addrCell, esc, eth, short, txCell } from "./format.js";
import { armPage, badge, band, counter, disclosure, rangeBars, statusTone } from "./ui.js";

const STEPS: [string, string][] = [
  ["Search", "A hunter agent sweeps the published operating range, simulating the same controller under conditions it was never tuned for, and keeps the mildest conditions that break it."],
  ["Verify and seal", "An independent verifier re-runs the claim in its own pinned environment, recomputes every hash from the delivered bytes, and registers a salted commitment to the evidence on chain. The listing existing is the verifier's statement that it re-ran the scenario itself."],
  ["Buy sealed", "The buyer sees the controller, the verdict, the severity band and the price — never the conditions. It funds an escrow, then retrieves the package by signing a single-use challenge with the key the escrow records as the buyer."],
  ["Settle", "The verifier compares the delivered bytes with the commitment on chain and releases the payment or refunds the buyer. A complaint is an event, not a refund: only the verifier moves the money, and only once."],
];

function findingCard(l: Listing, order: Order | undefined): string {
  const s = l.public_summary;
  const verdict = s.verification.verdict ?? s.verification.status;
  const settled = order?.status === "SETTLED_VALID" ? "The delivered bytes matched the seal. The seller was paid and the buyer keeps the evidence."
    : order?.status === "SETTLED_INVALID" ? "The delivered bytes did not match the seal. The buyer was refunded and the seller was paid nothing."
    : order ? "Purchased; settlement in progress." : "Not yet purchased.";
  return `<a class="finding reveal" href="#/orders/${esc(order?.order_id ?? "")}" ${order ? "" : 'aria-disabled="true"'}>
    <div class="finding-top">
      <span class="chip chip-${esc(s.severity.band)}">${esc(s.severity.band)} severity</span>
      ${badge(verdict, verdict === "VALID" ? "ok" : "bad")}
      ${l.demo_note ? badge("tampered delivery (demo)", "warn") : ""}
    </div>
    <h3>${esc(s.controller.id)}</h3>
    <span class="finding-id mono">listing ${esc(short(l.listing_id, 10, 6))}</span>
    <p class="finding-claim">${esc(s.claim_kind)}</p>
    <p class="finding-note">${esc(settled)}</p>
    <div class="finding-foot">
      <div><span class="k">Price</span><span class="v mono">${esc(eth(l.price_wei))}</span></div>
      <div><span class="k">Seller</span><span class="v">${addrCell(l.seller, l.chain_mode)}</span></div>
      <div><span class="k">Settled orders</span><span class="v mono">${l.seller_settled_orders ?? "—"}</span></div>
      <div><span class="k">On chain</span><span class="v">${l.on_chain ? badge(l.on_chain.status, statusTone(l.on_chain.status)) : badge("unreachable", "bad")}</span></div>
    </div>
    <span class="finding-go">${order ? "Open the finding" : "No order yet"} <i>→</i></span>
  </a>`;
}

export async function renderMarket(view: HTMLElement, st: Status): Promise<void> {
  const [listings, orders, demo, env] = await Promise.all([
    getJSON<Listing[]>("/api/listings"),
    getJSON<Order[]>("/api/orders"),
    getJSON<{ enabled: boolean; run: DemoRun; log_redacted?: boolean }>("/api/demo/status"),
    getJSON<EnvelopeDoc>("/api/envelope"),
  ]);
  const settledTotal = Math.max(0, ...listings.map((l) => l.seller_settled_orders ?? 0));
  const priceEth = listings.length ? Number(BigInt(listings[0].price_wei)) / 1e18 : 0;
  const firstOrder = orders.find((o) => o.status === "SETTLED_VALID") ?? orders[0];

  view.innerHTML = `
    <section class="band hero">
      <div class="wrap">
        <div class="eyebrow reveal">Reproducible failure scenarios for robot controllers</div>
        <h1 class="display reveal">Someone finds the conditions<br>where a robot controller fails.<br>You buy the recipe sealed.</h1>
        <p class="lede reveal">A warehouse cart is supposed to stop short of an obstacle. A hunter agent searches a published range of operating conditions for the ones where it does not. A verifier re-runs each claim itself and seals the evidence with a hash on a public blockchain. The buyer pays into escrow <em>before</em> being allowed to look — and gets refunded automatically if the delivered bytes do not match the seal.</p>
        <div class="cta-row reveal">
          ${firstOrder ? `<a class="btn" href="#/orders/${esc(firstOrder.order_id)}">See a settled finding</a>` : ""}
          <a class="btn ghost" href="#/how-it-works">How settlement works</a>
        </div>
        <div class="stat-strip">
          <div class="metric reveal"><div class="metric-v">${counter(listings.length, "", 0)}</div><div class="metric-k">findings listed</div></div>
          <div class="metric reveal"><div class="metric-v">${counter(settledTotal, "", 0)}</div><div class="metric-k">valid settlements</div><div class="metric-n">on-chain counter for this seller</div></div>
          <div class="metric reveal"><div class="metric-v">${counter(priceEth, "ETH", 3)}</div><div class="metric-k">price per finding</div></div>
          <div class="metric reveal"><div class="metric-v">${counter(st.latest_block ?? 0, "", 0)}</div><div class="metric-k">current block</div><div class="metric-n">${esc(st.chain_label)}</div></div>
        </div>
      </div>
    </section>

    ${band({
      id: "how", eyebrow: "The mechanism", inner: `
      <h2 class="section-title reveal">Four steps, no trust in the seller.</h2>
      <ol class="steps">${STEPS.map(([t, d], i) => `<li class="reveal"><span class="step-n">${i + 1}</span><div><h3>${esc(t)}</h3><p>${esc(d)}</p></div></li>`).join("")}</ol>
      <p class="after reveal"><a class="link-go" href="#/how-it-works">What the verifier checks, and what each verdict does to the money <i>→</i></a></p>`,
    })}

    ${band({
      id: "question", eyebrow: "What this market answers", inner: `
      <blockquote class="pull reveal">${esc(env.product_question)}</blockquote>
      <p class="prose reveal">The controller's author documented the conditions it was tuned for. The hunter searches a deliberately <em>wider</em> range. So a finding outside the tuned range is not a claim that the controller is broken where it was designed to work — it is a measured boundary of how far the operating range can be widened before it stops working.</p>
      ${rangeBars(env, null)}
      <p class="fineprint reveal">Tuned range source: ${esc(env.controller_tuned_range.source)}. ${esc(env.note)}</p>`,
    })}

    ${band({
      id: "findings", eyebrow: "Findings for sale", inner: `
      <h2 class="section-title reveal">What a buyer can see before paying.</h2>
      <p class="prose reveal">Controller and version hash, the envelope, the verifier's verdict and method, a coarse severity band and the seller's settled-order history. The exact conditions, the trajectory and the replay frames stay in the private package.</p>
      ${listings.length === 0 ? `<p class="prose muted reveal">No listings yet — run the demonstration pipeline below.</p>` : `<div class="findings">${listings.map((l) => findingCard(l, orders.find((o) => o.listing_id === l.listing_id))).join("")}</div>`}`,
    })}

    ${band({
      id: "pipeline", eyebrow: "Run it yourself", tone: "quiet", inner: `
      <h2 class="section-title reveal">The whole workflow, end to end, on this machine.</h2>
      <p class="prose reveal">The seller, verifier and buyer agents run server-side against <strong>${esc(st.chain_label)}</strong>: a bounded grid hunt over the envelope, verification by re-simulation, two listings registered on chain, a buyer that funds escrow and signs for delivery, and settlement. The second delivery is deliberately tampered so the refund path is visible too.</p>
      <div class="row reveal">
        <button id="run-demo" class="btn" ${st.demo_trigger_enabled ? "" : "disabled"}>Run the pipeline</button>
        <span id="demo-state" class="muted">${demo.run ? `last run ${esc(short(demo.run.run_id, 10, 6))} — ${esc(demo.run.status)}` : "no run yet"}</span>
      </div>
      ${disclosure("Show the pipeline log", `<pre id="demo-log" class="log">${demo.run ? esc(demo.run.log.map((l) => l.msg).join("\n")) : "no run yet"}</pre>`, demo.log_redacted ? "operator only on this host" : "every step the agents took")}`,
    })}

    ${band({
      eyebrow: "Read this before you believe any of it", tone: "quiet", inner: `
      <div class="two-col">
        <p class="prose reveal">Adversarially selected failures do not estimate real-world failure frequency. The physics is a simplified cart in an illustrative envelope, severity is an uncalibrated impact-speed proxy, and simulation needs calibration against physical robots before it can support an underwriting decision. Nothing here is audited, Sybil-resistant or production-ready.</p>
        <div>
          ${disclosure("Show who holds which key", `<p class="prose">In this demonstration all three role keys are test-only keys held by the server: verifier ${addrCell(st.roles.verifier, st.chain_mode)}, seller ${addrCell(st.roles.seller, st.chain_mode)}, buyer ${addrCell(st.roles.buyer, st.chain_mode)}. A deployed version keeps only the verifier key server-side; buyers and sellers sign with their own wallets, and automated spending is bounded by per-key budgets, an allowlist of contracts and selectors, and rate limits.</p><p class="prose">Mode: ${esc(st.mode)}</p>`)}
          ${disclosure("Show provenance", `<dl class="facts"><dt>Escrow</dt><dd>${st.escrow_address ? addrCell(st.escrow_address, st.chain_mode) : "not configured"}</dd><dt>Chain</dt><dd>${esc(st.chain_label)}</dd><dt>Envelope</dt><dd class="mono">${esc(st.provenance.envelope_id)} · ${esc(short(st.provenance.envelope_config_hash, 14, 6))}</dd><dt>Build</dt><dd class="mono">${esc(st.provenance.git_sha ? short(st.provenance.git_sha, 10, 0) : "unknown")}${st.provenance.git_dirty ? " (dirty)" : ""}</dd><dt>Captured</dt><dd class="mono">${esc(st.provenance.captured_at)}</dd></dl>`)}
        </div>
      </div>`,
    })}`;

  armPage(view);

  const btn = document.getElementById("run-demo") as HTMLButtonElement | null;
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    try { await postJSON("/api/demo/run", {}); } catch (e) { document.getElementById("demo-state")!.textContent = String((e as Error).message); }
    startPolling();
  });
  if (demo.run && demo.run.status === "running") startPolling();
}

let pollTimer: number | null = null;
export function stopPolling(): void { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    const d = await getJSON<{ enabled: boolean; run: DemoRun }>("/api/demo/status");
    const log = document.getElementById("demo-log");
    const state = document.getElementById("demo-state");
    if (!log || !state || !d.run) return;
    log.textContent = d.run.log.map((l) => l.msg).join("\n") || "…";
    log.scrollTop = log.scrollHeight;
    state.textContent = `${short(d.run.run_id, 10, 6)} — ${d.run.status}${d.run.error ? " — " + d.run.error : ""}`;
    if (d.run.status !== "running") { stopPolling(); location.reload(); }
  }, 1500);
}

export function txLink(hash: string | null | undefined, mode: string | null | undefined): string { return txCell(hash, mode); }
