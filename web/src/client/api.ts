export type Status = {
  app: string; mode: string; chain_mode: "local" | "testnet"; chain_id: number; chain_label: string; explorer_base: string | null;
  escrow_address: string | null; latest_block: number | null; roles: { verifier: string; seller: string; buyer: string };
  app_domain: string; buyer_budget_wei: string; demo_trigger_enabled: boolean; buyer_console_enabled: boolean; public_base_url: string;
  hosted_mode: boolean; private_routes_require_auth: boolean; operator_token_configured: boolean;
  /** Orders this host publishes deliberately as demonstration fixtures (readable with no token). */
  public_demo_orders?: string[]; public_demo_fixture_note?: string;
  provenance: { git_sha: string | null; git_dirty: boolean | null; envelope_ids?: string[]; envelope_id: string; envelope_config_hash: string; captured_at: string };
  targets: TargetInfo[];
};
export type OperatingContext = { controller_tuned_range: string; controller_tuned_range_label?: string; searched_envelope: string; question: string; note: string; reference: string };
export type TargetInfo = { id: string; label: string; short_label: string; machine: string; one_liner: string; envelope_id: string; subject_label: string; failure_classes: { id: string; label: string }[]; replay_renderer: string };
export type Axis = { name: string; low: number; high: number; nominal: number; marginal: string | null; scale: number | null; units: string; group: string; quantization: string; tuned_range: string };
export type FailureClassInfo = { id: string; label: string; severity_proxy: string; severity_units: string; detected_by: string };
export type EnvelopeDoc = {
  target_id: string; label?: string; short_label?: string; machine?: string; one_liner?: string; subject_noun?: string; subject_label?: string;
  replay_renderer?: string; sim_entry_point?: string; envelope_yaml?: string;
  envelope_id: string; yaml: string; axes: Axis[]; nominal_scenario: Record<string, number>; control_tick_ms: number; duplicate_rule: string;
  controller_tuned_range: { label: string; verb: string; unstated: string; prose: string; source: string; per_parameter: Record<string, { min?: number; max?: number; exactly?: number; not_stated?: boolean }> };
  searched_envelope: { prose: string }; product_question: string; note: string; distribution: string;
  severity: { proxy: string; units: string; definition: string }; failure_classes: FailureClassInfo[];
  verdicts: Record<string, string>;
};
/** GET /api/envelope — one published envelope per target in the registry. */
export type EnvelopesDoc = { schema: string; default_target: string; targets: EnvelopeDoc[] };
export const envelopeFor = (docs: EnvelopesDoc, targetId: string | undefined | null): EnvelopeDoc =>
  docs.targets.find((t) => t.target_id === targetId) ?? docs.targets.find((t) => t.target_id === docs.default_target) ?? docs.targets[0];

/** GET /api/market — aggregate search cost and per-target listing counts. Never per-listing. */
export type MarketDoc = {
  schema: string; chain_mode: string; listings: number;
  targets: { target_id: string; label: string; short_label: string; machine: string; one_liner: string; envelope_id: string; subject_label: string; replay_renderer: string; failure_classes: FailureClassInfo[]; listings: number; hunts: number; search_cost: { simulations: number; sim_steps: number; wall_time_s: number }; failures_by_class: Record<string, number> }[];
  search_cost_total: { hunts: number; simulations: number; sim_steps: number; wall_time_s: number };
  note: string;
};
export type Summary = {
  schema: string; controller: { id: string; hash: string }; envelope_id: string; admissible: boolean; claim_kind: string;
  /** Absent on listings registered before the marketplace became multi-target; those are the cart. */
  target?: { id: string; label: string; machine: string; subject_label: string; replay_renderer: string };
  failure_class?: { id: string; label: string; detected_by: string };
  verification: { status: string; verdict?: string; method: string | null; verifier_version: string; verifier: string; environment_fingerprint: string; evidence_binding?: string; verified_at: string };
  severity: { proxy: string; band: string; definition: string }; seller: string; seller_settled_orders_at_listing: number; price_wei: string;
  chain: { mode: string; chain_id: number; escrow: string }; hidden: string;
  /** Absent on listings registered before the operating-context fields existed (their terms hash is
   *  on chain and immutable); the client falls back to GET /api/envelope, which says the same thing. */
  operating_context?: OperatingContext;
};
export type Listing = {
  listing_id: string; chain_mode: string; chain_id: number; escrow_address: string; target_id?: string; seller: string; price_wei: string; commitment: string; terms_hash: string;
  public_summary: Summary; status: string; register_tx: string | null; created_at: string; demo_note: string | null;
  on_chain: { status: string; buyer: string; commitment: string; terms_hash: string; delivery_hash: string; delivery_deadline?: number; settlement_deadline?: number } | null;
  seller_settled_orders: number | null; events?: Ev[];
};
export type Ev = { id: number; listing_id: string; ts: string; actor: string; kind: string; detail: string; tx_hash: string | null; block_number: number | null; chain_mode: string };
export type Check = { name: string; ok: boolean; detail?: string };
export type Order = {
  order_id: string; listing_id: string; buyer: string; price_wei: string; status: string; fund_tx: string | null; deliver_tx: string | null; recheck_tx: string | null;
  settle_tx: string | null; withdraw_tx: string | null; timeout_tx: string | null; delivery_hash: string | null; retrieved_at: string | null;
  delivery_check: { valid: boolean; reason: string; on_chain_commitment: string; delivered_hash: string; asserted_delivery_hash: string | null; checks: Check[]; checked_at: string } | null;
  buyer_check: { ok: boolean; reason: string; delivered_hash: string; on_chain_commitment: string; checks: Check[] } | null;
  created_at: string; chain_mode?: string; listing?: Listing; on_chain?: Listing["on_chain"]; events?: Ev[]; revealed_in_buyer_console?: boolean;
  reveal_requires_auth?: boolean; explorer_base?: string | null;
  /** This order is published as a demonstration fixture: its evidence is served without a token. */
  public_demo_fixture?: boolean; public_demo_fixture_note?: string | null;
};
export type Frames = { dt_s: number; bodies: string[]; quat_order: string; data: number[][]; stride?: number; places?: number; source_dt_s?: number };
/** Per-tick telemetry. The fields differ per target and each renderer reads only its own. */
export type Tick = Record<string, any>;
export type RunLike = {
  scenario: Record<string, number>; scene: any; metrics: Record<string, any>; events: any[]; ticks: Tick[]; frames: Frames; trajectory_hash: string;
  controller: { id: string; hash: string }; environment: Record<string, any>; outcome?: string;
  /** Fixed scene geometry that is not a posed body: the arm target's goal site. Absent elsewhere. */
  goal_m?: number[] | null; initial_state_check?: any;
  /** The target the run belongs to, so class copy that differs per target (the G1's FELL) resolves. */
  target_id?: string;
  /** The G1's own fall predicate (thresholds), published by its simulator. Absent elsewhere. */
  fall_predicate?: any;
};
export type Claim = { outcome: string; failure_class: string; severity_proxy: string; severity_value: number | null; severity_units: string; moment_t_s: number | null; severity_band: string };
/** The AGGREGATE cost of the hunt that found this finding. Post-purchase only: it travels inside the
 *  private package, never in a listing summary. */
export type HunterRecord = {
  id: string; mode: string; target_id: string;
  search_cost: { simulations: number; sim_steps: number; wall_time_s: number };
  counts: { simulations: number; failures: number; survived: number; inconclusive: number; by_class: Record<string, number> };
  distinct_findings: number; near_duplicates: number;
};
export type Pkg = RunLike & {
  schema: string; salt_hex: string; seller: string; created_at: string; envelope_id: string; nominal_scenario: Record<string, number>;
  target_id?: string; target_label?: string; hunter?: HunterRecord;
  changed_conditions: { parameter: string; nominal: number; value: number; unit: string }[]; claim: Claim;
  replay: { frames: Frames; trajectory_hash: string; mjcf_hash: string | null; renderer?: string }; reproduce: { command: string; note: string }; tampered_by_demo?: string;
};
export type DemoRun = { run_id: string; status: string; started_at: string; log: { ts: string; msg: string }[]; error: string | null } | null;
/** GET /api/flows/:id — a live purchase or listing, step by step. Public: names, statuses, hashes,
 *  block numbers and one-line details only. */
export type FlowStep = { name: string; status: "pending" | "running" | "done" | "failed"; tx_hash: string | null; block_number: number | null; detail: string | null; at: string | null };
export type Flow = { flow_id: string; kind: "buy" | "list"; target_id: string; listing_id: string | null; status: "running" | "done" | "failed"; started_at: string; finished_at: string | null; error: string | null; steps: FlowStep[] };

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// HOSTED MODE: routes that return private data require a bearer token (the buyer session from
// POST /api/retrieve, or the operator token). It is kept per browser, never sent anywhere else, and
// only attached to same-origin requests to this app's API.
const TOKEN_KEY = "tb_access_token";
export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}
export function setToken(token: string): void {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode: token lives for this page only */ }
}
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new HttpError(r.status, `${url}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new HttpError(r.status, `${url}: ${r.status} ${text}`);
  return JSON.parse(text) as T;
}
