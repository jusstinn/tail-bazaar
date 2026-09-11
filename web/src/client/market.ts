// Marketplace page. Leads with one plain-language sentence, then the two robots on sale, then the
// mechanism, then the findings. Everything dense (roles, raw pipeline log, limitations) sits behind a
// labelled disclosure.
//
// MULTI-TARGET. A visitor has to be able to tell, inside one screen, how many robots are here and
// what "failure" means for each of them — so the robots come before the mechanism, each with its own
// machine, its own failure classes and who decides each class. The findings list is then grouped and
// filterable by robot. Nothing here counts the targets by hand: the copy is built from whatever the
// registry publishes at /api/market.
import { envelopeFor, getJSON, postJSON, type DemoRun, type EnvelopesDoc, type Listing, type MarketDoc, type Order, type Status } from "./api.js";
import { addrCell, esc, eth, short, txCell } from "./format.js";
import { armPage, badge, band, counter, disclosure, rangeBars, statusTone } from "./ui.js";

const STEPS: [string, string][] = [
  ["Search", "A hunter agent sweeps one robot's published operating range, simulating the same controller or policy under conditions it was never tuned for, and keeps the mildest conditions that break it."],
  ["Verify and seal", "An independent verifier re-runs the claim with that robot's own simulator in its own pinned environment, recomputes every hash from the delivered bytes, and registers a salted commitment to the evidence on chain. The listing existing is the verifier's statement that it re-ran the scenario itself."],
  ["Buy sealed", "The buyer sees the robot, the failure class, the verdict, the severity band and the price — never the conditions. It funds an escrow, then retrieves the package by signing a single-use challenge with the key the escrow records as the buyer."],
  ["Settle", "The verifier compares the delivered bytes with the commitment on chain and releases the payment or refunds the buyer. A complaint is an event, not a refund: only the verifier moves the money, and only once."],
];

const targetOf = (l: Listing): string => l.public_summary.target?.id ?? l.target_id ?? "cart";

const COUNT_WORD = ["no", "one", "two", "three", "four", "five", "six"];
const countWord = (n: number): string => COUNT_WORD[n] ?? String(n);
/** "a, b and c" — the robots on sale are read out, never hard-coded to a number of them. */
const oxford = (parts: string[]): string => (parts.length <= 1 ? parts[0] ?? "" : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

function findingCard(l: Listing, order: Order | undefined): string {
  const s = l.public_summary;
  const verdict = s.verification.verdict ?? s.verification.status;
  const settled = order?.status === "SETTLED_VALID" ? "The delivered bytes matched the seal. The seller was paid and the buyer keeps the evidence."
    : order?.status === "SETTLED_INVALID" ? "The delivered bytes did not match the seal. The buyer was refunded and the seller was paid nothing."
    : order ? "Purchased; settlement in progress." : "Not yet purchased.";
  const t = targetOf(l);
  return `<a class="finding reveal" data-target="${esc(t)}" href="#/orders/${esc(order?.order_id ?? "")}" ${order ? "" : 'aria-disabled="true"'}>
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
    </div>
    <span class="finding-go">${order ? "Open the finding" : "No order yet"} <i>→</i></span>
  </a>`;
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

export async function renderMarket(view: HTMLElement, st: Status): Promise<void> {
  const [listings, orders, demo, envs, market] = await Promise.all([
    getJSON<Listing[]>("/api/listings"),
    getJSON<Order[]>("/api/orders"),
    getJSON<{ enabled: boolean; run: DemoRun; log_redacted?: boolean }>("/api/demo/status"),
    getJSON<EnvelopesDoc>("/api/envelope"),
    getJSON<MarketDoc>("/api/market"),
  ]);
  const settledTotal = Math.max(0, ...listings.map((l) => l.seller_settled_orders ?? 0));
  const priceEth = listings.length ? Number(BigInt(listings[0].price_wei)) / 1e18 : 0;
  const firstOrder = orders.find((o) => o.status === "SETTLED_VALID") ?? orders[0];
  const live = market.targets.filter((t) => t.listings > 0);
  const shown = live.length ? live : market.targets;
  const counts = new Map(shown.map((t) => [t.target_id, listings.filter((l) => targetOf(l) === t.target_id).length]));

  view.innerHTML = `
    <section class="band hero">
      <div class="wrap">
        <div class="eyebrow reveal">Reproducible failure scenarios for robot controllers</div>
        <h1 class="display reveal">Someone finds the conditions<br>where a robot controller fails.<br>You buy the recipe sealed.</h1>
        <p class="lede reveal">${esc(countWord(shown.length).replace(/^./, (x) => x.toUpperCase()))} robots are on sale here: ${oxford(shown.map((t) => `a <strong>${esc(t.label.toLowerCase())}</strong>`))}. A hunter agent searches each one's published range of operating conditions for the ones where it fails. A verifier re-runs every claim with that robot's own simulator and seals the evidence with a hash on a public blockchain. The buyer pays into escrow <em>before</em> being allowed to look — and is refunded automatically if the delivered bytes do not match the seal.</p>
        <div class="cta-row reveal">
          ${firstOrder ? `<a class="btn" href="#/orders/${esc(firstOrder.order_id)}">See a settled finding</a>` : ""}
          <a class="btn ghost" href="#/how-it-works">How settlement works</a>
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
      ${listings.length === 0 ? `<p class="prose muted reveal">No listings yet — run the demonstration pipeline below.</p>` : `
      <div class="filters reveal" role="group" aria-label="filter by robot">
        <button data-filter="all" class="on">All <span class="fcount">${esc(listings.length)}</span></button>
        ${shown.map((t) => `<button data-filter="${esc(t.target_id)}">${esc(t.short_label)} <span class="fcount">${esc(counts.get(t.target_id) ?? 0)}</span></button>`).join("")}
      </div>
      ${shown.map((t) => {
        const mine = listings.filter((l) => targetOf(l) === t.target_id);
        if (!mine.length) return "";
        return `<div class="tgroup" data-target="${esc(t.target_id)}">
          <h3 class="tgroup-head reveal"><span class="badge target target-${esc(t.target_id)}">${esc(t.label)}</span> <span class="muted">${esc(t.machine)}</span></h3>
          <div class="findings">${mine.map((l) => findingCard(l, orders.find((o) => o.listing_id === l.listing_id))).join("")}</div>
        </div>`;
      }).join("")}`}`,
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
  wireEnvelopePanes(view);
  wireFilters(view);

  const btn = document.getElementById("run-demo") as HTMLButtonElement | null;
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    try { await postJSON("/api/demo/run", {}); } catch (e) { document.getElementById("demo-state")!.textContent = String((e as Error).message); }
    startPolling();
  });
  if (demo.run && demo.run.status === "running") startPolling();
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
