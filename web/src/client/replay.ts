// Replay viewer. It renders the recorded per-tick body transforms (position + quaternion) from the
// run documents with Three.js. There is NO physics here: every pose comes from the saved `frames`
// rows, in both viewports and for the ghost overlay.
//
// Two view modes over the same recorded data:
//   overlay — one large viewport showing the purchased failure run with the nominal baseline drawn
//             as a translucent ghost, so "stops in time" and "does not" are visible in one frame;
//   split   — the two runs side by side, with IDENTICAL camera framing (one shared follow anchor),
//             so the panels are comparable and both carts stay in frame.
// The failure moment (first contact, or whatever class the run declares) is marked in the scene with
// an expanding ring, held for a beat when the playhead crosses it, and played at a fraction of speed
// around it so the impact is legible rather than a single dropped frame.
import * as THREE from "three";
import type { Frames, RunLike, Tick } from "./api.js";
import type { FailurePresentation } from "../server/failure.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // MuJoCo is z-up

const COL = { chassis: 0x2f6fd0, load: 0xe2b64a, wheel: 0x1b1b1f, obstacle: 0xcf5a2c, floor: 0xf1f0ee, ghost: 0x6b7280, alert: 0xb42318 };
export const GHOST_LANE_OFFSET_M = 0.95; // lateral only: the position ALONG the track stays exact
const SLOW_WINDOW_S = 0.22;   // sim seconds either side of the failure moment
const SLOW_FACTOR = 0.18;     // played at ~1/5 speed through it
const FREEZE_S = 0.65;        // wall seconds held the first time the playhead crosses the moment
const RING_GROW_S = 0.5;      // sim seconds for the contact ring to expand

type Track = {
  name: string; run: RunLike; frames: Frames; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  bodies: Map<string, THREE.Object3D>; ghost: Map<string, THREE.Object3D> | null; ghostFrames: Frames | null;
  label: HTMLElement; hud: HTMLElement; frameEl: HTMLElement; callout: HTMLElement;
  momentAt: number | null; duration: number; ring: THREE.Mesh | null; ringMat: THREE.MeshBasicMaterial | null;
};

function mat(color: number): THREE.MeshLambertMaterial { return new THREE.MeshLambertMaterial({ color }); }

function bodyMeshes(sc: any, frames: Frames, ghost: boolean): Map<string, THREE.Object3D> {
  const bodies = new Map<string, THREE.Object3D>();
  const opts = ghost ? { transparent: true, opacity: 0.3, depthWrite: false } : {};
  const ch = sc.chassis_half_m as number[];
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2 * ch[0], 2 * ch[1], 2 * ch[2]), new THREE.MeshLambertMaterial({ color: ghost ? COL.ghost : COL.chassis, ...opts }));
  if (!ghost) {
    const rf = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), new THREE.MeshBasicMaterial({ color: 0x111111 })); // rangefinder site
    rf.position.set(ch[0] + 0.01, 0, 0);
    chassis.add(rf);
  }
  bodies.set("chassis", chassis);
  const lh = sc.load_half_m as number[];
  bodies.set("load", new THREE.Mesh(new THREE.BoxGeometry(2 * lh[0], 2 * lh[1], 2 * lh[2]), new THREE.MeshLambertMaterial({ color: ghost ? COL.ghost : COL.load, ...opts })));
  const r = sc.wheel_radius_m as number;
  for (const w of frames.bodies.filter((b) => b.startsWith("wheel"))) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.06, 24), new THREE.MeshLambertMaterial({ color: ghost ? COL.ghost : COL.wheel, ...opts }))); // axis along local y, like the MJCF zaxis="0 1 0"
    if (!ghost) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.064, r * 0.9), new THREE.MeshBasicMaterial({ color: 0xd0d3d8 }));
      spoke.position.set(0, 0, r * 0.45);
      g.add(spoke);
    }
    bodies.set(w, g);
  }
  return bodies;
}

/** A recorded body position at time t, read straight out of the saved frames. */
function bodyPosAt(frames: Frames, name: string, t: number): [number, number, number] {
  const bi = frames.bodies.indexOf(name);
  if (bi < 0 || frames.data.length === 0) return [0, 0, 0];
  const i = Math.min(Math.max(Math.round(t / frames.dt_s), 0), frames.data.length - 1);
  const o = 1 + 7 * bi;
  return [frames.data[i][o], frames.data[i][o + 1], frames.data[i][o + 2]];
}
const chassisXAt = (frames: Frames, t: number): number => bodyPosAt(frames, "chassis", t)[0];

function buildTrack(name: string, run: RunLike, frames: Frames, container: HTMLElement, opts: { ghostRun?: RunLike; ghostFrames?: Frames; momentAt: number | null; momentLabel: string; momentType?: string }): Track {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf7f7f6);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0a6, 1.25));
  const dir = new THREE.DirectionalLight(0xffffff, 1.35);
  dir.position.set(-2, -4, 6);
  scene.add(dir);
  const sc = run.scene;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ color: COL.floor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  floor.position.set(6, 0, 0);
  scene.add(floor);
  // 1 m floor grid built from thin meshes (GL_LINES are unreliable in software WebGL renderers)
  const gridMat = mat(0xd6d4d0);
  for (let i = -30; i <= 30; i++) {
    const gx = new THREE.Mesh(new THREE.BoxGeometry(60, 0.012, 0.004), gridMat);
    gx.position.set(6, i, 0.002);
    const gy = new THREE.Mesh(new THREE.BoxGeometry(0.012, 60, 0.004), gridMat);
    gy.position.set(6 + i, 0, 0.002);
    scene.add(gx, gy);
  }
  const oh = sc.obstacle_half_m as number[];
  const oc = sc.obstacle_center_m as number[];
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(2 * oh[0], 2 * oh[1], 2 * oh[2]), mat(COL.obstacle));
  obstacle.position.set(oc[0], oc[1], oc[2]);
  scene.add(obstacle);
  // target clearance marker: a thin line on the floor at obstacle_front - target_clearance
  const clear = (sc.target_clearance_m as number) ?? 0.4;
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.012, 2 * oh[1], 0.002), new THREE.MeshBasicMaterial({ color: 0x9a9691 }));
  marker.position.set((sc.obstacle_front_x_m as number) - clear, 0, 0.003);
  scene.add(marker);

  const bodies = bodyMeshes(sc, frames, false);
  for (const b of bodies.values()) scene.add(b);

  // Ghost overlay: the nominal baseline drawn inside this scene, posed from ITS OWN recorded frames.
  let ghost: Map<string, THREE.Object3D> | null = null;
  let ghostFrames: Frames | null = null;
  if (opts.ghostRun && opts.ghostFrames) {
    ghostFrames = opts.ghostFrames;
    ghost = bodyMeshes(opts.ghostRun.scene, ghostFrames, true);
    for (const b of ghost.values()) { const g = new THREE.Group(); g.position.set(0, GHOST_LANE_OFFSET_M, 0); g.add(b); scene.add(g); }
    // where the baseline came to rest: the line the purchased run failed to respect
    const stopX = Number(opts.ghostRun.metrics?.final_x_front_m);
    if (Number.isFinite(stopX)) {
      const stopLine = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.1, 0.004), new THREE.MeshBasicMaterial({ color: COL.ghost }));
      stopLine.position.set(stopX, GHOST_LANE_OFFSET_M, 0.004);
      scene.add(stopLine);
    }
  }

  // The failure moment, marked in the scene. WHICH BODY the mark sits on is read from the run: the
  // moment event's own type names it when it is not the cart itself (load_shed -> the load).
  let ring: THREE.Mesh | null = null;
  let ringMat: THREE.MeshBasicMaterial | null = null;
  if (opts.momentAt !== null) {
    const named = frames.bodies.find((b) => b !== "chassis" && (opts.momentType ?? "").includes(b));
    const p = bodyPosAt(frames, named ?? "chassis", opts.momentAt);
    const ch = sc.chassis_half_m as number[];
    const at: [number, number, number] = named ? p : [p[0] + ch[0] - 0.04, p[1], p[2] + 0.08];
    // drawn as an annotation: always on top, so it is never buried inside the body it marks
    ringMat = new THREE.MeshBasicMaterial({ color: COL.alert, transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.31, 48), ringMat);
    ring.rotation.y = Math.PI / 2; // face down the track
    ring.position.set(at[0], at[1], at[2]);
    ring.renderOrder = 999;
    ring.visible = false;
    scene.add(ring);
  }

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
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
  return { name, run, frames, scene, camera, bodies, ghost, ghostFrames, label, hud, frameEl, callout, momentAt: opts.momentAt, duration: last ? last[0] : 0, ring, ringMat };
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

function tickAt(run: RunLike, t: number): Tick | null {
  const ticks = run.ticks;
  if (!ticks?.length) return null;
  const i = Math.min(Math.max(Math.floor(t / 0.02), 0), ticks.length - 1);
  return ticks[i];
}

const n2 = (x: number | null | undefined): string => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—");

export type ViewMode = "overlay" | "split";
export type Visibility = { name: string; ndcX: number; ndcY: number; visible: boolean };

export type Replay = {
  setTime(t: number): void; play(): void; pause(): void; toggle(): boolean; playThrough(from: number, to: number): void;
  setSpeed(s: number): void; setMode(m: ViewMode): void; mode(): ViewMode; duration: number; time(): number;
  isPlaying(): boolean; onTime(cb: (t: number) => void): void; visibility(): Visibility[]; snapshot(t: number, width?: number): string; dispose(): void;
};

export type ReplayOptions = {
  baseline: RunLike; failure: RunLike; failureFrames: Frames;
  presentation: FailurePresentation; mode?: ViewMode; reducedMotion?: boolean;
};

export function createReplay(host: HTMLElement, opts: ReplayOptions): Replay {
  const { baseline, failure, failureFrames, presentation } = opts;
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

  const contactText = presentation.headline_quantity ? `${presentation.moment_label.toUpperCase()} · ${presentation.headline_quantity.text}` : presentation.moment_label.toUpperCase();
  const tracks: Track[] = [
    buildTrack("Baseline · nominal conditions", baseline, baseline.frames, overlayEl, { momentAt: null, momentLabel: "" }),
    buildTrack("Purchased scenario", failure, failureFrames, overlayEl, { ghostRun: baseline, ghostFrames: baseline.frames, momentAt, momentLabel: contactText, momentType: presentation.moment?.type }),
  ];
  const FAILURE = 1;
  const duration = Math.max(...tracks.map((t) => t.duration));

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
    const h = Math.max(320, Math.round(w * (mode === "overlay" ? 0.46 : 0.38)));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = h + "px";
    const n = activeTracks().length;
    activeTracks().forEach((tr) => { tr.camera.aspect = w / n / h; tr.camera.updateProjectionMatrix(); });
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(wrap);

  /** ONE framing anchor for every viewport: the leading cart across both runs. The panels are then
   *  literally the same camera, which is what makes them comparable — and with the two carts never
   *  more than a fraction of a metre apart, both stay inside a frame ~5.7 m wide. */
  function anchorX(): number {
    return Math.max(...tracks.map((tr) => chassisXAt(tr.frames, Math.min(t, tr.duration))));
  }

  function draw(): void {
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const shown = activeTracks();
    const cx = anchorX();
    renderer.setScissorTest(true);
    shown.forEach((tr, i) => {
      poseInto(tr.bodies, tr.frames, Math.min(t, tr.duration));
      if (tr.ghost && tr.ghostFrames && tr.ghost.size) poseInto(tr.ghost, tr.ghostFrames, Math.min(t, (tr.ghostFrames.data[tr.ghostFrames.data.length - 1] ?? [0])[0]));
      camTarget[i].set(cx - 1.15, -3.75, 1.75);
      if (firstDraw || reduced) tr.camera.position.copy(camTarget[i]);
      else tr.camera.position.lerp(camTarget[i], 0.25);
      tr.camera.lookAt(cx + 0.95, 0, 0.32);

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

      const tk = tickAt(tr.run, Math.min(t, tr.duration));
      const past = tr.momentAt !== null && t >= tr.momentAt;
      const trueRange = tk ? (tr.run.scene.obstacle_front_x_m as number) - tk.x_front_m : null;
      tr.hud.innerHTML = tk
        ? `<b>${t.toFixed(2)} s</b><span>${n2(tk.v_odom_mps)} m/s</span><span>sees ${tk.range_used_m >= 0 ? n2(tk.range_used_m) : "—"} m</span><span>really ${n2(trueRange)} m</span><span>brake ${(tk.brake_applied * 100).toFixed(0)}%</span>`
        : `<b>${t.toFixed(2)} s</b>`;
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
    setTime(v) { t = Math.min(Math.max(v, 0), duration); stopAt = null; listeners.forEach((cb) => cb(t)); },
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
      listeners.forEach((cb) => cb(t));
    },
    setSpeed(s) { speed = s; },
    onTime(cb) { listeners.push(cb); },
    /** Normalised device coordinates of every visible cart — a viewport where the cart is off-frame
     *  is a bug, and this is how the headless capture checks it. */
    visibility() {
      const out: Visibility[] = [];
      activeTracks().forEach((tr) => {
        const chassis = tr.bodies.get("chassis");
        if (!chassis) return;
        _v.copy(chassis.position).project(tr.camera);
        out.push({ name: tr.name, ndcX: Number(_v.x.toFixed(3)), ndcY: Number(_v.y.toFixed(3)), visible: Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1 });
      });
      return out;
    },
    /** Render one frame at an explicit size (independent of page layout) and return a JPEG data URL. */
    snapshot(v, width = 960) {
      playing = false;
      t = Math.min(Math.max(v, 0), duration);
      const n = activeTracks().length;
      const h = Math.round(width * (mode === "overlay" ? 0.46 : 0.38));
      renderer.setSize(width, h, false);
      activeTracks().forEach((tr) => { tr.camera.aspect = width / n / h; tr.camera.updateProjectionMatrix(); });
      firstDraw = true;
      for (let i = 0; i < 4; i++) draw();
      const url = renderer.domElement.toDataURL("image/jpeg", 0.6);
      resize();
      return url;
    },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); wrap.remove(); },
  };
}
