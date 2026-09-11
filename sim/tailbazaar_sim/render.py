"""Viewable renderings from recorded transforms (matplotlib; no second physics).

side_view_gif: x-z side view animation of chassis, load, wheels (with a spoke to show
rotation), obstacle and floor, drawn purely from the recorded per-tick body
positions/quaternions. metrics_png: x_front, speed, range and brake level vs time.
"""

from __future__ import annotations

import math
from typing import Any

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Circle, Polygon, Rectangle  # noqa: E402
from PIL import Image  # noqa: E402


def _quat_to_pitch_yaw(q: list[float]) -> tuple[float, float]:
    w, x, y, z = q
    # pitch about y (side view rotation) and yaw about z
    sinp = 2 * (w * y - z * x)
    pitch = math.copysign(math.pi / 2, sinp) if abs(sinp) >= 1 else math.asin(sinp)
    yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    return pitch, yaw


def _box_xz(cx: float, cz: float, hx: float, hz: float, pitch: float) -> list[tuple[float, float]]:
    c, s = math.cos(-pitch), math.sin(-pitch)
    pts = []
    for dx, dz in ((-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz)):
        pts.append((cx + c * dx - s * dz, cz + s * dx + c * dz))
    return pts


def _frame_bodies(row: list[float], bodies: list[str]) -> dict[str, tuple[list[float], list[float]]]:
    out = {}
    for i, b in enumerate(bodies):
        base = 1 + 7 * i
        out[b] = (row[base:base + 3], row[base + 3:base + 7])
    return out


def draw_frame(ax, row, bodies, scene, title: str, x_window: tuple[float, float] | None = None) -> None:
    ax.clear()
    fb = _frame_bodies(row, bodies)
    ox = scene["obstacle_front_x_m"]
    oh = scene["obstacle_half_m"]
    ax.add_patch(Rectangle((ox, 0), 2 * oh[0], 2 * oh[2], color="#c85a32"))
    ax.plot([-1, 8], [0, 0], color="#555", lw=2)
    ch = scene["chassis_half_m"]
    lh = scene["load_half_m"]
    (cp, cq) = fb["chassis"]
    pitch, _ = _quat_to_pitch_yaw(cq)
    ax.add_patch(Polygon(_box_xz(cp[0], cp[2], ch[0], ch[2], pitch), closed=True, color="#2f6fd0"))
    (lp, lq) = fb["load"]
    lpitch, _ = _quat_to_pitch_yaw(lq)
    ax.add_patch(Polygon(_box_xz(lp[0], lp[2], lh[0], lh[2], lpitch), closed=True, color="#e2b64a"))
    r = scene["wheel_radius_m"]
    for name in bodies:
        if not name.startswith("wheel"):
            continue
        (wp, wq) = fb[name]
        wpitch, _ = _quat_to_pitch_yaw(wq)
        ax.add_patch(Circle((wp[0], wp[2]), r, color="#222", zorder=3))
        ax.plot([wp[0], wp[0] + r * math.cos(-wpitch)], [wp[2], wp[2] + r * math.sin(-wpitch)], color="#ddd", lw=1.5, zorder=4)
    if x_window is None:
        x_window = (-0.6, ox + 2 * oh[0] + 0.3)
    ax.set_xlim(*x_window)
    ax.set_ylim(-0.1, 1.4)
    ax.set_aspect("equal")
    ax.set_xlabel("x [m]")
    ax.set_title(title, fontsize=9, loc="left")


def side_view_gif(res: dict[str, Any], path: str, fps: int = 25, stride: int = 2, label: str = "") -> str:
    frames = res["frames"]["data"]
    bodies = res["frames"]["bodies"]
    scene = res["scene"]
    fig, ax = plt.subplots(figsize=(9, 2.4), dpi=80)
    images = []
    ticks = res["ticks"]
    for i in range(0, len(frames), stride):
        row = frames[i]
        tk = ticks[min(i, len(ticks) - 1)] if ticks else None
        info = ""
        if tk:
            info = f"t={row[0]:.2f}s  v={tk['v_odom_mps']:.2f} m/s  range={tk['range_used_m']:.2f} m  brake={tk['brake_applied']:.2f}  {tk['phase']}"
            if tk["contact"]:
                info += "  CONTACT"
        draw_frame(ax, row, bodies, scene, f"{label} {res['outcome']}  {info}")
        fig.canvas.draw()
        buf = np.asarray(fig.canvas.buffer_rgba())
        images.append(Image.fromarray(buf[:, :, :3].copy()))
    plt.close(fig)
    # hold the last frame
    images.extend([images[-1]] * fps)
    images[0].save(path, save_all=True, append_images=images[1:], duration=int(1000 / fps), loop=0)
    return path


def metrics_png(res: dict[str, Any], path: str, title: str = "") -> str:
    ticks = res["ticks"]
    t = [k["t_s"] for k in ticks]
    fig, axes = plt.subplots(3, 1, figsize=(8, 6.5), dpi=90, sharex=True)
    ox = res["scene"]["obstacle_front_x_m"]
    axes[0].plot(t, [k["x_front_m"] for k in ticks], label="cart front x")
    axes[0].axhline(ox, color="#c85a32", ls="--", label="obstacle face")
    axes[0].axhline(ox - res["scene"]["target_clearance_m"], color="#888", ls=":", label="target stop")
    axes[0].set_ylabel("x [m]")
    axes[0].legend(loc="lower right", fontsize=8)
    axes[1].plot(t, [k["v_odom_mps"] for k in ticks], label="speed")
    axes[1].set_ylabel("v [m/s]")
    axes[2].plot(t, [k["range_raw_m"] for k in ticks], label="range (true)", color="#999")
    axes[2].plot(t, [k["range_used_m"] for k in ticks], label="range (as seen by controller)")
    ax2 = axes[2].twinx()
    ax2.plot(t, [k["brake_applied"] for k in ticks], color="#c00", label="brake level applied")
    ax2.set_ylim(0, 1.05)
    ax2.set_ylabel("brake")
    axes[2].set_ylabel("range [m]")
    axes[2].set_xlabel("t [s]")
    axes[2].legend(loc="upper right", fontsize=8)
    ax2.legend(loc="center right", fontsize=8)
    for e in res["events"]:
        for ax in axes:
            ax.axvline(e["t_s"], color="#333", lw=0.6, alpha=0.5)
        axes[0].text(e["t_s"], ox + 0.1, e["type"], fontsize=7, rotation=90, va="bottom")
    s = res["scenario"]
    fig.suptitle(f"{title} {res['outcome']} | sensor delay {s['sensor_delay_ms']} ms, actuator delay {s['actuator_delay_ms']} ms, mu {s['floor_friction']}, payload {s['payload_kg']} kg", fontsize=9)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def side_by_side_png(baseline: dict[str, Any], failure: dict[str, Any], path: str, times: list[float]) -> str:
    """Snapshot strip: baseline (top) vs failure (bottom) at the given times."""
    fig, axes = plt.subplots(2, len(times), figsize=(4.2 * len(times), 4.6), dpi=80)
    for col, tq in enumerate(times):
        for rowi, (res, label) in enumerate(((baseline, "baseline"), (failure, "failure"))):
            frames = res["frames"]["data"]
            idx = min(range(len(frames)), key=lambda i: abs(frames[i][0] - tq))
            draw_frame(axes[rowi][col], frames[idx], res["frames"]["bodies"], res["scene"], f"{label} t={frames[idx][0]:.2f}s", x_window=(3.0, 7.0))
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path
