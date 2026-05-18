#!/usr/bin/env python3
"""Generate macOS/Windows tray PNG assets at base + @2x; macOS template images so drawn in solid black with alpha."""

import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "electron", "assets")
os.makedirs(OUT_DIR, exist_ok=True)


def draw_idle(d: ImageDraw.ImageDraw, size: int) -> None:
    cx, cy = size // 2, size // 2
    r = size * 5 // 16
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(0, 0, 0, 255))


def draw_running(d: ImageDraw.ImageDraw, size: int) -> None:
    cx, cy = size // 2, size // 2
    r = size * 7 // 16
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(0, 0, 0, 255), width=max(1, size // 14))
    inner = size * 3 // 16
    d.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=(0, 0, 0, 255))


def draw_paused(d: ImageDraw.ImageDraw, size: int) -> None:
    w = size * 3 // 16
    h = size * 9 // 16
    gap = size * 2 // 16
    left_x = size // 2 - gap // 2 - w
    right_x = size // 2 + gap // 2
    top = (size - h) // 2
    d.rectangle((left_x, top, left_x + w, top + h), fill=(0, 0, 0, 255))
    d.rectangle((right_x, top, right_x + w, top + h), fill=(0, 0, 0, 255))


DRAWERS = {"idle": draw_idle, "running": draw_running, "paused": draw_paused}


def render(state: str, size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    DRAWERS[state](ImageDraw.Draw(img), size)
    return img


for state in DRAWERS:
    img1x = render(state, 16)
    img2x = render(state, 32)
    img1x.save(os.path.join(OUT_DIR, f"tray-{state}.png"), "PNG")
    img2x.save(os.path.join(OUT_DIR, f"tray-{state}@2x.png"), "PNG")
    # Windows .ico (multi-resolution baked-in for crisp HiDPI). PIL
    # supports saving an ICO with multiple sizes embedded; Windows
    # picks the closest match for the tray's current DPI scale.
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)]
    img_for_ico = render(state, 256)
    img_for_ico.save(
        os.path.join(OUT_DIR, f"tray-{state}.ico"),
        format="ICO",
        sizes=ico_sizes,
    )
    print(f"wrote tray-{state}.png + @2x + .ico ({len(ico_sizes)} sizes)")
