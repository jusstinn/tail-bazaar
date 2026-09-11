// CART RENDERER. Draws the warehouse-cart scene from the box dimensions the run document publishes
// (`scene.chassis_half_m`, `load_half_m`, `wheel_radius_m`, `obstacle_half_m`, …) and poses every
// body from the recorded transforms. No physics, no hard-coded geometry.
import * as THREE from "three";
import type { Frames, RunLike } from "./api.js";
import { COL, hex } from "./palette.js";
import type { Anchor, SceneRenderer } from "./replay.js";

const lambert = (color: number, ghost: boolean): THREE.MeshLambertMaterial =>
  new THREE.MeshLambertMaterial(ghost ? { color: COL.ghost, transparent: true, opacity: 0.3, depthWrite: false } : { color });

function bodyPosAt(frames: Frames, name: string, t: number): [number, number, number] {
  const bi = frames.bodies.indexOf(name);
  if (bi < 0 || frames.data.length === 0) return [0, 0, 0];
  const i = Math.min(Math.max(Math.round(t / frames.dt_s), 0), frames.data.length - 1);
  const o = 1 + 7 * bi;
  return [frames.data[i][o], frames.data[i][o + 1], frames.data[i][o + 2]];
}

const n2 = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—");

export const CART_RENDERER: SceneRenderer = {
  id: "cart-3d",
  anchorBody: "chassis",
  ghostLaneOffset: 0.95, // lateral only: the position ALONG the track stays exact
  aspect: { overlay: 0.46, split: 0.38 },
  swatches: [
    { color: hex(COL.chassis), label: "purchased run" },
    { color: hex(COL.ghost), label: "baseline ghost — same controller, nominal conditions, drawn one lane over", translucent: true },
    { color: hex(COL.ghost), label: "where the baseline stopped", thin: true },
  ],

  build(scene, run) {
    const sc = run.scene as Record<string, any>;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ color: COL.floor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    floor.position.set(6, 0, 0);
    scene.add(floor);
    // 1 m floor grid built from thin meshes (GL_LINES are unreliable in software WebGL renderers)
    const gridMat = new THREE.MeshLambertMaterial({ color: COL.grid });
    for (let i = -30; i <= 30; i++) {
      const gx = new THREE.Mesh(new THREE.BoxGeometry(60, 0.012, 0.004), gridMat);
      gx.position.set(6, i, 0.002);
      const gy = new THREE.Mesh(new THREE.BoxGeometry(0.012, 60, 0.004), gridMat);
      gy.position.set(6 + i, 0, 0.002);
      scene.add(gx, gy);
    }
    const oh = sc.obstacle_half_m as number[];
    const oc = sc.obstacle_center_m as number[];
    const obstacle = new THREE.Mesh(new THREE.BoxGeometry(2 * oh[0], 2 * oh[1], 2 * oh[2]), new THREE.MeshLambertMaterial({ color: COL.obstacle }));
    obstacle.position.set(oc[0], oc[1], oc[2]);
    scene.add(obstacle);
    // target clearance marker: a thin line on the floor at obstacle_front - target_clearance
    const clear = (sc.target_clearance_m as number) ?? 0.4;
    const marker = new THREE.Mesh(new THREE.BoxGeometry(0.012, 2 * oh[1], 0.002), new THREE.MeshBasicMaterial({ color: COL.line }));
    marker.position.set((sc.obstacle_front_x_m as number) - clear, 0, 0.003);
    scene.add(marker);
    return {};
  },

  /** Where the baseline came to rest: the line the purchased run failed to respect. */
  ghostExtras(scene, ghostRun, laneY) {
    const stopX = Number((ghostRun.metrics as Record<string, unknown>)?.final_x_front_m);
    if (!Number.isFinite(stopX)) return;
    const stopLine = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.1, 0.004), new THREE.MeshBasicMaterial({ color: COL.ghost }));
    stopLine.position.set(stopX, laneY, 0.004);
    scene.add(stopLine);
  },

  bodies(run, frames, ghost) {
    const sc = run.scene as Record<string, any>;
    const bodies = new Map<string, THREE.Object3D>();
    const ch = sc.chassis_half_m as number[];
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2 * ch[0], 2 * ch[1], 2 * ch[2]), lambert(COL.chassis, ghost));
    if (!ghost) {
      const rf = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), new THREE.MeshBasicMaterial({ color: COL.detail })); // rangefinder site
      rf.position.set(ch[0] + 0.01, 0, 0);
      chassis.add(rf);
    }
    bodies.set("chassis", chassis);
    const lh = sc.load_half_m as number[];
    bodies.set("load", new THREE.Mesh(new THREE.BoxGeometry(2 * lh[0], 2 * lh[1], 2 * lh[2]), lambert(COL.load, ghost)));
    const r = sc.wheel_radius_m as number;
    for (const w of frames.bodies.filter((b) => b.startsWith("wheel"))) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.06, 24), lambert(COL.wheel, ghost))); // axis along local y, like the MJCF zaxis="0 1 0"
      if (!ghost) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.064, r * 0.9), new THREE.MeshBasicMaterial({ color: COL.spoke }));
        spoke.position.set(0, 0, r * 0.45);
        g.add(spoke);
      }
      bodies.set(w, g);
    }
    return bodies;
  },

  anchor(frames, t): Anchor {
    const p = bodyPosAt(frames, "chassis", t);
    return { x: p[0], y: 0, z: p[2] };
  },

  camera(a) {
    return { pos: [a.x - 1.15, -3.75, 1.75], look: [a.x + 0.95, 0, 0.32] };
  },

  /** WHICH BODY the mark sits on is read from the run: the moment event's own type names it when it
   *  is not the cart itself (load_shed -> the load). */
  mark(run, frames, t, momentType) {
    const named = frames.bodies.find((b) => b !== "chassis" && (momentType ?? "").includes(b));
    const p = bodyPosAt(frames, named ?? "chassis", t);
    const ch = (run.scene as Record<string, any>).chassis_half_m as number[];
    const at: [number, number, number] = named ? p : [p[0] + ch[0] - 0.04, p[1], p[2] + 0.08];
    return { at, radius: 0.275, faceDownTrack: true };
  },

  hud(run, t) {
    const ticks = run.ticks as any[] | undefined;
    if (!ticks?.length) return `<b>${t.toFixed(2)} s</b>`;
    const tk = ticks[Math.min(Math.max(Math.floor(t / 0.02), 0), ticks.length - 1)];
    const trueRange = (run.scene as Record<string, any>).obstacle_front_x_m - tk.x_front_m;
    return `<b>${t.toFixed(2)} s</b><span>${n2(tk.v_odom_mps)} m/s</span><span>sees ${tk.range_used_m >= 0 ? n2(tk.range_used_m) : "—"} m</span><span>really ${n2(trueRange)} m</span><span>brake ${(tk.brake_applied * 100).toFixed(0)}%</span>`;
  },
};
