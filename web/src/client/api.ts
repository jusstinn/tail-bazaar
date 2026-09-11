export type Status = {
  app: string; mode: string; chain_mode: "local" | "testnet"; chain_id: number; chain_label: string; explorer_base: string | null;
  escrow_address: string | null; latest_block: number | null; roles: { verifier: string; seller: string; buyer: string };
  app_domain: string; buyer_budget_wei: string; demo_trigger_enabled: boolean; buyer_console_enabled: boolean; public_base_url: string;
  hosted_mode: boolean; private_routes_require_auth: boolean; operator_token_configured: boolean;
  provenance: { git_sha: string | null; git_dirty: boolean | null; envelope_id: string; envelope_config_hash: string; captured_at: string };
};
export type OperatingContext = { controller_tuned_range: string; searched_envelope: string; question: string; note: string; reference: string };
export type Axis = { name: string; low: number; high: number; nominal: number; marginal: string | null; scale: number | null; units: string; group: string; quantization: string; tuned_range: string };
export type EnvelopeDoc = {
  envelope_id: string; yaml: string; axes: Axis[]; nominal_scenario: Record<string, number>; control_tick_ms: number; duplicate_rule: string;
  controller_tuned_range: { prose: string; source: string; per_parameter: Record<string, { min?: number; max?: number; exactly?: number }> };
  searched_envelope: { prose: string }; product_question: string; note: string; distribution: string; verdicts: Record<string, string>;
};
export type Summary = {
  schema: string; controller: { id: string; hash: string }; envelope_id: string; admissible: boolean; claim_kind: string;
  verification: { status: string; verdict?: string; method: string | null; verifier_version: string; verifier: string; environment_fingerprint: string; evidence_binding?: string; verified_at: string };
  severity: { proxy: string; band: string; definition: string }; seller: string; seller_settled_orders_at_listing: number; price_wei: string;
  chain: { mode: string; chain_id: number; escrow: string }; hidden: string;
  /** Absent on listings registered before the operating-context fields existed (their terms hash is
   *  on chain and immutable); the client falls back to GET /api/envelope, which says the same thing. */
  operating_context?: OperatingContext;
};
export type Listing = {
  listing_id: string; chain_mode: string; chain_id: number; escrow_address: string; seller: string; price_wei: string; commitment: string; terms_hash: string;
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
};
export type Frames = { dt_s: number; bodies: string[]; quat_order: string; data: number[][] };
export type Tick = { t_s: number; v_odom_mps: number; range_raw_m: number; range_used_m: number; brake_cmd: number; brake_applied: number; phase: string; x_front_m: number; contact: boolean };
export type RunLike = {
  scenario: Record<string, number>; scene: any; metrics: Record<string, any>; events: any[]; ticks: Tick[]; frames: Frames; trajectory_hash: string;
  controller: { id: string; hash: string }; environment: Record<string, any>; outcome?: string;
};
export type Pkg = RunLike & {
  schema: string; salt_hex: string; seller: string; created_at: string; envelope_id: string; nominal_scenario: Record<string, number>;
  changed_conditions: { parameter: string; nominal: number; value: number; unit: string }[]; claim: { outcome: string; impact_speed_mps: number | null; first_contact_t_s: number | null; severity_band: string };
  replay: { frames: Frames; trajectory_hash: string; mjcf_hash: string | null }; reproduce: { command: string; note: string }; tampered_by_demo?: string;
};
export type DemoRun = { run_id: string; status: string; started_at: string; log: { ts: string; msg: string }[]; error: string | null } | null;

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
