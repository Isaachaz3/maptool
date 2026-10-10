"""Векторизация дорог, троп (пунктир) и рек: маска → скелет → полилинии.

Использование:  python3 tools/vectorize.py assets/faerun-full.jpg data
Выход: data/roads.json  — [{"t": "road"|"trail", "p": [[x, y], ...]}, ...]
       data/rivers.json — [{"p": [[x, y, w], ...]}, ...]   w — полуширина реки, точки идут по течению
Нужны: numpy, opencv-python-headless, scikit-image. Требует data/t0.png (разметка воды из classify.py).
"""
import heapq
import json
import math
import os
import sys

import cv2
import numpy as np
from skimage.morphology import skeletonize

sys.setrecursionlimit(100000)

sys.path.insert(0, os.path.dirname(__file__))
from labels import road_mask, text_mask  # noqa: E402


# ------------------------------------------------------------------ маски

def trail_mask(gray, text):
    """Пунктир: короткие вытянутые тёмно-серые штрихи (не буквы), которые после замыкания
    разрывов складываются в длинную тонкую линию."""
    dark = ((gray < 125) & ~text).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    span = np.maximum(st[:, 2], st[:, 3])
    cand = np.where((st[:, 4] >= 6) & (st[:, 4] <= 45) & (span >= 4) & (span <= 14))[0]
    keep = np.zeros(n, bool)
    for i in cand:
        if i == 0:
            continue
        x, y, w, h, a = st[i]
        (_, _), (rw, rh), _ = cv2.minAreaRect(cv2.findNonZero((lab[y:y + h, x:x + w] == i).astype(np.uint8)))
        lo, hi = min(rw, rh), max(rw, rh)
        if lo <= 4.5 and (hi >= 1.25 * max(lo, 1) or a <= 16):
            keep[i] = True
    dashes = keep[lab].astype(np.uint8)
    del lab
    closed = cv2.morphologyEx(dashes, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    span = np.maximum(st[:, 2], st[:, 3])
    # толщина = площадь / длина скелета: у сети троп она мала, у клочков штриховки и букв — велика
    sk = skeletonize(closed > 0)
    sklen = np.bincount(lab[sk], minlength=n).astype(np.float64)
    ok = np.where((span >= 24) & (sklen >= 20) & (st[:, 4] / np.maximum(sklen, 1) <= 4.0))[0]
    ok = ok[ok > 0]
    return np.isin(lab, ok)


def river_mask(img, water):
    """Голубые линии рек на суше (вода морей и озёр — по разметке)."""
    b, g, r = [img[:, :, i].astype(np.int16) for i in (2, 1, 0)]
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    blue = (b - r > 22) & (b >= g - 4) & (gray > 140) & (gray < 238)
    # исключаем только крупные водоёмы: широкие участки рек разметка тоже считает водой
    big = cv2.morphologyEx(water.astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))) > 0
    m = (blue & ~big).astype(np.uint8)
    # подписи поверх реки и тёмный контур берега оставляют дыры — заклеиваем
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    # широкие голубые пятна (озёра, болота, разливы) — не русла; широкие реки (до ~14 px) остаются
    thick = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17)))
    m[cv2.dilate(thick, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))) > 0] = 0
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    span = np.maximum(st[:, 2], st[:, 3])
    ok = np.where(span >= 30)[0]
    ok = ok[ok > 0]
    return np.isin(lab, ok)


# ------------------------------------------------------------------ скелет → граф → полилинии

NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def trace(skel):
    """Скелет (bool) → список путей (списки (y, x)) между узлами (концы и развилки)."""
    sk = skel.astype(np.uint8)
    cnt = cv2.filter2D(sk, -1, np.ones((3, 3), np.float32), borderType=cv2.BORDER_CONSTANT) - sk
    ys, xs = np.nonzero(sk)
    pix = set(zip(ys.tolist(), xs.tolist()))
    deg = {p: int(cnt[p]) for p in pix}
    nodes = {p for p, d in deg.items() if d != 2}
    seen_edges = set()
    paths = []

    def nbrs(p):
        y, x = p
        return [(y + dy, x + dx) for dy, dx in NB if (y + dy, x + dx) in pix]

    def walk(start, nxt):
        path = [start, nxt]
        prev, cur = start, nxt
        while cur not in nodes:
            cand = [q for q in nbrs(cur) if q != prev and q not in path[-3:]]
            if not cand:
                break
            # предпочитаем соседей по стороне (а не по диагонали), чтобы не срезать углы
            cand.sort(key=lambda q: abs(q[0] - cur[0]) + abs(q[1] - cur[1]))
            prev, cur = cur, cand[0]
            path.append(cur)
            if len(path) > 200000:
                break
        return path

    for s in nodes:
        for q in nbrs(s):
            e = (s, q)
            if e in seen_edges:
                continue
            p = walk(s, q)
            for a, b in zip(p, p[1:]):
                seen_edges.add((a, b))
                seen_edges.add((b, a))
            paths.append(p)
    # замкнутые петли без узлов
    covered = set(q for p in paths for q in p)
    for p0 in pix - covered:
        if p0 in covered:
            continue
        nb = nbrs(p0)
        if not nb:
            continue
        p = walk(p0, nb[0])
        covered.update(p)
        paths.append(p)
    return paths


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0], float), np.array(pts[-1], float)
    ab = b - a
    L = np.hypot(*ab)
    P = np.array(pts, float)
    if L < 1e-9:
        d = np.hypot(*(P - a).T)
    else:
        D = P - a
        d = np.abs(ab[0] * D[:, 1] - ab[1] * D[:, 0]) / L
    i = int(np.argmax(d))
    if d[i] > eps:
        return rdp(pts[:i + 1], eps)[:-1] + rdp(pts[i:], eps)
    return [pts[0], pts[-1]]


def polylines(mask, min_len, eps=0.8):
    """Маска → пути по скелету. Короткие висячие отростки выбрасываются, короткие перемычки
    между развилками остаются (иначе вблизи в дорогах появляются разрывы)."""
    skel = skeletonize(mask)
    paths = [p for p in trace(skel) if len(p) >= 2]
    ends = {}
    for p in paths:
        for q in (p[0], p[-1]):
            ends[q] = ends.get(q, 0) + 1
    out = []
    for p in paths:
        length = sum(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(p, p[1:]))
        dangling = ends[p[0]] == 1 or ends[p[-1]] == 1
        if length < min_len and dangling:
            continue
        if length < min_len * 3 and ends[p[0]] == 1 and ends[p[-1]] == 1:
            continue  # одиночный короткий обрывок
        pts = [(x + 0.5, y + 0.5) for y, x in p]
        out.append(rdp(pts, eps))
    return out, skel


def join_paths(paths):
    """Склеивает пути, встречающиеся концами в точке, где сходятся ровно два конца."""
    paths = [list(p) for p in paths]
    key = lambda pt: (round(pt[0], 1), round(pt[1], 1))
    ends = {}
    for i, p in enumerate(paths):
        ends.setdefault(key(p[0]), set()).add((i, 0))
        ends.setdefault(key(p[-1]), set()).add((i, 1))
    alive = set(range(len(paths)))
    queue = list(ends.keys())
    while queue:
        k = queue.pop()
        s = ends.get(k, set())
        if len(s) != 2:
            continue
        (i, si), (j, sj) = sorted(s)
        if i == j:
            continue
        a, b = paths[i], paths[j]
        for ii, side in ((i, 0), (i, 1), (j, 0), (j, 1)):
            ends[key(paths[ii][0] if side == 0 else paths[ii][-1])].discard((ii, side))
        if si == 0:
            a = a[::-1]
        if sj == 1:
            b = b[::-1]
        paths[i] = a + b[1:]
        alive.discard(j)
        ends.setdefault(key(paths[i][0]), set()).add((i, 0))
        ends.setdefault(key(paths[i][-1]), set()).add((i, 1))
        queue += [key(paths[i][0]), key(paths[i][-1])]
    return [paths[i] for i in sorted(alive)]


def bridge(paths, max_gap=16.0, targets=None, snap=8.0):
    """Склеивает разрывы пунктира: висячие концы, смотрящие друг на друга, соединяются;
    концы рядом с дорогой (targets — список полилиний) притягиваются к ней."""
    paths = [list(p) for p in paths if len(p) >= 2]

    def end_dir(p, k):
        a = np.array(p[0 if k == 0 else -1], float)[:2]
        b = np.array(p[min(3, len(p) - 1) if k == 0 else max(-4, -len(p))], float)[:2]
        d = a - b
        n = np.hypot(*d)
        return a, (d / n if n > 1e-6 else d)

    ends = []
    for i, p in enumerate(paths):
        for k in (0, 1):
            pt, d = end_dir(p, k)
            ends.append((i, k, pt, d))
    # кандидаты через сетку
    cell = max_gap
    grid = {}
    for e, (_, _, pt, _) in enumerate(ends):
        grid.setdefault((int(pt[0] // cell), int(pt[1] // cell)), []).append(e)
    pairs = []
    for e, (i, ki, pa, da) in enumerate(ends):
        gx, gy = int(pa[0] // cell), int(pa[1] // cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for f in grid.get((gx + dx, gy + dy), []):
                    if f <= e:
                        continue
                    j, kj, pb, db = ends[f]
                    if i == j:
                        continue
                    v = pb - pa
                    dist = np.hypot(*v)
                    if dist > max_gap or dist < 1e-6:
                        continue
                    u = v / dist
                    if np.dot(da, u) > 0.5 and np.dot(db, -u) > 0.5:
                        pairs.append((dist, e, f))
    pairs.sort()
    link = {}
    for _, e, f in pairs:
        if e in link or f in link:
            continue
        link[e] = f
        link[f] = e
    # сборка цепочек: конец пути e = 2*i + k
    used = set()
    out = []
    for i in range(len(paths)):
        if i in used:
            continue
        # идём к началу цепочки
        start, k = i, 0
        seen = {i}
        while True:
            e = 2 * start + k
            if e not in link:
                break
            f = link[e]
            j, kj = divmod(f, 2)
            if j in seen:
                break
            seen.add(j)
            start, k = j, 1 - kj
        # теперь от start, начиная с конца k, собираем
        chain = []
        cur, enter = start, k
        while cur is not None and cur not in used:
            used.add(cur)
            p = paths[cur] if enter == 0 else paths[cur][::-1]
            chain += p
            e = 2 * cur + (1 - enter)
            if e in link:
                j, kj = divmod(link[e], 2)
                cur, enter = (j, kj) if j not in used else (None, 0)
            else:
                cur = None
        out.append(chain)
    paths = out
    paths = [p for p in paths if p]
    if targets:
        segs = np.array([(a[0], a[1], b[0], b[1]) for t in targets for a, b in zip(t, t[1:])], float)
        if len(segs):
            for p in paths:
                for k in (0, -1):
                    q = np.array(p[k], float)
                    A, B = segs[:, :2], segs[:, 2:]
                    AB = B - A
                    t = np.clip(((q - A) * AB).sum(1) / np.maximum((AB * AB).sum(1), 1e-9), 0, 1)
                    proj = A + AB * t[:, None]
                    d = np.hypot(*(proj - q).T)
                    m = int(np.argmin(d))
                    if d[m] < snap:
                        pt = (float(proj[m][0]), float(proj[m][1]))
                        if k == 0:
                            p.insert(0, pt)
                        else:
                            p.append(pt)
    return paths


# ------------------------------------------------------------------ направление рек

def orient_rivers(rivers, water_sdf_at):
    """Направляет реки по течению: к морю/озеру. Графовое расстояние до воды по сети рек."""
    key = lambda p: (round(p[0] / 3), round(p[1] / 3))
    adj = {}
    for i, p in enumerate(rivers):
        a, b = key(p[0]), key(p[-1])
        L = sum(math.hypot(u[0] - v[0], u[1] - v[1]) for u, v in zip(p, p[1:]))
        adj.setdefault(a, []).append((b, L))
        adj.setdefault(b, []).append((a, L))
    # источники: узлы у воды
    dist = {}
    pq = []
    for i, p in enumerate(rivers):
        for k in (0, -1):
            if water_sdf_at(p[k][0], p[k][1]) > -6:
                kk = key(p[k])
                dist[kk] = 0.0
                heapq.heappush(pq, (0.0, kk))
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18):
            continue
        for v, L in adj.get(u, []):
            nd = d + L
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                heapq.heappush(pq, (nd, v))
    out = []
    for p in rivers:
        da, db = dist.get(key(p[0]), 1e18), dist.get(key(p[-1]), 1e18)
        out.append(p if db <= da else p[::-1])
    return out


def main(src, out):
    img = cv2.imread(src, cv2.IMREAD_COLOR)[:, :, ::-1].copy()
    H, W, _ = img.shape
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    t0 = cv2.imread(os.path.join(out, 't0.png'))[:, :, 2].astype(np.float32)  # R = вода (знаковое расстояние)
    wsdf = cv2.resize(t0, (W, H), interpolation=cv2.INTER_LINEAR)
    water = wsdf > 127

    def water_sdf_at(x, y):
        xi, yi = min(W - 1, max(0, int(x))), min(H - 1, max(0, int(y)))
        return (wsdf[yi, xi] / 255.0 - 0.5) * 48.0

    roads = []
    rm = road_mask(gray)
    # дорога рисуется 2–3 px, значки городов на ней — кольца: убираем заливку колец, чтобы скелет не петлял
    rm = cv2.morphologyEx(rm.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    rp, _ = polylines(rm, min_len=12, eps=0.7)
    print('road paths', len(rp), flush=True)
    for p in join_paths(rp):
        roads.append({'t': 'road', 'p': [[round(x, 1), round(y, 1)] for x, y in p]})
    _, text = text_mask(img)
    text = cv2.dilate(text.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    tm = trail_mask(gray, text) & ~cv2.dilate(rm.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    tp, _ = polylines(tm, min_len=14, eps=1.0)
    print('trail paths', len(tp), flush=True)
    road_lines = [r['p'] for r in roads]
    for p in bridge(join_paths(tp), max_gap=18.0, targets=road_lines, snap=9.0):
        roads.append({'t': 'trail', 'p': [[round(x, 1), round(y, 1)] for x, y in p]})

    rv = river_mask(img, water)
    dist = cv2.distanceTransform(rv.astype(np.uint8), cv2.DIST_L2, 5)
    rpaths, _ = polylines(rv, min_len=20, eps=0.8)
    rpaths = bridge(join_paths(rpaths), max_gap=14.0)
    rpaths = orient_rivers(rpaths, water_sdf_at)
    rivers = []
    for p in rpaths:
        pts = []
        for x, y in p:
            w = float(dist[min(H - 1, int(y)), min(W - 1, int(x))])
            pts.append([round(x, 1), round(y, 1), round(max(0.8, w), 1)])
        rivers.append({'p': pts})
    print('rivers', len(rivers), flush=True)
    json.dump(roads, open(os.path.join(out, 'roads.json'), 'w'), separators=(',', ':'))
    json.dump(rivers, open(os.path.join(out, 'rivers.json'), 'w'), separators=(',', ':'))
    print('points: roads', sum(len(r['p']) for r in roads), 'rivers', sum(len(r['p']) for r in rivers))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
