"""Viewable renderings from recorded transforms only (matplotlib; no second physics run).

This module is OPTIONAL and is never imported by the core path: `simulate`, `nominal`, `hunter`
and the `policy`/`selfcheck`/`nominal`/`hunt`/`run`/`repeat` CLI commands all work without
matplotlib, Pillow or any display. It is imported lazily by the `render` and `compare` commands,
so a headless machine that never asks for a picture never pays for one.

It is also the reference consumer of the run document's data-driven replay contract, which is
the same contract the Three.js viewer uses:

    frames.bodies[i]                    the i-th body's name
    frames.data[k] = [t, (x,y,z,qw,qx,qy,qz) * len(bodies)]    world pose per body per frame
    scene.render_bodies[j]              one primitive: which body it belongs to, its type
                                        (box/plane/mesh/...), its pose LOCAL to that body, and
                                        its size
    scene.goal_marker + goal_m          where the target sits, fixed for the episode

Nothing about the Fetch arm's geometry is hard-coded here. Composing those two gives the world
pose of every primitive, which is all a viewer needs. Mesh geoms are drawn as the bounding-box
proxy the run document declares them to be, with no pretence otherwise.
"""

from __future__ import annotations

from typing import Any

import numpy as np

# The scene is about 1 m across, viewed from the +x/-y front-right of the table.
_AZIM, _ELEV = -60.0, 18.0


def _quat_to_mat(q: list[float]) -> np.ndarray:
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


def primitives_at(res: dict[str, Any], frame_row: list[float]) -> list[dict[str, Any]]:
    """World pose of every render primitive at one recorded frame."""
    bodies = res["frames"]["bodies"]
    pose = {}
    for i, name in enumerate(bodies):
        base = 1 + 7 * i
        pose[name] = (np.asarray(frame_row[base : base + 3], dtype=float), frame_row[base + 3 : base + 7])
    out = []
    for prim in res["scene"]["render_bodies"]:
        if prim["body"] not in pose:
            continue
        bp, bq = pose[prim["body"]]
        R = _quat_to_mat(bq)
        world_pos = bp + R @ np.asarray(prim["pos_m"], dtype=float)
        local_R = _quat_to_mat(prim["quat_wxyz"])
        out.append({**prim, "world_pos": world_pos, "world_R": R @ local_R})
    return out


def _box_faces(centre: np.ndarray, R: np.ndarray, half: np.ndarray) -> list[np.ndarray]:
    signs = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)], dtype=float)
    corners = np.array([centre + R @ (s * half) for s in signs])
    idx = [
        (0, 1, 3, 2),
        (4, 5, 7, 6),
        (0, 1, 5, 4),
        (2, 3, 7, 6),
        (0, 2, 6, 4),
        (1, 3, 7, 5),
    ]
    return [corners[list(i)] for i in idx]


def _draw_frame(ax, res: dict[str, Any], row: list[float], highlight: bool = True) -> None:
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    prims = primitives_at(res, row)
    block_prim = None
    for p in prims:
        # `role` comes from the run document, which classified it from the compiled model: a geom
        # that collides with nothing is a marker, not geometry. Here that is the mocap gizmo.
        if p.get("role") == "visual_marker":
            continue
        if p["type"] == "plane":
            continue  # the floor plane is drawn as the table's shadow ground, not as a slab
        is_block = p.get("geom") == "object0"
        if p["type"] == "box":
            half = np.asarray(p["half_extent_m"], dtype=float)
        else:
            half = np.asarray(p.get("box_half_extent_m") or [0.02, 0.02, 0.02], dtype=float)
            if not np.any(half):
                continue
        if is_block:
            block_prim = (p, half)  # drawn last so it is never hidden behind the arm
            continue
        if p["body"] == "table0":
            colour, alpha, edge, lw = "#c9c2b4", 0.5, "#8d857a", 0.5
        elif "finger" in (p.get("geom") or ""):
            colour, alpha, edge, lw = "#2f6fb5", 0.95, "#173a61", 0.5
        elif p["type"] == "mesh":
            # A bounding-box proxy for a shape we cannot tessellate: drawn as a faint wireframe so
            # it reads as "roughly the arm is here", never as the arm's actual surface.
            colour, alpha, edge, lw = "none", 0.0, "#93a0ab", 0.45
        else:
            colour, alpha, edge, lw = "#9aa4ad", 0.3, "#6d757c", 0.25
        ax.add_collection3d(
            Poly3DCollection(
                _box_faces(p["world_pos"], p["world_R"], half),
                facecolor=colour,
                edgecolor=edge,
                linewidths=lw,
                alpha=alpha,
            )
        )
    if block_prim is not None:
        p, half = block_prim
        colour, edge = ("#d8452c", "#7d1d10") if highlight else ("#9aa4ad", "#6d757c")
        ax.add_collection3d(
            Poly3DCollection(
                _box_faces(p["world_pos"], p["world_R"], half),
                facecolor=colour,
                edgecolor=edge,
                linewidths=0.7,
                alpha=1.0,
                zorder=20,
            )
        )
    goal = np.asarray(res.get("goal_m") or [0, 0, 0], dtype=float)
    ax.scatter([goal[0]], [goal[1]], [goal[2]], s=70, marker="*", color="#1f9d55", depthshade=False, zorder=10)


def _setup_axes(ax, res: dict[str, Any]) -> None:
    tc = res["scene"]["table_centre_xy_m"]
    ax.set_xlim(tc[0] - 0.45, tc[0] + 0.45)
    ax.set_ylim(tc[1] - 0.45, tc[1] + 0.45)
    ax.set_zlim(0.0, 0.9)
    ax.set_box_aspect((1, 1, 1.0))
    ax.view_init(elev=_ELEV, azim=_AZIM)
    ax.set_axis_off()


def _frame_at(res: dict[str, Any], t: float) -> list[float]:
    data = res["frames"]["data"]
    times = [r[0] for r in data]
    k = min(range(len(times)), key=lambda i: abs(times[i] - t))
    return data[k]


def side_view_gif(res: dict[str, Any], path: str, label: str = "", fps: int = 12) -> str:
    """Animate the recorded frames. Needs matplotlib + Pillow; still headless (Agg)."""
    import matplotlib

    matplotlib.use("Agg")
    import io

    import matplotlib.pyplot as plt
    from PIL import Image

    rows = res["frames"]["data"]
    images = []
    for row in rows:
        fig = plt.figure(figsize=(4.2, 3.6), dpi=100)
        ax = fig.add_subplot(111, projection="3d")
        _setup_axes(ax, res)
        _draw_frame(ax, res, row)
        m = res["metrics"]
        state = res["outcome"]
        if m.get("drop_t_s") is not None and row[0] >= float(m["drop_t_s"]):
            state = "DROPPED at %.2fs" % float(m["drop_t_s"])
        ax.set_title(f"{label}\nt = {row[0]:.2f}s   {state}", fontsize=8, loc="left")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight")
        plt.close(fig)
        buf.seek(0)
        images.append(Image.open(buf).convert("P", palette=Image.ADAPTIVE))
    images[0].save(
        path, save_all=True, append_images=images[1:], duration=int(1000 / fps), loop=0, optimize=True
    )
    return path


def metrics_png(res: dict[str, Any], path: str, title: str = "") -> str:
    """Block height and block-goal distance against time, with the drop and landing marked."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ticks = res["ticks"]
    t = [x["t_s"] for x in ticks]
    z = [x["object_z_m"] for x in ticks]
    d = [x["object_goal_distance_m"] for x in ticks]
    grasped = [x["grasped"] for x in ticks]
    sc = res["scene"]
    m = res["metrics"]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(7.0, 4.6), dpi=110, sharex=True)
    ax1.plot(t, z, color="#d8452c", lw=1.6, label="block centre height")
    ax1.axhline(sc["object_resting_z_m"], color="#8d857a", lw=1.0, ls="--", label="resting on the table")
    ax1.axhline(
        sc["object_resting_z_m"] + res["drop_predicate"]["airborne_margin_m"],
        color="#8d857a",
        lw=0.8,
        ls=":",
        label="airborne margin",
    )
    ax1.fill_between(t, 0, 1, where=grasped, transform=ax1.get_xaxis_transform(),
                     color="#2f6fb5", alpha=0.12, label="held by both pads")
    ax1.set_ylabel("z (m)")
    ax1.legend(fontsize=6.5, loc="upper left", ncol=2)

    ax2.plot(t, d, color="#1f9d55", lw=1.6, label="block-to-goal distance")
    ax2.axhline(sc["distance_threshold_m"], color="#1f9d55", lw=1.0, ls="--",
                label=f"the environment's {sc['distance_threshold_m']} m success threshold")
    ax2.set_ylabel("distance (m)")
    ax2.set_xlabel("t (s)")
    ax2.legend(fontsize=6.5, loc="upper right")

    horizon = float(res["episode_horizon_ticks"]) * float(res["frames"]["source_dt_s"])
    for ax in (ax1, ax2):
        ax.axvline(horizon, color="#555", lw=0.8, ls="-.", alpha=0.6)
        if m.get("drop_t_s") is not None:
            ax.axvline(float(m["drop_t_s"]), color="#d8452c", lw=1.4)
        ev = next((e for e in res["events"] if e.get("event") == "LANDED"), None)
        if ev:
            ax.axvline(float(ev["t_s"]), color="#7d1d10", lw=1.0, ls=":")
        ax.grid(alpha=0.2, lw=0.4)

    sub = f"outcome {res['outcome']}"
    if m.get("drop_t_s") is not None:
        sub += f" — dropped at {m['drop_t_s']}s, impact {m.get('object_impact_speed_mps')} m/s"
    fig.suptitle(f"{title}\n{sub}", fontsize=9, x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    fig.savefig(path)
    plt.close(fig)
    return path


def _pick_times(a: dict[str, Any], b: dict[str, Any]) -> list[float]:
    """Four instants that tell the story: approach, lift, the drop, and after it."""
    drop = b["metrics"].get("drop_t_s")
    landed = next((e["t_s"] for e in b["events"] if e.get("event") == "LANDED"), None)
    if drop is None:
        end = b["frames"]["data"][-1][0]
        return [round(end * f, 2) for f in (0.15, 0.4, 0.65, 0.95)]
    drop = float(drop)
    end = float(landed) if landed else drop + 0.4
    return [round(max(0.0, drop - 0.4), 2), round(max(0.0, drop - 0.12), 2), round(drop, 2), round(end + 0.12, 2)]


def side_by_side_png(
    a: dict[str, Any], b: dict[str, Any], path: str, times: list[float] | None = None
) -> str:
    """Top row: the baseline. Bottom row: the failure. Same instants, same camera."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    times = times or _pick_times(a, b)
    fig = plt.figure(figsize=(3.1 * len(times), 6.4), dpi=110)
    for col, tt in enumerate(times):
        for row, res in enumerate((a, b)):
            ax = fig.add_subplot(2, len(times), row * len(times) + col + 1, projection="3d")
            _setup_axes(ax, res)
            _draw_frame(ax, res, _frame_at(res, tt))
            ax.set_title(f"t = {tt:.2f}s", fontsize=8)
    labels = []
    for res in (a, b):
        s = res["scenario"]
        m = res["metrics"]
        moved = [f"{k}={s[k]}" for k in s if k != "init_seed" and s[k] != _nominal(k)]
        tag = ", ".join(moved) if moved else "nominal"
        line = f"{res['outcome']}  —  {tag}  (init_seed {s['init_seed']})"
        if m.get("drop_t_s") is not None:
            line += f"  —  dropped at {m['drop_t_s']}s, impact {m.get('object_impact_speed_mps')} m/s"
        labels.append(line)
    fig.suptitle(labels[0] + "\n" + labels[1], fontsize=9.5, y=0.985)
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(path)
    plt.close(fig)
    return path


def _nominal(key: str):
    from .envelope import NOMINAL_SCENARIO

    return NOMINAL_SCENARIO.get(key)
