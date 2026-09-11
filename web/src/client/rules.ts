// "How settlement works": what the verifier actually checks, what each verdict does to the money,
// what the deadlines do, and why a complaint is not a refund. Short prose and one state diagram;
// the details a specialist wants sit behind disclosures.
import { getJSON, type EnvelopesDoc, type Status } from "./api.js";
import { esc } from "./format.js";
import { armPage, band, disclosure, rangeBars } from "./ui.js";

/** The escrow state machine, drawn rather than listed. Terminal states carry the money line. */
function stateDiagram(): string {
  const boxL = (x: number, y: number, w: number, label: string, cls = "") => `<g class="sd-node ${cls}"><rect x="${x}" y="${y}" width="${w}" height="48" rx="8"/><text x="${x + w / 2}" y="${y + 29}" class="sd-t">${esc(label)}</text></g>`;
  const boxT = (x: number, y: number, w: number, label: string, money: string, cls: string) => `<g class="sd-node ${cls}"><rect x="${x}" y="${y}" width="${w}" height="48" rx="8"/><text x="${x + w / 2}" y="${y + 21}" class="sd-t">${esc(label)}</text><text x="${x + w / 2}" y="${y + 37}" class="sd-m">${esc(money)}</text></g>`;
  return `<figure class="diagram reveal">
  <svg viewBox="0 0 890 300" role="img" aria-label="Escrow state machine: Listed to Funded to Delivered, then settled valid, settled invalid, or refunded on timeout.">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs>
    ${boxL(10, 116, 112, "Listed")}
    ${boxL(212, 116, 112, "Funded")}
    ${boxL(414, 116, 122, "Delivered")}
    ${boxT(660, 30, 210, "Settled valid", "seller withdraws the price", "ok")}
    ${boxT(660, 116, 210, "Settled invalid", "buyer withdraws a full refund", "bad")}
    ${boxT(660, 202, 210, "Refunded", "buyer withdraws a full refund", "bad")}
    <g class="sd-edge">
      <path d="M122 140 H202"/><text x="162" y="132" class="sd-l">fund</text>
      <path d="M324 140 H404"/><text x="364" y="132" class="sd-l">deliver</text>
      <path d="M536 132 H596 V54 H650"/><text x="625" y="46" class="sd-l">VALID</text>
      <path d="M536 140 H650"/><text x="593" y="132" class="sd-l">INVALID</text>
      <path d="M536 148 H596 V226 H650"/><text x="625" y="218" class="sd-l">timeout</text>
      <path d="M268 164 V276 H765 V254"/><text x="420" y="268" class="sd-l">timeout, no delivery</text>
    </g>
  </svg>
  <figcaption>Exactly one terminal transition per listing. Only the verifier can settle, and the contract never lets the verifier take the funds. Payouts are pull payments: a settlement credits a balance, the party withdraws it.</figcaption>
</figure>`;
}

/** A parallel list in prose colour. The stylesheet has no generic list rule, so the browser bullets stand. */
const list = (items: string[]): string => `<ul class="prose reveal">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const mono = (s: string): string => `<span class="mono">${esc(s)}</span>`;

/** Verdict name, tone, what happens to the money, and what the verifier found (HTML). */
const VERDICTS: [string, string, string, string][] = [
  ["VALID", "ok",
    "The seller is credited with the price and withdraws it.",
    `<p class="prose">The verifier re-ran the scenario, the delivered bytes hash to the commitment registered on chain, and the evidence matches the claim it advertised. The buyer keeps the package.</p>`],
  ["INVALID", "bad",
    "The buyer is credited with a full refund and withdraws it. The seller is paid nothing.",
    `<p class="prose">Something the verifier can check did not hold. One of:</p>${list([
      "the bytes do not hash to the commitment",
      "the replay frames do not reproduce the trajectory the verifier itself ran",
      "the controller named in the package is not the controller that was re-run",
      "the evidence contradicts the advertised claim",
    ])}`],
  ["INCONCLUSIVE", "warn",
    "Nothing is released, and an inconclusive verdict never pays. It is a refusal to certify, not a failed delivery.",
    `<p class="prose">The verifier could not BIND the delivered evidence to anything it ran. Typically the seller's environment pin is not the verifier's own, so no hash can tie the delivered frames to the re-run. Metrics that agree across two different environments describe the scenario, not which frames were delivered, so they never certify.</p>`],
];

export async function renderRules(view: HTMLElement, _st: Status): Promise<void> {
  const envs = await getJSON<EnvelopesDoc>("/api/envelope");
  const env = envs.targets[0];
  view.innerHTML = `
    <section class="band hero">
      <div class="wrap">
        <div class="eyebrow reveal">How it is decided</div>
        <h1 class="display reveal">What the verifier checks,<br>and who ends up with the money.</h1>
        <p class="lede reveal">A buyer pays for evidence it may not inspect first. That only works if someone independent re-does the work, and if the payout rules are fixed before anyone pays. Both are written down here.</p>
        <p class="prose reveal">To watch it happen instead, the <a class="link-go" href="#/market">marketplace</a> has a <strong>Buy</strong> button on every unsold finding and a <strong>List a new finding</strong> button for each robot. Each runs the steps below live, one transaction at a time.</p>
      </div>
    </section>

    ${band({
      eyebrow: "Step one", inner: `
      <h2 class="section-title reveal">The verifier does not read the seller's numbers.<br>It runs the scenario again.</h2>
      <div class="prose-col">
        <p class="prose reveal">When a finding is submitted, the verifier loads the same artefact and the same scene into <strong>its own pinned environment</strong> and simulates the claimed conditions from scratch, <strong>with that robot's own simulator</strong>. What it compares afterwards is its own trajectory, not the seller's.</p>
        ${list([
          "Pinned environment: a specific MuJoCo build, NumPy and Python version, timestep and locked dependency set.",
          "Own simulator: the cart's CLI for a cart finding, the humanoid's for a humanoid one.",
        ])}
        <p class="prose reveal">Then it recomputes the identifiers from the bytes it was handed. A declared hash is never taken on trust.</p>
        ${list([
          "Artefact digest: must equal the one it just ran, so a real failure of one version cannot be sold under another version's name. For the cart, the SHA-256 of the controller file; for the humanoid, the digest of the six actor tensors of the pinned policy checkpoint.",
          `Trajectory hash: <em>recomputed</em> as ${mono("keccak256")} over the canonical replay frames, then compared both with the value the package declares and with the verifier's own re-run. Frames altered behind an intact declared hash are caught.`,
        ])}
        <p class="prose reveal">It also reads the delivered frames as a trajectory and asks whether this scene could have produced them at all. The speed ceiling is an impossibility line, not a tolerance.</p>
        ${list([
          "Derived per robot from its own published envelope and the scene the run carries.",
          "Cart: the fastest anything can move under gravity plus the most friction the envelope admits, over the simulator's own divergence bound.",
          "Humanoid: the same, plus the largest velocity change the published push axis can impart to the lightest admissible body.",
        ])}
        <p class="prose reveal">Finally it checks the claim itself, and only then registers the listing. Since only the verifier's address may register, the listing's existence <em>is</em> its statement that it re-ran the scenario and computed the commitment itself.</p>
        ${list([
          "conditions admissible inside that robot's published envelope",
          "a failure class that robot actually has",
          "the severity band the listing advertises",
          "not a near-duplicate of a finding already sold for that robot",
        ])}
        <p class="prose reveal">Both checks run a second time on the bytes the seller actually serves at delivery. The bytes delivered and the bytes verified are not the same event.</p>
      </div>`,
    })}

    ${band({
      eyebrow: "Step two", inner: `
      <h2 class="section-title reveal">Three verdicts. Each one moves the money differently.</h2>
      <div class="verdicts">${VERDICTS.map(([name, tone, money, what]) => `<div class="verdict reveal"><div class="verdict-name ${esc(tone)}">${esc(name)}</div><div><p class="verdict-money">${esc(money)}</p>${what}</div></div>`).join("")}</div>
      ${stateDiagram()}`,
    })}

    ${band({
      eyebrow: "Step three", tone: "quiet", inner: `
      <h2 class="section-title reveal">Silence resolves in the buyer's favour.</h2>
      <div class="two-col">
        <div>
          <p class="prose reveal">Two deadlines are fixed when the buyer funds the escrow and can never be changed afterwards. Once either passes, anyone may call ${mono("claimTimeout")} and the buyer is refunded in full.</p>
          ${list([
            "Delivery deadline: the seller has not delivered.",
            "Settlement deadline: the verifier has not settled.",
          ])}
          <p class="prose reveal">The seller therefore depends on a responsive verifier. A verifier that goes quiet costs the seller, never the buyer.</p>
        </div>
        <div>
          <h3 class="sub reveal">Why a buyer cannot keep valid data <em>and</em> reclaim the payment</h3>
          <p class="prose reveal">An unhappy buyer calls ${mono("requestRecheck")}. That function is restricted to the buyer of that listing and does exactly one thing: it emits an event. It moves no funds and changes no state.</p>
          <p class="prose reveal">The only function that moves money is the verifier's ${mono("settle")}, and the contract allows exactly one terminal transition per listing. A complaint is therefore a public signal the verifier must answer, not a refund the buyer can take for itself.</p>
        </div>
      </div>`,
    })}

    ${band({
      eyebrow: "What is actually being sold", inner: `
      <h2 class="section-title reveal">One published envelope per robot, in the same shape.</h2>
      <p class="prose reveal">Each robot's author documented the conditions it was built for. The hunter searches a deliberately wider range. A finding outside those conditions is therefore a measured boundary of the deployable range, not a defect report.</p>
      ${envs.targets.map((e) => `
        <h3 class="sub reveal">${esc(e.label ?? e.target_id)} · <span class="mono">${esc(e.envelope_id)}</span></h3>
        <blockquote class="pull reveal">${esc(e.product_question)}</blockquote>
        ${rangeBars(e, null)}
        <p class="fineprint reveal">Source: ${esc(e.controller_tuned_range.source)}. ${esc(e.note)}</p>
        ${disclosure(`Show the ${esc(e.short_label ?? e.target_id)} envelope in full`, `<table class="data"><thead><tr><th>Axis</th><th>Group</th><th>${esc(e.controller_tuned_range.verb)}</th><th>Searched</th><th>Nominal</th><th>Units</th></tr></thead><tbody>${e.axes.map((a) => `<tr><td class="mono">${esc(a.name)}</td><td>${esc(a.group)}</td><td class="mono">${esc(a.tuned_range)}</td><td class="mono">${esc(a.low)} – ${esc(a.high)}</td><td class="mono">${esc(a.nominal)}</td><td>${esc(a.units)} <span class="muted">(${esc(a.quantization)})</span></td></tr>`).join("")}</tbody></table><p class="fineprint">Failure classes: ${e.failure_classes.map((c) => `<strong>${esc(c.label)}</strong> (${esc(c.detected_by)}), severity proxy <span class="mono">${esc(c.severity_proxy)}</span> in ${esc(c.severity_units)}`).join("; ")}.</p><p class="fineprint">${esc(e.distribution)}</p><p class="fineprint">Duplicate rule: ${esc(e.duplicate_rule)}. Published as <span class="mono">${esc(e.yaml)}</span> and served by <span class="mono">GET /api/envelope</span>; the simulator entry point is <span class="mono">${esc(e.sim_entry_point ?? "")}</span>.</p>`, "GUARD axis shape, served as JSON")}`).join("")}`,
    })}

    ${band({
      eyebrow: "Limits", tone: "quiet", inner: `
      <div class="two-col">
        <div>
          <p class="prose reveal">The contract enforces authorisation, payment, deadlines and a single terminal settlement. It cannot check that a package is semantically correct; that is the verifier's judgement. Verifier error or collusion is not prevented, only made visible, because every check it ran is published after settlement.</p>
        </div>
        <div>
          <p class="prose reveal">Bit-identical reproduction is claimed only for the pinned environment. On a machine whose environment pin differs, the verifier does not fall back to anything: it cannot bind the delivered replay to what it ran, so it returns INCONCLUSIVE and nothing is paid. A seed alone is never assumed to guarantee reproducibility.</p>
          <p class="prose reveal">Severity is a kinematic proxy per robot, not a damage estimate: impact speed for the cart, torso impact speed for the humanoid. No failure frequency is claimed or implied.</p>
        </div>
      </div>`,
    })}`;
  armPage(view);
}
