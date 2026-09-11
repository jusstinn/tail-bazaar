Decimated copies of the Unitree G1 12-dof link meshes for the Tail Bazaar replay viewer.

Source: unitreerobotics/unitree_rl_gym @ 276801e46c5d433564f24658bac64f254b7d2d4b,
resources/robots/g1_description/meshes/ (the 27 STL files g1_12dof.xml references), BSD-3-Clause,
copyright (c) 2016-2023 HangZhou YuShu TECHNOLOGY CO.,LTD. (Unitree Robotics); see LICENSE.txt here.

These files are NOT the originals: scripts/decimate-g1-meshes.py merged vertices on a 2-8 mm grid
(vertex clustering) so the page loads a few MB instead of 24 MB. The simulator never reads them;
it loads the verbatim meshes under sim/tailbazaar_sim/g1/assets/. Per-file result of the last run:

head_link.STL                              18654 ->   4496 tris    0.93 ->  0.22 MB  cell=6 mm
left_ankle_pitch_link.STL                   1422 ->   1422 tris    0.07 ->  0.07 MB  cell=verbatim
left_ankle_roll_link.STL                   13066 ->   5238 tris    0.65 ->  0.26 MB  cell=3 mm
left_elbow_link.STL                         1774 ->   1774 tris    0.09 ->  0.09 MB  cell=verbatim
left_hip_pitch_link.STL                     3632 ->   3632 tris    0.18 ->  0.18 MB  cell=verbatim
left_hip_roll_link.STL                      3842 ->   3842 tris    0.19 ->  0.19 MB  cell=verbatim
left_hip_yaw_link.STL                       5924 ->   5924 tris    0.30 ->  0.30 MB  cell=verbatim
left_knee_link.STL                         17096 ->   6328 tris    0.85 ->  0.32 MB  cell=4 mm
left_shoulder_pitch_link.STL                3534 ->   3534 tris    0.18 ->  0.18 MB  cell=verbatim
left_shoulder_roll_link.STL                 8004 ->   5254 tris    0.40 ->  0.26 MB  cell=2 mm
left_shoulder_yaw_link.STL                  4982 ->   4982 tris    0.25 ->  0.25 MB  cell=verbatim
left_wrist_roll_rubber_hand.STL            69696 ->   4798 tris    3.48 ->  0.24 MB  cell=4 mm
logo_link.STL                               4866 ->   4866 tris    0.24 ->  0.24 MB  cell=verbatim
pelvis.STL                                 21216 ->   6343 tris    1.06 ->  0.32 MB  cell=2 mm
pelvis_contour_link.STL                    36102 ->   4240 tris    1.81 ->  0.21 MB  cell=6 mm
right_ankle_pitch_link.STL                  1422 ->   1422 tris    0.07 ->  0.07 MB  cell=verbatim
right_ankle_roll_link.STL                  13074 ->   5212 tris    0.65 ->  0.26 MB  cell=3 mm
right_elbow_link.STL                        1774 ->   1774 tris    0.09 ->  0.09 MB  cell=verbatim
right_hip_pitch_link.STL                    3624 ->   3624 tris    0.18 ->  0.18 MB  cell=verbatim
right_hip_roll_link.STL                     3852 ->   3852 tris    0.19 ->  0.19 MB  cell=verbatim
right_hip_yaw_link.STL                      5924 ->   5924 tris    0.30 ->  0.30 MB  cell=verbatim
right_knee_link.STL                        17044 ->   6314 tris    0.85 ->  0.32 MB  cell=4 mm
right_shoulder_pitch_link.STL               3534 ->   3534 tris    0.18 ->  0.18 MB  cell=verbatim
right_shoulder_roll_link.STL                8036 ->   5246 tris    0.40 ->  0.26 MB  cell=2 mm
right_shoulder_yaw_link.STL                 4998 ->   4998 tris    0.25 ->  0.25 MB  cell=verbatim
right_wrist_roll_rubber_hand.STL           69630 ->   4806 tris    3.48 ->  0.24 MB  cell=4 mm
torso_link_23dof_rev_1_0.STL              156507 ->  13203 tris    7.83 ->  0.66 MB  cell=8 mm
TOTAL 25.16 MB -> 6.33 MB
