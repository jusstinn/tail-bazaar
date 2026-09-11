"""Tail Bazaar target #4: the Unitree G1 humanoid walking under Unitree's own pretrained policy.

Parallel to the cart, humanoid and arm targets and deliberately additive: nothing in this
package imports from or mutates another target's scene, controller or envelope. The shared
machinery (canonical JSON, commitment hashing) is reused from `tailbazaar_sim.canonical`.

Unlike the Gymnasium humanoid (target #2) this environment has no health flag of its own, so
the failure predicate here is THIS PROJECT'S and is documented as such in `simulate.py`.
"""

TARGET_ID = "unitree-g1-walk-v1"
