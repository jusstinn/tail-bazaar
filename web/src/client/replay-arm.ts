// ARM RENDERER. Draws the Gymnasium-Robotics Fetch pick-and-place scene from the primitives the run
// document publishes in `scene.render_bodies` — one box or plane per MJCF geom, each posed LOCAL to a
// named body — and poses those bodies from the recorded world transforms in `frames`. There is NO
// physics in the browser: every pose is read from the saved frames, for the purchased run and for the
// successful baseline ghost alike.
//
// SOLID BODIES, ON PURPOSE. The evidence PNGs in evidence/arm are wireframes, and a wireframe is
// exactly the wrong drawing for this failure: the question is whether the part is IN the hand or not,
// and overlapping outlines cannot answer it. Everything here is a filled mesh.
//
// Three things this renderer reads out of the run rather than assuming:
//   * `role` — the Fetch model ships MuJoCo's mocap gizmo, three 2 m bars marking the weld target the
//     environment drags the gripper with. They collide with nothing, the run labels them
//     `visual_marker`, and drawing them would put a giant coordinate cross through every frame.
//   * `box_half_extent_m` + `proxy` — the arm's links are meshes, which a from-data viewer cannot
//     tessellate. Each mesh geom publishes MuJoCo's own bounding half-extents and says plainly that a
//     box is a proxy for the shape. The things the failure is actually about — the part, the finger
//     pads, the table, the floor — are real boxes and planes and are exact.
//   * the goal. It is a SITE, not a body, so it is not in `frames`; the run publishes its fixed world
//     position and the package carries it. It is drawn as an open outline, never a solid: a filled
//     box at the goal would read as an object the arm has to avoid.
import * as THREE from "three";
import type { Frames, RunLike } from "./api.js";
import { COL, hex } from "./palette.js";
import type { Anchor, SceneRenderer } from "./replay.js";

type Primitive = {
  body: string; geom?: string | null; type: string; role?: string;
  pos_m?: number[]; quat_wxyz?: number[]; half_extent_m?: number[]; box_half_extent_m?: number[]; radius_m?: number;
};

/** The MuJoCo body a primitive belongs to decides what it is FOR, which is what decides its colour.
 *  Nothing is matched on a mesh name: `object0` and `table0` are the environment's own body ids and
 *  are carried in every run document, and a finger pad is a geom the run lists in `scene.finger_geoms`. */
function colourFor(body: string, fingers: Set<string>): number {
  if (body === "object0") return COL.part;
  if (body === "table0") return COL.table;
  if (fingers.has(body)) return COL.pad;
  return COL.link;
}

function material(colour: number, ghost: boolean): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial(ghost ? { color: COL.ghost, transparent: true, opacity: 0.3, depthWrite: false } : { color: colour });
}

/** One MJCF primitive as a mesh posed in its body's local frame. A mesh geom is drawn at MuJoCo's own
 *  bounding half-extents, which the run document itself labels a proxy. */
function primitiveMesh(p: Primitive, mat: THREE.Material): THREE.Object3D | null {
  const half = Array.isArray(p.half_extent_m) ? p.half_extent_m : Array.isArray(p.box_half_extent_m) ? p.box_half_extent_m : null;
  let geo: THREE.BufferGeometry | null = null;
  if (half && half.length >= 3) geo = new THREE.BoxGeometry(2 * Number(half[0]), 2 * Number(half[1]), 2 * Number(half[2]));
  else if (Number(p.radius_m) > 0) geo = new THREE.SphereGeometry(Number(p.radius_m), 14, 10);
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
const sc = (run: RunLike): Record<string, any> => (run.scene ?? {}) as Record<string, any>;
const tableTop = (run: RunLike): number => (Number.isFinite(Number(sc(run).table_top_z_m)) ? Number(sc(run).table_top_z_m) : 0.4);
const fingerSet = (run: RunLike): Set<string> => new Set((Array.isArray(sc(run).finger_geoms) ? sc(run).finger_geoms : []).map(String));

/** The goal site's fixed world position. It is not a body, so it travels beside the frames: the run
 *  publishes `goal_m` and the private package carries it through as `goal_m`. Older records that
 *  carry only the initial-state check still name it there. */
function goalOf(run: RunLike): [number, number, number] | null {
  const r = run as unknown as { goal_m?: unknown; initial_state_check?: { goal_xyz_m?: unknown } };
  const g = Array.isArray(r.goal_m) ? r.goal_m : Array.isArray(r.initial_state_check?.goal_xyz_m) ? r.initial_state_check!.goal_xyz_m : null;
  return Array.isArray(g) && g.length >= 3 && g.every((v) => Number.isFinite(Number(v))) ? [Number(g[0]), Number(g[1]), Number(g[2])] : null;
}

/** The goal, as an open cage of thin bars: twelve edges of a cube at the environment's own success
 *  threshold. Open, because the goal is a place, not a thing. */
function goalMarker(at: [number, number, number], half: number, colour: number, opacity: number): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false });
  const bar = 0.004;
  for (const axis of [0, 1, 2]) {
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        const size: [number, number, number] = [bar, bar, bar];
        size[axis] = 2 * half;
        const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
        const p: [number, number, number] = [0, 0, 0];
        const others = [0, 1, 2].filter((a) => a !== axis);
        p[others[0]] = s1 * half;
        p[others[1]] = s2 * half;
        m.position.set(p[0], p[1], p[2]);
        g.add(m);
      }
    }
  }
  g.position.set(at[0], at[1], at[2]);
  return g;
}

/** What the ghost draws. A full translucent second arm is a grey blob across half the frame and buys
 *  nothing: the comparison is about the PART and the HAND that should have kept hold of it, so the
 *  ghost bench is the table, the block and the gripper assembly. The failure run is drawn whole. */
const GHOST_BODIES = new Set(["table0", "object0", "robot0:gripper_link", "robot0:l_gripper_finger_link", "robot0:r_gripper_finger_link"]);

export const ARM_RENDERER: SceneRenderer = {
  id: "arm-3d",
  // The part is what must never leave the frame: the whole claim is about where it ends up.
  anchorBody: "object0",
  ghostLaneOffset: 0.85,
  aspect: { overlay: 0.46, split: 0.40 },
  swatches: [
    { color: hex(COL.part), label: "the part being carried" },
    { color: hex(COL.link), label: "the arm, drawn at each link's own bounding box (the links are meshes; the part, the pads and the table are exact)" },
    { color: hex(COL.pad), label: "the two gripper pads whose contact the drop predicate reads" },
    { color: hex(COL.ghost), label: "baseline ghost — the same policy at the published conditions, which places the part, drawn one bench over", translucent: true },
    { color: hex(COL.line), label: "the goal, at the environment's own success threshold", thin: true },
  ],

  build(scene, run) {
    // The floor plane the run publishes is 1.7 x 1.4 m; the replay wants a floor that reaches past it,
    // so the fall to the ground has somewhere to land on screen.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshLambertMaterial({ color: COL.floor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    floor.position.set(1.3, 0.75, 0);
    scene.add(floor);
    const gridMat = new THREE.MeshLambertMaterial({ color: COL.grid });
    for (let i = -10; i <= 10; i++) {
      const gx = new THREE.Mesh(new THREE.BoxGeometry(5, 0.006, 0.003), gridMat);
      gx.position.set(1.3, 0.75 + i * 0.25, 0.0015);
      const gy = new THREE.Mesh(new THREE.BoxGeometry(0.006, 5, 0.003), gridMat);
      gy.position.set(1.3 + i * 0.25, 0.75, 0.0015);
      scene.add(gx, gy);
    }
    const goal = goalOf(run);
    const half = Number(sc(run).distance_threshold_m);
    if (goal) scene.add(goalMarker(goal, Number.isFinite(half) ? half : 0.05, COL.line, 0.85));
    return {};
  },

  /** The baseline ran a different pick-and-place problem (the environment samples its own block and
   *  goal per initial state), so the ghost carries its OWN goal, drawn one bench over with it. */
  ghostExtras(scene, ghostRun, laneY) {
    const goal = goalOf(ghostRun);
    if (!goal) return;
    const half = Number(sc(ghostRun).distance_threshold_m);
    scene.add(goalMarker([goal[0], goal[1] + laneY, goal[2]], Number.isFinite(half) ? half : 0.05, COL.ghost, 0.5));
  },

  bodies(run, frames, ghost) {
    const prims: Primitive[] = Array.isArray(sc(run).render_bodies) ? sc(run).render_bodies : [];
    const fingers = fingerSet(run);
    const bodies = new Map<string, THREE.Object3D>();
    const groupFor = (name: string): THREE.Object3D => {
      let g = bodies.get(name);
      if (!g) { g = new THREE.Group(); bodies.set(name, g); }
      return g;
    };
    // Every frame body gets a group even if no primitive hangs off it, so posing never misses one.
    for (const b of frames.bodies) groupFor(b);
    const mats = new Map<number, THREE.MeshLambertMaterial>();
    for (const p of prims) {
      if (!p?.body) continue;
      if (p.role === "visual_marker") continue; // the mocap gizmo: 2 m bars that collide with nothing
      if (!bodies.has(p.body)) continue;        // e.g. the world's floor plane, drawn statically above
      if (ghost && !GHOST_BODIES.has(p.body)) continue;
      const colour = colourFor(p.body, fingers);
      let mat = mats.get(colour);
      if (!mat) { mat = material(colour, ghost); mats.set(colour, mat); }
      const mesh = primitiveMesh(p, mat);
      if (mesh) groupFor(p.body).add(mesh);
    }
    return bodies;
  },

  /** A FIXED framing: everything happens inside one cubic metre, so a camera that chased the part
   *  would swing the whole bench around it. The anchor is the table, which never moves, and both
   *  viewports therefore share one still camera. */
  anchor(frames): Anchor {
    const p = bodyPosAt(frames, "table0", 0);
    return { x: p[0], y: p[1], z: p[2] };
  },

  /** Framed to hold the whole bench at once: the arm, the table, the goal, the ghost one bench over
   *  and the patch of floor the part can reach. The part is 5 cm across, so the failure ring and the
   *  callout — not the part's own size — are what carry it at this distance. */
  camera(a) {
    return { pos: [a.x + 1.12, a.y - 1.3, a.z + 1.12], look: [a.x - 0.06, a.y + 0.36, a.z + 0.22] };
  },

  /** The mark sits on the part, which is the body the drop predicate is about. */
  mark(run, frames, t) {
    const p = bodyPosAt(frames, "object0", t);
    return { at: [p[0], p[1], p[2]], radius: 0.1, faceDownTrack: false };
  },

  hud(run, t) {
    const ticks = run.ticks as any[] | undefined;
    if (!ticks?.length) return `<b>${t.toFixed(2)} s</b>`;
    // The arm's per-tick rows start at the END of the first control tick while the frames start at
    // t = 0, so the row for a given time is one behind the frame index. Both intervals are declared
    // by the run itself; neither is a hard-coded tick.
    const dt = Number(run.frames?.dt_s) || 0.04;
    const tk = ticks[Math.min(Math.max(Math.round(t / dt) - 1, 0), ticks.length - 1)];
    // Where the part is, against the two surfaces the run itself publishes. A block below the table
    // top is on the floor, which for this target is the whole point and must never read as "on the
    // table" — so the resting height is read from the scene, not assumed.
    const rest = Number(sc(run).object_resting_z_m);
    const z = Number(tk.object_z_m);
    const above = z - (Number.isFinite(rest) ? rest : tableTop(run) + 0.025);
    const where = above > 0.015 ? `${above.toFixed(2)} m over the table` : z < tableTop(run) ? "on the floor" : "on the table";
    return `<b>${t.toFixed(2)} s</b><span class="${tk.grasped ? "" : "hud-alert"}">${tk.grasped ? "held" : "not held"}</span><span class="${where === "on the floor" ? "hud-alert" : ""}">${where}</span><span>${n2(tk.object_goal_distance_m)} m from the goal</span><span>${n2(tk.object_speed_mps)} m/s</span>`;
  },
};
