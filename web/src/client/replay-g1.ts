// G1 RENDERER. Draws Unitree's 12-dof MuJoCo G1 from the geometry the run document publishes in
// `scene.render_bodies` and poses its thirteen bodies from the recorded world transforms in `frames`.
// There is NO physics in the browser: every pose is read from the saved frames, for the purchased run
// and for the surviving nominal ghost alike.
//
// This robot is meshes. The run publishes, per mesh geom, MuJoCo's own bounding box (labelled a proxy)
// and TWO frames: the compiled one (`pos_m`/`quat_wxyz`, which folds in MuJoCo's re-centring of the
// mesh and is where the proxy box belongs) and the MJCF one (`mesh_frame_pos_m`/`mesh_frame_quat_wxyz`,
// the frame the raw STL vertices live in). The box is drawn first and swapped for the robot's OWN link
// mesh — the STL its MJCF names, served beside the page from /meshes/g1/ (verbatim copies; see the
// README.txt there) — the moment it loads. A link whose mesh never arrives keeps its honest box. Only
// the geoms the run labels `visual` are drawn: every link carries the same mesh twice (once for
// collision, once for display) plus a few collision-only cylinders and the eight foot spheres.
//
// Which file each mesh is: read from the run (`mesh_file`), but only if the name is in the allow-list
// below, which is exactly the 27 assets `g1_12dof.xml` declares — a run document can never make the
// page fetch anything else.
//
// The one extra piece of geometry is the FALL-HEIGHT MARKER: four thin bars at the pelvis height this
// project's predicate calls a fall (`fall_predicate.fall_z_m`, 0.462 m). That line is the failure
// definition, so drawing it is what makes "fell" legible in a single frame rather than a word in a
// caption — and unlike the Gymnasium humanoid's, the line is ours and the swatch says so.
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { Frames, RunLike } from "./api.js";
import { COL, hex } from "./palette.js";
import type { Anchor, SceneRenderer } from "./replay.js";

type Primitive = {
  body: string; geom?: string | null; type: string; role?: string;
  pos_m?: number[]; quat_wxyz?: number[]; radius_m?: number; half_length_m?: number; half_extent_m?: number[];
  mesh?: string; mesh_file?: string; mesh_scale?: number[]; box_center_m?: number[]; box_half_extent_m?: number[];
  mesh_frame_pos_m?: number[]; mesh_frame_quat_wxyz?: number[];
};

/** The 27 mesh assets g1_12dof.xml declares, asset name -> file under /meshes/g1/. */
export const G1_MESH_FILES: Readonly<Record<string, string>> = Object.fromEntries([
  "pelvis", "pelvis_contour_link", "left_hip_pitch_link", "left_hip_roll_link", "left_hip_yaw_link", "left_knee_link",
  "left_ankle_pitch_link", "left_ankle_roll_link", "right_hip_pitch_link", "right_hip_roll_link", "right_hip_yaw_link",
  "right_knee_link", "right_ankle_pitch_link", "right_ankle_roll_link", "torso_link_23dof_rev_1_0", "logo_link", "head_link",
  "left_shoulder_pitch_link", "left_shoulder_roll_link", "left_shoulder_yaw_link", "left_elbow_link", "left_wrist_roll_rubber_hand",
  "right_shoulder_pitch_link", "right_shoulder_roll_link", "right_shoulder_yaw_link", "right_elbow_link", "right_wrist_roll_rubber_hand",
].map((n) => [n, `${n}.STL`]));

export const G1_MESH_URL = "/meshes/g1/";

const geometries = new Map<string, Promise<THREE.BufferGeometry>>();

export function loadG1Mesh(file: string): Promise<THREE.BufferGeometry> {
  let p = geometries.get(file);
  if (!p) {
    p = new STLLoader().loadAsync(G1_MESH_URL + file).then((geo) => { geo.computeVertexNormals(); return geo; });
    p.catch(() => geometries.delete(file));
    geometries.set(file, p);
  }
  return p;
}

function material(ghost: boolean, dark: boolean): THREE.MeshLambertMaterial {
  if (ghost) return new THREE.MeshLambertMaterial({ color: COL.ghost, transparent: true, opacity: 0.28, depthWrite: false });
  return new THREE.MeshLambertMaterial({ color: dark ? COL.link : COL.body });
}

const setPose = (obj: THREE.Object3D, pos: number[] | undefined, q: number[] | undefined): void => {
  const p = pos ?? [0, 0, 0];
  obj.position.set(Number(p[0] ?? 0), Number(p[1] ?? 0), Number(p[2] ?? 0));
  const r = q ?? [1, 0, 0, 0];
  obj.quaternion.set(Number(r[1] ?? 0), Number(r[2] ?? 0), Number(r[3] ?? 0), Number(r[0] ?? 1)); // recorded w,x,y,z
};

/** The proxy box for a mesh geom: MuJoCo's bounding box, centred where MuJoCo says it is. */
function proxyBox(p: Primitive, mat: THREE.Material): THREE.Mesh | null {
  const h = p.box_half_extent_m;
  if (!Array.isArray(h) || h.length < 3) return null;
  const box = new THREE.Mesh(new THREE.BoxGeometry(2 * Number(h[0]), 2 * Number(h[1]), 2 * Number(h[2])), mat);
  const c = p.box_center_m ?? [0, 0, 0];
  box.position.set(Number(c[0] ?? 0), Number(c[1] ?? 0), Number(c[2] ?? 0));
  const holder = new THREE.Group();
  setPose(holder, p.pos_m, p.quat_wxyz);
  holder.add(box);
  // the holder carries the compiled frame; returned as one object so the swap can remove it whole
  return holder as unknown as THREE.Mesh;
}

/** Replace a link's proxy box with the robot's own mesh once it has loaded, at the MJCF geom frame. */
function swapForMesh(body: THREE.Object3D, proxy: THREE.Object3D, p: Primitive, file: string, mat: THREE.Material): void {
  loadG1Mesh(file).then(
    (geo) => {
      if (proxy.parent !== body) return; // the replay was torn down before the mesh arrived
      const mesh = new THREE.Mesh(geo, mat);
      setPose(mesh, p.mesh_frame_pos_m, p.mesh_frame_quat_wxyz);
      const s = p.mesh_scale ?? [1, 1, 1];
      mesh.scale.set(Number(s[0] ?? 1), Number(s[1] ?? 1), Number(s[2] ?? 1));
      body.add(mesh);
      body.remove(proxy);
    },
    (err: unknown) => console.warn(`g1 replay: ${file} did not load; that link keeps its bounding box`, err),
  );
}

function bodyPosAt(frames: Frames, name: string, t: number): [number, number, number] {
  const bi = frames.bodies.indexOf(name);
  if (bi < 0 || frames.data.length === 0) return [0, 0, 0];
  const i = Math.min(Math.max(Math.round(t / frames.dt_s), 0), frames.data.length - 1);
  const o = 1 + 7 * bi;
  return [frames.data[i][o], frames.data[i][o + 1], frames.data[i][o + 2]];
}

const n2 = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—");
/** The predicate's thresholds, read from the run: the `fall_predicate_fired` event carries them (and
 *  travels in the private package), the full run document also publishes them in `fall_predicate`. */
const threshold = (run: RunLike, key: "fall_z_m" | "fall_tilt_deg", fallback: number): number => {
  const ev = (run.events ?? []).find((e: any) => e?.type === "fall_predicate_fired") as Record<string, unknown> | undefined;
  const fromEvent = Number(ev?.[key]);
  if (Number.isFinite(fromEvent) && fromEvent > 0) return fromEvent;
  const fromDoc = Number((run.fall_predicate as Record<string, unknown> | undefined)?.[key]);
  return Number.isFinite(fromDoc) && fromDoc > 0 ? fromDoc : fallback;
};
const fallZ = (run: RunLike): number => threshold(run, "fall_z_m", 0.462);
const fallTilt = (run: RunLike): number => threshold(run, "fall_tilt_deg", 60);

export const G1_RENDERER: SceneRenderer = {
  id: "g1-3d",
  anchorBody: "pelvis",
  ghostLaneOffset: 1.8, // a side shove carries the purchased robot up to a metre sideways, so the ghost lane sits further out than the humanoid's
  aspect: { overlay: 0.44, split: 0.38 },
  swatches: [
    { color: hex(COL.body), label: "purchased run, drawn from the robot's own link meshes (the G1 STLs its MJCF names, verbatim from Unitree, posed under each recorded body; a link shows its bounding box only until its mesh has loaded)" },
    { color: hex(COL.ghost), label: "baseline ghost — the same policy at the publisher's deployment configuration, which keeps walking, drawn one lane over", translucent: true },
    { color: hex(COL.line), label: "the fall-height line: THIS PROJECT'S predicate calls it a fall when the pelvis drops below it (or tilts past 60°); Unitree's runner has no fall flag of its own", thin: true },
  ],

  build(scene, run) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshLambertMaterial({ color: COL.floor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    scene.add(floor);
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
    // Our fall-height line, as an outline (a filled sheet would read as a table the robot stands under).
    const z = fallZ(run);
    const plate = new THREE.Group();
    const edgeMat = new THREE.MeshBasicMaterial({ color: COL.line, transparent: true, opacity: 0.5, depthWrite: false });
    const W = 1.2;
    for (const sgn of [-1, 1]) {
      const along = new THREE.Mesh(new THREE.BoxGeometry(2 * W, 0.01, 0.004), edgeMat);
      along.position.set(0, sgn * W, 0);
      const across = new THREE.Mesh(new THREE.BoxGeometry(0.01, 2 * W, 0.004), edgeMat);
      across.position.set(sgn * W, 0, 0);
      plate.add(along, across);
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
    const bodies = new Map<string, THREE.Object3D>();
    const groupFor = (name: string): THREE.Object3D => {
      let g = bodies.get(name);
      if (!g) { g = new THREE.Group(); bodies.set(name, g); }
      return g;
    };
    for (const b of frames.bodies) groupFor(b);
    const light = material(ghost, false);
    const dark = material(ghost, true);
    for (const p of prims) {
      if (!p?.body || !bodies.has(p.body)) continue;
      if (p.role !== "visual") continue; // collision twins, shoulder cylinders and foot spheres: not drawn
      // the MJCF paints the frame links dark grey and the covers light; keep that two-tone reading
      const rgba = (p as { rgba?: number[] }).rgba;
      const mat = Array.isArray(rgba) && Number(rgba[0]) < 0.4 ? dark : light;
      const group = groupFor(p.body);
      if (p.type === "mesh") {
        const proxy = proxyBox(p, mat);
        if (!proxy) continue;
        group.add(proxy);
        const file = p.mesh ? G1_MESH_FILES[p.mesh] : undefined;
        if (file) swapForMesh(group, proxy, p, file, mat);
        continue;
      }
      let geo: THREE.BufferGeometry | null = null;
      if (p.type === "sphere" && Number(p.radius_m) > 0) geo = new THREE.SphereGeometry(Number(p.radius_m), 12, 8);
      else if ((p.type === "cylinder" || p.type === "capsule") && Number(p.radius_m) > 0) {
        geo = p.type === "cylinder" ? new THREE.CylinderGeometry(Number(p.radius_m), Number(p.radius_m), 2 * Number(p.half_length_m ?? 0), 14) : new THREE.CapsuleGeometry(Number(p.radius_m), 2 * Number(p.half_length_m ?? 0), 6, 14);
        geo.rotateX(Math.PI / 2); // three.js cylinders/capsules run along +y; the MJCF declares local z
      } else if (p.type === "box" && Array.isArray(p.half_extent_m)) geo = new THREE.BoxGeometry(2 * Number(p.half_extent_m[0]), 2 * Number(p.half_extent_m[1]), 2 * Number(p.half_extent_m[2]));
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      setPose(mesh, p.pos_m, p.quat_wxyz);
      group.add(mesh);
    }
    return bodies;
  },

  anchor(frames, t): Anchor {
    const p = bodyPosAt(frames, "pelvis", t);
    return { x: p[0], y: p[1], z: p[2] };
  },

  /** Whole robot in frame plus the ghost lane. The G1 stands 1.3 m tall, so the camera looks at the
   *  hips rather than the chest; it sits further back than the humanoid's because a side shove can
   *  carry the purchased robot metres across the lane the ghost keeps walking in, and the framing
   *  follows the purchased subject (replay.ts), so the ghost must not loom when it ends up nearer. */
  camera(a) {
    return { pos: [a.x - 1.7, a.y - 3.6, 1.7], look: [a.x + 0.15, a.y + 0.1, 0.55] };
  },

  /** The fall is marked on the pelvis, the body the predicate reads. */
  mark(run, frames, t) {
    const p = bodyPosAt(frames, "pelvis", t);
    return { at: [p[0], p[1], p[2]], radius: 0.36, faceDownTrack: false };
  },

  hud(run, t) {
    const ticks = run.ticks as any[] | undefined;
    const z = fallZ(run);
    if (!ticks?.length) return `<b>${t.toFixed(2)} s</b>`;
    const dt = Number(run.frames?.dt_s) || 0.02;
    const tk = ticks[Math.min(Math.max(Math.round(t / dt), 0), ticks.length - 1)];
    const low = Number(tk.pelvis_z_m) < z;
    const tilted = Number(tk.tilt_deg) > fallTilt(run);
    return `<b>${t.toFixed(2)} s</b><span class="${low ? "hud-alert" : ""}">pelvis ${n2(tk.pelvis_z_m)} m</span><span>fall line ${z.toFixed(3)} m</span><span class="${tilted ? "hud-alert" : ""}">tilt ${n2(tk.tilt_deg)}°</span><span>${n2(tk.pelvis_speed_mps)} m/s</span>${tk.push_on ? `<span class="hud-alert">push on</span>` : ""}`;
  },
};
