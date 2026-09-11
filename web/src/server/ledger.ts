// FAILURE LEDGER EXPORT — the artifact a GUARD-style underwriting pipeline would ingest.
//
// Row shape follows GUARD's report rows (guard/report.py) and manifest provenance (guard/manifest.py):
// the finding's TARGET and subject (≈ checkpoint_id), the theta vector, the limit-state margin and
// severity in GUARD's field names, a VALID / INVALID / INCONCLUSIVE verdict, how it was searched and
// at what cost, a deterministic run id, git provenance, the environment pins, and the on-chain record.
//
// PRIVACY: every row carries `scenario`, which is exactly what buyers pay for. This export is
// therefore operator-facing only. It is written by the CLI (`npm run ledger -- <file>`) and by the
// demo pipeline into its evidence directory; it is NEVER served by an HTTP route.
import fs from "node:fs";
import path from "node:path";
import { chainId, chainMode, escrowAddress, REPO_ROOT } from "./config.js";
import { getDb } from "./db.js";
import { deterministicRunId, provenance } from "./provenance.js";
import { fingerprint } from "./sim.js";
import { TARGET_IDS, TARGETS, targetFor, type Scenario, type TargetId } from "./targets.js";
import { VERDICT, type Verdict } from "./agents/verifier.js";
import type { Submission } from "./agents/seller.js";

export const LEDGER_SCHEMA = "tb-ledger-2";

export type LedgerRow = {
  finding_id: string;
  /** WHICH ROBOT. Every downstream consumer groups by this before it does anything else. */
  target_id: string;
  target_label: string;
  controller_id: string;
  controller_hash: string;
  envelope_id: string;
  scenario: Scenario;
  in_tuned_range: Record<string, boolean>;
  outcome: string;
  failure_class: string;
  limit_state_margin_m: number | null;
  /** The target's own severity proxy. Uncalibrated kinematics; never a damage or cost estimate. */
  severity: { proxy: string; value: number | null; units: string; band: string };
  impact_speed_mps: number | null;
  impact_kinetic_energy_j: number | null;
  total_mass_kg: number | null;
  /** Verdict on the FINDING (did the verifier reproduce and bind it?). */
  verdict: Verdict;
  /** Verdict on the DELIVERY of that finding to a buyer, when one happened. A finding can be VALID
   *  while its delivery is INVALID (the demo's tampered listing is exactly that case). */
  delivery_verdict: Verdict | null;
  verification_status: string;
  verification_method: string | null;
  source: string;
  search_cost: unknown;
  run_id: string;
  git_sha: string | null;
  git_dirty: boolean | null;
  environment: Record<string, unknown> | null;
  trajectory_hash: string;
  commitment: string | null;
  settled_on_chain: { chain_mode: string; chain_id: number; escrow: string; listing_id: string; register_tx: string | null; order_status: string | null; settle_tx: string | null } | null;
  created_at: string;
};

type LedgerTableRow = {
  finding_id: string; listing_id: string | null; target_id: string | null; controller_id: string; controller_hash: string; envelope_id: string;
  scenario: string; outcome: string; impact_speed_mps: number | null; trajectory_hash: string;
  verification_status: string; verification_method: string | null; created_at: string;
};

const SOURCE_LABEL: Record<string, string> = {
  grid: "bounded grid search", "grid-load": "bounded grid search (deck grip)", random: "seeded random search",
  "grid-push": "bounded grid search (push impulse x heading)", "grid-systems": "bounded grid search (latency x actuator noise)", "grid-terrain": "bounded grid search (friction x mass)",
  "grid-grip": "bounded grid search (grip friction x initial state)", "grid-payload": "bounded grid search (payload mass x initial state)", "grid-placement": "bounded grid search (block offset x by y)",
};

/** The nominal suites are produced by the simulators, not by the web layer; report each with its
 *  source file so a count is never presented as something this export measured itself. */
function nominalSuites(): { target_id: string; n_nominal_runs: number | null; all_passed: boolean | null; gate_passed: boolean | null; cases_that_failed: string[] | null; source: string | null }[] {
  const candidates: Record<TargetId, string[]> = {
    cart: [path.join("evidence", "local", "nominal-suite.json"), path.join("evidence", "milestone", "nominal-suite.json")],
    humanoid: [path.join("evidence", "local", "humanoid", "nominal-suite.json"), path.join("evidence", "humanoid", "nominal-suite.json")],
    arm: [path.join("evidence", "local", "arm", "nominal-suite.json"), path.join("evidence", "arm", "nominal-suite.json")],
    g1: [path.join("evidence", "local", "g1", "nominal-suite.json"), path.join("evidence", "g1", "nominal-suite.json")],
  };
  return TARGET_IDS.map((id) => {
    for (const rel of candidates[id]) {
      const file = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(file)) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(file, "utf8"));
        const cases = Array.isArray(doc.cases) ? doc.cases.length : Array.isArray(doc.results) ? doc.results.length : null;
        // Two different questions, reported separately because they mean different things: `all_passed`
        // is "every nominal case behaved as written", `gate_passed` is "the harness reproduces the
        // target as its author published it". The humanoid's suite keeps a benign perturbation that
        // FAILS (one 15 ms control tick fells the policy); that is a finding about the policy, not a
        // broken harness, so collapsing the two into one flag would misreport it.
        const failed = Array.isArray(doc.cases_that_fell) ? doc.cases_that_fell.map(String) : Array.isArray(doc.failed_cases) ? doc.failed_cases.map(String) : null;
        return { target_id: id, n_nominal_runs: cases, all_passed: doc.all_passed ?? null, gate_passed: doc.published_conditions_all_passed ?? doc.all_passed ?? null, cases_that_failed: failed, source: rel };
      } catch { /* unreadable: reported as unknown below */ }
    }
    return { target_id: id, n_nominal_runs: null, all_passed: null, gate_passed: null, cases_that_failed: null, source: null };
  });
}

export function buildLedger() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM ledger ORDER BY created_at ASC").all() as unknown as LedgerTableRow[];
  const out: LedgerRow[] = [];
  const searchCosts = new Map<string, { simulations: number; sim_steps: number; wall_time_s: number }>();
  for (const r of rows) {
    const target = targetFor(r.target_id);
    const scenario = JSON.parse(r.scenario) as Scenario;
    const listing = r.listing_id
      ? (db.prepare("SELECT commitment, register_tx, chain_mode, chain_id, escrow_address FROM listings WHERE listing_id = ?").get(r.listing_id) as { commitment: string; register_tx: string | null; chain_mode: string; chain_id: number; escrow_address: string } | undefined)
      : undefined;
    const priv = r.listing_id
      ? (db.prepare("SELECT submission, verification FROM private_packages WHERE listing_id = ?").get(r.listing_id) as { submission: string; verification: string } | undefined)
      : undefined;
    const order = r.listing_id
      ? (db.prepare("SELECT status, settle_tx, delivery_check FROM orders WHERE listing_id = ?").get(r.listing_id) as { status: string; settle_tx: string | null; delivery_check: string | null } | undefined)
      : undefined;
    const deliveryVerdict: Verdict | null = order?.delivery_check ? ((JSON.parse(order.delivery_check).verdict as Verdict) ?? (JSON.parse(order.delivery_check).valid ? "VALID" : "INVALID")) : null;
    const sub = priv ? (JSON.parse(priv.submission) as Submission) : null;
    const ver = priv ? (JSON.parse(priv.verification) as { verifier_run?: { environment: Record<string, unknown>; metrics: Record<string, unknown> } }) : null;
    const metrics = (ver?.verifier_run?.metrics ?? (sub?.metrics as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const environment = ver?.verifier_run?.environment ?? (sub?.environment as Record<string, unknown>) ?? null;
    const cost = sub?.hunter?.search_cost;
    if (cost && sub) searchCosts.set(JSON.stringify([sub.target_id, sub.hunter.id, sub.hunter.mode, cost]), cost as any);
    const num = (k: string): number | null => (typeof metrics[k] === "number" ? (metrics[k] as number) : null);
    const severityValue = num(target.severity.proxy) ?? sub?.claim?.severity_value ?? r.impact_speed_mps;
    out.push({
      finding_id: r.finding_id,
      target_id: target.id,
      target_label: target.label,
      controller_id: r.controller_id,
      controller_hash: r.controller_hash,
      envelope_id: r.envelope_id,
      scenario,
      in_tuned_range: Object.fromEntries(target.rangePosition(scenario).map((p) => [p.parameter, p.in_tuned_range])),
      outcome: r.outcome,
      failure_class: sub?.claim?.failure_class ?? r.outcome,
      // GUARD's g(theta). The cart records the minimum range to the obstacle; the humanoid records no
      // scalar limit-state margin of that shape, so the field is null rather than invented.
      limit_state_margin_m: num("min_range_m"),
      severity: { proxy: target.severity.proxy, value: severityValue, units: target.severity.units, band: target.severityBand(severityValue).band },
      // Kept under GUARD's own field names only where the quantity really is that quantity.
      impact_speed_mps: num("impact_speed_mps"),
      impact_kinetic_energy_j: num("impact_kinetic_energy_j"),
      total_mass_kg: num("total_mass_kg"),
      verdict: VERDICT[r.verification_status as keyof typeof VERDICT] ?? "INCONCLUSIVE",
      delivery_verdict: deliveryVerdict,
      verification_status: r.verification_status,
      verification_method: r.verification_method,
      source: sub ? (SOURCE_LABEL[sub.hunter.mode] ?? sub.hunter.mode) : "unknown (no submission recorded)",
      search_cost: cost ?? null,
      run_id: deterministicRunId("verify", { target_id: target.id, controller_hash: r.controller_hash, envelope_id: r.envelope_id, scenario, environment: environment ? fingerprint(target, environment) : null }),
      git_sha: provenance().git_sha,
      git_dirty: provenance().git_dirty,
      environment,
      trajectory_hash: r.trajectory_hash,
      commitment: listing?.commitment ?? r.finding_id,
      settled_on_chain: listing
        ? { chain_mode: listing.chain_mode, chain_id: listing.chain_id, escrow: listing.escrow_address, listing_id: r.listing_id!, register_tx: listing.register_tx, order_status: order?.status ?? null, settle_tx: order?.settle_tx ?? null }
        : null,
      created_at: r.created_at,
    });
  }
  const searches = [...searchCosts.values()];
  const byTarget = Object.fromEntries(TARGET_IDS.map((id) => [id, out.filter((r) => r.target_id === id).length]));
  return {
    schema: LEDGER_SCHEMA,
    generated_at: new Date().toISOString(),
    targets: TARGET_IDS.map((id) => ({
      target_id: id, label: TARGETS[id].label, envelope_id: TARGETS[id].envelope_id, envelope_yaml: TARGETS[id].envelope_yaml,
      failure_classes: TARGETS[id].failure_classes.map((c) => c.id), severity_proxy: TARGETS[id].severity.proxy, severity_units: TARGETS[id].severity.units,
      published_range: TARGETS[id].envelope_doc.controller_tuned_range.prose, searched_envelope: TARGETS[id].envelope_doc.searched_envelope.prose,
      product_question: TARGETS[id].envelope_doc.product_question,
    })),
    chain: { mode: chainMode, chain_id: chainId, escrow: escrowAddress || null },
    provenance: provenance(),
    nominal_suites: nominalSuites(),
    n_search_runs: searches.reduce((a, c) => a + (c.simulations ?? 0), 0),
    search_cost_total: { simulations: searches.reduce((a, c) => a + (c.simulations ?? 0), 0), sim_steps: searches.reduce((a, c) => a + (c.sim_steps ?? 0), 0), wall_time_s: Number(searches.reduce((a, c) => a + (c.wall_time_s ?? 0), 0).toFixed(3)) },
    n_findings: out.length,
    findings_by_target: byTarget,
    verdict_counts: out.reduce<Record<string, number>>((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] ?? 0) + 1 }), {}),
    placeholder_warnings: [
      "Adversarially selected failures are not failure frequencies: this ledger is a set of found failures, not an estimate of P(failure) under any distribution.",
      "No distribution D over the envelope axes is stated or estimated here; both envelope YAMLs leave GUARD's marginal/scale null on purpose.",
      "Severity is an uncalibrated kinematic proxy per target (cart: impact speed; humanoid: torso impact speed; arm: the carried part's impact speed, and NOT_PLACED deliberately has none at all). No biomechanical tier, damage estimate or monetary value is assigned.",
      "limit_state_margin_m is the cart's minimum recorded range to the obstacle; the simulator records no signed penetration depth, so it is not negative on contact, and the humanoid target records no quantity of that shape at all.",
      "The physics is a simplified cart, a Gymnasium MuJoCo mannequin and a mocap-welded Fetch arm in illustrative envelopes, and needs calibration against physical robots before any underwriting use.",
      "The humanoid target's policy checkpoint declares no licence; see evidence/humanoid/README.md. Neither does the arm target's, nor any FetchPickAndPlace checkpoint found on the hub; see evidence/arm/README.md.",
      "INCONCLUSIVE never pays; INVALID rows are recorded findings that failed verification, not deliverable evidence.",
    ],
    findings: out,
  };
}

export function writeLedger(file: string) {
  const doc = buildLedger();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return { file, doc };
}
