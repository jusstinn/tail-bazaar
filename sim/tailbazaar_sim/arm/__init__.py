"""Tail Bazaar target #3: a pretrained manipulator pick-and-place policy that can be made
to DROP the object it is carrying.

Parallel to the cart target in `tailbazaar_sim` and to the humanoid target in
`tailbazaar_sim.humanoid`, and deliberately additive: nothing in this package imports from
or mutates the cart's scene, controller or envelope, nothing here changes the humanoid
package, and both of their evidence directories are untouched.

Two things are reused rather than reimplemented:
  * `tailbazaar_sim.canonical` — canonical JSON and commitment hashing, as the humanoid does;
  * `tailbazaar_sim.humanoid.policy.read_torch_state_dict` — the RESTRICTED unpickler that
    reads a Stable-Baselines3 `.pth` without importing torch. Copying a security-sensitive
    unpickler into a second module so two near-identical versions can drift apart would be
    worse than importing the one that already exists. It is imported read-only; nothing in
    the humanoid package is modified.
"""

TARGET_ID = "arm-pick-place-sac-v1"
