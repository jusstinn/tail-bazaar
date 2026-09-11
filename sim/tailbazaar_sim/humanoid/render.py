"""Viewable renderings from recorded transforms only (matplotlib; no second physics run).

This module is OPTIONAL and is never imported by the core path: `simulate`, `nominal`, `hunter`
and the `run`/`hunt`/`nominal`/`repeat` CLI commands all work without matplotlib, Pillow or any
display. It is imported lazily by the `render` and `compare` commands, so a headless machine
that never asks for a picture never pays for one.

It is also the reference consumer of the run document's data-driven replay contract, which is
the same contract the Three.js viewer uses:

    frames.bodies[i]                    the i-th body's name
    frames.data[k] = [t, (x,y,z,qw,qx,qy,qz) * len(bodies)]    world pose per body per frame
    scene.render_bodies[j]              one primitive: which body it belongs to, its type
                                        (capsule/sphere/box/...), its pose LOCAL to that body,
                                        and its size

Nothing about the humanoid's geometry is hard-coded here. Composing those two gives the world
pose of every primitive, which is all a viewer needs.
"""

from __future__ import annotations

from typing import Any

import numpy as np


def _quat_to_mat(q: list[float]) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def _quat_mul(a: list[float], b: list[float]) -> list[float]:
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ]


def primitives_at(res: dict[str, Any], frame_row: list[float]) -> list[dict[str, Any]]:
    """World pose of every render primitive at one recorded frame."""
    bodies = res["frames"]["bodies"]
    pose = {}
    for i, name in enumerate(bodies):
        base = 1 + 7 * i
        pose[name] = (frame_row[base:base + 3], frame_row[base + 3:base + 7])
    out = []
    for prim in res["scene"]["render_bodies"]:
        if prim["body"] not in pose:
            continue
        bp, bq = pose[prim["body"]]
        R = _quat_to_mat(bq)
        world_pos = np.asarray(bp) + R @ np.asarray(prim["pos_m"])
        world_quat = _quat_mul(bq, prim["quat_wxyz"])
        out.append({**prim, "world_pos": world_pos, "world_quat": world_quat})
    return out


def _draw_frame(ax, res: dict[str, Any], row: list[float], title: str, x_window: tuple[float, float] | None) -> None:
    from matplotlib.lines import Line2D
    from matplotlib.patches import Circle

    prims = primitives_at(res, row)
    xs = [float(p["world_pos"][0]) for p in prims]
    cx = float(np.mean(xs)) if xs else 0.0
    lo, hi = x_window if x_window else (cx - 1.6, cx + 1.6)
    ax.add_line(Line2D([lo - 5, hi + 5], [0, 0], color="#9aa0a6", lw=1.4))
    ax.fill_between([lo - 5, hi + 5], -1, 0, color="#eceae6", zorder=0)
    for p in prims:
        colour = "#%02x%02x%02x" % tuple(int(255 * c) for c in p["rgba"][:3])
        pos = p["world_pos"]
        if p["type"] == "capsule":
            R = _quat_to_mat(p["world_quat"])
            axis = R @ np.array([0.0, 0.0, float(p["half_length_m"])])
            a, b = pos - axis, pos + axis
            ax.add_line(Line2D([a[0], b[0]], [a[2], b[2]], color=colour,
                               lw=max(1.5, 380.0 * float(p["radius_m"]) / max(hi - lo, 1e-6)),
                               solid_capstyle="round", alpha=0.95))
        elif p["type"] == "sphere":
            ax.add_patch(Circle((pos[0], pos[2]), float(p["radius_m"]), color=colour, alpha=0.95))
    ax.set_xlim(lo, hi)
    ax.set_ylim(-0.25, 2.35)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    if title:
        ax.set_title(title, fontsize=9)


def _healthy_band(ax, res: dict[str, Any]) -> None:
    lo, hi = res["health_predicate"]["healthy_z_range_m"]
    ax.axhspan(lo, hi, color="#d7ecd9", alpha=0.6, lw=0, label=f"healthy z [{lo}, {hi}] m")


def side_view_gif(res: dict[str, Any], path: str, fps: int = 20, stride: int = 2, label: str = "",
                  t0: float | None = None, t1: float | None = None) -> str:
    """x-z side view animated from the recorded frames. Requires matplotlib + Pillow.

    `t0`/`t1` trim the animation to a time window, which is how a 15 s survivor and a 3 s fall
    are made comparable side by side without re-simulating either.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from PIL import Image

    rows = [r for r in res["frames"]["data"] if (t0 is None or r[0] >= t0) and (t1 is None or r[0] <= t1)][::stride]
    if not rows:
        raise ValueError("run has no recorded frames; re-run with frames enabled")
    images = []
    for row in rows:
        fig, ax = plt.subplots(figsize=(4.2, 3.4), dpi=110)
        m = res["metrics"]
        note = f"t={row[0]:5.2f}s"
        if m.get("fall_time_s") is not None and row[0] >= m["fall_time_s"]:
            note += "  FELL"
        _draw_frame(ax, res, row, f"{label}  {note}" if label else note, None)
        fig.tight_layout(pad=0.2)
        fig.canvas.draw()
        images.append(Image.fromarray(np.asarray(fig.canvas.buffer_rgba())[..., :3]))
        plt.close(fig)
    images[0].save(path, save_all=True, append_images=images[1:], duration=int(1000 / fps), loop=0)
    return path


def metrics_png(res: dict[str, Any], path: str, title: str = "") -> str:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ticks = res["ticks"]
    t = [x["t_s"] for x in ticks]
    fig, axes = plt.subplots(2, 1, figsize=(7.2, 5.0), dpi=120, sharex=True)
    m = res["metrics"]

    _healthy_band(axes[0], res)
    axes[0].plot(t, [x["torso_z_m"] for x in ticks], color="#1f4e9c", lw=1.6, label="torso z")
    axes[0].set_ylabel("torso height (m)")
    axes[0].legend(fontsize=8, loc="upper right")

    axes[1].plot(t, [x["torso_speed_mps"] for x in ticks], color="#b06c1f", lw=1.4, label="torso speed")
    axes[1].set_ylabel("speed (m/s)")
    axes[1].set_xlabel("time (s)")
    axes[1].legend(fontsize=8, loc="upper right")

    push = [x["t_s"] for x in ticks if x["push_on"]]
    for ax in axes:
        if push:
            ax.axvspan(min(push), max(push), color="#f0d9a8", alpha=0.7, lw=0)
        if m.get("fall_time_s") is not None:
            ax.axvline(m["fall_time_s"], color="#b42318", lw=1.4, ls="--")
        if m.get("ground_contact_t_s") is not None:
            ax.axvline(m["ground_contact_t_s"], color="#7a1d13", lw=1.0, ls=":")
    head = title or res["metrics"]["outcome"]
    sub = f"{m['outcome']}  return={m['episode_return']:.0f}  survived={m['survival_time_s']:.2f}s"
    if m.get("torso_impact_speed_mps") is not None:
        sub += f"  torso impact {m['torso_impact_speed_mps']:.2f} m/s"
    fig.suptitle(f"{head}\n{sub}", fontsize=10)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    fig.savefig(path)
    plt.close(fig)
    return path


def side_by_side_png(baseline: dict[str, Any], failure: dict[str, Any], path: str, times: list[float]) -> str:
    """One row per run, one column per sampled time, drawn from the recorded frames."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    def row_at(res: dict[str, Any], t: float) -> list[float]:
        data = res["frames"]["data"]
        i = min(max(int(round(t / res["frames"]["dt_s"])), 0), len(data) - 1)
        return data[i]

    fig, axes = plt.subplots(2, len(times), figsize=(2.5 * len(times), 6.0), dpi=120)
    axes = np.atleast_2d(axes)
    names = ("SURVIVED - nominal conditions", "FELL - purchased scenario")
    for col, t in enumerate(times):
        for r, res in enumerate((baseline, failure)):
            row = row_at(res, t)
            prims = primitives_at(res, row)
            cx = float(np.mean([p["world_pos"][0] for p in prims]))
            note = f"t={t:.2f}s"
            fm = res["metrics"].get("fall_time_s")
            if fm is not None and t >= fm:
                note += "  FELL"
            _draw_frame(axes[r][col], res, row, note, (cx - 1.5, cx + 1.5))
    for r, name in enumerate(names):
        axes[r][0].text(-0.04, 0.5, name, transform=axes[r][0].transAxes, rotation=90,
                        va="center", ha="right", fontsize=9,
                        color="#1f4e9c" if r == 0 else "#b42318")
    m = failure["metrics"]
    fig.suptitle(
        f"{failure['target_label']}  -  {failure['primary_failure_class']} at "
        f"{m['fall_time_s']:.2f} s, torso impact "
        f"{m['torso_impact_speed_mps'] if m['torso_impact_speed_mps'] is not None else float('nan'):.2f} m/s",
        fontsize=10,
    )
    fig.tight_layout(rect=(0.03, 0, 1, 0.94))
    fig.subplots_adjust(hspace=0.18)
    fig.savefig(path)
    plt.close(fig)
    return path
