"""Fixed, documented controller: approach the delivery pose and stop before the obstacle.

This file is the *target* under test. Its SHA-256 (see controller_hash()) identifies
the controller version in every evidence document. Nothing in the hunter or the
verifier may change it.

Inputs each control tick (50 Hz, dt = 0.02 s):
  v_odom      forward speed of the chassis in m/s (proprioceptive; not delayed)
  range_m     obstacle distance from the rangefinder on the front face, in metres;
              a negative value means "nothing detected". This is the exteroceptive
              signal and is what the scenario's sensor delay applies to.

Outputs: drive_torque (N·m, applied to each of the two rear wheels) and
brake_level in [0, 1] (applied to all four wheels through the brake model in
simulate.py: torque = -brake_level * B_MAX * clip(omega / OMEGA_LIN, -1, 1)).

Policy (three phases, no return to an earlier phase):
  CRUISE  drive with a proportional speed loop toward V_CRUISE. Each tick compute the
          deceleration required to stop exactly D_CLEAR before the obstacle:
              a_req = v^2 / (2 * (range - D_CLEAR)).
          When a_req >= A_TRIGGER, switch to BRAKE.
  BRAKE   drive torque 0; brake_level = clip(a_req / A_FULL, B_MIN, 1). A_FULL is the
          deceleration the designer *assumed* full braking delivers on a nominal
          floor with the nominal payload. If the true floor or load delivers less,
          the loop asks for more until it saturates at 1.0; whether that is enough
          is decided by the physics, not by this file. When v < V_STOP, switch to PARKED.
  PARKED  drive 0, brake_level 1.

Design assumptions (illustrative, documented for the buyer): the loop was tuned for
sensor latency <= 40 ms, actuator latency <= 20 ms, floor friction >= 0.6 and a
20 kg payload. Nothing here checks those assumptions at runtime.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from pathlib import Path

CONTROLLER_ID = "stop-before-obstacle-v1"

V_CRUISE = 2.0        # m/s target cruise speed
KP_DRIVE = 4.0        # N·m per (m/s) of speed error, per driven wheel
T_DRIVE_MAX = 6.0     # N·m per driven wheel
B_MAX = 8.0           # N·m brake torque per wheel at brake_level 1
OMEGA_LIN = 5.0       # rad/s: below this the brake torque is proportional to omega (no sign chatter; keeps the explicit brake model stable at the 2 ms physics step)
A_FULL = 6.0          # m/s^2 assumed deceleration at full brake (4*B_MAX / (r*m) with r=0.1, m=53 kg)
A_TRIGGER = 3.0       # m/s^2 required deceleration at which braking begins (half of A_FULL: a 2x planning margin on braking capacity)
B_MIN = 0.15          # minimum brake level once braking has begun
D_CLEAR = 0.40        # m target clearance between the cart's front face and the obstacle
V_STOP = 0.05         # m/s: below this in BRAKE the controller parks

PHASES = ("CRUISE", "BRAKE", "PARKED")


@dataclass
class Command:
    drive_torque: float  # N·m per rear wheel
    brake_level: float   # 0..1
    phase: str
    a_req: float         # m/s^2 (may be inf)


class Controller:
    def __init__(self) -> None:
        self.phase = "CRUISE"

    def step(self, v_odom: float, range_m: float) -> Command:
        if range_m < 0:
            d_eff = math.inf
        else:
            d_eff = range_m - D_CLEAR
        v = max(v_odom, 0.0)
        if d_eff <= 0.0:
            a_req = math.inf
        elif d_eff == math.inf:
            a_req = 0.0
        else:
            a_req = v * v / (2.0 * d_eff)

        if self.phase == "CRUISE":
            if a_req >= A_TRIGGER:
                self.phase = "BRAKE"
            else:
                drive = KP_DRIVE * (V_CRUISE - v_odom)
                drive = max(-T_DRIVE_MAX, min(T_DRIVE_MAX, drive))
                return Command(drive, 0.0, "CRUISE", a_req)

        if self.phase == "BRAKE":
            if v_odom < V_STOP:
                self.phase = "PARKED"
            else:
                level = 1.0 if a_req == math.inf else a_req / A_FULL
                level = max(B_MIN, min(1.0, level))
                return Command(0.0, level, "BRAKE", a_req)

        return Command(0.0, 1.0, "PARKED", a_req)


def controller_hash() -> str:
    """SHA-256 of this source file: identifies the controller version and all constants."""
    return "sha256:" + hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
