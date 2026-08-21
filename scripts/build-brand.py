#!/usr/bin/env python3
"""
CY brand asset builder.

Traces the real CY brand mark (raster) into a themeable monochrome SVG and
renders the PNG icon set used by the extension. No external tracer required:
marching squares + Ramer-Douglas-Peucker on the alpha/luminance mask.

Usage:  python3 scripts/build-brand.py
"""
import os
import subprocess
import sys

import numpy as np
from PIL import Image

BRAND = "/Users/imac/Data/CY-Brand"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources")
OUT = os.path.abspath(OUT)
SRC = os.path.join(BRAND, "cy-logo-w.png")   # white mark on transparent
DARK_BG = "#07090c"


# ---------------------------------------------------------------- mask ------
def load_mask(path):
    im = Image.open(path).convert("RGBA")
    a = np.array(im).astype(np.float64)
    alpha = a[..., 3]
    lum = a[..., :3].mean(axis=2)
    # the visible light-coloured ink of the mark
    return ((alpha > 100) & (lum > 110)).astype(np.float64)


# ------------------------------------------------- marching squares ---------
def marching_squares(mask, level=0.5):
    """Return closed contours as lists of (x, y) in pixel coordinates."""
    m = np.pad(mask, 1, mode="constant", constant_values=0.0)
    h, w = m.shape
    segs = []

    def interp(p1, v1, p2, v2):
        if v1 == v2:
            t = 0.5
        else:
            t = (level - v1) / (v2 - v1)
        t = min(1.0, max(0.0, t))
        return (p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t)

    for i in range(h - 1):
        for j in range(w - 1):
            tl, tr = m[i, j], m[i, j + 1]
            br, bl = m[i + 1, j + 1], m[i + 1, j]
            idx = (tl > level) * 1 + (tr > level) * 2 + (br > level) * 4 + (bl > level) * 8
            if idx in (0, 15):
                continue
            P_TL, P_TR = (j, i), (j + 1, i)
            P_BR, P_BL = (j + 1, i + 1), (j, i + 1)
            top = interp(P_TL, tl, P_TR, tr)
            right = interp(P_TR, tr, P_BR, br)
            bottom = interp(P_BL, bl, P_BR, br)
            left = interp(P_TL, tl, P_BL, bl)
            table = {
                1: [(left, top)], 2: [(top, right)], 3: [(left, right)],
                4: [(right, bottom)], 5: [(left, top), (right, bottom)],
                6: [(top, bottom)], 7: [(left, bottom)], 8: [(bottom, left)],
                9: [(bottom, top)], 10: [(top, right), (bottom, left)],
                11: [(bottom, right)], 12: [(right, left)],
                13: [(right, top)], 14: [(top, left)],
            }
            segs.extend(table[idx])

    # stitch segments into closed loops
    from collections import defaultdict

    def key(p):
        return (round(p[0], 4), round(p[1], 4))

    adj = defaultdict(list)
    for a_, b_ in segs:
        adj[key(a_)].append(key(b_))

    contours = []
    used = set()
    for start in list(adj.keys()):
        if start in used or not adj[start]:
            continue
        loop = [start]
        used.add(start)
        cur = start
        while True:
            nxts = [n for n in adj.get(cur, []) if n not in used]
            if not nxts:
                if adj.get(cur) and key(start) in adj[cur]:
                    loop.append(start)
                break
            nxt = nxts[0]
            loop.append(nxt)
            used.add(nxt)
            cur = nxt
        if len(loop) > 8:
            contours.append([(p[0] - 1, p[1] - 1) for p in loop])  # undo pad
    return contours


# ----------------------------------------------------------- simplify -------
def rdp(points, eps):
    if len(points) < 3:
        return points
    start, end = np.array(points[0]), np.array(points[-1])
    line = end - start
    norm = np.hypot(*line)
    if norm == 0:
        dists = [np.hypot(*(np.array(p) - start)) for p in points]
    else:
        dists = [abs(line[0] * (p[1] - start[1]) - line[1] * (p[0] - start[0])) / norm for p in points]
    i = int(np.argmax(dists))
    if dists[i] > eps:
        left = rdp(points[: i + 1], eps)
        right = rdp(points[i:], eps)
        return left[:-1] + right
    return [points[0], points[-1]]


def to_path(contours, eps=0.6, scale=1.0):
    parts = []
    for c in contours:
        if len(c) < 4:
            continue
        simple = rdp(c, eps)
        if len(simple) < 4:
            continue
        pts = [(round(x * scale, 2), round(y * scale, 2)) for x, y in simple]
        d = "M" + " L".join(f"{x} {y}" for x, y in pts) + " Z"
        parts.append(d)
    return " ".join(parts)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="CY">
  <path fill="{fill}" fill-rule="evenodd" d="{d}"/>
</svg>
"""


def main():
    if not os.path.isfile(SRC):
        sys.exit(f"brand source missing: {SRC}")
    os.makedirs(OUT, exist_ok=True)

    mask = load_mask(SRC)
    size = mask.shape[0]
    contours = marching_squares(mask)
    d = to_path(contours, eps=0.6)
    if not d:
        sys.exit("tracing produced no geometry")

    written = []
    for name, fill in (("cy-mark-light.svg", "#ffffff"), ("cy-mark-dark.svg", "#07090c")):
        p = os.path.join(OUT, name)
        with open(p, "w") as f:
            f.write(SVG.format(size=size, fill=fill, d=d))
        written.append((name, os.path.getsize(p)))

    # copy the raw brand rasters through untouched
    for src_name in ("cy-logo.png", "cy-logo-w.png", "cy-logo-b.png", "cy-logo-i.png", "cy-logo-bi.png"):
        s = os.path.join(BRAND, src_name)
        if os.path.isfile(s):
            with open(s, "rb") as a, open(os.path.join(OUT, src_name), "wb") as b:
                b.write(a.read())

    # marketplace icon: white mark centred on the dark brand square, 512px
    icon = os.path.join(OUT, "cy-logo.png")
    try:
        subprocess.run(
            ["magick", "-size", "512x512", f"xc:{DARK_BG}",
             "(", SRC, "-resize", "372x372", ")",
             "-gravity", "center", "-composite",
             "-strip", icon],
            check=True, capture_output=True,
        )
        written.append(("cy-logo.png (512 dark)", os.path.getsize(icon)))
    except Exception as e:  # pragma: no cover
        print("icon composite skipped:", e)

    print(f"traced {len(contours)} contour(s), path length {len(d)} chars")
    for n, s in written:
        print(f"  {n}: {s} bytes")


if __name__ == "__main__":
    main()
