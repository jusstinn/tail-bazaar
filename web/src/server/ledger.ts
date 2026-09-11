// FAILURE LEDGER EXPORT — the artifact a GUARD-style underwriting pipeline would ingest.
//
// Row shape follows GUARD's report rows (guard/report.py) and manifest provenance (guard/manifest.py):
// the finding's controller (≈ checkpoint_id), the theta vector, the limit-state margin and impact
// energy in GUARD's field names, a VALID / INVALID / INCONCLUSIVE verdict, how it was searched and at
// what cost, a deterministic run id, git provenance, the environment pins, and the on-chain record.
//
// PRIVACY: every row carries `scenario`, which is exactly what buyers pay for. This export is
// therefore operator-facing only. It is written by the CLI (`npm run ledger -- <file>`) and by the
// demo pipeline into its evidence directory; it is NEVER served by an HTTP route.
import fs from "node:fs";
import path from "node:path";
import { chainId, chainMode, escrowAddress, REPO_ROOT } from "./config.js";
import { getDb } from "./db.js";
import { ENVELOPE_ID, PRODUCT_QUESTION, SEARCHED_ENVELOPE_PROSE, TUNED_RANGE_PROSE, rangePosition, type Scenario } from "./envelope.js";
import { deterministicRunId, provenance } from "./provenance.js";
import { fingerprint } from "./sim.js";
import { VERDICT, type Verdict } from "./agents/verifier.js";
import type { Submission } from "./agents/seller.js";

export const LEDGER_SCHEMA = "tb-ledger-1";

export type LedgerRow = {
  finding_id: string;
  controller_id: string;
  controller_hash: string;
  envelope_id: string;
  scenario: Scenario;
  in_tuned_range: Record<string, boolean>;
  outcome: string;
  limit_state_margin_m: number | null;
  impact_speed_mps: number | null;
  impact_kinetic_energy_j: number | null;
  total_mass_kg: number | null;
  /** Verdict on the FINDING (did the verifier reproduce and bind it?). */
  verdict: Verdict;
  /** Verdict on the DELIVERY of that finding to a buyer, when one happened. A finding can be VALID
   *  while its delivery is INVALID (the demo's tampered second order is exactly that case). */
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
  finding_id: string; listing_id: string | null; controller_id: string; controller_hash: string; envelope_id: string;
  scenario: string; outcome: string; impact_speed_mps: number | null; trajectory_hash: string;
  verification_status: string; verification_method: string | null; created_at: string;
};

const SOURCE_LABEL: Record<string, string> = { grid: "bounded grid search", random: "seeded random search" };

/** The nominal suite is produced by the simulator, not by the web layer; report it with its source
 *  file so the count is never presented as something this export measured itself. */
function nominalSuite(): { n_nominal_runs: number | null; all_passed: boolean | null; source: string | null } {
  for (const rel of [path.join("evidence", "local", "nominal-suite.json"), path.join("evidence", "milestone", "nominal-suite.json")]) {
    const file = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(file)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      const cases = Array.isArray(doc.cases) ? doc.cases.length : Array.isArray(doc.results) ? doc.results.length : null;
      return { n_nominal_runs: cases, all_passed: doc.all_passed ?? null, source: rel };
    } catch { /* unreadable: reported as unknown below */ }
  }
  return { n_nominal_runs: null, all_passed: null, source: null };
}

export function buildLedger() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM ledger ORDER BY created_at ASC").all() as unknown as LedgerTableRow[];
  const out: LedgerRow[] = [];
  const searchCosts = new Map<string, { simulations: number; sim_steps: number; wall_time_s: number }>();
  for (const r of rows) {
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
    if (cost && sub) searchCosts.set(JSON.stringify([sub.hunter.id, sub.hunter.mode, cost]), cost as any);
    const num = (k: string): number | null => (typeof metrics[k] === "number" ? (metrics[k] as number) : null);
    out.push({
      finding_id: r.finding_id,
      controller_id: r.controller_id,
      controller_hash: r.controller_hash,
      envelope_id: r.envelope_id,
      scenario,
      in_tuned_range: Object.fromEntries(rangePosition(scenario).map((p) => [p.parameter, p.in_tuned_range])),
      outcome: r.outcome,
      // GUARD's g(theta) for this scene: the minimum recorded range to the obstacle. The simulator
      // records no signed penetration depth, so on a collision this is the closest recorded approach
      // and `outcome` / metrics.collision is the authoritative failure flag.
      limit_state_margin_m: num("min_range_m"),
      impact_speed_mps: num("impact_speed_mps") ?? r.impact_speed_mps,
      impact_kinetic_energy_j: num("impact_kinetic_energy_j"),
      total_mass_kg: num("total_mass_kg"),
      verdict: VERDICT[r.verification_status as keyof typeof VERDICT] ?? "INCONCLUSIVE",
      delivery_verdict: deliveryVerdict,
      verification_status: r.verification_status,
      verification_method: r.verification_method,
      source: sub ? (SOURCE_LABEL[sub.hunter.mode] ?? sub.hunter.mode) : "unknown (no submission recorded)",
      search_cost: cost ?? null,
      run_id: deterministicRunId("verify", { controller_hash: r.controller_hash, envelope_id: r.envelope_id, scenario, environment: environment ? fingerprint(environment) : null }),
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
  const nominal = nominalSuite();
  return {
    schema: LEDGER_SCHEMA,
    generated_at: new Date().toISOString(),
    envelope_id: ENVELOPE_ID,
    envelope_yaml: "sim/envelope.yaml (same axis shape as GUARD configs/guard_theta.yaml)",
    chain: { mode: chainMode, chain_id: chainId, escrow: escrowAddress || null },
    provenance: provenance(),
    n_nominal_runs: nominal.n_nominal_runs,
    nominal_suite: { all_passed: nominal.all_passed, source: nominal.source },
    n_search_runs: searches.reduce((a, c) => a + (c.simulations ?? 0), 0),
    search_cost_total: { simulations: searches.reduce((a, c) => a + (c.simulations ?? 0), 0), sim_steps: searches.reduce((a, c) => a + (c.sim_steps ?? 0), 0), wall_time_s: Number(searches.reduce((a, c) => a + (c.wall_time_s ?? 0), 0).toFixed(3)) },
    n_findings: out.length,
    verdict_counts: out.reduce<Record<string, number>>((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] ?? 0) + 1 }), {}),
    controller_tuned_range: TUNED_RANGE_PROSE,
    searched_envelope: SEARCHED_ENVELOPE_PROSE,
    product_question: PRODUCT_QUESTION,
    placeholder_warnings: [
      "Adversarially selected failures are not failure frequencies: this ledger is a set of found failures, not an estimate of P(failure) under any distribution.",
      "No distribution D over the envelope axes is stated or estimated here; sim/envelope.yaml leaves GUARD's marginal/scale null on purpose.",
      "Severity is an uncalibrated impact-speed / kinetic-energy proxy. No biomechanical tier, damage estimate or monetary value is assigned.",
      "limit_state_margin_m is the minimum recorded range to the obstacle; the simulator records no signed penetration depth, so it is not negative on contact.",
      "The physics is a simplified cart in an illustrative envelope and needs calibration against physical robots before any underwriting use.",
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
