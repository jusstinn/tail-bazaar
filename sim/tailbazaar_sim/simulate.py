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

Two failure classes, both decided by the physics
------------------------------------------------
COLLISION   a contact between any cart geom and the obstacle geom appeared.
LOAD_SHED   the load, which merely rests on the chassis deck and is held there only by
            the friction of the chassis/load contact pair, left the deck. Three
            alternative criteria, evaluated every physics step (2 ms) in the CHASSIS
            frame, with slip measured from the load's seated position:

              slip        |slip_xy| > SHED_SLIP_M (0.15 m). 0.15 m is pure geometry:
                          CHASSIS_HALF[0] - LOAD_HALF[0] = 0.40 - 0.25, the deck margin
                          ahead of (and behind) the seated load. At exactly that
                          displacement the load's leading face has reached the deck's
                          leading face; beyond it the load overhangs the deck. The
                          lateral margin is smaller (0.05 m) and the same threshold is
                          used for the planar magnitude; motion in this scene is along x.
              separation  no chassis/load contact for SHED_SEPARATION_S (0.10 s = five
                          control ticks) after at least one has been seen. Long enough
                          that a bounce during a hard stop is not called a shed, short
                          enough to catch a real departure within a sixth of a stop.
              footprint   the load's centre of mass leaves the deck rectangle
                          (|slip_x| > 0.40 m or |slip_y| > 0.25 m). A backstop: with the
                          current geometry the slip criterion is strictly tighter, so for
                          any in-plane departure `slip` fires first.

            The first criterion to fire is recorded with the time, the slip vector, the
            load's speed relative to the chassis (the severity proxy) and its world
            speed. Nothing assigns this outcome directly; it is read out of MuJoCo's
            contact and body state. No monetary damage is estimated anywhere.

Termination (first that applies):
  DIVERGED     non-finite state, MuJoCo bad-acceleration warning, or |position| > 100 m
  COLLISION    a cart/obstacle contact appeared; the run continues POST_CONTACT_S (1.0 s)
               after first contact so the replay shows the impact
  SUCCESS      after brake onset the chassis speed stayed below 0.02 m/s for 0.5 s, and,
               if the load was shed, at least POST_SHED_S (1.0 s) has passed since the
               shed so the replay shows the load leaving the deck
  TIMEOUT      t reached T_MAX_S (10 s) without any of the above
An initial state with an obstacle contact or a penetration deeper than 5 mm is
INVALID_INITIAL_STATE and the run is not executed.

`chassis_outcome` is the stop-before-obstacle result on its own and uses exactly the
vocabulary schema tb-run-1 put in `outcome`. `outcome` now also reports LOAD_SHED, with
precedence DIVERGED > COLLISION > LOAD_SHED > SUCCESS > TIMEOUT, so a run that hits the
obstacle still reads COLLISION exactly as before. `failure_classes` is the authoritative
multi-class field and may hold both.

Outcomes other than SUCCESS / COLLISION / LOAD_SHED are inconclusive for the marketplace.
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
    A_FULL,
    A_TRIGGER,
    B_MAX,
    CONTROLLER_ID,
    D_CLEAR,
    OMEGA_LIN,
    Controller,
    controller_hash,
)
from .envelope import (
    DT_CTRL_MS,
    ENVELOPE_ID,
    ENVELOPE_REVISION,
    GRAVITY_MPS2,
    check_admissible,
    normalize,
    normalize_failure_classes,
    required_deck_grip,
)
from .scene import (
    BODY_NAMES,
    CART_GEOM_NAMES,
    CHASSIS_HALF,
    CHASSIS_MASS_KG,
    CHASSIS_Z0,
    DECK_MARGIN_X_M,
    DECK_MARGIN_Y_M,
    DRIVEN_WHEELS,
    INTEGRATOR,
    LOAD_HALF,
    LOAD_LOCAL_Z,
    LOAD_SEAT_LOCAL,
    OBSTACLE_FRONT_X,
    OBSTACLE_HALF,
    PHYSICS_TIMESTEP_S,
    SCENE_REVISION,
    WHEEL_LOCAL,
    WHEEL_MASS_KG,
    WHEEL_NAMES,
    WHEEL_RADIUS,
    build_mjcf,
)

# tb-run-2 adds the LOAD_SHED failure class, the `load_friction` scenario axis and the
# load_* metrics. Every field of tb-run-1 is still present with its original meaning,
# except that `outcome` gained the value LOAD_SHED (the tb-run-1 value is `chassis_outcome`).
RUN_SCHEMA = "tb-run-2"
T_MAX_S = 10.0
POST_CONTACT_S = 1.0
POST_SHED_S = 1.0
STOP_SPEED = 0.02
STOP_HOLD_S = 0.5
SUBSTEPS = int(round(DT_CTRL_MS / 1000.0 / PHYSICS_TIMESTEP_S))
DT_CTRL_S = DT_CTRL_MS / 1000.0
MAX_PENETRATION_M = 0.005

# --- LOAD_SHED thresholds (see the module docstring for the derivation) -------------
SHED_SLIP_M = DECK_MARGIN_X_M          # 0.15 m, = CHASSIS_HALF[0] - LOAD_HALF[0]
SHED_SEPARATION_S = 0.10               # five control ticks with no chassis/load contact
SHED_FOOTPRINT_HALF = (CHASSIS_HALF[0], CHASSIS_HALF[1])  # (0.40, 0.25) m
SHED_CRITERIA = ("slip", "separation", "footprint")


def load_shed_rules() -> dict[str, Any]:
    """The published LOAD_SHED detection rule, recorded in every run document."""
    return {
        "class": "LOAD_SHED",
        "measured_in": "chassis frame, relative to the load's seated position",
        "sample_rate_hz": round(1.0 / PHYSICS_TIMESTEP_S, 3),
        "criteria": {
            "slip": {
                "threshold_m": SHED_SLIP_M,
                "quantity": "planar magnitude of the load's displacement relative to its seat",
                "derivation": "CHASSIS_HALF[0] - LOAD_HALF[0] = 0.40 - 0.25: the deck margin ahead of the seated load",
            },
            "separation": {
                "threshold_s": SHED_SEPARATION_S,
                "quantity": "continuous time with no chassis_geom/load_geom contact, after at least one has been seen",
                "derivation": "five control ticks; longer than a bounce during a hard stop, shorter than a sixth of a stop",
            },
            "footprint": {
                "threshold_half_m": list(SHED_FOOTPRINT_HALF),
                "quantity": "load centre of mass projected into the deck plane leaves the chassis rectangle",
                "derivation": "chassis half extents; a backstop, strictly looser than the slip criterion at this geometry",
            },
        },
        "severity_proxy": {
            "primary": "load_rel_speed_at_shed_mps",
            "definition": "magnitude of the load's world velocity minus the chassis's world velocity at the moment the first criterion fires",
            "not_a_damage_estimate": True,
        },
        "deck_grip_required": {
            "planned_stop_a_trigger_mps2": A_TRIGGER,
            "planned_stop_mu": round(required_deck_grip(A_TRIGGER), 4),
            "saturated_brake_a_full_mps2": A_FULL,
            "saturated_brake_mu": round(required_deck_grip(A_FULL), 4),
            "gravity_mps2": GRAVITY_MPS2,
            "source": "arithmetic on controller.py's published constants; controller.py was not edited",
        },
    }


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
        "scene_revision": SCENE_REVISION,
        "load_attachment": "free rigid body resting on the chassis deck, held by contact friction only",
        "obstacle_front_x_m": OBSTACLE_FRONT_X,
        "obstacle_half_m": list(OBSTACLE_HALF),
        "obstacle_center_m": [OBSTACLE_FRONT_X + OBSTACLE_HALF[0], 0.0, OBSTACLE_HALF[2]],
        "chassis_half_m": list(CHASSIS_HALF),
        "chassis_mass_kg": CHASSIS_MASS_KG,
        "chassis_z0_m": CHASSIS_Z0,
        "load_half_m": list(LOAD_HALF),
        "load_local_z_m": LOAD_LOCAL_Z,
        "load_seat_local_m": list(LOAD_SEAT_LOCAL),
        "deck_margin_x_m": DECK_MARGIN_X_M,
        "deck_margin_y_m": DECK_MARGIN_Y_M,
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


def _empty_tail(result: dict[str, Any], started: float) -> dict[str, Any]:
    result["metrics"] = {}
    result["events"] = []
    result["ticks"] = []
    result["failure_classes"] = []
    result["primary_failure_class"] = "NONE"
    result["chassis_outcome"] = result["outcome"]
    result["load_shed_event"] = None
    result["frames"] = {"dt_s": DT_CTRL_S, "bodies": list(BODY_NAMES), "quat_order": "wxyz", "data": []}
    result["trajectory_hash"] = canonical.commitment(result["frames"])
    result["wall_time_s"] = round(time.perf_counter() - started, 4)
    return result


def run_scenario(scenario: dict[str, Any], record_frames: bool = True) -> dict[str, Any]:
    problems = check_admissible(scenario)
    scn = normalize(scenario) if not problems else dict(scenario)
    started = time.perf_counter()

    result: dict[str, Any] = {
        "schema": RUN_SCHEMA,
        "envelope_id": ENVELOPE_ID,
        "envelope_revision": ENVELOPE_REVISION,
        "scenario": scn,
        "admissible": not problems,
        "admissibility_problems": problems,
        "controller": {"id": CONTROLLER_ID, "hash": controller_hash()},
        "engine": engine_info(),
        "scene": scene_description(),
        "termination_rules": {
            "t_max_s": T_MAX_S,
            "post_contact_s": POST_CONTACT_S,
            "post_shed_s": POST_SHED_S,
            "stop_speed_mps": STOP_SPEED,
            "stop_hold_s": STOP_HOLD_S,
            "max_initial_penetration_m": MAX_PENETRATION_M,
        },
        "load_shed_rules": load_shed_rules(),
    }
    if problems:
        result["outcome"] = "REJECTED_OUT_OF_ENVELOPE"
        return _empty_tail(result, started)

    xml = build_mjcf(scn["floor_friction"], scn["payload_kg"], scn["load_friction"])
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    result["mjcf_hash"] = "sha256:" + hashlib.sha256(xml.encode()).hexdigest()

    body_ids = [model.body(n).id for n in BODY_NAMES]
    chassis_id = model.body("chassis").id
    load_id = model.body("load").id
    obstacle_gid = model.geom("obstacle").id
    chassis_gid = model.geom("chassis_geom").id
    load_gid = model.geom("load_geom").id
    cart_gids = {model.geom(n).id for n in CART_GEOM_NAMES}
    range_adr = model.sensor("range").adr[0]
    linvel_adr = model.sensor("chassis_linvel").adr[0]
    load_linvel_adr = model.sensor("load_linvel").adr[0]
    omega_adr = {w: model.sensor(f"{w}_omega").adr[0] for w in WHEEL_NAMES}
    act_ids = {w: model.actuator(f"{w}_motor").id for w in WHEEL_NAMES}
    total_mass = float(sum(model.body_mass[i] for i in range(model.nbody)))
    payload_kg = float(scn["payload_kg"])
    front_local = np.array([CHASSIS_HALF[0], 0.0, 0.0])
    seat_local = np.array(LOAD_SEAT_LOCAL)

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
        "load_pos_m": canonical.quantize(data.xpos[load_id].tolist()),
        "total_mass_kg": round(total_mass, 3),
    }
    result["initial_state_check"] = initial_check
    if not initial_check["ok"]:
        result["outcome"] = "INVALID_INITIAL_STATE"
        return _empty_tail(result, started)

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

    def load_slip() -> np.ndarray:
        """Load displacement from its seated position, expressed in the chassis frame."""
        R = data.xmat[chassis_id].reshape(3, 3)
        return R.T @ (data.xpos[load_id] - data.xpos[chassis_id]) - seat_local

    def load_rel_vel() -> np.ndarray:
        """World-frame velocity of the load's body frame minus the chassis's."""
        lv = data.sensordata[load_linvel_adr:load_linvel_adr + 3]
        cv = data.sensordata[linvel_adr:linvel_adr + 3]
        return np.asarray(lv) - np.asarray(cv)

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

    # --- load-shed state ----------------------------------------------------------
    shed_t: float | None = None
    shed_criterion: str | None = None
    shed_slip: np.ndarray | None = None
    shed_rel_speed: float | None = None
    shed_world_speed: float | None = None
    shed_direction: str | None = None
    shed_phase: str | None = None
    slip_max = 0.0
    rel_speed_max = 0.0
    deck_seen = False
    last_deck_contact_t = 0.0
    deck_lost_total_s = 0.0
    current_phase = "CRUISE"

    def check_shed() -> None:
        """Evaluate the three LOAD_SHED criteria at the current physics state."""
        nonlocal shed_t, shed_criterion, shed_slip, shed_rel_speed, shed_world_speed
        nonlocal shed_direction, shed_phase, slip_max, rel_speed_max
        slip = load_slip()
        planar = float(math.hypot(slip[0], slip[1]))
        slip_max = max(slip_max, planar)
        rel = load_rel_vel()
        rel_speed = float(np.linalg.norm(rel))
        rel_speed_max = max(rel_speed_max, rel_speed)
        if shed_t is not None:
            return
        crit: str | None = None
        if planar > SHED_SLIP_M:
            crit = "slip"
        elif deck_seen and (float(data.time) - last_deck_contact_t) >= SHED_SEPARATION_S:
            crit = "separation"
        elif abs(float(slip[0])) > SHED_FOOTPRINT_HALF[0] or abs(float(slip[1])) > SHED_FOOTPRINT_HALF[1]:
            crit = "footprint"
        if crit is None:
            return
        shed_t = float(data.time)
        shed_criterion = crit
        shed_slip = slip.copy()
        shed_rel_speed = rel_speed
        shed_world_speed = float(np.linalg.norm(data.sensordata[load_linvel_adr:load_linvel_adr + 3]))
        shed_direction = (
            "forward" if slip[0] > abs(slip[1]) else "rearward" if -slip[0] > abs(slip[1]) else "lateral"
        )
        shed_phase = current_phase
        events.append({
            "t_s": round(shed_t, 6),
            "type": "load_shed",
            "criterion": crit,
            "slip_m": round(planar, 6),
            "slip_xyz_m": canonical.quantize(slip.tolist()),
            "direction": shed_direction,
            "load_rel_speed_mps": round(rel_speed, 6),
            "load_speed_mps": round(shed_world_speed, 6),
            "chassis_speed_mps": round(chassis_vx(), 6),
            "phase": current_phase,
        })

    check_shed()  # t = 0: records the seated slip (zero) and arms the maxima

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
        current_phase = cmd.phase
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

        tick_slip = load_slip()
        tick_slip_planar = float(math.hypot(tick_slip[0], tick_slip[1]))
        tick_rel_speed = float(np.linalg.norm(load_rel_vel()))

        if tick == max_ticks:
            break

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

            deck_contact = False
            for i in range(data.ncon):
                c = data.contact[i]
                g1, g2 = int(c.geom1), int(c.geom2)
                if (g1 == chassis_gid and g2 == load_gid) or (g2 == chassis_gid and g1 == load_gid):
                    deck_contact = True
                if first_contact_t is None and (
                    (g1 == obstacle_gid and g2 in cart_gids) or (g2 == obstacle_gid and g1 in cart_gids)
                ):
                    first_contact_t = float(data.time)
                    impact_speed = v_before
                    events.append({"t_s": round(first_contact_t, 6), "type": "first_contact",
                                   "impact_speed_mps": round(impact_speed, 6),
                                   "cart_geom": model.geom(g1 if g2 == obstacle_gid else g2).name,
                                   "x_front_m": round(front_x(), 6)})
            if deck_contact:
                deck_seen = True
                last_deck_contact_t = float(data.time)
            elif deck_seen:
                deck_lost_total_s += PHYSICS_TIMESTEP_S

            if not np.all(np.isfinite(data.qpos)) or not np.all(np.isfinite(data.qvel)):
                diverged_reason = "non-finite state"
                break
            check_shed()
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
            "load_slip_m": round(tick_slip_planar, 6),
            "load_rel_speed_mps": round(tick_rel_speed, 6),
            "load_shed": shed_t is not None,
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
            shed_settled = shed_t is None or (data.time - shed_t) >= POST_SHED_S
            if stop_count * DT_CTRL_S >= STOP_HOLD_S and shed_settled:
                outcome = "SUCCESS"
                events.append({"t_s": round(stop_t, 6), "type": "stopped", "x_front_m": round(stop_x, 6)})
                break
        else:
            stop_count = 0
            stop_t = None
            stop_x = None

    record_frame(float(data.time)) if (record_frames and (not frames or frames[-1][0] != round(float(data.time), 6))) else None

    # --- outcome and failure classes ----------------------------------------------
    chassis_outcome = outcome  # exactly the vocabulary schema tb-run-1 put in `outcome`
    classes: list[str] = []
    if first_contact_t is not None:
        classes.append("COLLISION")
    if shed_t is not None:
        classes.append("LOAD_SHED")
    classes = normalize_failure_classes(classes)
    if shed_t is not None and chassis_outcome in ("SUCCESS", "TIMEOUT"):
        outcome = "LOAD_SHED"
    primary = "COLLISION" if first_contact_t is not None else ("LOAD_SHED" if shed_t is not None else "NONE")

    final_front = front_x()
    final_clearance = OBSTACLE_FRONT_X - final_front
    final_slip = load_slip()
    # `metrics` stays flat and scalar-only (number | string | null | boolean): it is consumed
    # as such by the web layer. Vector quantities live in the top-level `load_shed_event`.
    metrics: dict[str, Any] = {
        "outcome": outcome,
        "chassis_outcome": chassis_outcome,
        "failure_class_set": "+".join(classes) if classes else "NONE",
        "primary_failure_class": primary,
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
        # --- LOAD_SHED -------------------------------------------------------------
        "load_shed": shed_t is not None,
        "load_shed_t_s": None if shed_t is None else round(shed_t, 6),
        "load_shed_criterion": shed_criterion,
        "load_shed_phase": shed_phase,
        "load_shed_direction": shed_direction,
        "load_slip_at_shed_m": None if shed_slip is None else round(float(math.hypot(shed_slip[0], shed_slip[1])), 6),
        "load_slip_at_shed_x_m": None if shed_slip is None else round(float(shed_slip[0]), 6),
        "load_slip_at_shed_y_m": None if shed_slip is None else round(float(shed_slip[1]), 6),
        "load_slip_at_shed_z_m": None if shed_slip is None else round(float(shed_slip[2]), 6),
        "load_rel_speed_at_shed_mps": None if shed_rel_speed is None else round(shed_rel_speed, 6),
        "load_speed_at_shed_mps": None if shed_world_speed is None else round(shed_world_speed, 6),
        "load_shed_relative_kinetic_energy_j": (
            None if shed_rel_speed is None else round(0.5 * payload_kg * shed_rel_speed ** 2, 3)
        ),
        "load_slip_max_m": round(slip_max, 6),
        "load_rel_speed_max_mps": round(rel_speed_max, 6),
        "load_final_slip_m": round(float(math.hypot(final_slip[0], final_slip[1])), 6),
        "load_final_slip_x_m": round(float(final_slip[0]), 6),
        "load_final_slip_y_m": round(float(final_slip[1]), 6),
        "load_final_slip_z_m": round(float(final_slip[2]), 6),
        "deck_contact_lost_total_s": round(deck_lost_total_s, 6),
        "load_friction": scn["load_friction"],
        "deck_grip_required_at_peak_decel": round(required_deck_grip(peak_decel), 6),
        "deck_grip_margin": round(float(scn["load_friction"]) - required_deck_grip(peak_decel), 6),
    }
    if chassis_outcome == "SUCCESS" and stop_x is not None and brake_onset_x is not None:
        metrics["stopping_distance_m"] = round(stop_x - brake_onset_x, 6)
        metrics["stop_t_s"] = round(stop_t, 6)
        metrics["pose_error_m"] = round(final_clearance - D_CLEAR, 6)
    if first_contact_t is not None and brake_onset_x is not None:
        ev = next(e for e in events if e["type"] == "first_contact")
        metrics["distance_brake_onset_to_impact_m"] = round(ev["x_front_m"] - brake_onset_x, 6)
    if first_contact_t is not None and brake_onset_x is None:
        metrics["note"] = "collision before any braking was applied"

    result["outcome"] = outcome
    result["chassis_outcome"] = chassis_outcome
    result["failure_classes"] = classes
    result["primary_failure_class"] = primary
    result["load_shed_event"] = None if shed_t is None else {
        "t_s": round(shed_t, 6),
        "criterion": shed_criterion,
        "phase": shed_phase,
        "direction": shed_direction,
        "slip_m": round(float(math.hypot(shed_slip[0], shed_slip[1])), 6),
        "slip_xyz_m": canonical.quantize(shed_slip.tolist()),
        "load_rel_speed_mps": round(shed_rel_speed, 6),
        "load_speed_mps": round(shed_world_speed, 6),
        "relative_kinetic_energy_j": round(0.5 * payload_kg * shed_rel_speed ** 2, 3),
        "final_slip_xyz_m": canonical.quantize(final_slip.tolist()),
    }
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
        f"sd={s.get('sensor_delay_ms')}ms ad={s.get('actuator_delay_ms')}ms mu={s.get('floor_friction')} "
        f"m={s.get('payload_kg')}kg mu_load={s.get('load_friction')}",
    ]
    if m:
        parts.append(f"vmax={m['v_max_mps']:.2f}")
        parts.append(f"clear={m['final_clearance_m']:.3f}m")
        if m.get("impact_speed_mps") is not None:
            parts.append(f"impact={m['impact_speed_mps']:.3f}m/s")
        if m.get("load_shed"):
            parts.append(f"shed@{m['load_shed_t_s']:.2f}s({m['load_shed_criterion']},{m['load_shed_direction']},"
                         f"rel={m['load_rel_speed_at_shed_mps']:.3f}m/s)")
        else:
            parts.append(f"slipmax={m['load_slip_max_m']:.3f}m")
        if m.get("stopping_distance_m") is not None:
            parts.append(f"stopdist={m['stopping_distance_m']:.3f}m")
        parts.append(f"steps={m['sim_steps']} wall={res['wall_time_s']:.2f}s")
    return " ".join(parts)
