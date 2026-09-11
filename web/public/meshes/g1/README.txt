Decimated copies of the Unitree G1 12-dof link meshes for the Tail Bazaar replay viewer.

Source: unitreerobotics/unitree_rl_gym @ 276801e46c5d433564f24658bac64f254b7d2d4b,
resources/robots/g1_description/meshes/ (the 27 STL files g1_12dof.xml references), BSD-3-Clause,
copyright (c) 2016-2023 HangZhou YuShu TECHNOLOGY CO.,LTD. (Unitree Robotics); see LICENSE.txt here.

These files ARE the originals, byte for byte: the same 27 STLs the simulator loads from
sim/tailbazaar_sim/g1/assets/ (24 MB in total). An earlier decimated copy (vertex clustering on a 2-8 mm
grid, 6 MB) was replaced because it no longer looked like the robot; scripts/decimate-g1-meshes.py is kept
for reference and is not used by the build.
