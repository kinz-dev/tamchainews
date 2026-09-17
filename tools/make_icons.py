#!/usr/bin/env python3
"""Rasterise the app icon into the PNG sizes the browsers and iOS want.

web/icon.svg is the master; this redraws the same geometry with Pillow because
no SVG rasteriser is guaranteed on the machine. Keep the two in step — the
coordinates below are the numbers in the SVG, on the same 512 canvas.

    python3 tools/make_icons.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

WEB = Path(__file__).resolve().parent.parent / "web"

CANVAS = 512
SCALE = 4                       # draw large, downsample: Pillow has no antialiased draw
BG = "#11151c"
FG = "#ffb454"

CENTRE = (256, 300)
WAVES = [(78, 26), (132, 26)]   # (radius, stroke width)
WAVE_FROM, WAVE_TO = 215, 325   # degrees, 0 = east, clockwise; 270 = straight up
RIM = (96, 286, 416, 314)       # x0, y0, x1, y1
RIM_RADIUS = 14
BOWL = (120, 314 - 128, 392, 314 + 128)   # bounding box of the bowl's ellipse


def draw_icon(size: int, rounded: bool, simplify: bool = False) -> Image.Image:
    """One icon at `size` px.

    `rounded` clips the corners; iOS prefers full-bleed. `simplify` drops the
    inner wave, which at favicon sizes closes up into a blob rather than
    reading as a second arc.
    """
    big = size * SCALE
    k = big / CANVAS                      # canvas units -> pixels
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = 112 * k if rounded else 0
    draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=radius, fill=BG)

    cx, cy = CENTRE[0] * k, CENTRE[1] * k
    # One wave, thickened: a 26-unit stroke is under 1px once the ico is 16px.
    waves = [(WAVES[-1][0], 36)] if simplify else WAVES
    for radius_units, width_units in waves:
        r, w = radius_units * k, width_units * k
        # Pillow strokes an arc inward from the bounding box, SVG centres the
        # stroke on the path; push the box out by half a width so they agree.
        outer = r + w / 2
        draw.arc((cx - outer, cy - outer, cx + outer, cy + outer),
                 WAVE_FROM, WAVE_TO, fill=FG, width=round(w))
        # ...and Pillow's ends are square, so round them off the way the SVG does.
        for angle in (WAVE_FROM, WAVE_TO):
            px = cx + r * math.cos(math.radians(angle))
            py = cy + r * math.sin(math.radians(angle))
            draw.ellipse((px - w / 2, py - w / 2, px + w / 2, py + w / 2), fill=FG)

    draw.rounded_rectangle(
        tuple(v * k for v in RIM), radius=RIM_RADIUS * k, fill=FG,
    )
    # chord(0, 180) fills the lower half of the ellipse: the bowl.
    draw.chord(tuple(v * k for v in BOWL), 0, 180, fill=FG)

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    written = []

    for size, name, rounded in [
        (512, "icon-512.png", True),
        (192, "icon-192.png", True),
        (180, "apple-touch-icon.png", False),   # iOS masks it itself and dislikes alpha
    ]:
        image = draw_icon(size, rounded)
        if name == "apple-touch-icon.png":
            flat = Image.new("RGB", image.size, BG)
            flat.paste(image, mask=image.split()[3])
            image = flat
        path = WEB / name
        image.save(path)
        written.append(path)

    # favicon.ico for the browsers and bookmark bars that still ask for one.
    # Only ever shown small, so it gets the simplified mark at every size.
    ico = WEB / "favicon.ico"
    draw_icon(64, True, simplify=True).save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    written.append(ico)

    for path in written:
        print(f"{path.relative_to(WEB.parent)}  {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
