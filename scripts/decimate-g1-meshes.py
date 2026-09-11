"""Decimate the vendored G1 STL meshes for the web viewer (web/public/meshes/g1/).

The simulator loads the verbatim meshes under sim/tailbazaar_sim/g1/assets/; the browser only draws
them, and 24 MB of STL per page load is too much. This script produces smaller copies by VERTEX
CLUSTERING (numpy only, no extra dependency): every vertex is snapped to a cubic grid of `cell` metres,
vertices that land in the same cell are merged at their mean, and triangles that collapse are dropped.
The cell size is chosen per file, the smallest of 2/3/4/6/8 mm that brings the file under the size cap,
so small parts keep their shape and only the big covers get coarsened. Geometry moves by at most half
a cell (<= 4 mm), which is below what the replay can resolve. Run:

    cd sim && uv run python ../scripts/decimate-g1-meshes.py
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "sim" / "tailbazaar_sim" / "g1" / "assets" / "g1_description" / "meshes"
DST = ROOT / "web" / "public" / "meshes" / "g1"
CAP_BYTES = 320_000          # ~6 400 triangles per file at most
CELLS_M = (0.002, 0.003, 0.004, 0.006, 0.008)

_REC = np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])


def read_stl(p: Path) -> np.ndarray:
    raw = p.read_bytes()
    n = struct.unpack("<I", raw[80:84])[0]
    return np.frombuffer(raw[84:84 + 50 * n], dtype=_REC)["v"].astype(np.float64)  # (n, 3, 3)


def write_stl(p: Path, tris: np.ndarray) -> None:
    n = tris.shape[0]
    e1 = tris[:, 1] - tris[:, 0]
    e2 = tris[:, 2] - tris[:, 0]
    nrm = np.cross(e1, e2)
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = np.where(ln > 0, nrm / np.maximum(ln, 1e-30), 0.0)
    out = np.zeros(n, dtype=_REC)
    out["n"] = nrm.astype(np.float32)
    out["v"] = tris.astype(np.float32)
    header = b"tail-bazaar decimated copy (vertex clustering) of a Unitree G1 mesh, BSD-3-Clause".ljust(80, b"\0")
    p.write_bytes(header + struct.pack("<I", n) + out.tobytes())


def cluster(tris: np.ndarray, cell: float) -> np.ndarray:
    v = tris.reshape(-1, 3)
    keys = np.floor(v / cell).astype(np.int64)
    _, inv = np.unique(keys, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    k = int(inv.max()) + 1
    sums = np.zeros((k, 3))
    np.add.at(sums, inv, v)
    counts = np.bincount(inv, minlength=k).astype(np.float64)
    centres = sums / counts[:, None]
    idx = inv.reshape(-1, 3)
    keep = (idx[:, 0] != idx[:, 1]) & (idx[:, 1] != idx[:, 2]) & (idx[:, 0] != idx[:, 2])
    return centres[idx[keep]]


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    total_in = total_out = 0
    rows = []
    for src in sorted(SRC.glob("*.STL")):
        tris = read_stl(src)
        n_in = tris.shape[0]
        chosen = None
        out = tris
        if src.stat().st_size > CAP_BYTES:
            for cell in CELLS_M:
                out = cluster(tris, cell)
                chosen = cell
                if 84 + 50 * out.shape[0] <= CAP_BYTES:
                    break
        write_stl(DST / src.name, out)
        size_in, size_out = src.stat().st_size, (DST / src.name).stat().st_size
        total_in += size_in
        total_out += size_out
        rows.append(f"{src.name:<40} {n_in:>7} -> {out.shape[0]:>6} tris  {size_in / 1e6:6.2f} -> {size_out / 1e6:5.2f} MB  cell={'verbatim' if chosen is None else f'{chosen * 1000:.0f} mm'}")
    for r in rows:
        print(r)
    print(f"TOTAL {total_in / 1e6:.2f} MB -> {total_out / 1e6:.2f} MB")
    (DST / "README.txt").write_text(
        "Decimated copies of the Unitree G1 12-dof link meshes for the Tail Bazaar replay viewer.\n\n"
        "Source: unitreerobotics/unitree_rl_gym @ 276801e46c5d433564f24658bac64f254b7d2d4b,\n"
        "resources/robots/g1_description/meshes/ (the 27 STL files g1_12dof.xml references), BSD-3-Clause,\n"
        "copyright (c) 2016-2023 HangZhou YuShu TECHNOLOGY CO.,LTD. (Unitree Robotics); see LICENSE.txt here.\n\n"
        "These files are NOT the originals: scripts/decimate-g1-meshes.py merged vertices on a 2-8 mm grid\n"
        "(vertex clustering) so the page loads a few MB instead of 24 MB. The simulator never reads them;\n"
        "it loads the verbatim meshes under sim/tailbazaar_sim/g1/assets/. Per-file result of the last run:\n\n"
        + "\n".join(rows) + f"\nTOTAL {total_in / 1e6:.2f} MB -> {total_out / 1e6:.2f} MB\n"
    )


if __name__ == "__main__":
    main()
