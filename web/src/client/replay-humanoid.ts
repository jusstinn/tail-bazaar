// HUMANOID RENDERER. Draws Gymnasium's `humanoid.xml` mannequin from the primitives the run document
// publishes in `scene.render_bodies` — one capsule, sphere or box per MJCF geom, each posed LOCAL to
// a named body — and poses those bodies from the recorded world transforms in `frames`.
//
// NOTHING about the humanoid is hard-coded here: the body list, the primitive shapes, their sizes and
// their local offsets all come out of the run. That is the same contract `sim/tailbazaar_sim/humanoid/
// render.py` consumes, which is what makes it sufficient. There is NO physics in the browser: every
// pose is read from the saved frames, for the failure run and for the surviving nominal ghost alike.
//
// The one extra piece of geometry is the HEALTHY-HEIGHT PLATE: a translucent graphite plate drawn at
// the bottom of the environment's own `healthy_z_range`. That line is the failure definition — the
// environment calls the humanoid fallen exactly when the torso drops below it — so drawing it is what
// makes "fell" legible in a single frame rather than a word in a caption.
import * as THREE from "three";
import type { Frames, RunLike } from "./api.js";
import { COL, hex } from "./palette.js";
import type { Anchor, SceneRenderer } from "./replay.js";

type Primitive = {
  body: string; geom?: string; type: string;
  pos_m?: number[]; quat_wxyz?: number[]; radius_m?: number; half_length_m?: number; size_m?: number[]; axis?: string;
};

function material(ghost: boolean): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial(ghost ? { color: COL.ghost, transparent: true, opacity: 0.28, depthWrite: false } : { color: COL.body });
}

/** One MJCF primitive as a mesh posed in its body's local frame. A capsule's axis is local z in the
 *  MJCF, and three.js builds capsules along y, so the geometry is rotated once at construction. */
function primitiveMesh(p: Primitive, mat: THREE.Material): THREE.Object3D | null {
  const r = Number(p.radius_m ?? 0);
  let geo: THREE.BufferGeometry | null = null;
  if (p.type === "capsule") {
    const len = 2 * Number(p.half_length_m ?? 0);
    geo = new THREE.CapsuleGeometry(r, Math.max(len, 1e-4), 6, 14);
    geo.rotateX(Math.PI / 2); // three.js capsules run along +y; the MJCF declares local z
  } else if (p.type === "sphere") {
    geo = new THREE.SphereGeometry(r, 18, 12);
  } else if (p.type === "box" && Array.isArray(p.size_m)) {
    geo = new THREE.BoxGeometry(2 * Number(p.size_m[0]), 2 * Number(p.size_m[1]), 2 * Number(p.size_m[2]));
  } else if (r > 0) {
    geo = new THREE.SphereGeometry(r, 12, 8); // an unknown primitive still gets drawn at its own size
  }
  if (!geo) return null;
  const mesh = new THREE.Mesh(geo, mat);
  const pos = p.pos_m ?? [0, 0, 0];
  mesh.position.set(Number(pos[0] ?? 0), Number(pos[1] ?? 0), Number(pos[2] ?? 0));
  const q = p.quat_wxyz ?? [1, 0, 0, 0];
  mesh.quaternion.set(Number(q[1] ?? 0), Number(q[2] ?? 0), Number(q[3] ?? 0), Number(q[0] ?? 1)); // recorded w,x,y,z
  return mesh;
}

function bodyPosAt(frames: Frames, name: string, t: number): [number, number, number] {
  const bi = frames.bodies.indexOf(name);
  if (bi < 0 || frames.data.length === 0) return [0, 0, 0];
  const i = Math.min(Math.max(Math.round(t / frames.dt_s), 0), frames.data.length - 1);
  const o = 1 + 7 * bi;
  return [frames.data[i][o], frames.data[i][o + 1], frames.data[i][o + 2]];
}

const n2 = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—");
const healthyFloor = (run: RunLike): number => {
  const r = (run.scene as Record<string, any>)?.healthy_z_range_m;
  return Array.isArray(r) && Number.isFinite(Number(r[0])) ? Number(r[0]) : 1.0;
};

export const HUMANOID_RENDERER: SceneRenderer = {
  id: "humanoid-3d",
  anchorBody: "torso",
  ghostLaneOffset: 1.25,
  aspect: { overlay: 0.5, split: 0.42 },
  swatches: [
    { color: hex(COL.body), label: "purchased run" },
    { color: hex(COL.ghost), label: "baseline ghost — the same policy at nominal conditions, which survives, drawn one lane over", translucent: true },
    { color: hex(COL.line), label: "the healthy-height floor: the environment calls it a fall below this line", thin: true },
  ],

  build(scene, run) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshLambertMaterial({ color: COL.floor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    scene.add(floor);
    // A grid that follows the walker: the humanoid covers tens of metres, so a fixed grid would
    // either be enormous or run out. Twenty-one lines each way, re-centred on the anchor every frame.
    const gridMat = new THREE.MeshLambertMaterial({ color: COL.grid });
    const grid = new THREE.Group();
    for (let i = -10; i <= 10; i++) {
      const gx = new THREE.Mesh(new THREE.BoxGeometry(22, 0.01, 0.004), gridMat);
      gx.position.set(0, i, 0.002);
      const gy = new THREE.Mesh(new THREE.BoxGeometry(0.01, 22, 0.004), gridMat);
      gy.position.set(i, 0, 0.002);
      grid.add(gx, gy);
    }
    scene.add(grid);

    // The environment's own healthy-height floor, drawn where it actually is.
    const z = healthyFloor(run);
    const plate = new THREE.Group();
    const plateMat = new THREE.MeshBasicMaterial({ color: COL.line, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false });
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), plateMat);
    plate.add(sheet);
    const edgeMat = new THREE.MeshBasicMaterial({ color: COL.line, transparent: true, opacity: 0.55, depthWrite: false });
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.012, 0.004), edgeMat);
      e.position.set(0, s * 1.3, 0);
      plate.add(e);
    }
    plate.position.z = z;
    scene.add(plate);

    return {
      update(a: Anchor) {
        grid.position.set(Math.round(a.x), Math.round(a.y), 0);
        plate.position.set(a.x, a.y, z);
      },
    };
  },

  bodies(run, frames, ghost) {
    const prims: Primitive[] = Array.isArray((run.scene as Record<string, any>)?.render_bodies) ? (run.scene as Record<string, any>).render_bodies : [];
    const mat = material(ghost);
    const bodies = new Map<string, THREE.Object3D>();
    const groupFor = (name: string): THREE.Object3D => {
      let g = bodies.get(name);
      if (!g) { g = new THREE.Group(); bodies.set(name, g); }
      return g;
    };
    // Every frame body gets a group even if no primitive hangs off it, so posing never misses one.
    for (const b of frames.bodies) groupFor(b);
    for (const p of prims) {
      if (!p?.body) continue;
      const mesh = primitiveMesh(p, mat);
      if (mesh) groupFor(p.body).add(mesh);
    }
    return bodies;
  },

  anchor(frames, t): Anchor {
    const p = bodyPosAt(frames, "torso", t);
    return { x: p[0], y: p[1], z: p[2] };
  },

  camera(a) {
    return { pos: [a.x - 1.9, a.y - 4.0, 1.95], look: [a.x + 0.25, a.y, 0.8] };
  },

  /** The fall is marked on the torso, which is the body the environment's health predicate reads. */
  mark(run, frames, t) {
    const p = bodyPosAt(frames, "torso", t);
    return { at: [p[0], p[1], p[2]], radius: 0.42, faceDownTrack: false };
  },

  hud(run, t) {
    const ticks = run.ticks as any[] | undefined;
    const z = healthyFloor(run);
    if (!ticks?.length) return `<b>${t.toFixed(2)} s</b>`;
    const dt = Number((run.scene as Record<string, any>)?.control_dt_s) || 0.015;
    const tk = ticks[Math.min(Math.max(Math.floor(t / dt), 0), ticks.length - 1)];
    const low = Number(tk.torso_z_m) < z;
    return `<b>${t.toFixed(2)} s</b><span class="${low ? "hud-alert" : ""}">torso ${n2(tk.torso_z_m)} m</span><span>healthy ≥ ${z.toFixed(2)} m</span><span>${n2(tk.torso_speed_mps)} m/s</span>${tk.push_on ? `<span class="hud-alert">push on</span>` : ""}`;
  },
};
