"""Run one scenario through MuJoCo with the fixed controller and record everything.

Units: metres, seconds, kilograms, newton-metres, radians. Physics at 500 Hz
(timestep 0.002 s), control at 50 Hz (10 substeps per tick). Delays are integer
numbers of control ticks:
  sensor delay    the controller receives the rangefinder reading taken
                  sensor_delay_ms/20 ticks ago (before any reading is that old it
                  receives the oldest one available, i.e. the t=0 reading).
  actuator delay  the command computed at tick k is applied from tick
                  k + actuator_delay_ms/20; until the first command arrives the
                  actuators apply zero drive and zero brake.
Between ticks the applied command is held (zero-order hold). The brake model runs
at physics rate because it depends on the instantaneous wheel speed:
  wheel torque = drive (rear wheels only) - brake_level * B_MAX * clip(omega/OMEGA_LIN, -1, 1)

Termination (first that applies):
  DIVERGED     non-finite state, MuJoCo bad-acceleration warning, or |position| > 100 m
  COLLISION    a contact between any cart geom and the obstacle geom appeared; the
               run continues 1.0 s after first contact so the replay shows the impact
  SUCCESS      after brake onset the chassis speed stayed below 0.02 m/s for 0.5 s
  TIMEOUT      t reached T_MAX_S (10 s) without any of the above
An initial state with an obstacle contact or a penetration deeper than 5 mm is
INVALID_INITIAL_STATE and the run is not executed.

Outcomes other than SUCCESS/COLLISION are inconclusive for the marketplace.
"""

from __future__ import annotations

import hashlib
import math
import platform
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any

import mujoco
import numpy as np

from . import canonical
from .controller import (
    B_MAX,
    CONTROLLER_ID,
    D_CLEAR,
    OMEGA_LIN,
    Controller,
    controller_hash,
)
from .envelope import DT_CTRL_MS, ENVELOPE_ID, check_admissible, normalize
from .scene import (
    BODY_NAMES,
    CART_GEOM_NAMES,
    CHASSIS_HALF,
    CHASSIS_MASS_KG,
    CHASSIS_Z0,
    DRIVEN_WHEELS,
    INTEGRATOR,
    LOAD_HALF,
    LOAD_LOCAL_Z,
    OBSTACLE_FRONT_X,
    OBSTACLE_HALF,
    PHYSICS_TIMESTEP_S,
    WHEEL_LOCAL,
    WHEEL_MASS_KG,
    WHEEL_NAMES,
    WHEEL_RADIUS,
    build_mjcf,
)

RUN_SCHEMA = "tb-run-1"
T_MAX_S = 10.0
POST_CONTACT_S = 1.0
STOP_SPEED = 0.02
STOP_HOLD_S = 0.5
SUBSTEPS = int(round(DT_CTRL_MS / 1000.0 / PHYSICS_TIMESTEP_S))
DT_CTRL_S = DT_CTRL_MS / 1000.0
MAX_PENETRATION_M = 0.005


def engine_info() -> dict[str, Any]:
    return {
        "engine": "mujoco",
        "engine_version": mujoco.__version__,
        "numpy_version": np.__version__,
        "python_version": sys.version.split()[0],
        "platform": f"{platform.system()}-{platform.machine()}",
        "integrator": INTEGRATOR,
        "physics_timestep_s": PHYSICS_TIMESTEP_S,
        "control_dt_s": DT_CTRL_S,
        "substeps_per_tick": SUBSTEPS,
        "threads": 1,
    }


def scene_hash() -> str:
    return "sha256:" + hashlib.sha256((Path(__file__).parent / "scene.py").read_bytes()).hexdigest()


def scene_description() -> dict[str, Any]:
    return {
        "scene_hash": scene_hash(),
        "obstacle_front_x_m": OBSTACLE_FRONT_X,
        "obstacle_half_m": list(OBSTACLE_HALF),
        "obstacle_center_m": [OBSTACLE_FRONT_X + OBSTACLE_HALF[0], 0.0, OBSTACLE_HALF[2]],
        "chassis_half_m": list(CHASSIS_HALF),
        "chassis_mass_kg": CHASSIS_MASS_KG,
        "chassis_z0_m": CHASSIS_Z0,
        "load_half_m": list(LOAD_HALF),
        "load_local_z_m": LOAD_LOCAL_Z,
        "wheel_radius_m": WHEEL_RADIUS,
        "wheel_mass_kg": WHEEL_MASS_KG,
        "wheel_local_m": {k: list(v) for k, v in WHEEL_LOCAL.items()},
        "driven_wheels": list(DRIVEN_WHEELS),
        "bodies": list(BODY_NAMES),
        "target_clearance_m": D_CLEAR,
    }


def _brake_torque(level: float, omega: float) -> float:
    s = max(-1.0, min(1.0, omega / OMEGA_LIN))
    return -level * B_MAX * s


def run_scenario(scenario: dict[str, Any], record_frames: bool = True) -> dict[str, Any]:
    problems = check_admissible(scenario)
    scn = normalize(scenario) if not problems else dict(scenario)
    started = time.perf_counter()

    result: dict[str, Any] = {
        "schema": RUN_SCHEMA,
        "envelope_id": ENVELOPE_ID,
        "scenario": scn,
        "admissible": not problems,
        "admissibility_problems": problems,
        "controller": {"id": CONTROLLER_ID, "hash": controller_hash()},
        "engine": engine_info(),
        "scene": scene_description(),
        "termination_rules": {
            "t_max_s": T_MAX_S,
            "post_contact_s": POST_CONTACT_S,
            "stop_speed_mps": STOP_SPEED,
            "stop_hold_s": STOP_HOLD_S,
            "max_initial_penetration_m": MAX_PENETRATION_M,
        },
    }
    if problems:
        result["outcome"] = "REJECTED_OUT_OF_ENVELOPE"
        result["metrics"] = {}
        result["events"] = []
        result["ticks"] = []
        result["frames"] = {"dt_s": DT_CTRL_S, "bodies": list(BODY_NAMES), "quat_order": "wxyz", "data": []}
        result["trajectory_hash"] = canonical.commitment(result["frames"])
        result["wall_time_s"] = round(time.perf_counter() - started, 4)
        return result

    xml = build_mjcf(scn["floor_friction"], scn["payload_kg"])
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    result["mjcf_hash"] = "sha256:" + hashlib.sha256(xml.encode()).hexdigest()

    body_ids = [model.body(n).id for n in BODY_NAMES]
    chassis_id = model.body("chassis").id
    obstacle_gid = model.geom("obstacle").id
    cart_gids = {model.geom(n).id for n in CART_GEOM_NAMES}
    range_adr = model.sensor("range").adr[0]
    linvel_adr = model.sensor("chassis_linvel").adr[0]
    omega_adr = {w: model.sensor(f"{w}_omega").adr[0] for w in WHEEL_NAMES}
    act_ids = {w: model.actuator(f"{w}_motor").id for w in WHEEL_NAMES}
    total_mass = float(sum(model.body_mass[i] for i in range(model.nbody)))
    front_local = np.array([CHASSIS_HALF[0], 0.0, 0.0])

    mujoco.mj_forward(model, data)

    # --- initial state validity ---------------------------------------------------
    init_contacts_obstacle = 0
    min_dist = math.inf
    for i in range(data.ncon):
        c = data.contact[i]
        if c.geom1 == obstacle_gid or c.geom2 == obstacle_gid:
            init_contacts_obstacle += 1
        min_dist = min(min_dist, float(c.dist))
    initial_check = {
        "ok": init_contacts_obstacle == 0 and (min_dist == math.inf or min_dist >= -MAX_PENETRATION_M),
        "contacts_with_obstacle": init_contacts_obstacle,
        "min_contact_dist_m": None if min_dist == math.inf else round(min_dist, 6),
        "initial_range_m": round(float(data.sensordata[range_adr]), 6),
    }
    result["initial_state"] = {
        "qpos": canonical.quantize(data.qpos.tolist()),
        "qvel": canonical.quantize(data.qvel.tolist()),
        "chassis_pos_m": canonical.quantize(data.xpos[chassis_id].tolist()),
        "total_mass_kg": round(total_mass, 3),
    }
    result["initial_state_check"] = initial_check
    if not initial_check["ok"]:
        result["outcome"] = "INVALID_INITIAL_STATE"
        result["metrics"] = {}
        result["events"] = []
        result["ticks"] = []
        result["frames"] = {"dt_s": DT_CTRL_S, "bodies": list(BODY_NAMES), "quat_order": "wxyz", "data": []}
        result["trajectory_hash"] = canonical.commitment(result["frames"])
        result["wall_time_s"] = round(time.perf_counter() - started, 4)
        return result

    # --- delays ------------------------------------------------------------------
    sensor_delay_ticks = scn["sensor_delay_ms"] // DT_CTRL_MS
    act_delay_ticks = scn["actuator_delay_ms"] // DT_CTRL_MS
    sensor_buf: deque[float] = deque()
    cmd_buf: deque[tuple[float, float]] = deque()

    ctrl = Controller()
    ticks: list[dict[str, Any]] = []
    frames: list[list[float]] = []
    events: list[dict[str, Any]] = []

    def front_x() -> float:
        R = data.xmat[chassis_id].reshape(3, 3)
        return float(data.xpos[chassis_id][0] + (R @ front_local)[0])

    def chassis_vx() -> float:
        return float(data.sensordata[linvel_adr])

    def record_frame(t: float) -> None:
        if not record_frames:
            return
        row: list[float] = [round(t, 6)]
        for b in body_ids:
            row.extend(canonical.quantize(data.xpos[b].tolist()))
            row.extend(canonical.quantize(data.xquat[b].tolist()))
        frames.append(row)

    outcome = "TIMEOUT"
    brake_onset_t: float | None = None
    brake_onset_x: float | None = None
    first_contact_t: float | None = None
    impact_speed: float | None = None
    stop_t: float | None = None
    stop_x: float | None = None
    stop_count = 0
    v_max = 0.0
    v_prev_tick = 0.0
    peak_decel = 0.0
    min_range = math.inf
    steps = 0
    max_ticks = int(round(T_MAX_S / DT_CTRL_S))
    diverged_reason = None

    for tick in range(max_ticks + 1):
        t = tick * DT_CTRL_S
        record_frame(t)

        # sensing (with delay)
        raw_range = float(data.sensordata[range_adr])
        sensor_buf.append(raw_range)
        if len(sensor_buf) > sensor_delay_ticks + 1:
            sensor_buf.popleft()
        used_range = sensor_buf[0]  # oldest retained reading = reading from sensor_delay_ticks ago
        v_odom = chassis_vx()
        if raw_range >= 0:
            min_range = min(min_range, raw_range)

        # control
        cmd = ctrl.step(v_odom, used_range)
        cmd_buf.append((cmd.drive_torque, cmd.brake_level))
        if len(cmd_buf) > act_delay_ticks + 1:
            cmd_buf.popleft()
        if len(cmd_buf) == act_delay_ticks + 1:
            applied_drive, applied_brake = cmd_buf[0]
        else:
            applied_drive, applied_brake = 0.0, 0.0

        if applied_brake > 0 and brake_onset_t is None:
            brake_onset_t = t
            brake_onset_x = front_x()
            events.append({"t_s": round(t, 6), "type": "brake_onset", "x_front_m": round(brake_onset_x, 6),
                           "speed_mps": round(v_odom, 6), "range_used_m": round(used_range, 6)})

        if tick == max_ticks:
            break

        contact_this_tick = False
        # physics substeps
        for _ in range(SUBSTEPS):
            v_before = chassis_vx()
            for w in WHEEL_NAMES:
                omega = float(data.sensordata[omega_adr[w]])
                torque = _brake_torque(applied_brake, omega)
                if w in DRIVEN_WHEELS:
                    torque += applied_drive
                data.ctrl[act_ids[w]] = torque
            mujoco.mj_step(model, data)
            steps += 1
            if first_contact_t is None:
                for i in range(data.ncon):
                    c = data.contact[i]
                    g1, g2 = int(c.geom1), int(c.geom2)
                    if (g1 == obstacle_gid and g2 in cart_gids) or (g2 == obstacle_gid and g1 in cart_gids):
                        first_contact_t = float(data.time)
                        impact_speed = v_before
                        contact_this_tick = True
                        events.append({"t_s": round(first_contact_t, 6), "type": "first_contact",
                                       "impact_speed_mps": round(impact_speed, 6),
                                       "cart_geom": model.geom(g1 if g2 == obstacle_gid else g2).name,
                                       "x_front_m": round(front_x(), 6)})
                        break
            if not np.all(np.isfinite(data.qpos)) or not np.all(np.isfinite(data.qvel)):
                diverged_reason = "non-finite state"
                break
        if diverged_reason is None:
            if data.warning[mujoco.mjtWarning.mjWARN_BADQACC].number > 0:
                diverged_reason = "mujoco bad qacc warning"
            elif abs(data.xpos[chassis_id]).max() > 100.0:
                diverged_reason = "position out of bounds"

        v_after = chassis_vx()
        v_max = max(v_max, v_after)
        decel = (v_prev_tick - v_after) / DT_CTRL_S
        peak_decel = max(peak_decel, decel)
        v_prev_tick = v_after

        ticks.append({
            "t_s": round(t, 6),
            "v_odom_mps": round(v_odom, 6),
            "range_raw_m": round(raw_range, 6),
            "range_used_m": round(used_range, 6),
            "drive_cmd_nm": round(cmd.drive_torque, 6),
            "brake_cmd": round(cmd.brake_level, 6),
            "drive_applied_nm": round(applied_drive, 6),
            "brake_applied": round(applied_brake, 6),
            "phase": cmd.phase,
            "a_req_mps2": None if cmd.a_req == math.inf else round(min(cmd.a_req, 999.0), 6),
            "x_front_m": round(front_x(), 6),
            "contact": first_contact_t is not None,
        })

        if diverged_reason is not None:
            outcome = "DIVERGED"
            events.append({"t_s": round(float(data.time), 6), "type": "diverged", "reason": diverged_reason})
            break
        if first_contact_t is not None:
            outcome = "COLLISION"
            if data.time - first_contact_t >= POST_CONTACT_S:
                break
            continue
        if brake_onset_t is not None and abs(v_after) < STOP_SPEED:
            if stop_count == 0:
                stop_t = t + DT_CTRL_S
                stop_x = front_x()
            stop_count += 1
            if stop_count * DT_CTRL_S >= STOP_HOLD_S:
                outcome = "SUCCESS"
                events.append({"t_s": round(stop_t, 6), "type": "stopped", "x_front_m": round(stop_x, 6)})
                break
        else:
            stop_count = 0
            stop_t = None
            stop_x = None

    record_frame(float(data.time)) if (record_frames and (not frames or frames[-1][0] != round(float(data.time), 6))) else None

    final_front = front_x()
    final_clearance = OBSTACLE_FRONT_X - final_front
    metrics: dict[str, Any] = {
        "outcome": outcome,
        "duration_s": round(float(data.time), 6),
        "sim_steps": steps,
        "v_max_mps": round(v_max, 6),
        "peak_decel_mps2": round(peak_decel, 6),
        "min_range_m": None if min_range == math.inf else round(min_range, 6),
        "brake_onset_t_s": None if brake_onset_t is None else round(brake_onset_t, 6),
        "x_front_at_brake_onset_m": None if brake_onset_x is None else round(brake_onset_x, 6),
        "final_x_front_m": round(final_front, 6),
        "final_clearance_m": round(final_clearance, 6),
        "target_clearance_m": D_CLEAR,
        "total_mass_kg": round(total_mass, 3),
        "collision": first_contact_t is not None,
        "first_contact_t_s": None if first_contact_t is None else round(first_contact_t, 6),
        "impact_speed_mps": None if impact_speed is None else round(impact_speed, 6),
        "impact_kinetic_energy_j": None if impact_speed is None else round(0.5 * total_mass * impact_speed ** 2, 3),
        "stopping_distance_m": None,
        "distance_brake_onset_to_impact_m": None,
        "stop_t_s": None,
    }
    if outcome == "SUCCESS" and stop_x is not None and brake_onset_x is not None:
        metrics["stopping_distance_m"] = round(stop_x - brake_onset_x, 6)
        metrics["stop_t_s"] = round(stop_t, 6)
        metrics["pose_error_m"] = round(final_clearance - D_CLEAR, 6)
    if outcome == "COLLISION" and brake_onset_x is not None:
        ev = next(e for e in events if e["type"] == "first_contact")
        metrics["distance_brake_onset_to_impact_m"] = round(ev["x_front_m"] - brake_onset_x, 6)
    if outcome == "COLLISION" and brake_onset_x is None:
        metrics["note"] = "collision before any braking was applied"

    result["outcome"] = outcome
    result["metrics"] = metrics
    result["events"] = events
    result["ticks"] = ticks
    result["frames"] = {"dt_s": DT_CTRL_S, "bodies": list(BODY_NAMES), "quat_order": "wxyz", "data": frames}
    result["trajectory_hash"] = canonical.commitment(result["frames"])
    result["wall_time_s"] = round(time.perf_counter() - started, 4)
    return result


def summarize(res: dict[str, Any]) -> str:
    m = res.get("metrics", {})
    s = res["scenario"]
    parts = [
        f"{res['outcome']:<10}",
        f"sd={s.get('sensor_delay_ms')}ms ad={s.get('actuator_delay_ms')}ms mu={s.get('floor_friction')} m={s.get('payload_kg')}kg",
    ]
    if m:
        parts.append(f"vmax={m['v_max_mps']:.2f}")
        parts.append(f"clear={m['final_clearance_m']:.3f}m")
        if m.get("impact_speed_mps") is not None:
            parts.append(f"impact={m['impact_speed_mps']:.3f}m/s")
        if m.get("stopping_distance_m") is not None:
            parts.append(f"stopdist={m['stopping_distance_m']:.3f}m")
        parts.append(f"steps={m['sim_steps']} wall={res['wall_time_s']:.2f}s")
    return " ".join(parts)
