// THE FETCH LINK MESHES. The arm's links are MuJoCo mesh geoms, which the run document cannot carry:
// it publishes each one's bounding half-extents and says plainly that a box is a proxy. This module
// carries the one thing the viewer needs beyond the run — which STL each mesh geom is — read straight
// out of the Fetch MJCF that Gymnasium-Robotics ships (`envs/assets/fetch/shared.xml` names the mesh
// assets and their files, `robot.xml` hangs one mesh geom per link off them). The files are copied
// verbatim into web/public/meshes/fetch/ (see the LICENSE.txt beside them) and served statically.
//
// FRAMES, EXACTLY. Two frames exist for every mesh geom, and they are NOT the same:
//   * the MJCF geom frame — the geom's own `pos`/`quat` local to its body (identity for every Fetch
//     link: none of the mesh geoms in robot.xml declares an offset, and no `<mesh>` declares a
//     `scale`). The STL's raw vertices live in THIS frame.
//   * the compiled geom frame — MuJoCo re-centres every mesh asset on its centre of mass and
//     re-orients it along its principal axes at compile time, and folds that transform
//     (mjModel.mesh_pos / mesh_quat) into geom_pos / geom_quat. That is what `render_bodies`
//     publishes as `pos_m` / `quat_wxyz`, and it is where the proxy BOX belongs, because the
//     published half-extents are the bounding box of the re-centred mesh.
// So the mesh goes under the body Object3D at the MJCF pos/quat/scale below, never at `pos_m`, and
// the recorded body transform in `frames` does the rest. Checked against the compiled model: for
// every Fetch mesh geom, geom_pos == mesh_pos and geom_quat == mesh_quat, and the raw STL vertices
// transformed by that centring land exactly on MuJoCo's own geom_aabb.
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

export type FetchMesh = {
  /** file name under /meshes/fetch/, as shared.xml's `<mesh file=...>` names it */
  file: string;
  /** the geom's local `pos` in its body frame (MJCF, metres) */
  pos: [number, number, number];
  /** the geom's local `quat` in its body frame (MJCF order: w, x, y, z) */
  quat_wxyz: [number, number, number, number];
  /** the asset's `scale` (MJCF `<mesh scale=...>`), 1 when undeclared */
  scale: [number, number, number];
};

const AT_BODY_ORIGIN = { pos: [0, 0, 0] as [number, number, number], quat_wxyz: [1, 0, 0, 0] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

/** Keyed by the geom name the run publishes in `render_bodies[].geom`, which for Fetch is also the
 *  mesh asset name and the body name. Every entry is one `<geom mesh=... />` in robot.xml. The two
 *  wheel meshes and the bellows are declared as assets in shared.xml but no geom uses them. */
export const FETCH_MESH_BY_GEOM: Readonly<Record<string, FetchMesh>> = {
  "robot0:base_link": { file: "base_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:torso_lift_link": { file: "torso_lift_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:head_pan_link": { file: "head_pan_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:head_tilt_link": { file: "head_tilt_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:shoulder_pan_link": { file: "shoulder_pan_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:shoulder_lift_link": { file: "shoulder_lift_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:upperarm_roll_link": { file: "upperarm_roll_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:elbow_flex_link": { file: "elbow_flex_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:forearm_roll_link": { file: "forearm_roll_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:wrist_flex_link": { file: "wrist_flex_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:wrist_roll_link": { file: "wrist_roll_link_collision.stl", ...AT_BODY_ORIGIN },
  "robot0:gripper_link": { file: "gripper_link.stl", ...AT_BODY_ORIGIN },
  "robot0:estop_link": { file: "estop_link.stl", ...AT_BODY_ORIGIN },
  "robot0:laser_link": { file: "laser_link.stl", ...AT_BODY_ORIGIN },
  "robot0:torso_fixed_link": { file: "torso_fixed_link.stl", ...AT_BODY_ORIGIN },
};

/** Where the page fetches the files from. The build copies web/public into dist/client, which the
 *  server serves at the site root, so this is a root-relative path like every /api call. */
export const FETCH_MESH_URL = "/meshes/fetch/";

// One download per file per page, shared by every viewport that draws the arm (the failure track,
// the baseline track and the ghost all pose the same geometry). A failed load is dropped from the
// cache so a later replay on the same page retries instead of inheriting the failure.
const geometries = new Map<string, Promise<THREE.BufferGeometry>>();

export function loadFetchMesh(file: string): Promise<THREE.BufferGeometry> {
  let p = geometries.get(file);
  if (!p) {
    p = new STLLoader().loadAsync(FETCH_MESH_URL + file).then((geo) => {
      // The STLs carry per-facet normals; recomputing them from the winding costs nothing on a
      // non-indexed geometry and guards against a file whose stored normals are zero.
      geo.computeVertexNormals();
      return geo;
    });
    p.catch(() => geometries.delete(file));
    geometries.set(file, p);
  }
  return p;
}

/** The mesh for one Fetch geom, posed at the MJCF geom frame local to its body. */
export function fetchMeshObject(fm: FetchMesh, geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(fm.pos[0], fm.pos[1], fm.pos[2]);
  const q = fm.quat_wxyz;
  mesh.quaternion.set(q[1], q[2], q[3], q[0]); // MJCF is w,x,y,z; Three.js is x,y,z,w
  mesh.scale.set(fm.scale[0], fm.scale[1], fm.scale[2]);
  return mesh;
}
