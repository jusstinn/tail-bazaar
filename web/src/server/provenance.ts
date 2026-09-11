// Run provenance, aligned with GUARD's guard/manifest.py: every stage records the git SHA, a dirty
// flag, the resolved configuration hash, and a deterministic run id (same stage + same resolved
// config -> same id). Nothing here touches the simulator; it describes the repository and the
// resolved envelope/controller configuration the web layer ran with.
import { execFileSync } from "node:child_process";
import { commitment } from "./canonical.js";
import { TARGET_IDS, TARGETS } from "./targets.js";
import { REPO_ROOT } from "./config.js";

export type Provenance = {
  git_sha: string | null;
  git_dirty: boolean | null;
  /** One entry per target in the registry. */
  envelope_ids: string[];
  envelope_id: string;
  envelope_config_hash: string;
  captured_at: string;
};

function git(args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    return null; // not a git checkout (e.g. an exported tarball): provenance is reported as unknown
  }
}

/** keccak256 over the canonical bytes of EVERY target's resolved envelope configuration, so the hash
 *  changes if any published axis, nominal point, duplicate rule or published range moves. */
export const ENVELOPE_IDS = TARGET_IDS.map((id) => TARGETS[id].envelope_id);
export const ENVELOPE_CONFIG_HASH = commitment(
  Object.fromEntries(TARGET_IDS.map((id) => {
    const d = TARGETS[id].envelope_doc;
    return [id, { envelope_id: d.envelope_id, axes: d.axes, nominal_scenario: d.nominal_scenario, duplicate_rule: d.duplicate_rule, published_range: d.controller_tuned_range.per_parameter }];
  })),
);

let cache: { at: number; value: Provenance } | null = null;

export function provenance(maxAgeMs = 5000): Provenance {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  const sha = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  const value: Provenance = {
    git_sha: sha,
    git_dirty: status === null ? null : status !== "",
    envelope_ids: ENVELOPE_IDS,
    envelope_id: ENVELOPE_IDS.join(" + "),
    envelope_config_hash: ENVELOPE_CONFIG_HASH,
    captured_at: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Deterministic run id: same stage and same resolved configuration produce the same id (GUARD
 *  manifest semantics). It is a function of the inputs only, never of wall-clock time. */
export function deterministicRunId(stage: string, config: unknown): string {
  return "run-" + commitment({ stage, config, envelope_config_hash: ENVELOPE_CONFIG_HASH }).slice(2, 18);
}
