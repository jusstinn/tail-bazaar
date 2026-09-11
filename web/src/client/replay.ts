// Replay viewer — one engine, one renderer per target. It renders the recorded per-tick body
// transforms (position + quaternion) from the run documents with Three.js. There is NO physics here:
// every pose comes from the saved `frames` rows, in both viewports and for the ghost overlay.
//
// Two view modes over the same recorded data:
//   overlay — one large viewport showing the purchased failure run with the surviving nominal
//             baseline drawn as a translucent ghost, so "survives" and "does not" are visible in one
//             frame;
//   split   — the two runs side by side, with IDENTICAL camera framing (one shared follow anchor),
//             so the panels are comparable and both subjects stay in frame.
// The failure moment (first contact, load shed, the fall — whatever class the run declares) is marked
// in the scene with an expanding ring, held for a beat when the playhead crosses it, and played at a
// fraction of speed around it so the moment is legible rather than a single dropped frame.
//
// TARGETS. Everything that differs between a warehouse cart, a humanoid and a manipulator — the
// geometry, the floor, the camera, the HUD, where the ring sits — lives in a SceneRenderer
// (replay-cart.ts, replay-humanoid.ts, replay-arm.ts). This file knows only about frames, time and
// the failure presentation.
import * as THREE from "three";
import type { Frames, RunLike } from "./api.js";
import { COL } from "./palette.js";
import type { FailurePresentation } from "../server/failure.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // MuJoCo is z-up

const SLOW_WINDOW_S = 0.22;   // sim seconds either side of the failure moment
const SLOW_FACTOR = 0.18;     // played at ~1/5 speed through it
const FREEZE_S = 0.65;        // wall seconds held the first time the playhead crosses the moment
const RING_GROW_S = 0.5;      // sim seconds for the contact ring to expand
const LEAD_MAX_M = 0.4;       // how far the surviving run may lead the purchased subject in the framing

export type Anchor = { x: number; y: number; z: number };

/** Everything that is specific to one target's scene. See replay-cart.ts / replay-humanoid.ts. */
export type SceneRenderer = {
  id: string;
  /** The body the camera follows and the visibility check reports on. */
  anchorBody: string;
  ghostLaneOffset: number;
  aspect: { overlay: number; split: number };
  /** Legend entries, so the page's swatches and the viewport's materials can never drift apart. */
  swatches: { color: string; label: string; translucent?: boolean; thin?: boolean }[];
  build(scene: THREE.Scene, run: RunLike, frames: Frames): { update?(a: Anchor, t: number): void };
  ghostExtras?(scene: THREE.Scene, ghostRun: RunLike, laneY: number): void;
  bodies(run: RunLike, frames: Frames, ghost: boolean): Map<string, THREE.Object3D>;
  anchor(frames: Frames, t: number): Anchor;
  camera(a: Anchor): { pos: [number, number, number]; look: [number, number, number] };
  mark(run: RunLike, frames: Frames, t: number, momentType: string | undefined): { at: [number, number, number]; radius: number; faceDownTrack: boolean };
  hud(run: RunLike, t: number): string;
};

type Track = {
  name: string; run: RunLike; frames: Frames; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  bodies: Map<string, THREE.Object3D>; ghost: Map<string, THREE.Object3D> | null; ghostFrames: Frames | null;
  label: HTMLElement; hud: HTMLElement; frameEl: HTMLElement; callout: HTMLElement;
  momentAt: number | null; duration: number; ring: THREE.Mesh | null; ringMat: THREE.MeshBasicMaterial | null;
  statics: { update?(a: Anchor, t: number): void };
};

function buildTrack(r: SceneRenderer, name: string, run: RunLike, frames: Frames, container: HTMLElement, opts: { ghostRun?: RunLike; ghostFrames?: Frames; momentAt: number | null; momentLabel: string; momentType?: string }): Track {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.background);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9d968c, 1.25));
  const dir = new THREE.DirectionalLight(0xffffff, 1.35);
  dir.position.set(-2, -4, 6);
  scene.add(dir);
  const statics = r.build(scene, run, frames);

  const bodies = r.bodies(run, frames, false);
  for (const b of bodies.values()) scene.add(b);

  // Ghost overlay: the surviving nominal baseline drawn inside this scene, posed from ITS OWN
  // recorded frames, one lane over — its position ALONG the track stays exact.
  let ghost: Map<string, THREE.Object3D> | null = null;
  let ghostFrames: Frames | null = null;
  if (opts.ghostRun && opts.ghostFrames) {
    ghostFrames = opts.ghostFrames;
    ghost = r.bodies(opts.ghostRun, ghostFrames, true);
    for (const b of ghost.values()) { const g = new THREE.Group(); g.position.set(0, r.ghostLaneOffset, 0); g.add(b); scene.add(g); }
    r.ghostExtras?.(scene, opts.ghostRun, r.ghostLaneOffset);
  }

  // The failure moment, marked in the scene.
  let ring: THREE.Mesh | null = null;
  let ringMat: THREE.MeshBasicMaterial | null = null;
  if (opts.momentAt !== null) {
    const m = r.mark(run, frames, opts.momentAt, opts.momentType);
    // drawn as an annotation: always on top, so it is never buried inside the body it marks
    ringMat = new THREE.MeshBasicMaterial({ color: COL.alert, transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    ring = new THREE.Mesh(new THREE.RingGeometry(m.radius * 0.87, m.radius * 1.13, 48), ringMat);
    if (m.faceDownTrack) ring.rotation.y = Math.PI / 2;
    ring.position.set(m.at[0], m.at[1], m.at[2]);
    ring.renderOrder = 999;
    ring.visible = false;
    scene.add(ring);
  }

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  camera.up.set(0, 0, 1);

  const label = document.createElement("div");
  label.className = "vp-label";
  label.textContent = name;
  const hud = document.createElement("div");
  hud.className = "vp-hud";
  const callout = document.createElement("div");
  callout.className = "vp-callout";
  callout.textContent = opts.momentLabel;
  callout.hidden = true;
  const frameEl = document.createElement("div");
  frameEl.className = "vp-frame";
  frameEl.append(label, callout, hud);
  container.appendChild(frameEl);
  const last = frames.data[frames.data.length - 1];
  return { name, run, frames, scene, camera, bodies, ghost, ghostFrames, label, hud, frameEl, callout, momentAt: opts.momentAt, duration: last ? last[0] : 0, ring, ringMat, statics };
}

const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _v = new THREE.Vector3();

function poseInto(targets: Map<string, THREE.Object3D>, frames: Frames, t: number): void {
  const { data, dt_s, bodies } = frames;
  if (data.length === 0) return;
  const f = Math.min(Math.max(t / dt_s, 0), data.length - 1);
  const i0 = Math.floor(f), i1 = Math.min(i0 + 1, data.length - 1);
  const a = f - i0;
  const r0 = data[i0], r1 = data[i1];
  bodies.forEach((name, bi) => {
    const obj = targets.get(name);
    if (!obj) return;
    const o = 1 + 7 * bi;
    _p1.set(r0[o], r0[o + 1], r0[o + 2]);
    _p2.set(r1[o], r1[o + 1], r1[o + 2]);
    obj.position.copy(_p1.lerp(_p2, a));
    _q1.set(r0[o + 4], r0[o + 5], r0[o + 6], r0[o + 3]); // recorded order is w,x,y,z
    _q2.set(r1[o + 4], r1[o + 5], r1[o + 6], r1[o + 3]);
    obj.quaternion.copy(_q1.slerp(_q2, a));
  });
}

export type ViewMode = "overlay" | "split";
export type Visibility = { name: string; ndcX: number; ndcY: number; visible: boolean };

export type Replay = {
  setTime(t: number): void; play(): void; pause(): void; toggle(): boolean; playThrough(from: number, to: number): void;
  setSpeed(s: number): void; setMode(m: ViewMode): void; mode(): ViewMode; duration: number; time(): number;
  isPlaying(): boolean; onTime(cb: (t: number) => void): void; visibility(): Visibility[]; snapshot(t: number, width?: number): string; dispose(): void;
  /** Camera state of the purchased-run viewport, for capture tooling and framing checks. */
  debug(): { t: number; anchor: Anchor; cam: { pos: number[]; look: number[] }; cameraPos: number[]; aspect: number; fov: number; size: number[] };
};

export type ReplayOptions = {
  renderer: SceneRenderer;
  baseline: RunLike; failure: RunLike; failureFrames: Frames;
  presentation: FailurePresentation; mode?: ViewMode; reducedMotion?: boolean;
  baselineLabel?: string; failureLabel?: string;
};

export function createReplay(host: HTMLElement, opts: ReplayOptions): Replay {
  const { renderer: R, baseline, failure, failureFrames, presentation } = opts;
  const momentAt = presentation.moment_t_s;
  const reduced = opts.reducedMotion ?? false;

  const wrap = document.createElement("div");
  wrap.className = "viewports";
  host.appendChild(wrap);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); // preserve so the canvas can be exported/inspected
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  wrap.appendChild(renderer.domElement);
  const overlayEl = document.createElement("div");
  overlayEl.className = "vp-overlay";
  wrap.appendChild(overlayEl);

  // The callout names the moment the SEVERITY was measured at, which for the humanoid is the ground
  // impact rather than the instant the environment declared the fall.
  const momentWord = presentation.severity_label || presentation.moment_label;
  const contactText = presentation.headline_quantity ? `${momentWord.toUpperCase()} · ${presentation.headline_quantity.text}` : momentWord.toUpperCase();
  const tracks: Track[] = [
    buildTrack(R, opts.baselineLabel ?? "Baseline · nominal conditions", baseline, baseline.frames, overlayEl, { momentAt: null, momentLabel: "" }),
    buildTrack(R, opts.failureLabel ?? "Purchased scenario", failure, failureFrames, overlayEl, { ghostRun: baseline, ghostFrames: baseline.frames, momentAt, momentLabel: contactText, momentType: presentation.moment?.type }),
  ];
  const FAILURE = 1;
  // The timeline is the PURCHASED run's own length. The ghost (and the baseline panel in split mode)
  // is posed from its own frames and holds its last pose if it is shorter. If it is LONGER — the
  // humanoid baseline survives the whole 15 s episode while the purchased run ends 1.2 s after the
  // fall — the extra seconds would only stretch the scrubber and push every marker off the time it
  // was computed on, because the page places its markers on the purchased run's duration.
  const duration = tracks[FAILURE].duration;

  let mode: ViewMode = opts.mode ?? "overlay";
  let t = 0, playing = false, speed = 0.5, last = performance.now();
  let stopAt: number | null = null, freezeLeft = 0, frozeOnce = false;
  const listeners: ((t: number) => void)[] = [];
  const camTarget = tracks.map(() => new THREE.Vector3());
  let firstDraw = true;

  function activeTracks(): Track[] { return mode === "overlay" ? [tracks[FAILURE]] : tracks; }

  function applyMode(): void {
    wrap.classList.toggle("is-overlay", mode === "overlay");
    wrap.classList.toggle("is-split", mode === "split");
    // the ghost belongs to the single-viewport comparison; side by side already shows both runs
    tracks[FAILURE].ghost?.forEach((o) => { (o.parent ?? o).visible = mode === "overlay"; });
    tracks[0].frameEl.hidden = mode === "overlay";
    resize();
  }

  function resize(): void {
    const w = wrap.clientWidth || 960;
    const h = Math.max(320, Math.round(w * (mode === "overlay" ? R.aspect.overlay : R.aspect.split)));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = h + "px";
    const n = activeTracks().length;
    activeTracks().forEach((tr) => { tr.camera.aspect = w / n / h; tr.camera.updateProjectionMatrix(); });
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(wrap);

  /** ONE framing anchor for every viewport: the leading subject across both runs, with the lateral
   *  position taken from the purchased run. The panels are then literally the same camera, which is
   *  what makes them comparable — and the two subjects stay inside one frame. */
  function anchor(): Anchor {
    const each = tracks.map((tr) => R.anchor(tr.frames, Math.min(t, tr.duration)));
    // The surviving run may lead the framing, but only by so much: the purchased subject is the
    // evidence, and once the humanoid is down the ghost keeps walking away from it.
    const xf = each[FAILURE].x;
    const lead = Math.max(...each.map((a) => a.x)) - xf;
    return { x: xf + Math.min(Math.max(lead, 0), LEAD_MAX_M), y: each[FAILURE].y, z: each[FAILURE].z };
  }

  function draw(): void {
    // Viewport and scissor are given in CSS pixels: three.js multiplies them by the pixel ratio
    // itself. Passing the drawing buffer's size here doubled them on a Retina display, and the
    // visible canvas then showed the bottom-left quarter of the intended frame at twice the size.
    const pr = renderer.getPixelRatio();
    const w = renderer.domElement.width / pr, h = renderer.domElement.height / pr;
    const shown = activeTracks();
    const a = anchor();
    const cam = R.camera(a);
    renderer.setScissorTest(true);
    shown.forEach((tr, i) => {
      poseInto(tr.bodies, tr.frames, Math.min(t, tr.duration));
      if (tr.ghost && tr.ghostFrames && tr.ghost.size) poseInto(tr.ghost, tr.ghostFrames, Math.min(t, (tr.ghostFrames.data[tr.ghostFrames.data.length - 1] ?? [0])[0]));
      tr.statics.update?.(a, t);
      camTarget[i].set(cam.pos[0], cam.pos[1], cam.pos[2]);
      if (firstDraw || reduced) tr.camera.position.copy(camTarget[i]);
      else tr.camera.position.lerp(camTarget[i], 0.25);
      tr.camera.lookAt(cam.look[0], cam.look[1], cam.look[2]);

      // failure moment: expanding ring that settles into a persistent mark
      if (tr.ring && tr.ringMat && tr.momentAt !== null) {
        const age = t - tr.momentAt;
        tr.ring.visible = age >= 0;
        if (age >= 0) {
          const k = Math.min(age / RING_GROW_S, 1);
          const s = 0.45 + k * 1.25;
          tr.ring.scale.set(s, s, s);
          tr.ringMat.opacity = 1 - k * 0.55;
        }
      }
      const x0 = Math.floor((i * w) / shown.length);
      const vw = Math.floor(w / shown.length);
      renderer.setViewport(x0, 0, vw, h);
      renderer.setScissor(x0, 0, vw, h);
      renderer.render(tr.scene, tr.camera);

      const past = tr.momentAt !== null && t >= tr.momentAt;
      tr.hud.innerHTML = R.hud(tr.run, Math.min(t, tr.duration));
      tr.callout.hidden = !past;
      tr.frameEl.classList.toggle("contact", past);
    });
    firstDraw = false;
  }

  function loop(now: number): void {
    const dtWall = Math.min(Math.max((now - last) / 1000, 0), 0.1); // never negative: a rAF timestamp can lag performance.now() after a slow first paint
    last = now;
    if (playing) {
      if (freezeLeft > 0) {
        freezeLeft -= dtWall;
      } else {
        const near = !reduced && momentAt !== null && Math.abs(t - momentAt) < SLOW_WINDOW_S;
        const prev = t;
        t += dtWall * speed * (near ? SLOW_FACTOR : 1);
        if (!reduced && momentAt !== null && prev < momentAt && t >= momentAt && !frozeOnce) { t = momentAt; frozeOnce = true; freezeLeft = FREEZE_S; }
        if (stopAt !== null && t >= stopAt) { t = stopAt; stopAt = null; playing = false; }
        if (t >= duration) { t = duration; playing = false; }
      }
      listeners.forEach((cb) => cb(t));
    }
    draw();
    raf = requestAnimationFrame(loop);
  }
  let raf = requestAnimationFrame(loop);

  applyMode();
  draw();

  return {
    duration,
    time: () => t,
    isPlaying: () => playing,
    mode: () => mode,
    setMode(m) { if (m !== mode) { mode = m; applyMode(); firstDraw = true; } },
    // A jump in time snaps the camera and draws at once: a scrub must show its frame even where the
    // animation loop is throttled (a background tab, a headless capture), not on the next tick.
    setTime(v) { t = Math.min(Math.max(v, 0), duration); stopAt = null; firstDraw = true; draw(); listeners.forEach((cb) => cb(t)); },
    play() { if (t >= duration) { t = 0; frozeOnce = false; } playing = true; last = performance.now(); },
    pause() { playing = false; stopAt = null; },
    toggle() { playing ? this.pause() : this.play(); return playing; },
    /** Autoplay one pass across a window of the run (used on load: lead-in, failure, short tail). */
    playThrough(from, to) {
      t = Math.min(Math.max(from, 0), duration);
      stopAt = Math.min(Math.max(to, from), duration);
      frozeOnce = t > (momentAt ?? Infinity);
      playing = true;
      last = performance.now();
      firstDraw = true;
      draw();
      listeners.forEach((cb) => cb(t));
    },
    setSpeed(s) { speed = s; },
    onTime(cb) { listeners.push(cb); },
    /** Normalised device coordinates of every visible subject — a viewport where the subject is
     *  off-frame is a bug, and this is how the headless capture checks it. */
    visibility() {
      const out: Visibility[] = [];
      activeTracks().forEach((tr) => {
        const body = tr.bodies.get(R.anchorBody);
        if (!body) return;
        _v.copy(body.position).project(tr.camera);
        out.push({ name: tr.name, ndcX: Number(_v.x.toFixed(3)), ndcY: Number(_v.y.toFixed(3)), visible: Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1 });
      });
      return out;
    },
    /** Render one frame at an explicit size (independent of page layout) and return a JPEG data URL. */
    snapshot(v, width = 960) {
      playing = false;
      t = Math.min(Math.max(v, 0), duration);
      const n = activeTracks().length;
      const h = Math.round(width * (mode === "overlay" ? R.aspect.overlay : R.aspect.split));
      renderer.setSize(width, h, false);
      activeTracks().forEach((tr) => { tr.camera.aspect = width / n / h; tr.camera.updateProjectionMatrix(); });
      firstDraw = true;
      for (let i = 0; i < 4; i++) draw();
      const url = renderer.domElement.toDataURL("image/jpeg", 0.6);
      resize();
      return url;
    },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); wrap.remove(); },
    debug() {
      const a = anchor(); const cam = R.camera(a); const c = tracks[FAILURE].camera;
      return { t, anchor: a, cam: { pos: [...cam.pos], look: [...cam.look] }, cameraPos: [c.position.x, c.position.y, c.position.z], aspect: c.aspect, fov: c.fov, size: [renderer.domElement.width, renderer.domElement.height] };
    },
  };
}

/** The renderer a run's target declares. Unknown ids fall back to the cart, which is the renderer
 *  every record written before the marketplace became multi-target implies. */
export function rendererFor(id: string | undefined | null): SceneRenderer {
  return id === "humanoid-3d" ? HUMANOID : id === "arm-3d" ? ARM : CART;
}

import { CART_RENDERER as CART } from "./replay-cart.js";
import { HUMANOID_RENDERER as HUMANOID } from "./replay-humanoid.js";
import { ARM_RENDERER as ARM } from "./replay-arm.js";
export { CART_RENDERER } from "./replay-cart.js";
export { HUMANOID_RENDERER } from "./replay-humanoid.js";
export { ARM_RENDERER } from "./replay-arm.js";
export const GHOST_LANE_OFFSET_M = CART.ghostLaneOffset;
