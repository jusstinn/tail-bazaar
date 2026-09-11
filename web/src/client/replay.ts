// Replay viewer: renders the recorded per-tick body transforms (position + quaternion) from the run
// documents with Three.js. There is NO physics here: every pose comes from the saved `frames` rows.
import * as THREE from "three";
import type { Frames, RunLike, Tick } from "./api.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // MuJoCo is z-up

type Track = { name: string; run: RunLike; frames: Frames; scene: THREE.Scene; camera: THREE.PerspectiveCamera; bodies: Map<string, THREE.Object3D>; label: HTMLElement; hud: HTMLElement; frameEl: HTMLElement; contactAt: number | null; duration: number; nBodies: number };

const COL = { chassis: 0x2f6fd0, load: 0xe2b64a, wheel: 0x222222, obstacle: 0xd9541e, floor: 0xe6e8eb };

function buildTrack(name: string, run: RunLike, frames: Frames, container: HTMLElement): Track {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf7f8fa);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0a6, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(-2, -4, 6);
  scene.add(dir);
  const sc = run.scene;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ color: COL.floor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  floor.position.set(6, 0, 0);
  scene.add(floor);
  // 1 m floor grid built from thin meshes (GL_LINES are unreliable in software WebGL renderers)
  const gridMat = new THREE.MeshLambertMaterial({ color: 0xb4b9c0 });
  const gridGroup = new THREE.Group();
  for (let i = -30; i <= 30; i++) {
    const gx = new THREE.Mesh(new THREE.BoxGeometry(60, 0.015, 0.004), gridMat);
    gx.position.set(6, i, 0.002);
    const gy = new THREE.Mesh(new THREE.BoxGeometry(0.015, 60, 0.004), gridMat);
    gy.position.set(6 + i, 0, 0.002);
    gridGroup.add(gx, gy);
  }
  scene.add(gridGroup);
  const oh = sc.obstacle_half_m as number[];
  const oc = sc.obstacle_center_m as number[];
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(2 * oh[0], 2 * oh[1], 2 * oh[2]), new THREE.MeshLambertMaterial({ color: COL.obstacle }));
  obstacle.position.set(oc[0], oc[1], oc[2]);
  scene.add(obstacle);
  // target clearance marker: a thin line on the floor at obstacle_front - target_clearance
  const clear = sc.target_clearance_m ?? 0.4;
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.01, 2 * oh[1], 0.002), new THREE.MeshBasicMaterial({ color: 0x6b7280 }));
  marker.position.set(sc.obstacle_front_x_m - clear, 0, 0.002);
  scene.add(marker);

  const bodies = new Map<string, THREE.Object3D>();
  const ch = sc.chassis_half_m as number[];
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2 * ch[0], 2 * ch[1], 2 * ch[2]), new THREE.MeshLambertMaterial({ color: COL.chassis }));
  // rangefinder site (small cube on the front face)
  const rf = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  rf.position.set(ch[0] + 0.01, 0, 0);
  chassis.add(rf);
  bodies.set("chassis", chassis);
  const lh = sc.load_half_m as number[];
  bodies.set("load", new THREE.Mesh(new THREE.BoxGeometry(2 * lh[0], 2 * lh[1], 2 * lh[2]), new THREE.MeshLambertMaterial({ color: COL.load })));
  const r = sc.wheel_radius_m as number;
  for (const w of frames.bodies.filter((b) => b.startsWith("wheel"))) {
    const g = new THREE.Group();
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.06, 24), new THREE.MeshLambertMaterial({ color: COL.wheel })); // axis along local y, like the MJCF zaxis="0 1 0"
    g.add(cyl);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.064, r * 0.9), new THREE.MeshBasicMaterial({ color: 0xd0d3d8 }));
    spoke.position.set(0, 0, r * 0.45);
    g.add(spoke);
    bodies.set(w, g);
  }
  for (const b of bodies.values()) scene.add(b);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.up.set(0, 0, 1);

  const label = document.createElement("div");
  label.className = "vp-label";
  label.textContent = name;
  const hud = document.createElement("div");
  hud.className = "vp-hud mono";
  const frameEl = document.createElement("div");
  frameEl.className = "vp-frame";
  frameEl.append(label, hud);
  container.appendChild(frameEl);
  const contact = run.events.find((e: any) => e.type === "first_contact");
  const last = frames.data[frames.data.length - 1];
  return { name, run, frames, scene, camera, bodies, label, hud, frameEl, contactAt: contact ? Number(contact.t_s) : null, duration: last ? last[0] : 0, nBodies: frames.bodies.length };
}

const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3();

function poseAt(track: Track, t: number): void {
  const { data, dt_s, bodies } = track.frames;
  if (data.length === 0) return;
  const f = Math.min(Math.max(t / dt_s, 0), data.length - 1);
  const i0 = Math.floor(f), i1 = Math.min(i0 + 1, data.length - 1);
  const a = f - i0;
  const r0 = data[i0], r1 = data[i1];
  bodies.forEach((name, bi) => {
    const obj = track.bodies.get(name);
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

export type Replay = { setTime(t: number): void; play(): void; pause(): void; toggle(): boolean; setSpeed(s: number): void; duration: number; time(): number; onTime(cb: (t: number) => void): void; snapshot(t: number, width?: number): string; dispose(): void };

export function createReplay(host: HTMLElement, baseline: RunLike, failure: RunLike, failureFrames: Frames): Replay {
  const wrap = document.createElement("div");
  wrap.className = "viewports";
  host.appendChild(wrap);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); // preserve so the canvas can be exported/inspected
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  wrap.appendChild(renderer.domElement);
  const overlay = document.createElement("div");
  overlay.className = "vp-overlay";
  wrap.appendChild(overlay);
  const tracks = [buildTrack("BASELINE — nominal conditions (public run)", baseline, baseline.frames, overlay), buildTrack("FAILURE — purchased scenario (private package)", failure, failureFrames, overlay)];
  const duration = Math.max(...tracks.map((t) => t.duration));
  let t = 0, playing = false, speed = 0.5, last = performance.now();
  const listeners: ((t: number) => void)[] = [];
  const camTarget = tracks.map(() => new THREE.Vector3());

  function resize() {
    const w = wrap.clientWidth, h = Math.max(300, Math.round(w * 0.38));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = h + "px";
    tracks.forEach((tr) => { tr.camera.aspect = w / 2 / h; tr.camera.updateProjectionMatrix(); });
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  function draw() {
    const w = renderer.domElement.width, h = renderer.domElement.height;
    renderer.setScissorTest(true);
    tracks.forEach((tr, i) => {
      poseAt(tr, t);
      const chassis = tr.bodies.get("chassis")!;
      const cx = chassis.position.x;
      // follow camera: slightly behind and beside the cart, looking ahead toward the obstacle
      camTarget[i].set(cx - 1.6, -5.2, 2.3);
      tr.camera.position.lerp(camTarget[i], 0.25);
      tr.camera.lookAt(cx + 1.4, 0, 0.35);
      const x0 = Math.floor((i * w) / 2);
      renderer.setViewport(x0, 0, Math.floor(w / 2), h);
      renderer.setScissor(x0, 0, Math.floor(w / 2), h);
      renderer.render(tr.scene, tr.camera);
      const tk = tickAt(tr.run, t);
      const inContact = tr.contactAt !== null && t >= tr.contactAt;
      const m = tr.run.metrics;
      const trueRange = tk ? (tr.run.scene.obstacle_front_x_m - tk.x_front_m) : null;
      tr.hud.textContent = tk
        ? `t ${t.toFixed(2)} s   v ${tk.v_odom_mps.toFixed(2)} m/s   range seen ${tk.range_used_m >= 0 ? tk.range_used_m.toFixed(2) : "—"} m   true ${trueRange !== null ? trueRange.toFixed(2) : "—"} m   brake ${(tk.brake_applied * 100).toFixed(0)}%   ${tk.phase}${inContact ? `   CONTACT @ ${m.impact_speed_mps?.toFixed(3)} m/s` : ""}`
        : `t ${t.toFixed(2)} s`;
      tr.frameEl.classList.toggle("contact", inContact);
    });
  }

  function loop(now: number) {
    if (playing) {
      t += ((now - last) / 1000) * speed;
      if (t >= duration) { t = duration; playing = false; }
      listeners.forEach((cb) => cb(t));
    }
    last = now;
    draw();
    raf = requestAnimationFrame(loop);
  }
  let raf = requestAnimationFrame(loop);

  return {
    duration,
    time: () => t,
    setTime(v) { t = Math.min(Math.max(v, 0), duration); listeners.forEach((cb) => cb(t)); },
    play() { if (t >= duration) t = 0; playing = true; last = performance.now(); },
    pause() { playing = false; },
    toggle() { playing ? this.pause() : this.play(); return playing; },
    setSpeed(s) { speed = s; },
    onTime(cb) { listeners.push(cb); },
    /** Render one frame at an explicit size (independent of page layout) and return a JPEG data URL. */
    snapshot(v, width = 960) {
      playing = false;
      t = Math.min(Math.max(v, 0), duration);
      const h = Math.round(width * 0.38);
      renderer.setSize(width, h, false);
      tracks.forEach((tr) => { tr.camera.aspect = width / 2 / h; tr.camera.updateProjectionMatrix(); });
      for (let i = 0; i < 12; i++) draw(); // let the follow camera settle
      const url = renderer.domElement.toDataURL("image/jpeg", 0.5);
      resize();
      return url;
    },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); wrap.remove(); },
  };
}
