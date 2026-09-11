// The finding page, told in five stages: the sealed claim, the purchase, the reveal, the evidence,
// the settlement. Each stage leads with one plain sentence; hashes, canonical JSON, envelopes,
// provenance and raw metrics stay complete but live behind labelled disclosures.
import { envelopeFor, getJSON, getToken, HttpError, setToken, type Check, type EnvelopeDoc, type EnvelopesDoc, type Ev, type OperatingContext, type Order, type Pkg, type RunLike, type Status } from "./api.js";
import { addrCell, esc, eth, num, short, txCell, when } from "./format.js";
import { armPage, badge, band, counter, disclosure, facts, inTuned, rangeBars, reducedMotion, statusTone } from "./ui.js";
import { createReplay, type Replay, type ViewMode } from "./replay.js";
import { targetView, type TargetView } from "./target-view.js";
import { autoplayStop, defaultPlayhead, presentFailure, type FailurePresentation } from "../server/failure.js";

let replay: Replay | null = null;
export function disposeReplay(): void { if (replay) { replay.dispose(); replay = null; } }

/** The badge a deliberately published order carries. The server sends the same string; this is the
 *  fallback for a record served by an older build. */
const DEMO_FIXTURE_NOTE = "DEMONSTRATION FIXTURE, published in the repository, not a secret";

const STAGES: [string, string][] = [
  ["claim", "The sealed claim"], ["purchase", "The purchase"], ["reveal", "The reveal"], ["evidence", "The evidence"], ["settlement", "The settlement"],
];

const EVENT_STORY: Record<string, string> = {
  verified: "The verifier re-simulated the claim in its own pinned environment and accepted it.",
  registered: "The verifier registered the listing on chain, sealing the commitment to the evidence and the terms of the sale.",
  funded: "The buyer's agent funded the escrow with the exact price — still without seeing the scenario.",
  delivered: "The seller marked the package delivered and served the bytes.",
  retrieved: "The buyer signed a single-use challenge with the key the escrow records as the buyer, and retrieved the package.",
  recheck_requested: "The buyer disputed the delivery. This emits an event and moves no money.",
  settled_valid: "The verifier settled VALID. The price was credited to the seller.",
  settled_invalid: "The verifier settled INVALID. The full price was credited back to the buyer.",
  withdrawn: "The seller withdrew the payment.",
  refund_withdrawn: "The buyer withdrew the refund.",
};

function checksList(checks: Check[]): string {
  return `<ul class="checks">${checks.map((c) => `<li><span class="tick ${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✕"}</span><span class="check-n mono">${esc(c.name)}</span>${c.detail ? `<span class="check-d mono">${esc(c.detail)}</span>` : ""}</li>`).join("")}</ul>`;
}

function stageHead(id: string, n: number, title: string, sentence: string): string {
  return `<div class="stage-head reveal"><span class="stage-n">${n}</span><h2 class="section-title">${esc(title)}</h2></div><p class="lede reveal">${sentence}</p>`;
}

// ------------------------------------------------------------------ page
export async function renderOrder(view: HTMLElement, orderId: string, st: Status): Promise<void> {
  const [o, envs] = await Promise.all([getJSON<Order>(`/api/orders/${orderId}`), getJSON<EnvelopesDoc>("/api/envelope")]);
  const l = o.listing!;
  const s = l.public_summary;
  const targetId = s.target?.id ?? l.target_id ?? "cart";
  const tv = targetView(targetId);
  const env = envelopeFor(envs, targetId);
  const ctx: OperatingContext = s.operating_context ?? {
    controller_tuned_range: env.controller_tuned_range.prose, searched_envelope: env.searched_envelope.prose,
    question: env.product_question, note: env.note, reference: "GET /api/envelope",
  };
  const events = (o.events ?? []) as Ev[];
  const valid = o.status === "SETTLED_VALID";
  const verdict = s.verification.verdict ?? s.verification.status;

  const headline = valid ? tv.headline : "The seller delivered bytes<br>that did not match the seal.";
  const lede = valid
    ? `A hunter agent found conditions inside the published operating range where this ${esc(s.target?.subject_label?.toLowerCase() ?? "controller")} fails, and a verifier re-ran them with the same simulator and agreed. A buyer paid <strong>${esc(eth(l.price_wei))}</strong> into escrow before being allowed to look at any of it. Everything below is what happened next, in the order it happened.`
    : `A buyer paid <strong>${esc(eth(l.price_wei))}</strong> into escrow for this finding. What the seller then served did not hash to the commitment registered on chain, so the verifier settled the order invalid and the escrow refunded the buyer in full. This is the refund path, demonstrated deliberately.`;

  view.innerHTML = `
    <section class="band hero order-hero">
      <div class="wrap">
        <div class="eyebrow reveal"><a href="#/">Marketplace</a> <span>/</span> Finding · <span class="mono">${esc(short(o.order_id, 10, 6))}</span></div>
        <h1 class="display reveal">${headline}</h1>
        <p class="lede reveal">${lede}</p>
        <div class="cta-row reveal">
          ${badge(s.target?.label ?? "Warehouse cart", "target target-" + esc(targetId))}
          ${badge(o.chain_mode === "testnet" ? "Base Sepolia" : "Local anvil", o.chain_mode === "testnet" ? "testnet" : "local")}
          ${badge(o.status.replace(/_/g, " ").toLowerCase(), statusTone(o.status))}
          ${o.on_chain ? badge("on chain: " + o.on_chain.status, statusTone(o.on_chain.status)) : ""}
          ${o.public_demo_fixture ? badge(o.public_demo_fixture_note ?? DEMO_FIXTURE_NOTE, "fixture") : ""}
        </div>
      </div>
    </section>

    <nav class="rail" id="rail"><div class="wrap">${STAGES.map(([id, t], i) => `<button data-goto="stage-${id}"><span>${i + 1}</span>${esc(t)}</button>`).join("")}</div></nav>

    ${band({ id: "stage-claim", inner: `
      ${stageHead("claim", 1, "The sealed claim", `This is everything the buyer was allowed to see before paying. It names the robot, what failed and who decides that, the version hash of the ${esc((s.target?.subject_label ?? "controller").toLowerCase())} and the verdict — and deliberately says nothing that would let anyone reconstruct the scenario.`)}
      <div class="two-col">
        <div>
          ${facts([
            ["Robot", `${esc(s.target?.label ?? "Warehouse cart")}<div class="sub-mono">${esc(s.target?.machine ?? "a braking warehouse cart carrying a payload")}</div>`],
            [s.target?.subject_label ?? "Controller", `${esc(s.controller.id)}<div class="sub-mono mono">${esc(s.controller.hash)}</div>`],
            ["Failure class", `${badge(s.failure_class?.label ?? "Collision", "bad")}<div class="sub-mono">${esc(s.failure_class?.detected_by ?? "the simulator's own contact flag")}</div>`],
            ["Claim", esc(s.claim_kind)],
            ["Verified by", `${badge(verdict, verdict === "VALID" ? "ok" : "bad")} <span class="muted">${esc(s.verification.method ?? "")}</span><div class="sub-mono">re-simulated in the verifier's own environment · ${esc(s.verification.verifier_version)}</div>`],
            ["Severity", `${badge(s.severity.band, "chip-" + s.severity.band)} <span class="muted">${esc(s.severity.definition)}</span>`],
            ["Seller", `${addrCell(l.seller, l.chain_mode)} <span class="muted">· ${s.seller_settled_orders_at_listing} settled orders at listing, ${l.seller_settled_orders ?? "—"} now</span>`],
            ["Price", `<span class="mono">${esc(eth(l.price_wei))}</span>`],
          ])}
        </div>
        <div>
          <h3 class="sub reveal">What stayed hidden until payment</h3>
          <p class="prose reveal">${esc(s.hidden)}.</p>
          <p class="prose reveal">The buyer knew the question it was buying an answer to — <em>${esc(ctx.question)}</em> — and that the ${esc(ctx.controller_tuned_range_label ?? "range it was tuned for")} is ${esc(ctx.controller_tuned_range)} while the hunter searched ${esc(ctx.searched_envelope)}. Those two ranges are the same for every listing of this robot, so stating them reveals nothing about this one.</p>
          ${disclosure("Show the sealed summary and its hashes", `${facts([
            ["Commitment", `<span class="mono">${esc(l.commitment)}</span><div class="sub-mono">keccak256 of the canonical private package, which carries a random 32-byte salt</div>`],
            ["Terms hash", `<span class="mono">${esc(l.terms_hash)}</span><div class="sub-mono">keccak256 of this public summary; listing id = keccak256(commitment ‖ terms hash)</div>`],
            ["Envelope", `<span class="mono">${esc(s.envelope_id)}</span>`],
            ["Admissible", s.admissible ? "yes" : "no"],
            ["Environment fingerprint", `<span class="mono">${esc(s.verification.environment_fingerprint)}</span>`],
            ["Evidence binding", esc(s.verification.evidence_binding ?? "—")],
          ])}<pre class="json">${esc(JSON.stringify(s, null, 2))}</pre>`, "the exact bytes whose hash is on chain")}
        </div>
      </div>` })}

    ${band({ id: "stage-purchase", tone: "quiet", inner: `
      ${stageHead("purchase", 2, "The purchase", "The buyer's agent funded the escrow with the exact price. From that moment two deadlines were fixed and could not be changed by anyone.")}
      <div class="two-col">
        <div>${facts([
          ["Buyer", addrCell(o.buyer, o.chain_mode)],
          ["Paid into escrow", `<span class="mono">${esc(eth(o.price_wei))}</span>`],
          ["Escrow contract", l.escrow_address ? addrCell(l.escrow_address, l.chain_mode) : "—"],
          ["Funding transaction", txCell(o.fund_tx, o.chain_mode)],
        ])}</div>
        <div>
          <p class="prose reveal">${o.on_chain?.delivery_deadline
            ? `The seller had until <strong>${esc(when(new Date(o.on_chain.delivery_deadline * 1000).toISOString()))}</strong> to deliver, and the verifier until <strong>${esc(when(new Date(o.on_chain.settlement_deadline! * 1000).toISOString()))}</strong> to settle. If either had gone quiet, anyone could have called <span class="mono">claimTimeout</span> after the deadline and the buyer would have been refunded in full.`
            : `Both deadlines are fixed at funding from the contract's immutable windows. If either party goes quiet, anyone may call <span class="mono">claimTimeout</span> after the deadline and the buyer is refunded in full.`}</p>
          <p class="prose reveal"><a class="link-go" href="#/how-it-works">Why silence resolves in the buyer's favour <i>→</i></a></p>
        </div>
      </div>` })}

    <section class="band" id="stage-reveal"><div class="wrap" id="reveal-wrap">
      ${stageHead("reveal", 3, "The reveal", "Loading the purchased package and the public baseline run…")}
    </div></section>

    ${band({ id: "stage-evidence", inner: `
      ${stageHead("evidence", 4, "The evidence", valid
        ? "The verifier checked the delivered bytes against the commitment it had registered on chain, and the buyer checked them independently. Both agreed."
        : "The verifier checked the delivered bytes against the commitment it had registered on chain. They did not match, and the buyer's own check reached the same conclusion.")}
      <div class="verdict-strip reveal">
        <div class="vs-side"><div class="vs-label">Verifier</div>${o.delivery_check ? `<div class="vs-v ${o.delivery_check.valid ? "ok" : "bad"}">${o.delivery_check.valid ? "VALID" : "INVALID"}</div><p class="prose">${esc(o.delivery_check.reason)}</p>` : `<div class="vs-v">pending</div>`}</div>
        <div class="vs-side"><div class="vs-label">Buyer's own check</div>${o.buyer_check ? `<div class="vs-v ${o.buyer_check.ok ? "ok" : "bad"}">${o.buyer_check.ok ? "PASSED" : "FAILED"}</div><p class="prose">${esc(o.buyer_check.reason)}</p>` : `<div class="vs-v">pending</div>`}</div>
      </div>
      ${o.delivery_check ? disclosure("Show the verifier's checks", `${facts([
        ["Commitment on chain", `<span class="mono">${esc(o.delivery_check.on_chain_commitment)}</span>`],
        ["keccak256(delivered bytes)", `<span class="mono">${esc(o.delivery_check.delivered_hash)}</span>`],
        ["Hash the seller asserted", `<span class="mono">${esc(o.delivery_check.asserted_delivery_hash ?? "—")}</span>`],
      ])}${checksList(o.delivery_check.checks)}`, `${o.delivery_check.checks.length} checks, all published after settlement`) : ""}
      ${o.buyer_check ? disclosure("Show the buyer's own checks", checksList(o.buyer_check.checks), "run by the buyer agent, independently of the verifier") : ""}
      <p class="after reveal"><a class="link-go" href="#/how-it-works">What the verifier checks, and what each verdict does to the money <i>→</i></a></p>` })}

    ${band({ id: "stage-settlement", tone: "quiet", inner: `
      ${stageHead("settlement", 5, "The settlement", valid
        ? `The verifier settled valid. The escrow credited the seller, who withdrew the payment. The buyer keeps the evidence.`
        : `The verifier settled invalid. The escrow credited the buyer, who withdrew a full refund. The seller was paid nothing and the buyer does not get the package.`)}
      <ol class="story">${events.map((e) => `<li class="reveal">
        <div class="story-dot"></div>
        <div class="story-body">
          <p class="story-t">${esc(EVENT_STORY[e.kind] ?? e.detail ?? e.kind)}</p>
          <div class="story-meta"><span class="actor">${esc(e.actor)}</span><span>${esc(when(e.ts))}</span>${e.tx_hash ? `<span>${txCell(e.tx_hash, e.chain_mode)}</span><span class="muted">block ${esc(e.block_number)}</span>` : `<span class="muted">off chain</span>`}</div>
        </div></li>`).join("")}</ol>
      ${disclosure("Show every transaction", `<table class="data"><tbody>
        ${[["fund", o.fund_tx], ["markDelivered", o.deliver_tx], ["requestRecheck", o.recheck_tx], ["settle", o.settle_tx], ["withdraw", o.withdraw_tx], ["claimTimeout", o.timeout_tx], ["registerListing", l.register_tx]]
          .filter(([, h]) => !!h).map(([k, h]) => `<tr><td class="mono">${esc(k)}</td><td>${txCell(h as string, o.chain_mode)}</td></tr>`).join("")}
      </tbody></table>`, o.chain_mode === "testnet" ? "explorer links are real Base Sepolia transactions" : "local anvil: no explorer")}` })}`;

  armPage(view);
  wireRail();
  await renderRevealStage(document.getElementById("reveal-wrap")!, o, env, valid, tv, targetId);
}

function wireRail(): void {
  const rail = document.getElementById("rail");
  if (!rail) return;
  // scroll the stage under the sticky header + rail, not behind them
  const offset = (document.getElementById("topbar")?.offsetHeight ?? 60) + rail.offsetHeight + 8;
  rail.querySelectorAll<HTMLButtonElement>("button[data-goto]").forEach((b) => {
    b.addEventListener("click", () => {
      const el = document.getElementById(b.dataset.goto!);
      if (!el) return;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: reducedMotion() ? "auto" : "smooth" });
    });
  });
  if (!("IntersectionObserver" in window)) return;
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      rail.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.goto === e.target.id));
    }
  }, { rootMargin: "-30% 0px -60% 0px" });
  STAGES.forEach(([id]) => { const el = document.getElementById("stage-" + id); if (el) obs.observe(el); });
}

// ------------------------------------------------------------------ stage 3
async function renderRevealStage(host: HTMLElement, o: Order, env: EnvelopeDoc, valid: boolean, view: TargetView, targetId: string): Promise<void> {
  const head = stageHead("reveal", 3, "The reveal", "");
  if (!o.revealed_in_buyer_console) {
    host.innerHTML = `${stageHead("reveal", 3, "The reveal", valid
      ? "This order's package was not retrieved by the buyer agent on this instance, so there is nothing to replay here."
      : "No package was retrieved for this order on this instance, and a refunded order cannot be retrieved afterwards: once the escrow settles invalid, the delivery route refuses the buyer's signature. The buyer paid, the delivery failed the verifier's check, and the money came back.")}
      <div class="sealed reveal"><div class="sealed-mark">sealed</div><p class="prose">The private package for this order is not served. What anyone can still read is the public summary, every check the verifier ran, and the complete on-chain record below.</p></div>`;
    armPage(host);
    return;
  }
  host.innerHTML = `${head}<p class="lede reveal">Loading the purchased package and the public baseline run…</p>`;
  try {
    const [pkg, baseline] = await Promise.all([getJSON<Pkg>(`/api/orders/${o.order_id}/reveal`), getJSON<RunLike>(`/api/runs/baseline?target=${encodeURIComponent(targetId)}`)]);
    renderReveal(host, pkg, baseline, o, env, view);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) renderLocked(host, o, env);
    else throw e;
  }
}

/** HOSTED MODE: the paid evidence is not public. Only the buyer session issued by a signed-challenge
 *  retrieval (or the operator token) unlocks it, and the token is held by this browser alone. */
function renderLocked(host: HTMLElement, o: Order, env: EnvelopeDoc): void {
  host.innerHTML = `${stageHead("reveal", 3, "The reveal", "This instance is hosted at a public URL, so the paid evidence is not served to anonymous visitors. The exact conditions, the recorded trajectory, the replay frames and the salt stay closed until you prove you are this order's buyer.")}
    <div class="locked reveal">
      <div class="locked-head">${badge("authentication required", "bad")}</div>
      <p class="prose">Unlock it with the <strong>buyer session</strong> the retrieval route hands back — <span class="mono">POST /api/challenges</span>, sign the message with the buyer key, <span class="mono">POST /api/retrieve</span> returns the token in the <span class="mono">x-tb-session</span> header — or with the operator token, if the operator of this host configured one.</p>
      <div class="row">
        <input id="tok" type="password" placeholder="paste session or operator token" autocomplete="off">
        <button id="tok-go" class="btn">Unlock</button>
        ${getToken() ? `<button id="tok-clear" class="btn ghost">Forget stored token</button>` : ""}
      </div>
      <p class="fineprint">The token stays in this browser and is sent to this app only. Public either way: the summary, every verifier check, the on-chain record, and both published ranges — ${esc(env.controller_tuned_range.prose)} versus a searched envelope of ${esc(env.searched_envelope.prose)}.</p>
    </div>`;
  armPage(host);
  const input = document.getElementById("tok") as HTMLInputElement;
  const go = (): void => { setToken(input.value.trim()); location.reload(); };
  document.getElementById("tok-go")!.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go(); });
  document.getElementById("tok-clear")?.addEventListener("click", () => { setToken(""); location.reload(); });
}

function changedChips(pkg: Pkg): string {
  return `<div class="chips reveal">${pkg.changed_conditions.map((c) => `<div class="chg"><span class="chg-p mono">${esc(c.parameter)}</span><span class="chg-v"><s>${esc(String(c.nominal))}</s> → <strong>${esc(String(c.value))}</strong> ${esc(c.unit === "1" ? "" : c.unit)}</span></div>`).join("") || `<div class="chg">nothing changed (nominal)</div>`}</div>`;
}

function metricsTable(view: TargetView, baseline: RunLike, pkg: Pkg): string {
  const rows = view.metrics(baseline, pkg);
  return `<table class="data"><thead><tr><th>Metric</th><th>Baseline</th><th>This finding</th></tr></thead><tbody>${rows.map(([k, a, b]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(a)}</td><td class="mono">${esc(b)}</td></tr>`).join("")}</tbody></table>`;
}

/** SEARCH COST, post-purchase and as an AGGREGATE: how many simulations the hunt ran and how many of
 *  them produced this finding's failure class. It is a property of the search, not of the scenario —
 *  no parameter, no value and no range of this finding is narrowed by it — and it is shown only after
 *  the package has been paid for and revealed. */
function searchCostBlock(pkg: Pkg, p: FailurePresentation): string {
  const h = pkg.hunter;
  if (!h) return "";
  const k = h.counts.by_class?.[p.class_id];
  const cost = h.search_cost;
  const rate = cost.simulations > 0 && typeof k === "number" ? ` — ${((k / cost.simulations) * 100).toFixed(0)} % of the sweep` : "";
  return `<div class="searchcost reveal">
    <div class="sc-head">What this finding cost to find</div>
    <p class="prose">The hunter ran <strong>${esc(cost.simulations)} simulations</strong> in this sweep${typeof k === "number" ? `, and <strong>${esc(k)}</strong> of them produced <span class="mono">${esc(p.class_id)}</span>${rate}` : ""}. ${esc(cost.sim_steps.toLocaleString())} physics steps, ${esc(cost.wall_time_s)} s of wall time, ${esc(h.distinct_findings)} distinct findings after the duplicate rule and ${esc(h.near_duplicates)} near-duplicates dropped. Search mode <span class="mono">${esc(h.mode)}</span>, hunter <span class="mono">${esc(h.id)}</span>.</p>
    <p class="fineprint">This is an aggregate over the whole sweep, published after purchase. It says nothing about which conditions were tried: a count of simulations narrows no scenario. Adversarially selected failures are not failure frequencies — this ratio describes the hunter's search, not how often anything fails in the field.</p>
  </div>`;
}

/** Axes on which this scenario falls outside the range the controller was tuned for. An axis with no
 *  stated tuned range, or one this scenario does not set, cannot be outside anything. */
function outsideAxes(pkg: Pkg, env: EnvelopeDoc): string[] {
  const tuned = env.controller_tuned_range.per_parameter;
  return env.axes.filter((a) => {
    const v = Number(pkg.scenario[a.name]);
    return Number.isFinite(v) && !inTuned(v, tuned[a.name] ?? {});
  }).map((a) => a.name);
}

function renderReveal(host: HTMLElement, pkg: Pkg, baseline: RunLike, o: Order, env: EnvelopeDoc, view: TargetView): void {
  const failureRun: RunLike = { scenario: pkg.scenario, scene: pkg.scene, metrics: pkg.metrics, events: pkg.events, ticks: pkg.ticks, frames: pkg.replay.frames, trajectory_hash: pkg.replay.trajectory_hash, controller: pkg.controller, environment: pkg.environment, outcome: pkg.claim?.outcome, goal_m: pkg.goal_m ?? null, initial_state_check: pkg.initial_state_check };
  const p: FailurePresentation = presentFailure(failureRun, baseline);
  const hashMatch = o.delivery_check ? o.delivery_check.valid : null;

  const mk = (label: string, v: unknown, unit: string, dec: number, note = ""): string =>
    typeof v === "number" && Number.isFinite(v) ? `<div class="metric reveal"><div class="metric-v">${counter(v, unit, dec)}</div><div class="metric-k">${esc(label)}</div>${note ? `<div class="metric-n">${esc(note)}</div>` : ""}</div>` : "";

  const honest = o.delivery_check ? o.delivery_check.valid : true;
  const revealLede = honest
    ? `This is the run the buyer paid for, played back from the body transforms recorded when it was simulated. Nothing is re-simulated in your browser. <strong>${esc(p.sentence)}</strong>`
    : `These are the bytes the seller actually served. They do <strong>not</strong> hash to the commitment registered on chain, so the verifier refused them and the buyer was refunded — what follows is the rejected delivery, not certified evidence. It is played back from its own recorded transforms; nothing is re-simulated in your browser.`;
  // A reader who opens the public URL cold gets this order's evidence without a token. Say so on the
  // page, next to the evidence itself, so nobody mistakes a published fixture for a hole in the gate.
  const fixtureNote = o.public_demo_fixture
    ? `<p class="fineprint reveal"><strong>${esc(o.public_demo_fixture_note ?? DEMO_FIXTURE_NOTE)}.</strong> This host publishes a short list of order ids whose evidence is served to anyone, so the whole flow can be read without a key. These packages are committed to the repository as evidence; every order not on that list still requires the buyer session from a signed retrieval, or the operator token.</p>`
    : "";
  host.innerHTML = `
    ${stageHead("reveal", 3, "The reveal", revealLede)}
    ${fixtureNote}
    <div class="chips-row reveal">
      ${badge(p.label, "bad")}
      ${p.also.map((a) => badge("also " + a.label.toLowerCase(), "warn")).join("")}
      ${p.headline_quantity ? badge(`${p.moment_label} ${p.headline_quantity.text}`, "bad") : ""}
      ${hashMatch === null ? "" : badge(hashMatch ? "package hash = commitment on chain" : "package hash ≠ commitment on chain", hashMatch ? "ok" : "bad")}
      ${pkg.tampered_by_demo ? badge("tampered (demo)", "warn") : ""}
    </div>

    <div class="viewer reveal">
      <div class="viewer-bar">
        <div class="seg" role="group" aria-label="view mode">
          <button data-mode="overlay" class="on">Ghost overlay</button>
          <button data-mode="split">Side by side</button>
        </div>
        <div class="legend">
          ${view.renderer.swatches.map((w) => `<span><i class="sw${w.thin ? " sw-thin" : ""}" style="background:${esc(w.color)}${w.translucent ? ";opacity:.45" : ""}"></i>${esc(w.label)}</span>`).join("")}
        </div>
      </div>
      <div id="viewport"></div>
      <div class="timeline">
        <div class="tl-track" id="tl-track">
          <div class="tl-fill" id="tl-fill"></div>
          <input id="scrub" type="range" min="0" max="1000" value="0" aria-label="playhead">
          ${p.markers.map((m, i) => `<div class="tl-mark ${m.kind} ${i % 2 ? "alt" : ""}" style="left:${((m.t_s / Math.max(replayDuration(pkg), 0.001)) * 100).toFixed(2)}%"><b></b><span>${esc(m.label)}</span></div>`).join("")}
          ${p.moment_t_s !== null ? (() => { const k = (p.moment_t_s! / Math.max(replayDuration(pkg), 0.001)) * 100; return `<div class="tl-callout${k > 74 ? " edge" : ""}" style="left:${k.toFixed(2)}%">${esc(p.headline)}</div>`; })() : ""}
        </div>
        <div class="tl-row">
          <button id="play" class="btn small">Pause</button>
          <button id="again" class="btn ghost small">Replay ${esc(p.moment_label.startsWith("the ") ? p.moment_label : "the " + p.moment_label)}</button>
          <span id="tlabel" class="mono"></span>
          <label class="speed">speed <select id="speed"><option value="0.25">0.25×</option><option value="0.5" selected>0.5×</option><option value="1">1×</option></select></label>
        </div>
      </div>
    </div>

    <div class="stat-strip">
      ${view.stats(pkg, baseline, p).map((st) => mk(st.label, st.value, st.unit, st.dec, st.note ?? "")).join("")}
    </div>

    ${searchCostBlock(pkg, p)}

    <div class="two-col wide-left">
      <div>
        <h3 class="sub reveal">What was different</h3>
        ${changedChips(pkg)}
        <p class="prose reveal">${view.narrate(pkg, baseline, p)}</p>
        ${p.quantities.length || p.severity_quantities.length ? `<p class="fineprint reveal">Recorded at ${esc(p.moment_label)}: ${p.quantities.map((q) => `${esc(q.label)} ${esc(q.text)}`).join(" · ")}${p.severity_moment ? `; at ${esc(p.severity_label)}: ${p.severity_quantities.map((q) => `${esc(q.label)} ${esc(q.text)}`).join(" · ")}` : ""}${p.attributes.length ? ` · ${p.attributes.map((a) => `${esc(a.label)} ${esc(a.value)}`).join(" · ")}` : ""}. Failure class <span class="mono">${esc(p.classes.join(", "))}</span>, read from the run document.</p>` : ""}
        ${p.also.length ? `<p class="prose reveal">This run failed in more than one way. ${p.also.map((a) => `<strong>${esc(a.label)}</strong>${a.t_s !== null ? ` at <span class="mono">${num(a.t_s, 3)} s</span>` : ""}`).join(", ")} — marked on the timeline above alongside ${esc(p.moment_label)}.</p>` : ""}
      </div>
      <div>
        <h3 class="sub reveal">Where this finding sits</h3>
        <p class="prose reveal">${outsideAxes(pkg, env).length === 0
          ? `Every parameter of this scenario is inside the ${esc(env.controller_tuned_range.label)}: this failure is inside its own published assumptions.`
          : `Outside the ${esc(env.controller_tuned_range.label)} on ${outsideAxes(pkg, env).map((n) => `<span class="mono">${esc(n)}</span>`).join(" and ")}, and inside the published searched envelope on every axis. It is a measured boundary of how far the operating range can be widened — not evidence that it is broken where it was designed to work.`}</p>
      </div>
    </div>
    ${rangeBars(env, pkg.scenario)}

    ${disclosure("Show the full metric comparison", metricsTable(view, baseline, pkg), "baseline versus this finding")}
    ${disclosure("Show hashes, scenario and reproduction", `${facts([
      ["Scenario", `<span class="mono">${esc(JSON.stringify(pkg.scenario))}</span>`],
      ["Nominal", `<span class="mono">${esc(JSON.stringify(pkg.nominal_scenario))}</span>`],
      ["Target", `<span class="mono">${esc(pkg.target_id ?? "cart")}</span> · ${esc(pkg.target_label ?? "warehouse cart")}`],
      ["Subject hash", `<span class="mono">${esc(pkg.controller.hash)}</span>`],
      ["Trajectory hash", `<span class="mono">${esc(pkg.replay.trajectory_hash)}</span><div class="sub-mono">baseline ${esc(baseline.trajectory_hash)}</div>`],
      ["Salt", `<span class="mono">${esc(pkg.salt_hex)}</span>`],
      ["Reproduce", `<pre class="json">${esc(pkg.reproduce.command)}</pre><div class="sub-mono">${esc(pkg.reproduce.note)}</div>`],
    ])}`, "canonical JSON tb-cjson-1")}
    ${disclosure("Show provenance and environment pins", facts([
      ["Engine", `<span class="mono">${esc(pkg.environment.engine)} ${esc(pkg.environment.engine_version)}</span>`],
      ["Integrator", `<span class="mono">${esc(pkg.environment.integrator)}, timestep ${esc(pkg.environment.physics_timestep_s)} s, ${esc(pkg.environment.substeps_per_tick)} substeps per ${esc(pkg.environment.control_dt_s)} s control tick</span>`],
      ["Runtime", `<span class="mono">Python ${esc(pkg.environment.python_version)}, NumPy ${esc(pkg.environment.numpy_version)}, ${esc(pkg.environment.platform)}, ${esc(pkg.environment.threads)} thread</span>`],
      ["Dependency lock", `<span class="mono">${esc(pkg.environment.uv_lock_sha256)}</span>`],
      ["Envelope", `<span class="mono">${esc(pkg.envelope_id)}</span>`],
      ["Package schema", `<span class="mono">${esc(pkg.schema)}</span> · sealed ${esc(when(pkg.created_at))}`],
    ]), "what would have to match to reproduce this bit for bit")}`;

  armPage(host);
  mountReplay(host, baseline, failureRun, pkg, p, view);
}

function replayDuration(pkg: Pkg): number {
  const d = pkg.replay.frames.data;
  return d.length ? d[d.length - 1][0] : 1;
}

function mountReplay(host: HTMLElement, baseline: RunLike, failureRun: RunLike, pkg: Pkg, p: FailurePresentation, view: TargetView): void {
  const viewport = host.querySelector<HTMLElement>("#viewport")!;
  try {
    replay = createReplay(viewport, { renderer: view.renderer, baseline, failure: failureRun, failureFrames: pkg.replay.frames, presentation: p, mode: "overlay", reducedMotion: reducedMotion(), baselineLabel: view.baselineLabel, failureLabel: view.failureLabel });
  } catch (e) {
    viewport.innerHTML = `<div class="note bad">The 3D replay is unavailable in this browser (${esc((e as Error)?.message ?? e)}). The recorded transforms are still in the package; every metric and hash below is unaffected.</div>`;
    host.querySelector(".timeline")?.remove();
    host.querySelector(".viewer-bar")?.remove();
    return;
  }
  (window as any).tbReplay = replay; // debug handle (no secrets; the package is already revealed on this page)

  const scrub = host.querySelector<HTMLInputElement>("#scrub")!;
  const fill = host.querySelector<HTMLElement>("#tl-fill")!;
  const play = host.querySelector<HTMLButtonElement>("#play")!;
  const tlabel = host.querySelector<HTMLElement>("#tlabel")!;
  const setLabel = (): void => { play.textContent = replay!.isPlaying() ? "Pause" : "Play"; };
  replay.onTime((t) => {
    const k = t / replay!.duration;
    scrub.value = String(Math.round(k * 1000));
    fill.style.width = (k * 100).toFixed(2) + "%";
    tlabel.textContent = `${t.toFixed(2)} s / ${replay!.duration.toFixed(2)} s`;
    setLabel();
  });
  scrub.addEventListener("input", () => { replay!.pause(); replay!.setTime((Number(scrub.value) / 1000) * replay!.duration); setLabel(); });
  play.addEventListener("click", () => { replay!.toggle(); setLabel(); });
  host.querySelector<HTMLSelectElement>("#speed")!.addEventListener("change", (e) => replay!.setSpeed(Number((e.target as HTMLSelectElement).value)));
  host.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => b.addEventListener("click", () => {
    host.querySelectorAll(".seg button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    replay!.setMode(b.dataset.mode as ViewMode);
  }));
  host.querySelectorAll<HTMLElement>(".tl-mark").forEach((m, i) => m.addEventListener("click", () => {
    const t = p.markers[i]?.t_s ?? 0;
    replay!.playThrough(Math.max(t - 0.6, 0), Math.min(t + 0.9, replay!.duration));
    setLabel();
  }));

  // THE DEFAULT VIEW IS THE IMPACT, NOT THE PARKED END OF THE RUN: open a lead-in before the failure
  // moment and play through it once, so a visitor sees the failure without touching anything.
  const from = defaultPlayhead(p.moment_t_s, replay.duration);
  const to = autoplayStop(p.moment_t_s, replay.duration);
  const again = host.querySelector<HTMLButtonElement>("#again")!;
  again.addEventListener("click", () => { replay!.playThrough(from, to); setLabel(); });

  const q = new URLSearchParams(location.search);
  const t0 = Number(q.get("t"));
  if (q.has("t") && Number.isFinite(t0)) { replay.setTime(t0); replay.pause(); }
  else if (q.get("paused") === "1") { replay.setTime(from); replay.pause(); }
  // prefers-reduced-motion: do not autoplay — open ON the failure frame instead, so the reader still
  // sees the moment without anything moving until they ask for it.
  else if (reducedMotion()) { replay.setTime(p.moment_t_s ?? from); replay.pause(); }
  else replay.playThrough(from, to);
  setLabel();
}
