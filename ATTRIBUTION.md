# Third-party software and attribution

Tail Bazaar's own code is MIT licensed (see LICENSE). It depends on:

| Component | Use | License |
|---|---|---|
| [MuJoCo](https://github.com/google-deepmind/mujoco) 3.13 (Python bindings) | rigid-body simulation of the cart, wheels, load and obstacle | Apache-2.0 |
| [NumPy](https://numpy.org) | numerics in the simulator and hunter | BSD-3-Clause |
| [matplotlib](https://matplotlib.org) + [Pillow](https://python-pillow.org) | optional offline GIF/PNG renderings from recorded transforms | matplotlib license (BSD-style) / MIT-CMU |
| [pycryptodome](https://www.pycryptodome.org) | keccak-256 in Python (commitment hashing) | BSD-2-Clause / public domain |
| [uv](https://github.com/astral-sh/uv) | pinned Python environment (`sim/uv.lock`) | MIT / Apache-2.0 |
| [Three.js](https://threejs.org) 0.180 | browser replay of recorded transforms (no physics) | MIT |
| [viem](https://viem.sh) | chain access, EIP-191 signing and recovery | MIT |
| [Hono](https://hono.dev) + @hono/node-server | HTTP server | MIT |
| [dotenv](https://github.com/motdotla/dotenv) | `.env` loading | BSD-2-Clause |
| [esbuild](https://esbuild.github.io) / [TypeScript](https://www.typescriptlang.org) | build tooling | MIT / Apache-2.0 |
| [Foundry](https://github.com/foundry-rs/foundry) (forge, cast, anvil) | contract compilation, tests, local chain, deployment | MIT / Apache-2.0 |
| Node.js `node:sqlite` | durable local storage | MIT (Node.js) / public domain (SQLite) |

The contract tests declare a minimal `Vm` cheatcode interface compatible with Foundry's cheatcode
address rather than vendoring forge-std.

The assignment brief ("The Black Box Bazaar", Blockchain at Berkeley) is the source of the task
statement; Loop is the author's own robotics-insurance idea. No benchmark code or third-party data
sets are included.
