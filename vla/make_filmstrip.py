"""Build the success-vs-failure filmstrip for evidence/vla/.

Two rows of frames sampled from two recorded episodes of the SAME seed: the top
row is the nominal run the policy completes, the bottom row is the run with one
envelope axis moved. Run on the GPU host, where imageio-ffmpeg is installed.

    python make_filmstrip.py out/nominal_seed1.mp4 out/failure_seed1_noise05.mp4 \
        out/success_vs_failure.png
"""

from __future__ import annotations

import sys

import imageio.v2 as imageio
import numpy as np

N = 5  # frames per row
PAD = 6
LABEL_H = 22


def _digit_glyphs():
    # 5x7 bitmap font, enough for the short ASCII labels we draw.
    raw = {
        "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
        "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
        "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
        "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
        "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
        "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
        "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
        "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
        "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
        "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
        "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
        "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
        "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
        "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
        "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
        "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
        "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
        "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
        "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
        "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
        "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
        "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
        ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
        "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
        " ": ["00000"] * 7,
        "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
        "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
        ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
    }
    return {k: np.array([[int(c) for c in row] for row in v], dtype=np.uint8) for k, v in raw.items()}


GLYPHS = _digit_glyphs()


def draw_text(canvas: np.ndarray, text: str, x: int, y: int, color=(255, 255, 255), scale=2):
    for ch in text.upper():
        g = GLYPHS.get(ch)
        if g is None:
            x += 6 * scale
            continue
        h, w = g.shape
        for r in range(h):
            for c in range(w):
                if g[r, c]:
                    canvas[y + r * scale : y + (r + 1) * scale, x + c * scale : x + (c + 1) * scale] = color
        x += (w + 1) * scale
    return x


def sample(path: str, n: int = N) -> list[np.ndarray]:
    frames = list(imageio.mimread(path, memtest=False))
    idx = np.linspace(0, len(frames) - 1, n).astype(int)
    return [frames[i] for i in idx]


def main() -> int:
    top_path, bot_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    top = sample(top_path)
    bot = sample(bot_path)

    h, w = top[0].shape[:2]
    scale = 0.5
    th, tw = int(h * scale), int(w * scale)

    def shrink(f):
        return np.array(f[:: int(1 / scale), :: int(1 / scale)][:th, :tw])

    top = [shrink(f) for f in top]
    bot = [shrink(f) for f in bot]

    row_w = N * tw + (N + 1) * PAD
    total_h = 2 * (th + LABEL_H) + 3 * PAD
    canvas = np.full((total_h, row_w, 3), 18, dtype=np.uint8)

    y = PAD
    draw_text(canvas, "SUCCESS  NOMINAL  SEED 1  REWARD 4/4", PAD, y + 3, (120, 230, 140), 2)
    y += LABEL_H
    for i, f in enumerate(top):
        x = PAD + i * (tw + PAD)
        canvas[y : y + th, x : x + tw] = f
    y += th + PAD

    draw_text(canvas, "FAILURE  ACTION NOISE 0.05  SEED 1  REWARD 0/4", PAD, y + 3, (240, 120, 120), 2)
    y += LABEL_H
    for i, f in enumerate(bot):
        x = PAD + i * (tw + PAD)
        canvas[y : y + th, x : x + tw] = f

    imageio.imwrite(out_path, canvas)
    print("wrote", out_path, canvas.shape)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
