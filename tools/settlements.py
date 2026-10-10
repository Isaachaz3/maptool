"""Поиск значков поселений на карте сопоставлением с шаблонами.

Использование:  python3 tools/settlements.py assets/faerun-full.jpg data/settlements.json
Типы: city — кольцо с точкой, castle — чёрный квадрат, town — чёрная точка.
Значок принимается, только если рядом есть подпись, он не внутри слова и не на краю провала
(иначе находятся буквы «O», развилки дорог и точки вдоль границы Подземья).
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from labels import text_mask  # noqa: E402


def disk(size, r, val=0, bg=255):
    t = np.full((size, size), bg, np.float32)
    c = (size - 1) / 2
    yy, xx = np.mgrid[:size, :size]
    t[(xx - c) ** 2 + (yy - c) ** 2 <= r * r] = val
    return t


def ring(size, ro, ri, rd):
    t = np.full((size, size), 255, np.float32)
    c = (size - 1) / 2
    yy, xx = np.mgrid[:size, :size]
    d2 = (xx - c) ** 2 + (yy - c) ** 2
    t[(d2 <= ro * ro) & (d2 >= ri * ri)] = 0
    t[d2 <= rd * rd] = 0
    return t


def square(size, s):
    t = np.full((size, size), 255, np.float32)
    a = (size - s) // 2
    t[a:a + s, a:a + s] = 0
    return t


TEMPLATES = [
    ('city', ring(17, 6.4, 4.3, 2.6), 0.62),
    ('city', ring(15, 5.6, 3.7, 2.2), 0.62),
]
PRIORITY = {'city': 0, 'castle': 1, 'town': 2}


def main(src, out):
    gray = cv2.imread(src, cv2.IMREAD_GRAYSCALE).astype(np.float32)
    found = []
    for kind, tpl, thr in TEMPLATES:
        res = cv2.matchTemplate(gray, tpl, cv2.TM_CCOEFF_NORMED)
        peaks = (res >= thr) & (res == cv2.dilate(res, np.ones((9, 9), np.uint8)))
        ys, xs = np.nonzero(peaks)
        h = tpl.shape[0] // 2
        for x, y in zip(xs, ys):
            cx, cy = x + h, y + h
            # центр значка должен быть действительно тёмным (отсекает буквы вроде «O»)
            if gray[cy - 1:cy + 2, cx - 1:cx + 2].mean() > 90:
                continue
            found.append((PRIORITY[kind], -float(res[y, x]), kind, int(cx), int(cy)))
        print(kind, tpl.shape, len(xs), flush=True)
    # точки и квадраты: размыкание тёмной маски убирает линии, пунктир и буквы толщиной < 5 px
    dark = (gray < 90).astype(np.uint8)
    blobs = cv2.morphologyEx(dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n, lab, st, cent = cv2.connectedComponentsWithStats(blobs, connectivity=8)
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if not (4 <= w <= 13 and 4 <= h <= 13 and abs(int(w) - int(h)) <= 3 and 14 <= a <= 150):
            continue
        fill = a / (w * h)
        if fill < 0.55:
            continue
        kind = 'castle' if fill > 0.86 and w >= 7 else 'town'
        found.append((PRIORITY[kind], -fill, kind, int(round(cent[i][0])), int(round(cent[i][1]))))
    print('blobs', n, flush=True)
    # подписи рядом и не внутри слова
    img = cv2.imread(src, cv2.IMREAD_COLOR)[:, :, ::-1].copy()
    _, words = text_mask(img)
    words = words.astype(np.uint8)
    near = cv2.dilate(words, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61)))
    # провалы из разметки местности (data/t2.png, зелёный канал, 1/4 разрешения)
    t2 = cv2.imread(os.path.join(os.path.dirname(out), 't2.png'))
    chasm = None
    if t2 is not None:
        g = t2[:, :, 1].astype(np.float32)  # BGR → зелёный
        chasm = cv2.resize(g, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_LINEAR)
    kept = []
    for f in found:
        _, _, kind, x, y = f
        if not near[y, x]:
            continue
        # «внутри слова» — если текст окружает значок с большинства сторон (у настоящего значка подпись сбоку)
        hits = 0
        for k in range(8):
            a = k * np.pi / 4
            for rr in (8, 12):
                xx, yy = int(x + rr * np.cos(a)), int(y + rr * np.sin(a))
                if 0 <= yy < words.shape[0] and 0 <= xx < words.shape[1] and words[yy, xx]:
                    hits += 1
                    break
        if hits >= 5:
            continue
        # SDF провала: 0.5 = граница, ±24 px → 1 px ≈ 0.0104; отсекаем ближе 20 px к провалу
        if chasm is not None and chasm[y, x] > 255 * (0.5 - 20 / 48):
            continue
        kept.append(f)
    print('после фильтра', len(kept), 'из', len(found), flush=True)
    found = kept
    found.sort()
    pts = []
    taken = np.zeros((gray.shape[0] // 8 + 2, gray.shape[1] // 8 + 2), bool)
    for _, score, kind, x, y in found:
        gx, gy = x // 8, y // 8
        if taken[gy - 1:gy + 2, gx - 1:gx + 2].any():
            continue
        taken[gy, gx] = True
        pts.append({'x': x, 'y': y, 'type': kind})
    print('total', len(pts), {k: sum(p['type'] == k for p in pts) for k in PRIORITY})
    with open(out, 'w') as f:
        json.dump(pts, f, separators=(',', ':'))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
