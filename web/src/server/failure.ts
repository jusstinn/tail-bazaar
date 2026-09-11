// Failure-class vocabulary, DERIVED FROM THE RUN DOCUMENT, never hard-coded to "collision".
//
// A run document names its own failure class in `outcome` (mirrored in the package's
// `claim.outcome`): COLLISION today, and whatever the simulator adds later — e.g. a payload that
// slides off the cart under hard braking, class LOAD_SHED. Everything the experience says about a
// failure is computed here from the run's own `events` and `metrics`:
//   * the class name shown to a reader,
//   * the moment the failure happens (used for the default playhead, the freeze, the contact ring),
//   * the number that summarises it and its unit,
//   * the marks drawn on the replay scrubber.
// A new class therefore needs no UI change: if it is not in KNOWN_CLASSES it still gets a readable
// name, its own moment event, and its own quantities, read from the bytes the verifier certified.
//
// This module is deliberately free of DOM and of node builtins: it is compiled by the server
// tsconfig (so `node --test` can drive it) and bundled into the browser client by esbuild.

export type RunEvent = { type: string; t_s: number; [k: string]: unknown };

/** Events that are steps on the way to a failure, not the failure itself. */
export const CUE_EVENTS = new Set(["brake_onset", "stopped", "start", "cruise", "hold", "push_start", "push_end", "RELEASE_DISCARDED"]);

const CUE_LABELS: Record<string, string> = {
  brake_onset: "brake onset",
  stopped: "stopped",
  start: "start",
  cruise: "cruise",
  hold: "hold",
  push_start: "push starts",
  push_end: "push ends",
  // The arm's drop predicate proposes a release and then withdraws it when the grasp comes back
  // within three ticks. Marking the withdrawn proposals shows what the confirmation window rejected.
  RELEASE_DISCARDED: "release proposal withdrawn",
};

/** Suffix → unit. Longest suffix wins, so `_mps2` beats `_mps` and `_mps` beats `_s`. */
const UNIT_SUFFIXES: [string, string][] = [
  ["_mps2", "m/s²"],
  ["_mps", "m/s"],
  ["_kg", "kg"],
  ["_deg", "°"],
  ["_ms", "ms"],
  ["_nm", "N·m"],
  ["_ns", "N·s"],
  ["_pct", "%"],
  ["_j", "J"],
  ["_m", "m"],
  ["_s", "s"],
  ["_n", "N"],
];

/** Copy for the classes that exist today, across every target. Anything absent falls through to the
 *  generic path. `headline_key` names the field the simulator itself uses as that class's severity
 *  proxy, and `severity_event` names the event that field is recorded on when it is NOT the failure
 *  moment: a humanoid is declared fallen when its torso leaves the healthy band, but the impact speed
 *  that says how hard it landed is measured later, at the first ground contact. */
const KNOWN_CLASSES: Record<string, { label: string; moment_event: string; moment_label: string; headline_key: string; sentence: string; severity_event?: string; severity_label?: string }> = {
  COLLISION: {
    label: "Collision",
    moment_event: "first_contact",
    moment_label: "first contact",
    headline_key: "impact_speed_mps",
    sentence: "The cart reached the obstacle instead of stopping short of it.",
  },
  LOAD_SHED: {
    label: "Load shed",
    moment_event: "load_shed",
    moment_label: "load breaks loose",
    headline_key: "load_rel_speed_mps",
    sentence: "The payload broke loose from the cart deck instead of riding out the manoeuvre.",
  },
  FELL: {
    label: "Fell",
    moment_event: "health_predicate_fired",
    moment_label: "the fall",
    headline_key: "torso_impact_speed_mps",
    severity_event: "ground_contact",
    severity_label: "torso impact",
    sentence: "The torso dropped out of the height band the environment calls healthy: the policy lost its balance instead of walking on.",
  },
  DROPPED: {
    label: "Dropped",
    moment_event: "DROPPED",
    moment_label: "the release",
    headline_key: "impact_speed_mps",
    severity_event: "LANDED",
    severity_label: "impact",
    sentence: "The part left the gripper in mid-air, away from the goal: the arm let go of what it was carrying instead of placing it.",
  },
  NOT_PLACED: {
    label: "Not placed",
    // The environment judges placement at its own horizon, not at an instant, so this class has no
    // moment event and the run records none: there is nothing to freeze the replay on.
    moment_event: "NOT_PLACED",
    moment_label: "the episode horizon",
    headline_key: "object_goal_distance_m",
    sentence: "The part was still not within the environment's own success threshold of the goal when the episode ran out, and it was never dropped on the way.",
  },
};

export type Quantity = { key: string; label: string; value: number; unit: string; text: string };
export type Attribute = { key: string; label: string; value: string };
export type Marker = { id: string; t_s: number; label: string; kind: "moment" | "secondary" | "cue" };

export type FailurePresentation = {
  class_id: string;
  known_class: boolean;
  label: string;
  sentence: string;
  /** Every failure class this run recorded, primary first. A run can shed its load AND collide. */
  classes: string[];
  also: { class_id: string; label: string; t_s: number | null }[];
  moment: RunEvent | null;
  moment_t_s: number | null;
  moment_label: string;
  quantities: Quantity[];
  attributes: Attribute[];
  /** The event the severity proxy is measured on, when the run records it separately from the
   *  failure moment (the humanoid's ground contact). Null when it is the moment itself. */
  severity_moment: RunEvent | null;
  severity_moment_t_s: number | null;
  severity_label: string;
  severity_quantities: Quantity[];
  headline_quantity: Quantity | null;
  headline: string;
  markers: Marker[];
};

export function humanizeClass(id: string): string {
  const t = String(id ?? "").trim();
  if (!t) return "Failure";
  const words = t.replace(/[_-]+/g, " ").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function unitFor(key: string): string {
  const k = key.toLowerCase();
  for (const [suffix, unit] of UNIT_SUFFIXES) if (k.endsWith(suffix)) return unit;
  return "";
}

export function labelForKey(key: string): string {
  let k = String(key);
  for (const [suffix] of UNIT_SUFFIXES) {
    if (k.toLowerCase().endsWith(suffix)) { k = k.slice(0, -suffix.length); break; }
  }
  return k.replace(/[_-]+/g, " ").trim() || key;
}

/** Shortest readable form: integers stay integral, everything else keeps at most `places` decimals
 *  with trailing zeros trimmed. No rounding beyond display; the evidence keeps the exact value. */
export function formatValue(v: number, places = 3): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(places);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function quantityFrom(key: string, value: number): Quantity {
  const unit = unitFor(key);
  const text = `${formatValue(value)}${unit ? " " + unit : ""}`;
  return { key, label: labelForKey(key), value, unit, text };
}

/** WHICH FIELD NAMES THE EVENT is read from the document rather than assumed: the cart and the
 *  humanoid simulators write `type`, the arm simulator writes `event`. Both are the run's own word for
 *  what happened, so both are accepted and normalised to `type` for everything downstream. */
function eventTypeOf(e: unknown): string | null {
  const r = e as { type?: unknown; event?: unknown } | null;
  const raw = typeof r?.type === "string" ? r.type : typeof r?.event === "string" ? r.event : null;
  return raw && raw.trim() ? raw.trim() : null;
}

function eventsOf(run: unknown): RunEvent[] {
  const ev = (run as { events?: unknown })?.events;
  if (!Array.isArray(ev)) return [];
  return ev
    .filter((e) => !!e && typeof e === "object" && eventTypeOf(e) !== null && Number.isFinite(Number((e as RunEvent).t_s)))
    .map((e) => ({ ...(e as RunEvent), type: eventTypeOf(e) as string, t_s: Number((e as RunEvent).t_s) }));
}

function outcomeOf(run: unknown): string {
  const r = run as { outcome?: unknown; metrics?: { outcome?: unknown; primary_failure_class?: unknown }; claim?: { outcome?: unknown } };
  const raw = r?.metrics?.primary_failure_class ?? r?.metrics?.outcome ?? r?.outcome ?? r?.claim?.outcome;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "UNKNOWN";
}

/** Every failure class the run recorded, primary first. The simulator publishes the set; older run
 *  documents carry only `outcome`, and then the set is that one class. */
function classesOf(run: unknown, primary: string): string[] {
  const r = run as { failure_classes?: unknown; metrics?: { failure_class_set?: unknown }; claim?: { failure_classes?: unknown } };
  const raw = r?.failure_classes ?? r?.metrics?.failure_class_set ?? r?.claim?.failure_classes;
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  const out = [primary, ...list.filter((c) => c !== primary)];
  return out.filter((c) => c !== "UNKNOWN" || out.length === 1);
}

/** The event that carries a class's failure moment, when the run recorded one. */
function momentFor(classId: string, events: RunEvent[]): RunEvent | null {
  const known = KNOWN_CLASSES[classId];
  if (known) { const e = events.find((x) => x.type === known.moment_event); if (e) return e; }
  const terminal = events.filter((e) => !CUE_EVENTS.has(e.type));
  return terminal.length ? terminal[terminal.length - 1] : null;
}

/**
 * Read a run document and return everything the experience needs to narrate its failure.
 * `baseline`, when given, contributes one extra scrubber mark: the moment the nominal run stopped,
 * which is what makes "stops in time" versus "does not" legible on a single timeline.
 */
export function presentFailure(run: unknown, baseline?: unknown): FailurePresentation {
  const classId = outcomeOf(run);
  const known = KNOWN_CLASSES[classId];
  const events = eventsOf(run);
  const classes = classesOf(run, classId);

  // The moment: the class's own event type when the run carries it, otherwise the last event that is
  // not a cue on the way there, otherwise nothing.
  const moment = momentFor(classId, events);

  const numericOf = (e: RunEvent | null): Quantity[] =>
    e ? Object.entries(e).filter(([k, v]) => k !== "t_s" && typeof v === "number" && Number.isFinite(v)).map(([k, v]) => quantityFrom(k, v as number)) : [];
  const quantities: Quantity[] = numericOf(moment);
  // Where the severity proxy is actually recorded. Read from the run's own events, never assumed.
  const severity_moment = known?.severity_event ? events.find((e) => e.type === known.severity_event) ?? null : null;
  const severity_quantities = numericOf(severity_moment);
  const severity_label = severity_moment ? known?.severity_label ?? labelForKey(severity_moment.type) : known ? known.moment_label : moment ? labelForKey(moment.type) : "the failure";
  const attributes: Attribute[] = [moment, severity_moment]
    .filter((e): e is RunEvent => !!e)
    .flatMap((e) => Object.entries(e).filter(([k, v]) => k !== "type" && k !== "event" && typeof v === "string").map(([k, v]) => ({ key: k, label: labelForKey(k), value: v as string })));
  // The headline is the severity proxy the simulator itself uses for this class, taken from whichever
  // event records it; failing that, a speed-like field, which is the one a reader can feel.
  const headline_quantity = (known && (severity_quantities.find((q) => q.key === known.headline_key) ?? quantities.find((q) => q.key === known.headline_key)))
    ?? quantities.find((q) => /speed/.test(q.key) || q.unit === "m/s") ?? severity_quantities[0] ?? quantities[0] ?? null;

  const label = known ? known.label : humanizeClass(classId);
  const moment_label = known ? known.moment_label : moment ? labelForKey(moment.type) : "the failure";

  const markers: Marker[] = [];
  for (const e of events) {
    if (!CUE_EVENTS.has(e.type)) continue;
    markers.push({ id: e.type, t_s: e.t_s, label: CUE_LABELS[e.type] ?? labelForKey(e.type), kind: "cue" });
  }
  if (moment) markers.push({ id: "moment", t_s: moment.t_s, label: moment_label, kind: "moment" });
  if (severity_moment && severity_moment !== moment) markers.push({ id: "severity", t_s: severity_moment.t_s, label: severity_label, kind: "secondary" });
  // a run can fail in more than one way; each extra class gets its own mark and badge
  const also = classes.slice(1).map((c) => {
    const e = KNOWN_CLASSES[c] ? events.find((x) => x.type === KNOWN_CLASSES[c].moment_event) ?? null : null;
    const l = KNOWN_CLASSES[c]?.label ?? humanizeClass(c);
    if (e && e !== moment) markers.push({ id: c, t_s: e.t_s, label: KNOWN_CLASSES[c]?.moment_label ?? l.toLowerCase(), kind: "secondary" });
    return { class_id: c, label: l, t_s: e ? e.t_s : null };
  });
  const bStop = eventsOf(baseline).find((e) => e.type === "stopped");
  if (bStop) markers.push({ id: "baseline_stop", t_s: bStop.t_s, label: "baseline stops", kind: "cue" });
  markers.sort((a, b) => a.t_s - b.t_s);

  return {
    class_id: classId,
    known_class: !!known,
    label,
    sentence: known ? known.sentence : `The simulator classified this run as ${classId} rather than SUCCESS.`,
    classes,
    also,
    moment,
    moment_t_s: moment ? moment.t_s : null,
    moment_label,
    quantities,
    attributes,
    severity_moment,
    severity_moment_t_s: severity_moment ? severity_moment.t_s : null,
    severity_label,
    severity_quantities,
    headline_quantity,
    headline: headline_quantity ? `${label.toUpperCase()} · ${headline_quantity.text}` : label.toUpperCase(),
    markers,
  };
}

/**
 * Where the playhead should sit when the replay opens: a lead-in before the failure moment, so the
 * viewer arrives just before impact rather than at the parked end of the run. Without a moment the
 * run opens at the start.
 */
export function defaultPlayhead(momentT: number | null, duration: number, lead = 0.6): number {
  if (momentT === null || !Number.isFinite(momentT)) return 0;
  return Math.min(Math.max(momentT - lead, 0), Math.max(duration, 0));
}

/** Where the replay should stop after autoplaying through the failure once. */
export function autoplayStop(momentT: number | null, duration: number, tail = 0.9): number {
  if (momentT === null || !Number.isFinite(momentT)) return duration;
  return Math.min(momentT + tail, duration);
}
