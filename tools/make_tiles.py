"""Режет большую карту на пирамиду тайлов для веб-просмотрщика.

Использование:  python3 tools/make_tiles.py assets/faerun-full.jpg tiles
Уровень 0 — исходное разрешение, каждый следующий уменьшен вдвое,
пока карта не влезет в один тайл.
"""
import json
import math
import os
import shutil
import sys

from PIL import Image

Image.MAX_IMAGE_PIXELS = None
TILE = 512
QUALITY = 84


def main(src, out):
    img = Image.open(src).convert("RGB")
    w, h = img.size
    if os.path.isdir(out):
        shutil.rmtree(out)
    levels = 0
    level_img = img
    while True:
        lw, lh = level_img.size
        cols, rows = math.ceil(lw / TILE), math.ceil(lh / TILE)
        d = os.path.join(out, str(levels))
        os.makedirs(d)
        for r in range(rows):
            for c in range(cols):
                box = (c * TILE, r * TILE, min(lw, (c + 1) * TILE), min(lh, (r + 1) * TILE))
                level_img.crop(box).save(
                    os.path.join(d, f"{c}_{r}.jpg"), quality=QUALITY, optimize=True, progressive=True
                )
        print(f"level {levels}: {lw}x{lh}, {cols}x{rows} tiles")
        levels += 1
        if cols == 1 and rows == 1:
            break
        level_img = level_img.resize((max(1, lw // 2), max(1, lh // 2)), Image.LANCZOS)
    with open(os.path.join(out, "info.json"), "w") as f:
        json.dump({"width": w, "height": h, "tileSize": TILE, "levels": levels}, f)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
