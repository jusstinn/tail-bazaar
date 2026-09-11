// Marketplace page. Leads with one plain-language sentence, then the two robots on sale, then the
// mechanism, then the findings. Everything dense (roles, raw pipeline log, limitations) sits behind a
// labelled disclosure.
//
// MULTI-TARGET. A visitor has to be able to tell, inside one screen, how many robots are here and
// what "failure" means for each of them — so the robots come before the mechanism, each with its own
// machine, its own failure classes and who decides each class. The findings list is then grouped and
// filterable by robot. Nothing here counts the targets by hand: the copy is built from whatever the
// registry publishes at /api/market.
import { envelopeFor, getJSON, getToken, postJSON, setToken, type DemoRun, type EnvelopesDoc, type Flow, type Listing, type MarketDoc, type Order, type Status } from "./api.js";
import { addrCell, esc, eth, short, txCell } from "./format.js";
import { armPage, badge, band, counter, disclosure, rangeBars, statusTone } from "./ui.js";
import { heroMarkup, mountHero } from "./hero.js";
import { livePanelMarkup, mountLive, plainError } from "./live.js";

/** Whether this browser may drive the market (buy, list). Local demonstration mode: always. Hosted
 *  mode: only with the operator token stored, because a flow spends the operator's test ETH. */
type Drive = { ok: boolean; note: string };
const driveFor = (st: Status): Drive => (st.hosted_mode && !getToken() ? { ok: false, note: "hosted instance: paste the operator token below to drive the market from this page" } : { ok: true, note: "" });

const STEPS: [string, string][] = [
  ["Search", "A hunter agent sweeps one robot's published operating range, simulating the same controller or policy under conditions it was never tuned for, and keeps the mildest conditions that break it."],
  ["Verify and seal", "An independent verifier re-runs the claim with that robot's own simulator in its own pinned environment, recomputes every hash from the delivered bytes, and registers a salted commitment to the evidence on chain. The listing existing is the verifier's statement that it re-ran the scenario itself."],
  ["Buy sealed", "The buyer sees the robot, the failure class, the verdict, the severity band and the price — never the conditions. It funds an escrow, then retrieves the package by signing a single-use challenge with the key the escrow records as the buyer."],
  ["Settle", "The verifier compares the delivered bytes with the commitment on chain and releases the payment or refunds the buyer. A complaint is an event, not a refund: only the verifier moves the money, and only once."],
];

const targetOf = (l: Listing): string => l.public_summary.target?.id ?? l.target_id ?? "cart";

const COUNT_WORD = ["no", "one", "two", "three", "four", "five", "six"];
const countWord = (n: number): string => COUNT_WORD[n] ?? String(n);

function findingCard(l: Listing, order: Order | undefined, drive: Drive): string {
  const s = l.public_summary;
  const verdict = s.verification.verdict ?? s.verification.status;
  const unsold = !order && l.status === "LISTED";
  const settled = order?.status === "SETTLED_VALID" ? "The delivered bytes matched the seal. The seller was paid and the buyer keeps the evidence."
    : order?.status === "SETTLED_INVALID" ? "The delivered bytes did not match the seal. The buyer was refunded and the seller was paid nothing."
    : order ? "Purchased; settlement in progress." : unsold ? "Sealed and for sale. Buying it runs the escrow, delivery, retrieval and settlement live, one transaction at a time." : "Not yet purchased.";
  const t = targetOf(l);
  const inner = `
    <div class="finding-top">
      <span class="badge target target-${esc(t)}">${esc(s.target?.label ?? "Warehouse cart")}</span>
      <span class="chip chip-${esc(s.severity.band)}">${esc(s.severity.band)} severity</span>
      ${badge(verdict, verdict === "VALID" ? "ok" : "bad")}
      ${l.demo_note ? badge("tampered delivery (demo)", "warn") : ""}
    </div>
    <h3>${esc(s.failure_class?.label ?? "Collision")}</h3>
    <span class="finding-id mono">${esc(s.controller.id)}</span>
    <p class="finding-claim">${esc(s.claim_kind)}</p>
    <p class="finding-note">${esc(settled)}</p>
    <div class="finding-foot">
      <div><span class="k">Price</span><span class="v mono">${esc(eth(l.price_wei))}</span></div>
      <div><span class="k">Seller</span><span class="v">${addrCell(l.seller, l.chain_mode)}</span></div>
      <div><span class="k">Settled orders</span><span class="v mono">${l.seller_settled_orders ?? "—"}</span></div>
      <div><span class="k">On chain</span><span class="v">${l.on_chain ? badge(l.on_chain.status, statusTone(l.on_chain.status)) : badge("unreachable", "bad")}</span></div>
    </div>`;
  if (unsold) {
    return `<div class="finding unsold reveal" data-target="${esc(t)}">${inner}
      <div class="finding-buy"><button class="btn small" data-buy="${esc(l.listing_id)}" ${drive.ok ? "" : "disabled"}>Buy for ${esc(eth(l.price_wei))}</button>${drive.ok ? "" : `<span class="muted">${esc(drive.note)}</span>`}</div>
    </div>`;
  }
  return `<a class="finding reveal" data-target="${esc(t)}" href="#/orders/${esc(order?.order_id ?? "")}" ${order ? "" : 'aria-disabled="true"'}>${inner}
    <span class="finding-go">${order ? "Open the finding" : "No order yet"} <i>→</i></span>
  </a>`;
}

/** HOSTED MODE: the operator token that unlocks the Buy and List buttons. Same storage as the order
 *  page's unlock box (api.ts getToken/setToken); it stays in this browser and goes to this app only. */
function tokenBox(st: Status): string {
  if (!st.hosted_mode) return "";
  if (getToken()) return `<p class="fineprint reveal">An operator token is stored in this browser, so the Buy and List buttons are live. <a href="#" id="op-tok-clear" class="link-go">Forget it <i>→</i></a></p>`;
  return `<div class="op-token reveal">
    <div class="row"><input id="op-tok" type="password" placeholder="paste the operator token to buy or list from this page" autocomplete="off"><button id="op-tok-go" class="btn small">Save</button></div>
    <p class="fineprint">This instance is hosted at a public URL. Buying or listing from the page writes to the chain and spends the operator's test ETH, so it needs the operator token. The token stays in this browser and is sent to this app only.</p>
  </div>`;
}

/** One robot, explained in the space a visitor actually reads: what it is, what "failure" means for
 *  it, who decides that, and what the hunters have already spent looking. */
function targetCard(t: MarketDoc["targets"][number], envs: EnvelopesDoc): string {
  const env = envelopeFor(envs, t.target_id);
  return `<div class="tcard reveal" data-target="${esc(t.target_id)}">
    <div class="tcard-top"><span class="badge target target-${esc(t.target_id)}">${esc(t.label)}</span><span class="tcard-count">${esc(t.listings)} listing${t.listings === 1 ? "" : "s"}</span></div>
    <h3>${esc(t.machine)}</h3>
    <p class="prose">${esc(t.one_liner)}</p>
    <dl class="tcard-facts">
      <dt>Failure means</dt><dd>${t.failure_classes.map((c) => `<strong>${esc(c.label)}</strong> — ${esc(c.detected_by)}`).join("<br>")}</dd>
      <dt>Severity is</dt><dd>${esc(env.severity.definition)}</dd>
      <dt>${esc(env.controller_tuned_range.label.replace(/^./, (x) => x.toUpperCase()))}</dt><dd>${esc(env.controller_tuned_range.prose)}</dd>
      <dt>Hunters searched</dt><dd>${esc(env.searched_envelope.prose)}</dd>
      <dt>Search so far</dt><dd class="mono">${esc(t.search_cost.simulations)} simulations · ${esc(t.search_cost.sim_steps.toLocaleString())} physics steps · ${esc(t.search_cost.wall_time_s)} s${Object.keys(t.failures_by_class).length ? ` · ${Object.entries(t.failures_by_class).map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}</dd>
    </dl>
  </div>`;
}

export async function renderMarket(view: HTMLElement, st: Status, opts: { showFlow?: Flow | null } = {}): Promise<void> {
  const [listings, orders, demo, envs, market, flows] = await Promise.all([
    getJSON<Listing[]>("/api/listings"),
    getJSON<Order[]>("/api/orders"),
    getJSON<{ enabled: boolean; run: DemoRun; log_redacted?: boolean }>("/api/demo/status"),
    getJSON<EnvelopesDoc>("/api/envelope"),
    getJSON<MarketDoc>("/api/market"),
    getJSON<{ flow: Flow | null }>("/api/flows/current").catch(() => ({ flow: null as Flow | null })),
  ]);
  const drive = driveFor(st);
  // A listing flow still running on the server (say, after a reload) is mounted where it was; a
  // just-finished one the caller hands in stays on screen above the listing it produced.
  const liveFlow = flows.flow && flows.flow.status === "running" ? flows.flow : null;
  const shownFlow = opts.showFlow ?? null;
  const settledTotal = Math.max(0, ...listings.map((l) => l.seller_settled_orders ?? 0));
  const priceEth = listings.length ? Number(BigInt(listings[0].price_wei)) / 1e18 : 0;
  const firstOrder = orders.find((o) => o.status === "SETTLED_VALID") ?? orders[0];
  const live = market.targets.filter((t) => t.listings > 0);
  const shown = live.length ? live : market.targets;
  const counts = new Map(shown.map((t) => [t.target_id, listings.filter((l) => targetOf(l) === t.target_id).length]));

  view.innerHTML = `
    <section class="band hero market-hero">
      <div class="wrap">
        <div class="hero-layout">
          <div class="hero-copy">
            <div class="eyebrow reveal">A marketplace for reproducible robot failures</div>
            <h1 class="display reveal">Every robot has<br>a breaking point.</h1>
            <p class="lede reveal">A hunter finds the conditions that break a robot. A verifier reproduces the failure. You buy the recipe sealed — with your payment held in escrow until the delivered evidence matches the seal.</p>
            <div class="hero-targets reveal">${shown.map((t) => `<span class="badge target target-${esc(t.target_id)}">${esc(t.short_label)}</span>`).join("")}<span class="hero-target-note">${esc(shown.length)} robots. Real simulation evidence.</span></div>
            <div class="cta-row reveal">
              ${firstOrder ? `<a class="btn" href="#/orders/${esc(firstOrder.order_id)}">See a settled finding <span aria-hidden="true">↗</span></a>` : ""}
              <a class="btn ghost" href="#/how-it-works">How settlement works</a>
            </div>
          </div>
          ${heroMarkup()}
        </div>
        <div class="stat-strip">
          <div class="metric reveal"><div class="metric-v">${counter(listings.length, "", 0)}</div><div class="metric-k">findings listed</div><div class="metric-n">across ${esc(shown.length)} robot${shown.length === 1 ? "" : "s"}</div></div>
          <div class="metric reveal"><div class="metric-v">${counter(market.search_cost_total.simulations, "", 0)}</div><div class="metric-k">simulations run by hunters</div><div class="metric-n">${esc(market.search_cost_total.hunts)} sweeps, ${esc(market.search_cost_total.sim_steps.toLocaleString())} physics steps</div></div>
          <div class="metric reveal"><div class="metric-v">${counter(settledTotal, "", 0)}</div><div class="metric-k">valid settlements</div><div class="metric-n">on-chain counter for this seller</div></div>
          <div class="metric reveal"><div class="metric-v">${counter(priceEth, "ETH", 3)}</div><div class="metric-k">price per finding</div><div class="metric-n">${esc(st.chain_label)}</div></div>
        </div>
      </div>
    </section>

    ${band({
      id: "robots", eyebrow: "What is on the market", inner: `
      <h2 class="section-title reveal">${esc(countWord(shown.length).replace(/^./, (x) => x.toUpperCase()))} robots. ${esc(countWord(shown.length).replace(/^./, (x) => x.toUpperCase()))} different meanings of "it failed".</h2>
      <p class="prose reveal">Almost none of these failure classes is invented here. The cart's collision is the simulator's own contact flag; the humanoid's fall is Gymnasium's own health predicate; the arm's <em>not placed</em> is Gymnasium-Robotics' own success flag at its own episode horizon — all read straight off the environment. The one exception is stated rather than hidden: the arm's <em>dropped</em> is this project's own predicate, because the environment scores placement and not custody. It is mechanical, it reads MuJoCo's own contact list, and the card below says exactly what it is so a reader can disagree with it on the evidence.</p>
      <div class="tcards">${shown.map((t) => targetCard(t, envs)).join("")}</div>
      <p class="fineprint reveal">${esc(market.note)}</p>`,
    })}

    ${band({
      id: "how", eyebrow: "The mechanism", tone: "quiet", inner: `
      <h2 class="section-title reveal">Four steps, no trust in the seller.</h2>
      <ol class="steps">${STEPS.map(([t, d], i) => `<li class="reveal"><span class="step-n">${i + 1}</span><div><h3>${esc(t)}</h3><p>${esc(d)}</p></div></li>`).join("")}</ol>
      <p class="after reveal"><a class="link-go" href="#/how-it-works">What the verifier checks, and what each verdict does to the money <i>→</i></a></p>`,
    })}

    ${band({
      id: "question", eyebrow: "What this market answers", inner: `
      <div class="seg seg-wide reveal" role="group" aria-label="robot">${shown.map((t, i) => `<button data-env="${esc(t.target_id)}" class="${i === 0 ? "on" : ""}">${esc(t.short_label)}</button>`).join("")}</div>
      ${shown.map((t, i) => {
        const env = envelopeFor(envs, t.target_id);
        return `<div class="envpane" data-env="${esc(t.target_id)}"${i === 0 ? "" : " hidden"}>
          <blockquote class="pull reveal">${esc(env.product_question)}</blockquote>
          <p class="prose reveal">Its author documented the conditions it was built for. The hunter searches a deliberately <em>wider</em> range. So a finding outside those conditions is not a claim that it is broken where it was designed to work — it is a measured boundary of how far the operating range can be widened before it stops working.</p>
          ${rangeBars(env, null)}
          <p class="fineprint reveal">Source: ${esc(env.controller_tuned_range.source)}. ${esc(env.note)}</p>
        </div>`;
      }).join("")}`,
    })}

    ${band({
      id: "findings", eyebrow: "Findings for sale", tone: "quiet", inner: `
      <h2 class="section-title reveal">What a buyer can see before paying.</h2>
      <p class="prose reveal">The robot, the failure class, the version hash of the controller or policy checkpoint, the envelope, the verifier's verdict and method, a coarse severity band and the seller's settled-order history. The exact conditions, the trajectory, the replay frames and the hunt that found it stay in the private package.</p>
      <p class="prose reveal">Every unsold finding has a <strong>Buy</strong> button, and every robot a <strong>List a new finding</strong> button: each runs the real agents against the chain while you watch, one transaction at a time.</p>
      ${tokenBox(st)}
      ${liveFlow && liveFlow.kind === "buy" ? `<p class="prose reveal">A purchase is running right now — <a class="link-go" href="#/orders/${esc(liveFlow.listing_id ?? "")}">watch it on the finding's page <i>→</i></a></p>` : ""}
      ${listings.length === 0 ? `<p class="prose muted reveal">No listings yet — list a finding for a robot below, or run the whole demonstration pipeline further down.</p>` : `
      <div class="filters reveal" role="group" aria-label="filter by robot">
        <button data-filter="all" class="on">All <span class="fcount">${esc(listings.length)}</span></button>
        ${shown.map((t) => `<button data-filter="${esc(t.target_id)}">${esc(t.short_label)} <span class="fcount">${esc(counts.get(t.target_id) ?? 0)}</span></button>`).join("")}
      </div>`}
      ${shown.map((t) => {
        const mine = listings.filter((l) => targetOf(l) === t.target_id);
        return `<div class="tgroup" data-target="${esc(t.target_id)}">
          <h3 class="tgroup-head reveal"><span class="badge target target-${esc(t.target_id)}">${esc(t.label)}</span> <span class="muted">${esc(t.machine)}</span><button class="btn ghost small" data-list="${esc(t.target_id)}" ${drive.ok && !liveFlow ? "" : "disabled"} title="${esc(drive.ok ? "" : drive.note)}">List a new finding</button></h3>
          <div class="live-host" data-live-for="${esc(t.target_id)}">${shownFlow && shownFlow.target_id === t.target_id ? livePanelMarkup(shownFlow, st) : ""}</div>
          ${mine.length ? `<div class="findings">${mine.map((l) => findingCard(l, orders.find((o) => o.listing_id === l.listing_id), drive)).join("")}</div>` : `<p class="tgroup-empty reveal">No findings listed for this robot yet.</p>`}
        </div>`;
      }).join("")}`,
    })}

    ${band({
      id: "pipeline", eyebrow: "Run it yourself", inner: `
      <h2 class="section-title reveal">The whole workflow, end to end, on this machine.</h2>
      <p class="prose reveal">The seller, verifier and buyer agents run server-side against <strong>${esc(st.chain_label)}</strong>: a bounded hunt over each robot's envelope with that robot's own simulator, verification by re-simulation, listings registered on chain for every target, a buyer that shops target by target under a budget, and settlement. One delivery is deliberately tampered so the refund path is visible too.</p>
      <div class="row reveal">
        <button id="run-demo" class="btn" ${st.demo_trigger_enabled ? "" : "disabled"}>Run the pipeline</button>
        <span id="demo-state" class="muted">${demo.run ? `last run ${esc(short(demo.run.run_id, 10, 6))} — ${esc(demo.run.status)}` : "no run yet"}</span>
      </div>
      ${disclosure("Show the pipeline log", `<pre id="demo-log" class="log">${demo.run ? esc(demo.run.log.map((l) => l.msg).join("\n")) : "no run yet"}</pre>`, demo.log_redacted ? "operator only on this host" : "every step the agents took")}`,
    })}

    ${band({
      eyebrow: "Read this before you believe any of it", tone: "quiet", inner: `
      <div class="two-col">
        <p class="prose reveal">Adversarially selected failures do not estimate real-world failure frequency. The physics is a simplified cart, a 42 kg Gymnasium mannequin and a mocap-welded Fetch arm carrying a 5 cm cube, all in illustrative envelopes; severity is an uncalibrated kinematic proxy, and simulation needs calibration against physical robots before it can support an underwriting decision. Both pretrained policy checkpoints — the humanoid's and the arm's — declare no licence, and neither does any alternative that was checked. Nothing here is audited, Sybil-resistant or production-ready.</p>
        <div>
          ${disclosure("Show who holds which key", `<p class="prose">In this demonstration all three role keys are test-only keys held by the server: verifier ${addrCell(st.roles.verifier, st.chain_mode)}, seller ${addrCell(st.roles.seller, st.chain_mode)}, buyer ${addrCell(st.roles.buyer, st.chain_mode)}. A deployed version keeps only the verifier key server-side; buyers and sellers sign with their own wallets, and automated spending is bounded by per-key budgets, an allowlist of contracts and selectors, and rate limits.</p><p class="prose">Mode: ${esc(st.mode)}</p>`)}
          ${disclosure("Show provenance", `<dl class="facts"><dt>Escrow</dt><dd>${st.escrow_address ? addrCell(st.escrow_address, st.chain_mode) : "not configured"}</dd><dt>Chain</dt><dd>${esc(st.chain_label)}</dd><dt>Envelopes</dt><dd class="mono">${esc((st.provenance.envelope_ids ?? [st.provenance.envelope_id]).join(", "))} · ${esc(short(st.provenance.envelope_config_hash, 14, 6))}</dd><dt>Build</dt><dd class="mono">${esc(st.provenance.git_sha ? short(st.provenance.git_sha, 10, 0) : "unknown")}${st.provenance.git_dirty ? " (dirty)" : ""}</dd><dt>Captured</dt><dd class="mono">${esc(st.provenance.captured_at)}</dd></dl>`)}
        </div>
      </div>`,
    })}`;

  armPage(view);
  mountHero(view);
  wireEnvelopePanes(view);
  wireFilters(view);
  wireDrive(view, st);
  if (liveFlow && liveFlow.kind === "list") {
    const host = view.querySelector<HTMLElement>(`.live-host[data-live-for="${liveFlow.target_id}"]`);
    if (host) mountLive(host, liveFlow, st, (f) => { renderMarket(view, st, { showFlow: f }).catch(() => {}); });
  }

  const btn = document.getElementById("run-demo") as HTMLButtonElement | null;
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    try { await postJSON("/api/demo/run", {}); } catch (e) { document.getElementById("demo-state")!.textContent = String((e as Error).message); }
    startPolling();
  });
  if (demo.run && demo.run.status === "running") startPolling();
}

/** The Buy and List buttons, and the hosted-mode token box. A buy moves to the finding's page, which
 *  mounts the live panel; a listing stays here and mounts it above that robot's findings. */
function wireDrive(view: HTMLElement, st: Status): void {
  view.querySelectorAll<HTMLButtonElement>("button[data-buy]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const r = await postJSON<{ flow_id: string; order_id: string }>(`/api/listings/${b.dataset.buy}/buy`, {});
      location.hash = `#/orders/${r.order_id}`;
    } catch (e) {
      b.disabled = false;
      b.parentElement!.querySelector(".alert")?.remove();
      b.insertAdjacentHTML("afterend", `<span class="muted alert">${esc(plainError(e))}</span>`);
    }
  }));
  view.querySelectorAll<HTMLButtonElement>("button[data-list]").forEach((b) => b.addEventListener("click", async () => {
    const t = b.dataset.list!;
    const host = view.querySelector<HTMLElement>(`.live-host[data-live-for="${t}"]`)!;
    view.querySelectorAll<HTMLButtonElement>("button[data-list]").forEach((x) => { x.disabled = true; });
    try {
      const r = await postJSON<{ flow_id: string; flow: Flow }>(`/api/targets/${t}/list`, {});
      mountLive(host, r.flow, st, (f) => { renderMarket(view, st, { showFlow: f }).catch(() => {}); });
    } catch (e) {
      view.querySelectorAll<HTMLButtonElement>("button[data-list]").forEach((x) => { x.disabled = false; });
      host.innerHTML = `<p class="live-note bad">${esc(plainError(e))}</p>`;
    }
  }));
  const tok = document.getElementById("op-tok") as HTMLInputElement | null;
  const save = (): void => { setToken(tok!.value.trim()); location.reload(); };
  document.getElementById("op-tok-go")?.addEventListener("click", save);
  tok?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") save(); });
  document.getElementById("op-tok-clear")?.addEventListener("click", (e) => { e.preventDefault(); setToken(""); location.reload(); });
}

function wireEnvelopePanes(root: ParentNode): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".seg-wide button[data-env]"));
  const panes = Array.from(root.querySelectorAll<HTMLElement>(".envpane"));
  for (const b of buttons) {
    b.addEventListener("click", () => {
      buttons.forEach((x) => x.classList.toggle("on", x === b));
      panes.forEach((p) => { p.hidden = p.dataset.env !== b.dataset.env; });
      armPage(root);
    });
  }
}

function wireFilters(root: ParentNode): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".filters button[data-filter]"));
  const groups = Array.from(root.querySelectorAll<HTMLElement>(".tgroup"));
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const want = b.dataset.filter!;
      buttons.forEach((x) => x.classList.toggle("on", x === b));
      groups.forEach((g) => { g.hidden = want !== "all" && g.dataset.target !== want; });
    });
  }
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
