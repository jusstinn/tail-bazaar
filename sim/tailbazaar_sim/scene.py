"""MJCF scene builder: floor, static obstacle, cart chassis, rigid load, four wheels.

Geometry (metres) is fixed and part of the target definition; only the friction
coefficient and payload mass vary with the scenario. Frame: x forward (toward the
obstacle), y left, z up. The cart starts at rest at the origin, heading +x.
"""

from __future__ import annotations

PHYSICS_TIMESTEP_S = 0.002  # 500 Hz physics; 10 substeps per 20 ms control tick
INTEGRATOR = "implicitfast"

CHASSIS_HALF = (0.40, 0.25, 0.06)  # 0.80 x 0.50 x 0.12 m box
CHASSIS_MASS_KG = 25.0
CHASSIS_Z0 = 0.12  # chassis centre height so that wheels (r=0.10) touch the floor
LOAD_HALF = (0.25, 0.20, 0.15)  # 0.50 x 0.40 x 0.30 m box, rigidly attached on top
LOAD_LOCAL_Z = CHASSIS_HALF[2] + LOAD_HALF[2]
WHEEL_RADIUS = 0.10
WHEEL_HALF_WIDTH = 0.03
WHEEL_MASS_KG = 2.0
WHEEL_LOCAL = {  # name -> (x, y, z) in chassis frame
    "wheel_fl": (0.30, 0.30, -0.02),
    "wheel_fr": (0.30, -0.30, -0.02),
    "wheel_rl": (-0.30, 0.30, -0.02),
    "wheel_rr": (-0.30, -0.30, -0.02),
}
WHEEL_NAMES = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"]
DRIVEN_WHEELS = ["wheel_rl", "wheel_rr"]
RANGEFINDER_LOCAL = (CHASSIS_HALF[0] + 0.01, 0.0, 0.0)  # 1 cm ahead of the front face

OBSTACLE_FRONT_X = 6.00  # x of the obstacle face the cart approaches
OBSTACLE_HALF = (0.30, 0.80, 0.50)  # 0.60 deep, 1.60 wide, 1.00 tall box (a pallet rack end)

BODY_NAMES = ["chassis", "load"] + WHEEL_NAMES  # bodies whose transforms are recorded
CART_GEOM_NAMES = ["chassis_geom", "load_geom"] + [f"{w}_geom" for w in WHEEL_NAMES]


def build_mjcf(floor_friction: float, payload_kg: float) -> str:
    mu = float(floor_friction)
    fr = f"{mu:.4f} 0.005 0.0001"
    ox = OBSTACLE_FRONT_X + OBSTACLE_HALF[0]
    wheels = []
    for name in WHEEL_NAMES:
        x, y, z = WHEEL_LOCAL[name]
        wheels.append(
            f'<body name="{name}" pos="{x} {y} {z}">'
            f'<joint name="{name}_hinge" type="hinge" axis="0 1 0" damping="0.02"/>'
            f'<geom name="{name}_geom" type="cylinder" size="{WHEEL_RADIUS} {WHEEL_HALF_WIDTH}" '
            f'zaxis="0 1 0" mass="{WHEEL_MASS_KG}" friction="{fr}" rgba="0.15 0.15 0.15 1"/>'
            f"</body>"
        )
    actuators = "".join(
        f'<motor name="{w}_motor" joint="{w}_hinge" gear="1" ctrllimited="true" ctrlrange="-40 40"/>'
        for w in WHEEL_NAMES
    )
    wheel_sensors = "".join(f'<jointvel name="{w}_omega" joint="{w}_hinge"/>' for w in WHEEL_NAMES)
    return f"""<mujoco model="tail-bazaar-cart">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="{PHYSICS_TIMESTEP_S}" gravity="0 0 -9.81" integrator="{INTEGRATOR}"/>
  <default>
    <geom condim="3" friction="{fr}" solref="0.02 1" solimp="0.9 0.95 0.001"/>
  </default>
  <worldbody>
    <light pos="3 0 4" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="20 6 0.1" friction="{fr}" rgba="0.75 0.75 0.75 1"/>
    <geom name="obstacle" type="box" pos="{ox} 0 {OBSTACLE_HALF[2]}" size="{OBSTACLE_HALF[0]} {OBSTACLE_HALF[1]} {OBSTACLE_HALF[2]}" rgba="0.85 0.35 0.2 1"/>
    <body name="chassis" pos="0 0 {CHASSIS_Z0}">
      <freejoint name="root"/>
      <geom name="chassis_geom" type="box" size="{CHASSIS_HALF[0]} {CHASSIS_HALF[1]} {CHASSIS_HALF[2]}" mass="{CHASSIS_MASS_KG}" rgba="0.2 0.4 0.8 1"/>
      <site name="range_site" pos="{RANGEFINDER_LOCAL[0]} {RANGEFINDER_LOCAL[1]} {RANGEFINDER_LOCAL[2]}" zaxis="1 0 0" size="0.01"/>
      <body name="load" pos="0 0 {LOAD_LOCAL_Z}">
        <geom name="load_geom" type="box" size="{LOAD_HALF[0]} {LOAD_HALF[1]} {LOAD_HALF[2]}" mass="{float(payload_kg)}" rgba="0.9 0.75 0.3 1"/>
      </body>
      {''.join(wheels)}
    </body>
  </worldbody>
  <actuator>{actuators}</actuator>
  <sensor>
    <rangefinder name="range" site="range_site"/>
    <framelinvel name="chassis_linvel" objtype="body" objname="chassis"/>
    {wheel_sensors}
  </sensor>
</mujoco>"""
