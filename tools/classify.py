"""Разметка карты по цветам: местность, дороги, реки, поселения.

Использование:  python3 tools/classify.py assets/faerun-full.jpg data
Нужны: numpy, opencv-python-headless, Pillow.
Значки поселений ищет отдельный скрипт tools/settlements.py.

Выход (всё в 1/4 разрешения карты, RGB PNG без альфы — браузеры портят цвет при альфе 0):
  data/t0.png  R=вода  G=лес  B=горы        (знаковое расстояние, 0.5 = граница)
  data/t1.png  R=холмы G=пустыня B=болото
  data/t2.png  R=лёд   G=провал B=дороги (расстояние до линии)
  data/t3.png  R=реки  G=глубина моря (расстояние от берега) B=высота рельефа
  data/preview.jpg   плоская раскраска классов для проверки
"""
import json
import os
import sys

import cv2
import numpy as np

K = 4                 # во сколько раз уменьшаем текстуры
SDF_R = 24.0          # диапазон знакового расстояния, px исходной карты
LINE_R = 12.0         # диапазон расстояния для линий
DEPTH_R = 400.0       # диапазон «глубины» моря

# Эталонные цвета (RGB) → сырые классы. Получены k-means по самой карте.
WATER, PLAIN, FOREST, SWAMP, RELIEF, DESERT, ICE, INK = range(8)
REFS = [
    ((189, 216, 230), WATER), ((204, 228, 243), WATER), ((218, 239, 249), WATER), ((170, 205, 225), WATER),
    ((246, 240, 223), PLAIN), ((237, 228, 212), PLAIN),
    ((191, 208, 160), FOREST), ((173, 181, 146), FOREST), ((150, 170, 120), FOREST), ((120, 145, 95), FOREST),
    # оливковые тени лесов: G >= R, B заметно ниже — в отличие от тёплых серо-коричневых гор
    ((168, 168, 136), FOREST), ((152, 152, 120), FOREST), ((136, 136, 116), FOREST), ((200, 200, 160), FOREST),
    ((184, 184, 150), FOREST), ((200, 216, 168), FOREST), ((110, 115, 90), FOREST),
    ((198, 217, 192), SWAMP),
    ((203, 187, 171), RELIEF), ((179, 168, 155), RELIEF), ((162, 154, 137), RELIEF), ((219, 205, 188), RELIEF),
    ((148, 137, 123), RELIEF), ((127, 122, 116), RELIEF), ((96, 88, 83), RELIEF),
    ((246, 228, 179), DESERT), ((235, 205, 150), DESERT),
    ((251, 252, 252), ICE),
    ((16, 12, 10), INK), ((76, 53, 50), INK), ((120, 101, 50), INK), ((199, 65, 69), INK), ((55, 80, 130), INK),
]

# итоговые классы местности
T_WATER, T_PLAIN, T_FOREST, T_SWAMP, T_HILLS, T_MOUNT, T_DESERT, T_ICE, T_CHASM = range(9)
PREVIEW = {
    T_WATER: (70, 120, 160), T_PLAIN: (225, 215, 170), T_FOREST: (60, 110, 50), T_SWAMP: (100, 130, 110),
    T_HILLS: (175, 150, 100), T_MOUNT: (120, 100, 85), T_DESERT: (235, 195, 120), T_ICE: (245, 250, 255),
    T_CHASM: (40, 25, 30),
}

# Области-украшения на сборной карте (легенда), которые не являются местностью: x0, y0, x1, y1 в px карты
DECOR_AS_WATER = [
    (6870, 3700, 7330, 4560),   # легенда
]


def log(*a):
    print(*a, flush=True)


def classify_raw(img):
    lab = cv2.cvtColor(img, cv2.COLOR_RGB2LAB).astype(np.float32)
    refs = np.array([r for r, _ in REFS], np.uint8).reshape(-1, 1, 3)
    rlab = cv2.cvtColor(refs, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    cls = np.array([c for _, c in REFS], np.uint8)
    H, W, _ = img.shape
    out = np.empty((H, W), np.uint8)
    step = 96
    for y in range(0, H, step):
        blk = lab[y:y + step]
        d = ((blk[:, :, None, :] - rlab[None, None]) ** 2).sum(-1)
        out[y:y + step] = cls[d.argmin(-1)]
    return out


def box(mask, r):
    return cv2.blur(mask.astype(np.float32), (2 * r + 1, 2 * r + 1), borderType=cv2.BORDER_REFLECT)


def sdf(mask, R):
    """Знаковое расстояние (внутри > 0) в px, обрезанное до ±R, упакованное в 0..1."""
    m = mask.astype(np.uint8)
    din = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    dout = cv2.distanceTransform(1 - m, cv2.DIST_L2, 5)
    d = np.where(m > 0, din - 0.5, -(dout - 0.5))
    return np.clip(0.5 + d / (2 * R), 0, 1).astype(np.float32)


def udf(mask, R):
    """Расстояние до линии (0 на линии), упакованное в 0..1."""
    d = cv2.distanceTransform((1 - mask.astype(np.uint8)), cv2.DIST_L2, 5)
    return np.clip(d / R, 0, 1).astype(np.float32)


def down(a):
    H, W = a.shape
    h, w = (H + K - 1) // K, (W + K - 1) // K
    return cv2.resize(a, (w, h), interpolation=cv2.INTER_AREA)


def to8(a):
    return np.clip(np.round(a * 255), 0, 255).astype(np.uint8)


def components(mask, conn=8):
    n, lab, stats, cent = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=conn)
    return n, lab, stats, cent


def main(src, out):
    os.makedirs(out, exist_ok=True)
    img = cv2.imread(src, cv2.IMREAD_COLOR)[:, :, ::-1].copy()
    img = cv2.medianBlur(img, 3)  # убираем JPEG-шум
    H, W, _ = img.shape
    log('size', W, H)

    raw = classify_raw(img)
    for x0, y0, x1, y1 in DECOR_AS_WATER:
        raw[y0:y1, x0:x1] = WATER
    log('raw classes', np.bincount(raw.ravel(), minlength=8) / raw.size)

    ink = raw == INK
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    black = gray < 70

    # --- провалы: крупные тёмные заливки (Подземье и т.п.)
    dark = gray < 115
    dark_open = cv2.morphologyEx(dark.astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
    n, lab, st, _ = components(dark_open)
    chasm = np.zeros_like(dark)
    big = np.where(st[1:, cv2.CC_STAT_AREA] > 6000)[0] + 1
    chasm = np.isin(lab, big)
    chasm = cv2.morphologyEx(chasm.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    log('chasm px', int(chasm.sum()))

    # --- плотности классов; «краска» (текст, линии) не голосует — так затираются надписи
    r = 8
    names = [WATER, PLAIN, FOREST, SWAMP, RELIEF, DESERT, ICE]
    dens = np.stack([box(raw == c, r) for c in names]).astype(np.float16)
    tot = dens.astype(np.float32).sum(0)
    weak = tot < 0.25
    if weak.any():
        dens2 = np.stack([box(raw == c, 28) for c in names]).astype(np.float16)
        dens[:, weak] = dens2[:, weak]
        del dens2
    region = np.array(names, np.uint8)[dens.argmax(0)]
    del dens
    log('regions done')

    # рельеф → холмы/горы по плотности штрихов на большем радиусе
    rel = box(raw == RELIEF, 22)
    relief_region = region == RELIEF
    terrain = np.full((H, W), T_PLAIN, np.uint8)
    terrain[region == WATER] = T_WATER
    terrain[region == FOREST] = T_FOREST
    terrain[region == SWAMP] = T_SWAMP
    terrain[region == DESERT] = T_DESERT
    terrain[region == ICE] = T_ICE
    terrain[relief_region & (rel >= 0.45)] = T_MOUNT
    terrain[relief_region & (rel < 0.45) & (rel >= 0.2)] = T_HILLS
    # редкие «штрихи рельефа» — это контуры берегов и лесов, а не холмы.
    # Тонкие кольца холмов вокруг лесов и вдоль берегов убираем размыканием.
    hills = (terrain == T_HILLS).astype(np.uint8)
    opened = cv2.morphologyEx(hills, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)))
    terrain[(hills > 0) & (opened == 0)] = T_PLAIN
    terrain[chasm] = T_CHASM

    # сглаживание формы: мода по окрестности (убирает пиксельную крошку)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    best = np.zeros((H, W), np.float32)
    smooth = terrain.copy()
    for c in range(9):
        m = cv2.filter2D((terrain == c).astype(np.float32), -1, k / k.sum())
        upd = m > best
        smooth[upd] = c
        best[upd] = m[upd]
    terrain = smooth
    del best, smooth
    # мелкие острова воды/суши — шум
    for c in range(9):
        m = terrain == c
        n, lab, st, _ = components(m, 4)
        tiny = np.where(st[1:, cv2.CC_STAT_AREA] < 40)[0] + 1
        if len(tiny):
            t = np.isin(lab, tiny)
            # заполняем ближайшим соседним классом через дилатацию
            fill = cv2.dilate(np.where(t, 0, terrain + 1).astype(np.uint8), np.ones((5, 5), np.uint8))
            terrain[t] = np.maximum(fill[t], 1) - 1
    log('terrain', np.bincount(terrain.ravel(), minlength=9) / terrain.size)

    # --- дороги: длинные чёрные линии (буквы короткие — отсекаются)
    n, lab, st, _ = components(black)
    w_, h_, a_ = st[:, cv2.CC_STAT_WIDTH], st[:, cv2.CC_STAT_HEIGHT], st[:, cv2.CC_STAT_AREA]
    span = np.maximum(w_, h_)
    fill = a_ / np.maximum(1, w_ * h_)
    road_ids = np.where((span >= 45) & (fill < 0.25))[0]
    road_ids = road_ids[road_ids > 0]
    roads = np.isin(lab, road_ids)
    roads &= ~chasm

    del lab

    # --- реки: голубые линии вне водных областей
    water_px = raw == WATER
    river = water_px & (terrain != T_WATER)
    n, lab, st, _ = components(river)
    span = np.maximum(st[:, cv2.CC_STAT_WIDTH], st[:, cv2.CC_STAT_HEIGHT])
    keep = np.where(span >= 30)[0]
    keep = keep[keep > 0]
    river = np.isin(lab, keep)
    del lab
    # тонкая осевая линия реки: эрозия толстой полосы, но не до исчезновения
    river = cv2.morphologyEx(river.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0

    # --- рельеф как «высота»: плотность штрихов + сами классы
    height = np.clip(rel * 1.3, 0, 1) * (terrain != T_WATER)
    height = cv2.GaussianBlur(height.astype(np.float32), (0, 0), 10)

    log('distance fields...')
    S = lambda c: down(sdf(terrain == c, SDF_R))
    wat = terrain == T_WATER
    depth = cv2.distanceTransform(wat.astype(np.uint8), cv2.DIST_L2, 5)
    packs = {
        't0': (S(T_WATER), S(T_FOREST), S(T_MOUNT)),
        't1': (S(T_HILLS), S(T_DESERT), S(T_SWAMP)),
        't2': (S(T_ICE), S(T_CHASM), down(udf(roads, LINE_R))),
        't3': (down(udf(river, LINE_R)), down(np.clip(depth / DEPTH_R, 0, 1).astype(np.float32)), down(height)),
    }
    for name, chans in packs.items():
        arr = np.dstack(chans)
        cv2.imwrite(os.path.join(out, name + '.png'), to8(arr)[:, :, ::-1], [cv2.IMWRITE_PNG_COMPRESSION, 9])
        log('wrote', name, arr.shape)

    # превью
    pal = np.zeros((9, 3), np.uint8)
    for c, col in PREVIEW.items():
        pal[c] = col
    prev = pal[terrain]
    prev[roads] = (30, 20, 15)
    prev[river & (terrain != T_WATER)] = (70, 140, 200)
    small = cv2.resize(prev, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(out, 'preview.jpg'), small[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 85])
    json.dump({'width': W, 'height': H, 'k': K, 'sdfR': SDF_R, 'lineR': LINE_R, 'depthR': DEPTH_R},
              open(os.path.join(out, 'meta.json'), 'w'))
    log('done')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
