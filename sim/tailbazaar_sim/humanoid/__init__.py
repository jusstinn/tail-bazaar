"""Tail Bazaar target #2: a pretrained humanoid balance/locomotion policy.

Parallel to the cart target in `tailbazaar_sim` and deliberately additive: nothing in
this package imports from or mutates the cart's scene, controller or envelope, and the
cart's evidence is untouched. The shared machinery (canonical JSON, commitment hashing)
is reused from `tailbazaar_sim.canonical`.
"""

TARGET_ID = "humanoid-balance-sac-v1"
