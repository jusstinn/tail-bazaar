// Shared presentation helpers: the page vocabulary (bands, eyebrows, disclosures, range bars) and
// the small amount of motion the experience uses. Everything here honours prefers-reduced-motion.
import { esc } from "./format.js";
import type { Axis, EnvelopeDoc } from "./api.js";

export const reducedMotion = (): boolean => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

export function badge(text: string, cls = ""): string {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

export function statusTone(s: string): string {
  if (/SettledInvalid|INVALID|Refunded|REFUND|FAIL/i.test(s)) return "bad";
  if (/VALID|SettledValid|OK|VERIFIED/i.test(s)) return "ok";
  if (/Listed|LISTED|Funded|FUNDED|Delivered|DELIVERED/i.test(s)) return "info";
  return "";
}

/** A full-width section with generous vertical rhythm. */
export function band(opts: { id?: string; eyebrow?: string; tone?: string; inner: string }): string {
  return `<section class="band ${opts.tone ?? ""}"${opts.id ? ` id="${esc(opts.id)}"` : ""}>
    <div class="wrap">
      ${opts.eyebrow ? `<div class="eyebrow reveal">${esc(opts.eyebrow)}</div>` : ""}
      ${opts.inner}
    </div>
  </section>`;
}

/** Labelled progressive disclosure. The contents stay complete and reachable; they are simply not
 *  the first thing a visitor reads. */
export function disclosure(summary: string, inner: string, note = ""): string {
  return `<details class="disc reveal"><summary><span class="disc-label">${esc(summary)}</span>${note ? `<span class="disc-note">${esc(note)}</span>` : ""}</summary><div class="disc-body">${inner}</div></details>`;
}

/** Key/value rows in readable type. Monospace is reserved for the `mono` flag: hashes, addresses,
 *  parameter names and other code-like values. */
export function facts(rows: [string, string, boolean?][]): string {
  return `<dl class="facts">${rows.map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ""}>${v}</dd>`).join("")}</dl>`;
}

export function counter(value: number, unit: string, decimals = 2): string {
  return `<span class="count" data-count="${value}" data-dec="${decimals}">0</span>${unit ? `<span class="count-unit">${esc(unit)}</span>` : ""}`;
}

export function metric(label: string, value: number, unit: string, decimals = 2, note = ""): string {
  return `<div class="metric reveal"><div class="metric-v">${counter(value, unit, decimals)}</div><div class="metric-k">${esc(label)}</div>${note ? `<div class="metric-n">${esc(note)}</div>` : ""}</div>`;
}

// ------------------------------------------------------------------ operating-range bars
const pct = (v: number, lo: number, hi: number): number => (hi === lo ? 0 : ((v - lo) / (hi - lo)) * 100);

export type TunedSpec = { min?: number; max?: number; exactly?: number };

export function inTuned(v: number, t: TunedSpec): boolean {
  return t.exactly !== undefined ? v === t.exactly : (t.min === undefined || v >= t.min) && (t.max === undefined || v <= t.max);
}

/** One axis as a range bar: the searched envelope is the whole track, the range the controller was
 *  tuned for is the shaded band inside it, and (post-purchase only) a marker shows where this
 *  finding sits. */
export function rangeBar(axis: Axis, tuned: TunedSpec, finding?: number | null): string {
  const lo = axis.low, hi = axis.high;
  const tLo = tuned.exactly !== undefined ? tuned.exactly : tuned.min !== undefined ? tuned.min : lo;
  const tHi = tuned.exactly !== undefined ? tuned.exactly : tuned.max !== undefined ? tuned.max : hi;
  let left = pct(tLo, lo, hi), width = pct(tHi, lo, hi) - left;
  if (width < 1.2) { left = Math.max(0, left - 0.6); width = 1.2; }
  const hasFinding = typeof finding === "number" && Number.isFinite(finding);
  const ok = hasFinding ? inTuned(finding as number, tuned) : true;
  const unit = axis.units === "coefficient" ? "" : axis.units;
  return `<div class="rb reveal">
    <div class="rb-head"><span class="mono rb-name">${esc(axis.name)}</span><span class="rb-group">${esc(axis.group)}</span></div>
    <div class="rb-track">
      <div class="rb-tuned" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div>
      <div class="rb-nominal" style="left:${pct(axis.nominal, lo, hi).toFixed(2)}%" title="nominal ${esc(axis.nominal)}"></div>
      ${hasFinding ? `<div class="rb-find ${ok ? "ok" : "out"}" style="left:${pct(finding as number, lo, hi).toFixed(2)}%"><span>${esc(finding)}</span></div>` : ""}
    </div>
    <div class="rb-scale"><span>${esc(lo)}</span><span class="rb-unit">${esc(unit)}</span><span>${esc(hi)}</span></div>
    <div class="rb-note">searched ${esc(lo)}–${esc(hi)} · tuned for ${esc(axis.tuned_range)}${hasFinding ? ` · this finding <strong class="${ok ? "" : "alert"}">${esc(finding)}</strong>` : ""}</div>
  </div>`;
}

export function rangeBars(env: EnvelopeDoc, scenario?: Record<string, number> | null): string {
  return `<div class="rb-grid">${env.axes.map((a) => rangeBar(a, env.controller_tuned_range.per_parameter[a.name] ?? {}, scenario ? Number(scenario[a.name]) : null)).join("")}</div>
  <div class="rb-legend"><span><i class="sw sw-tuned"></i>range the controller was tuned for</span><span><i class="sw sw-track"></i>envelope the hunter searched</span><span><i class="sw sw-nominal"></i>nominal operating point</span>${scenario ? `<span><i class="sw sw-find"></i>where this finding sits</span>` : ""}</div>`;
}

// ------------------------------------------------------------------ motion
let io: IntersectionObserver | null = null;

/** Scroll-triggered entrance: fade plus a short upward translate, staggered within each band. */
export function armReveals(root: ParentNode = document): void {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(".reveal:not(.in)"));
  if (reducedMotion() || !("IntersectionObserver" in window)) { nodes.forEach((n) => n.classList.add("in")); return; }
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        const i = Number(el.dataset.stagger ?? 0);
        window.setTimeout(() => el.classList.add("in"), Math.min(i, 6) * 55);
        io!.unobserve(el);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
  }
  nodes.forEach((n) => {
    const siblings = Array.from(n.parentElement?.children ?? []).filter((c) => c.classList.contains("reveal"));
    n.dataset.stagger = String(Math.max(0, siblings.indexOf(n)));
    io!.observe(n);
  });
  // anything already in view when the page renders should not wait for a scroll
  window.requestAnimationFrame(() => {
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.92) n.classList.add("in");
    }
  });
}

/** Count a number up once, when it first scrolls into view. */
export function armCounters(root: ParentNode = document): void {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(".count:not([data-done])"));
  const settle = (el: HTMLElement): void => {
    const to = Number(el.dataset.count ?? 0);
    const dec = Number(el.dataset.dec ?? 2);
    el.dataset.done = "1";
    if (reducedMotion()) { el.textContent = to.toFixed(dec); return; }
    const start = performance.now(), dur = 820;
    const step = (now: number): void => {
      const k = Math.min((now - start) / dur, 1);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = (to * e).toFixed(dec);
      if (k < 1) requestAnimationFrame(step);
      else el.textContent = to.toFixed(dec);
    };
    requestAnimationFrame(step);
  };
  if (!("IntersectionObserver" in window)) { nodes.forEach(settle); return; }
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { settle(e.target as HTMLElement); obs.unobserve(e.target); }
  }, { threshold: 0.3 });
  nodes.forEach((n) => obs.observe(n));
}

export function armPage(root: ParentNode = document): void {
  armReveals(root);
  armCounters(root);
}
