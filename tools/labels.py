"""Вытаскивает надписи с карты в отдельный слой (маска букв) и режет его на тайлы.

Использование:  python3 tools/labels.py assets/faerun-full.jpg labels
Выход: labels/{level}/{c}_{r}.png — тайлы яркости (белое = буква), labels/info.json — список непустых тайлов.
Функция text_mask() используется и при поиске поселений.
"""
import json
import math
import os
import shutil
import sys

import cv2
import numpy as np

TILE = 512


def road_mask(gray):
    """Длинные тонкие чёрные линии — дороги и границы, не текст."""
    black = (gray < 70).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(black, connectivity=8)
    w, h, a = st[:, 2], st[:, 3], st[:, 4]
    span = np.maximum(w, h)
    fill = a / np.maximum(1, w * h)
    ids = np.where((span >= 45) & (fill < 0.25))[0]
    ids = ids[ids > 0]
    return np.isin(lab, ids)


def text_mask(img, debug=False, with_words=False, loose=False):
    """img — RGB uint8. Возвращает (alpha 0..255, маска групп-слов[, список слов с геометрией])."""
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    # тонкие тёмные штрихи на светлом фоне (black-hat по яркости: голубые реки слишком светлые и не попадают)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    bh = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, k)
    # текст — почти чёрный или насыщенный цвет; штриховка гор и лесов серо-коричневая и светлее
    mx, mn = img.max(2).astype(np.int16), img.min(2).astype(np.int16)
    inky = (gray < 95) | ((mx - mn > 70) & (gray < 170))
    strokes = ((bh > 45) & inky).astype(np.uint8)
    strokes[cv2.dilate(road_mask(gray).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0] = 0
    # значки поселений (сплошные точки и квадраты) — не текст
    blobs = cv2.morphologyEx((gray < 90).astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(blobs, connectivity=8)
    small = np.where((st[:, 4] < 160) & (np.maximum(st[:, 2], st[:, 3]) <= 14))[0]
    small = small[small > 0]
    strokes[cv2.dilate(np.isin(lab, small).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0] = 0
    # пунктир и одиночные линии: после замыкания слова становятся толстыми пятнами,
    # а линии остаются тонкими — размыкание оставляет только «толстое», остальное выкидываем
    closed = cv2.morphologyEx(strokes, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    fat = cv2.morphologyEx(closed, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (6, 6)))
    keepfat = cv2.dilate(fat, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))) > 0
    # крупные буквы с широкой разрядкой не склеиваются — оставляем штрихи «буквенной» формы
    n, lab, st, _ = cv2.connectedComponentsWithStats(strokes, connectivity=8)
    span = np.maximum(st[:, 2], st[:, 3])
    big = np.zeros(n, bool)
    for i in np.where((span >= 14) & (span <= 60) & (st[:, 4] >= 40))[0]:
        if i == 0:
            continue
        x, y, w, h, a = st[i]
        (_, _), (rw, rh), _ = cv2.minAreaRect(cv2.findNonZero((lab[y:y + h, x:x + w] == i).astype(np.uint8)))
        if min(rw, rh) >= 5.5:
            big[i] = True
    if not loose:  # в мягком режиме (для газеттира) тонкий курсив не выбрасываем
        strokes[~(keepfat | big[lab])] = 0
    del closed, fat, lab, keepfat
    # буквы → слова: склеиваем только близкие штрихи (зазор между буквами 1–3 px, у пунктира больше)
    words = cv2.dilate(strokes, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(words, connectivity=8)
    keep = np.zeros(n, bool)
    found = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < 60 or w > 1500 or h > 1500:
            continue
        sub = (lab[y:y + h, x:x + w] == i).astype(np.uint8)
        pts = cv2.findNonZero(sub)
        (rcx, rcy), (rw, rh), rang = cv2.minAreaRect(pts)
        t, l = min(rw, rh), max(rw, rh)
        if t < (7 if loose else 9.5) or t > 70 or l < 10:
            continue
        ink = strokes[y:y + h, x:x + w][sub > 0].mean()
        if not ((0.07 if loose else 0.1) <= ink <= 0.7):
            continue
        # слова плотно заполняют свой повёрнутый прямоугольник, клочья штриховки — нет
        if a / max(1.0, rw * rh) < (0.3 if loose else 0.35):
            continue
        keep[i] = True
        if with_words:
            # угол вдоль длинной стороны, приведённый к (-90, 90]: так читается текст
            ang = rang if rw >= rh else rang + 90
            while ang > 90:
                ang -= 180
            while ang <= -90:
                ang += 180
            found.append({'cx': float(x + rcx), 'cy': float(y + rcy), 'len': float(l), 'h': float(t),
                          'angle': float(ang), 'bbox': [int(x), int(y), int(w), int(h)]})
    groups = keep[lab]
    # мягкая альфа: насколько пиксель темнее локального фона
    bg = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, k).astype(np.float32)
    dark = np.clip((bh.astype(np.float32) - 20) / 90.0, 0, 1)
    alpha = (dark * cv2.dilate(groups.astype(np.uint8), np.ones((3, 3), np.uint8))).astype(np.float32)
    if with_words:
        return (alpha * 255).astype(np.uint8), groups, found
    return (alpha * 255).astype(np.uint8), groups


def main(src, out):
    img = cv2.imread(src, cv2.IMREAD_COLOR)[:, :, ::-1].copy()
    alpha, _ = text_mask(img)
    cv2.imwrite(os.path.join('/tmp', 'labels_full.png'), alpha) if os.environ.get('LABELS_DEBUG') else None
    if os.path.isdir(out):
        shutil.rmtree(out)
    H, W = alpha.shape
    tiles = {}
    level, a = 0, alpha
    while level < 3:
        lh, lw = a.shape
        cols, rows = math.ceil(lw / TILE), math.ceil(lh / TILE)
        os.makedirs(os.path.join(out, str(level)))
        have = []
        for r in range(rows):
            for c in range(cols):
                t = a[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE]
                if t.max() < 40:
                    continue
                cv2.imwrite(os.path.join(out, str(level), f'{c}_{r}.png'), t, [cv2.IMWRITE_PNG_COMPRESSION, 9])
                have.append(f'{c}_{r}')
        tiles[level] = have
        print('level', level, lw, lh, len(have), 'tiles', flush=True)
        level += 1
        a = cv2.resize(a, (lw // 2, lh // 2), interpolation=cv2.INTER_AREA)
    with open(os.path.join(out, 'info.json'), 'w') as f:
        json.dump({'width': W, 'height': H, 'tileSize': TILE, 'levels': 3, 'tiles': tiles}, f)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
