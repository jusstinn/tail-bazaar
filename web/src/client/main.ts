import { getJSON, postJSON, type DemoRun, type Listing, type Order, type Pkg, type RunLike, type Status, type Ev } from "./api.js";
import { addrCell, esc, eth, num, short, txCell, when } from "./format.js";
import { createReplay, type Replay } from "./replay.js";

const view = document.getElementById("view")!;
let status: Status | null = null;
let replay: Replay | null = null;
let pollTimer: number | null = null;

function badge(text: string, cls = ""): string { return `<span class="badge ${cls}">${esc(text)}</span>`; }
function statusClass(s: string): string {
  if (/VALID$|SettledValid/.test(s) && !/INVALID|SettledInvalid/.test(s)) return "ok";
  if (/INVALID|Refunded|REFUND/.test(s)) return "bad";
  if (/LISTED|Listed/.test(s)) return "info";
  return "";
}

async function loadStatus(): Promise<Status> {
  status = await getJSON<Status>("/api/status");
  document.getElementById("chainbar")!.innerHTML = `
    ${badge(status.chain_mode === "testnet" ? "BASE SEPOLIA TESTNET" : "LOCAL ANVIL", status.chain_mode === "testnet" ? "testnet" : "local")}
    <span class="muted">${esc(status.chain_label)}</span>
    <span class="sep"></span><span class="muted">escrow</span> ${status.escrow_address ? addrCell(status.escrow_address, status.chain_mode) : "<span class='muted'>not configured</span>"}
    <span class="sep"></span><span class="muted">block</span> <span class="mono">${status.latest_block ?? "unreachable"}</span>
    <span class="sep"></span>${badge(status.mode, "demo")}`;
  return status;
}

function route(): void {
  const hash = location.hash || "#/";
  if (replay) { replay.dispose(); replay = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const m = hash.match(/^#\/orders\/(0x[0-9a-fA-F]{64})$/);
  if (m) renderOrder(m[1]).catch(showError);
  else renderMarket().catch(showError);
}

function showError(e: unknown): void {
  view.innerHTML = `<div class="card error"><strong>Error</strong><pre>${esc((e as Error)?.message ?? e)}</pre></div>`;
}

// ------------------------------------------------------------------ marketplace
async function renderMarket(): Promise<void> {
  const st = await loadStatus();
  const [listings, orders, demo] = await Promise.all([getJSON<Listing[]>("/api/listings"), getJSON<Order[]>("/api/orders"), getJSON<{ enabled: boolean; run: DemoRun }>("/api/demo/status")]);
  view.innerHTML = `
    <section class="hero">
      <h1>Reproducible failure scenarios for warehouse robot controllers</h1>
      <p>Autonomous hunter agents search a published operating envelope for admissible conditions under which a fixed controller collides. A verifier re-simulates each claim in its own pinned environment, publishes a coarse summary, and registers the salted package commitment on chain. Buyers pay into escrow, retrieve the private package with a signed challenge, and the verifier settles or refunds.</p>
      <p class="muted small">Adversarially selected failures do not estimate real-world failure frequency. Simulation requires calibration against physical robots before supporting underwriting decisions. Severity bands are an impact-speed proxy, not a damage estimate.</p>
    </section>
    <section class="card">
      <div class="card-head"><h2>Listings</h2><span class="muted small">pre-purchase view: controller, envelope, admissibility, verification, severity band, seller history. Parameters and trajectories stay private.</span></div>
      ${listings.length === 0 ? `<p class="muted">No listings yet. Run the demonstration pipeline below.</p>` : `
      <table><thead><tr><th>Listing</th><th>Controller</th><th>Envelope</th><th>Admissible</th><th>Verification</th><th>Severity band</th><th>Seller</th><th>Settled orders</th><th>Price</th><th>On chain</th><th></th></tr></thead><tbody>
      ${listings.map((l) => {
        const s = l.public_summary;
        const order = orders.find((o) => o.listing_id === l.listing_id);
        return `<tr>
          <td class="mono" title="${esc(l.listing_id)}">${esc(short(l.listing_id, 10, 6))}${l.demo_note ? `<div class="tiny warn" title="${esc(l.demo_note)}">demo: tampered delivery</div>` : ""}</td>
          <td><div>${esc(s.controller.id)}</div><div class="mono tiny muted" title="${esc(s.controller.hash)}">${esc(short(s.controller.hash, 14, 6))}</div></td>
          <td>${esc(s.envelope_id)}</td>
          <td>${s.admissible ? badge("yes", "ok") : badge("no", "bad")}</td>
          <td>${badge(s.verification.status, s.verification.status === "VERIFIED" ? "ok" : "bad")}<div class="tiny muted">${esc(s.verification.method ?? "")}</div></td>
          <td>${badge(s.severity.band, "sev-" + s.severity.band)}<div class="tiny muted">${esc(s.severity.proxy)}</div></td>
          <td>${addrCell(l.seller, l.chain_mode)}</td>
          <td class="mono">${l.seller_settled_orders ?? "—"}</td>
          <td class="mono">${esc(eth(l.price_wei))}</td>
          <td>${l.on_chain ? badge(l.on_chain.status, statusClass(l.on_chain.status)) : badge("unreachable", "bad")}<div class="tiny">${txCell(l.register_tx, l.chain_mode)}</div></td>
          <td>${order ? `<a class="btn small" href="#/orders/${esc(order.order_id)}">order</a>` : `<span class="muted tiny">no order</span>`}</td>
        </tr>`; }).join("")}
      </tbody></table>`}
    </section>
    <section class="card">
      <div class="card-head"><h2>Orders</h2><span class="muted small">real transaction status; explorer links only for Base Sepolia transactions</span></div>
      ${orders.length === 0 ? `<p class="muted">No orders yet.</p>` : `
      <table><thead><tr><th>Order</th><th>Buyer</th><th>Price</th><th>Status</th><th>fund</th><th>markDelivered</th><th>settle</th><th>withdraw</th><th>Verifier check</th><th></th></tr></thead><tbody>
      ${orders.map((o) => `<tr>
        <td class="mono" title="${esc(o.order_id)}">${esc(short(o.order_id, 10, 6))}</td>
        <td>${addrCell(o.buyer, o.chain_mode)}</td>
        <td class="mono">${esc(eth(o.price_wei))}</td>
        <td>${badge(o.status, statusClass(o.status))}</td>
        <td>${txCell(o.fund_tx, o.chain_mode)}</td><td>${txCell(o.deliver_tx, o.chain_mode)}</td><td>${txCell(o.settle_tx, o.chain_mode)}</td><td>${txCell(o.withdraw_tx, o.chain_mode)}</td>
        <td>${o.delivery_check ? badge(o.delivery_check.valid ? "valid" : "invalid", o.delivery_check.valid ? "ok" : "bad") : "<span class='muted'>pending</span>"}</td>
        <td><a class="btn small" href="#/orders/${esc(o.order_id)}">open</a></td>
      </tr>`).join("")}
      </tbody></table>`}
    </section>
    <section class="card" id="demo-card">
      <div class="card-head"><h2>Local demonstration pipeline</h2><span class="muted small">seller, verifier and buyer agents run server-side with test-only keys</span></div>
      <p class="small">Runs the whole workflow against <strong>${esc(st.chain_label)}</strong>: the seller agent runs the bounded grid hunt (144 MuJoCo simulations), submits its two mildest distinct collisions; the verifier re-simulates each in its own pinned environment, compares trajectory hashes, publishes summaries and registers listings; the buyer agent applies its deterministic policy (verified, compatible controller, within budget ${esc(eth(st.buyer_budget_wei))}), funds escrow, signs the retrieval challenge, retrieves and checks the package; the verifier checks the delivery against the on-chain commitment and settles. The second listing's delivery is deliberately tampered to demonstrate the refund path.</p>
      <div class="row">
        <button id="run-demo" class="btn" ${st.demo_trigger_enabled ? "" : "disabled"}>Run pipeline</button>
        <span id="demo-state" class="muted small">${demo.run ? `last run ${esc(demo.run.run_id)}: ${esc(demo.run.status)}` : "no run yet"}</span>
      </div>
      <pre id="demo-log" class="log">${demo.run ? esc(demo.run.log.map((l) => l.msg).join("\n")) : ""}</pre>
    </section>
    <section class="card small muted">
      <p><strong>Roles (test-only keys, server-side):</strong> verifier ${addrCell(st.roles.verifier, st.chain_mode)} · seller ${addrCell(st.roles.seller, st.chain_mode)} · buyer ${addrCell(st.roles.buyer, st.chain_mode)}. A deployed version keeps only the verifier key on the server; buyers and sellers sign with their own wallets and automated spending is limited by per-key budgets, allowlisted contracts and rate limits (see README).</p>
    </section>`;
  document.getElementById("run-demo")!.addEventListener("click", async () => {
    const btn = document.getElementById("run-demo") as HTMLButtonElement;
    btn.disabled = true;
    try { await postJSON("/api/demo/run", {}); } catch (e) { (document.getElementById("demo-state")!).textContent = String((e as Error).message); }
    startPolling();
  });
  if (demo.run && demo.run.status === "running") startPolling();
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = window.setInterval(async () => {
    const d = await getJSON<{ enabled: boolean; run: DemoRun }>("/api/demo/status");
    const log = document.getElementById("demo-log");
    const state = document.getElementById("demo-state");
    if (!log || !state || !d.run) return;
    log.textContent = d.run.log.map((l) => l.msg).join("\n");
    log.scrollTop = log.scrollHeight;
    state.textContent = `${d.run.run_id}: ${d.run.status}${d.run.error ? " — " + d.run.error : ""}`;
    if (d.run.status !== "running") { clearInterval(pollTimer!); pollTimer = null; route(); }
  }, 1500);
}

// ------------------------------------------------------------------ order + reveal
const KIND_LABEL: Record<string, string> = {
  verified: "Verifier re-simulated and verified the claim", registered: "registerListing (verifier)", funded: "fund (buyer) — escrow funded", delivered: "markDelivered (seller)",
  retrieved: "Buyer retrieved the package with a signed challenge", recheck_requested: "requestRecheck (buyer) — event only", settled_valid: "settle(valid) — seller credited",
  settled_invalid: "settle(invalid) — buyer credited", withdrawn: "withdraw (seller)", refund_withdrawn: "withdraw (buyer refund)",
};

function checksTable(checks: { name: string; ok: boolean; detail?: string }[]): string {
  return `<table class="checks"><tbody>${checks.map((c) => `<tr><td>${badge(c.ok ? "ok" : "fail", c.ok ? "ok" : "bad")}</td><td>${esc(c.name)}</td><td class="muted mono tiny">${esc(c.detail ?? "")}</td></tr>`).join("")}</tbody></table>`;
}

async function renderOrder(orderId: string): Promise<void> {
  await loadStatus();
  const o = await getJSON<Order>(`/api/orders/${orderId}`);
  const l = o.listing!;
  const s = l.public_summary;
  const events = (o.events ?? []) as Ev[];
  view.innerHTML = `
    <a class="back" href="#/">← marketplace</a>
    <section class="card">
      <div class="card-head"><h2>Order <span class="mono">${esc(short(o.order_id, 14, 8))}</span></h2>
        <span>${badge(o.chain_mode === "testnet" ? "BASE SEPOLIA" : "LOCAL ANVIL", o.chain_mode === "testnet" ? "testnet" : "local")} ${badge(o.status, statusClass(o.status))} ${o.on_chain ? badge("on chain: " + o.on_chain.status, statusClass(o.on_chain.status)) : ""}</span></div>
      <div class="grid2">
        <div>
          <h3>Pre-purchase summary (public)</h3>
          <dl>
            <dt>Controller</dt><dd>${esc(s.controller.id)} <span class="mono tiny muted">${esc(s.controller.hash)}</span></dd>
            <dt>Envelope</dt><dd>${esc(s.envelope_id)}</dd>
            <dt>Admissible</dt><dd>${s.admissible ? "yes" : "no"}</dd>
            <dt>Verification</dt><dd>${badge(s.verification.status, "ok")} ${esc(s.verification.method ?? "")} · ${esc(s.verification.verifier_version)} · fingerprint <span class="mono tiny">${esc(short(s.verification.environment_fingerprint, 12, 6))}</span></dd>
            <dt>Severity band</dt><dd>${badge(s.severity.band, "sev-" + s.severity.band)} <span class="tiny muted">${esc(s.severity.definition)}</span></dd>
            <dt>Seller</dt><dd>${addrCell(l.seller, l.chain_mode)} · settled orders now: <span class="mono">${l.seller_settled_orders ?? "—"}</span> (at listing: ${s.seller_settled_orders_at_listing})</dd>
            <dt>Price</dt><dd class="mono">${esc(eth(l.price_wei))}</dd>
            <dt>Commitment</dt><dd class="mono tiny">${esc(l.commitment)}</dd>
            <dt>Terms hash</dt><dd class="mono tiny">${esc(l.terms_hash)}</dd>
            <dt>Hidden until purchase</dt><dd class="tiny muted">${esc(s.hidden)}</dd>
          </dl>
        </div>
        <div>
          <h3>Timeline</h3>
          <table class="timeline"><tbody>
          ${events.map((e) => `<tr>
            <td class="tiny muted">${esc(when(e.ts))}</td>
            <td><strong>${esc(e.actor)}</strong> ${esc(KIND_LABEL[e.kind] ?? e.kind)}</td>
            <td>${e.tx_hash ? `${txCell(e.tx_hash, e.chain_mode)}<div class="tiny muted">confirmed, block ${e.block_number}</div>` : `<span class="tiny muted">off-chain</span>`}</td>
          </tr>`).join("")}
          </tbody></table>
          ${o.on_chain?.delivery_deadline ? `<p class="tiny muted">Deadlines (unix): delivery ${o.on_chain.delivery_deadline}, settlement ${o.on_chain.settlement_deadline}. After a missed deadline anyone can call claimTimeout to refund the buyer.</p>` : ""}
        </div>
      </div>
    </section>
    <section class="card">
      <div class="grid2">
        <div><h3>Verifier delivery check</h3>${o.delivery_check ? `<p>${badge(o.delivery_check.valid ? "VALID" : "INVALID", o.delivery_check.valid ? "ok" : "bad")} ${esc(o.delivery_check.reason)}</p>
          <p class="tiny mono">on-chain commitment ${esc(o.delivery_check.on_chain_commitment)}<br>keccak256(delivered) ${esc(o.delivery_check.delivered_hash)}<br>seller asserted ${esc(o.delivery_check.asserted_delivery_hash ?? "—")}</p>${checksTable(o.delivery_check.checks)}` : "<p class='muted'>pending</p>"}</div>
        <div><h3>Buyer's own check</h3>${o.buyer_check ? `<p>${badge(o.buyer_check.ok ? "OK" : "FAILED", o.buyer_check.ok ? "ok" : "bad")} ${esc(o.buyer_check.reason)}</p>${checksTable(o.buyer_check.checks)}` : "<p class='muted'>pending</p>"}</div>
      </div>
    </section>
    <section id="reveal" class="card"></section>`;
  const reveal = document.getElementById("reveal")!;
  if (!o.revealed_in_buyer_console) {
    reveal.innerHTML = `<h3>Private package</h3><p class="muted">Not retrieved by the local buyer agent for this order${o.status === "SETTLED_INVALID" ? " — refunded orders do not unlock a package" : ""}.</p>`;
    return;
  }
  reveal.innerHTML = `<h3>Revealed finding (buyer console, local demonstration mode)</h3><p class="muted">loading package and public baseline…</p>`;
  const [pkg, baseline] = await Promise.all([getJSON<Pkg>(`/api/orders/${orderId}/reveal`), getJSON<RunLike>("/api/runs/baseline")]);
  renderReveal(reveal, pkg, baseline, o);
}

function renderReveal(host: HTMLElement, pkg: Pkg, baseline: RunLike, o: Order): void {
  const failureRun: RunLike = { scenario: pkg.scenario, scene: pkg.scene, metrics: pkg.metrics, events: pkg.events, ticks: pkg.ticks, frames: pkg.replay.frames, trajectory_hash: pkg.replay.trajectory_hash, controller: pkg.controller, environment: pkg.environment };
  const hashMatch = o.delivery_check ? o.delivery_check.valid : null;
  const bOnset = baseline.events.find((e: any) => e.type === "brake_onset");
  const fOnset = pkg.events.find((e: any) => e.type === "brake_onset");
  const fContact = pkg.events.find((e: any) => e.type === "first_contact");
  const obs = pkg.scene.obstacle_front_x_m as number;
  const trueRangeAtOnset = fOnset ? obs - fOnset.x_front_m : null;
  const bTrueRangeAtOnset = bOnset ? obs - bOnset.x_front_m : null;
  const changed = pkg.changed_conditions.map((c) => `<li><strong>${esc(c.parameter)}</strong>: ${esc(String(c.nominal))} → <strong>${esc(String(c.value))}</strong> ${esc(c.unit === "1" ? "" : c.unit)}</li>`).join("");
  host.innerHTML = `
    <div class="card-head"><h3>Revealed finding (buyer console, local demonstration mode)</h3>
      <span>${hashMatch === null ? "" : badge(hashMatch ? "package hash = on-chain commitment" : "package hash ≠ on-chain commitment", hashMatch ? "ok" : "bad")} ${pkg.tampered_by_demo ? badge("TAMPERED (demo)", "bad") : ""}</span></div>
    <div id="viewport"></div>
    <div class="controls">
      <button id="play" class="btn">Play</button>
      <input id="scrub" type="range" min="0" max="1000" value="0">
      <span id="tlabel" class="mono">0.00 s</span>
      <select id="speed"><option value="0.25">0.25×</option><option value="0.5" selected>0.5×</option><option value="1">1×</option></select>
      <button class="btn small jump" data-t="${fOnset ? fOnset.t_s : 0}">brake onset</button>
      <button class="btn small jump" data-t="${fContact ? fContact.t_s : 0}">first contact</button>
    </div>
    <div class="grid2">
      <div>
        <h3>What changed</h3>
        <ul class="changes">${changed || "<li>nothing (nominal)</li>"}</ul>
        <p>${fOnset ? `The controller started braking at <span class="mono">t = ${num(fOnset.t_s, 2)} s</span> moving at <span class="mono">${num(fOnset.speed_mps, 2)} m/s</span>. Because the range measurement was ${esc(String(pkg.scenario.sensor_delay_ms))} ms stale it believed the obstacle was <span class="mono">${num(fOnset.range_used_m, 2)} m</span> away while the true range was <span class="mono">${num(trueRangeAtOnset, 2)} m</span>${bOnset ? ` (baseline: braking began at ${num(bOnset.t_s, 2)} s with ${num(bTrueRangeAtOnset, 2)} m of true range)` : ""}.` : "The controller never braked before contact."}
        ${fContact ? ` On a floor with friction ${esc(String(pkg.scenario.floor_friction))} the wheels could not deliver the requested deceleration and the chassis reached the obstacle at <span class="mono">t = ${num(fContact.t_s, 3)} s</span> with an impact speed of <span class="mono">${num(pkg.metrics.impact_speed_mps, 3)} m/s</span> (kinetic energy ${num(pkg.metrics.impact_kinetic_energy_j, 1)} J, a proxy only).` : ""}
        The baseline under nominal conditions stopped with <span class="mono">${num(baseline.metrics.final_clearance_m, 3)} m</span> of clearance (target ${num(baseline.metrics.target_clearance_m, 2)} m).</p>
      </div>
      <div>
        <h3>Metrics</h3>
        <table class="metrics"><thead><tr><th></th><th>baseline</th><th>failure</th></tr></thead><tbody>
          ${[["outcome", baseline.metrics.outcome, pkg.metrics.outcome], ["v_max (m/s)", num(baseline.metrics.v_max_mps), num(pkg.metrics.v_max_mps)], ["brake onset (s)", num(baseline.metrics.brake_onset_t_s, 2), num(pkg.metrics.brake_onset_t_s, 2)],
            ["stopping distance (m)", num(baseline.metrics.stopping_distance_m), pkg.metrics.stopping_distance_m === null ? "undefined (collision)" : num(pkg.metrics.stopping_distance_m)],
            ["final clearance (m)", num(baseline.metrics.final_clearance_m), num(pkg.metrics.final_clearance_m)], ["first contact (s)", "—", num(pkg.metrics.first_contact_t_s, 3)],
            ["impact speed (m/s)", "—", num(pkg.metrics.impact_speed_mps)], ["brake onset → impact (m)", "—", num(pkg.metrics.distance_brake_onset_to_impact_m)], ["peak decel (m/s²)", num(baseline.metrics.peak_decel_mps2, 2), num(pkg.metrics.peak_decel_mps2, 2)], ["total mass (kg)", num(baseline.metrics.total_mass_kg, 1), num(pkg.metrics.total_mass_kg, 1)]]
            .map(([k, a, b]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(a)}</td><td class="mono">${esc(b)}</td></tr>`).join("")}
        </tbody></table>
      </div>
    </div>
    <details class="small"><summary>Scenario, hashes and reproduction</summary>
      <dl>
        <dt>Scenario</dt><dd class="mono">${esc(JSON.stringify(pkg.scenario))}</dd>
        <dt>Nominal</dt><dd class="mono">${esc(JSON.stringify(pkg.nominal_scenario))}</dd>
        <dt>Controller hash</dt><dd class="mono tiny">${esc(pkg.controller.hash)}</dd>
        <dt>Trajectory hash</dt><dd class="mono tiny">${esc(pkg.replay.trajectory_hash)} (failure) · ${esc(baseline.trajectory_hash)} (baseline)</dd>
        <dt>Engine</dt><dd class="mono tiny">${esc(JSON.stringify(pkg.environment))}</dd>
        <dt>Salt</dt><dd class="mono tiny">${esc(pkg.salt_hex)}</dd>
        <dt>Reproduce</dt><dd class="mono tiny">${esc(pkg.reproduce.command)}<br><span class="muted">${esc(pkg.reproduce.note)}</span></dd>
      </dl>
    </details>`;
  try {
    replay = createReplay(document.getElementById("viewport")!, baseline, failureRun, pkg.replay.frames);
  } catch (e) {
    document.getElementById("viewport")!.innerHTML = `<div class="card error small">3D replay unavailable in this browser (${esc((e as Error)?.message ?? e)}). The recorded transforms are still in the package; metrics and events below are unaffected.</div>`;
    document.querySelector(".controls")?.remove();
    return;
  }
  (window as any).tbReplay = replay; // debug handle (no secrets; the package is already revealed on this page)
  const scrub = document.getElementById("scrub") as HTMLInputElement;
  const play = document.getElementById("play") as HTMLButtonElement;
  const tlabel = document.getElementById("tlabel")!;
  replay.onTime((t) => { scrub.value = String(Math.round((t / replay!.duration) * 1000)); tlabel.textContent = `${t.toFixed(2)} s / ${replay!.duration.toFixed(2)} s`; if (t >= replay!.duration) play.textContent = "Replay"; });
  scrub.addEventListener("input", () => { replay!.pause(); play.textContent = "Play"; replay!.setTime((Number(scrub.value) / 1000) * replay!.duration); });
  play.addEventListener("click", () => { const p = replay!.toggle(); play.textContent = p ? "Pause" : "Play"; });
  (document.getElementById("speed") as HTMLSelectElement).addEventListener("change", (e) => replay!.setSpeed(Number((e.target as HTMLSelectElement).value)));
  document.querySelectorAll<HTMLButtonElement>(".jump").forEach((b) => b.addEventListener("click", () => { replay!.pause(); play.textContent = "Play"; replay!.setTime(Number(b.dataset.t) - 0.3); }));
  // Deep link: ?t=<seconds> seeks the replay, ?paused=1 keeps it paused (used for screenshots/demos)
  const q = new URLSearchParams(location.search);
  const t0 = Number(q.get("t"));
  if (Number.isFinite(t0) && q.has("t")) replay.setTime(t0);
  if (q.get("paused") === "1") { replay.pause(); play.textContent = "Play"; }
  else { replay.play(); play.textContent = "Pause"; }
}

window.addEventListener("hashchange", route);
route();
