"""Газеттир: из подписей карты — список мест с точной геометрией подписей.

  python3 tools/gazetteer.py prep  assets/faerun-full.jpg WORKDIR
      находит слова (группы букв) и режет карту на тайлы для чтения:
      WORKDIR/words.json, WORKDIR/tiles.json, WORKDIR/tiles/<id>_clean.jpg, <id>_ann.jpg
  python3 tools/gazetteer.py build WORKDIR data/places.json [assets/faerun-full.jpg]
      собирает распознанные подписи (WORKDIR/draft|read/*.json) в data/places.json;
      с картой — подгоняет положение и высоту строк по реальным буквам

Распознавание текста делают люди или модели по снимкам из prep: для каждого тайла —
список подписей с номерами входящих в них слов (см. формат в WORKDIR/README.txt).
"""
import glob
import json
import math
import os
import re
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from labels import text_mask  # noqa: E402

CORE = 560      # ядро тайла: слова с центром здесь нумеруются в этом тайле
MARGIN = 90     # поля для контекста
SCALE = 2       # увеличение снимка для чтения

KINDS = ['city', 'town', 'village', 'castle', 'ruin', 'site', 'kingdom', 'region', 'forest', 'mountains',
         'hills', 'desert', 'swamp', 'plain', 'river', 'lake', 'sea', 'bay', 'island', 'road', 'pass', 'other']


def prep(src, work):
    os.makedirs(os.path.join(work, 'tiles'), exist_ok=True)
    img = cv2.imread(src, cv2.IMREAD_COLOR)[:, :, ::-1].copy()
    H, W, _ = img.shape
    _, _, words = text_mask(img, with_words=True)
    for i, w in enumerate(words):
        w['id'] = i + 1
    json.dump(words, open(os.path.join(work, 'words.json'), 'w'))
    print('words', len(words), flush=True)
    bgr = img[:, :, ::-1]
    tiles = []
    cols, rows = math.ceil(W / CORE), math.ceil(H / CORE)
    font = cv2.FONT_HERSHEY_SIMPLEX
    for r in range(rows):
        for c in range(cols):
            cx0, cy0 = c * CORE, r * CORE
            core = [w for w in words if cx0 <= w['cx'] < cx0 + CORE and cy0 <= w['cy'] < cy0 + CORE]
            if not core:
                continue
            x0, y0 = max(0, cx0 - MARGIN), max(0, cy0 - MARGIN)
            x1, y1 = min(W, cx0 + CORE + MARGIN), min(H, cy0 + CORE + MARGIN)
            crop = cv2.resize(bgr[y0:y1, x0:x1], None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_CUBIC)
            tid = f't{c:02d}_{r:02d}'
            cv2.imwrite(os.path.join(work, 'tiles', tid + '_clean.jpg'), crop, [cv2.IMWRITE_JPEG_QUALITY, 93])
            ann = (crop.astype(np.float32) * 0.8 + 255 * 0.2).astype(np.uint8)
            # граница ядра
            kx0, ky0 = (cx0 - x0) * SCALE, (cy0 - y0) * SCALE
            kx1, ky1 = (min(W, cx0 + CORE) - x0) * SCALE, (min(H, cy0 + CORE) - y0) * SCALE
            cv2.rectangle(ann, (kx0, ky0), (kx1, ky1), (0, 140, 255), 2)
            # слова вокруг (с полями): ядро — с номерами, остальные серым
            near = [w for w in words if x0 - 40 <= w['cx'] < x1 + 40 and y0 - 40 <= w['cy'] < y1 + 40]
            colors = [(0, 0, 255), (200, 0, 160), (0, 120, 0), (180, 90, 0)]
            for w in near:
                ang = w['angle']
                box = cv2.boxPoints((((w['cx'] - x0) * SCALE, (w['cy'] - y0) * SCALE),
                                     (w['len'] * SCALE + 4, w['h'] * SCALE + 4), ang))
                box = np.round(box).astype(np.int32)
                is_core = w in core
                col = colors[w['id'] % 4] if is_core else (150, 150, 150)
                cv2.polylines(ann, [box], True, col, 2 if is_core else 1)
                if is_core:
                    label = str(w['id'])
                    tx, ty = int(box[:, 0].min()), int(box[:, 1].min()) - 3
                    (tw, th), _ = cv2.getTextSize(label, font, 0.5, 1)
                    tx = min(max(0, tx), ann.shape[1] - tw - 2)
                    ty = max(th + 2, ty)
                    cv2.rectangle(ann, (tx - 1, ty - th - 2), (tx + tw + 1, ty + 2), (255, 255, 255), -1)
                    cv2.putText(ann, label, (tx, ty), font, 0.5, col, 1, cv2.LINE_AA)
            # бледная сетка и подписи координат снимка каждые 100 px
            grid = ann.copy()
            for gx in range(100, ann.shape[1], 100):
                cv2.line(grid, (gx, 0), (gx, ann.shape[0]), (90, 90, 90), 1)
            for gy in range(100, ann.shape[0], 100):
                cv2.line(grid, (0, gy), (ann.shape[1], gy), (90, 90, 90), 1)
            ann = cv2.addWeighted(grid, 0.35, ann, 0.65, 0)
            for gx in range(0, ann.shape[1], 100):
                cv2.line(ann, (gx, 0), (gx, 8), (0, 0, 0), 1)
                cv2.putText(ann, str(gx), (gx + 2, 18), font, 0.35, (0, 0, 0), 1, cv2.LINE_AA)
            for gy in range(0, ann.shape[0], 100):
                cv2.line(ann, (0, gy), (8, gy), (0, 0, 0), 1)
                cv2.putText(ann, str(gy), (2, gy - 2), font, 0.35, (0, 0, 0), 1, cv2.LINE_AA)
            cv2.imwrite(os.path.join(work, 'tiles', tid + '_ann.jpg'), ann, [cv2.IMWRITE_JPEG_QUALITY, 93])
            tiles.append({'id': tid, 'x0': x0, 'y0': y0, 'w': x1 - x0, 'h': y1 - y0, 'scale': SCALE,
                          'core': [cx0, cy0, min(W, cx0 + CORE), min(H, cy0 + CORE)],
                          'words': [w['id'] for w in core]})
    json.dump(tiles, open(os.path.join(work, 'tiles.json'), 'w'))
    print('tiles', len(tiles), 'words in tiles', sum(len(t['words']) for t in tiles))


# ---------------------------------------------------------------- сборка

def norm(s):
    return re.sub(r'[^a-z0-9]+', '', s.lower())


def ink_mask(src):
    """Все тёмные/цветные штрихи букв (без дорог) — для подгонки геометрии подписей."""
    from labels import road_mask
    img = cv2.imread(src, cv2.IMREAD_COLOR)[:, :, ::-1].copy()
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    bh = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    mx, mn = img.max(2).astype(np.int16), img.min(2).astype(np.int16)
    inky = (gray < 95) | ((mx - mn > 60) & (gray < 175))
    m = (bh > 40) & inky
    m[cv2.dilate(road_mask(gray).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0] = False
    return m


def refine(ln, ink):
    """Подгоняет прямую строку к реальным буквам: концы, смещение поперёк, высоту."""
    if ink is None or ln.get('path'):
        return
    a = math.radians(ln.get('angle', 0))
    ux, uy = math.cos(a), math.sin(a)
    s = max(5.0, ln['size'])
    expect = max(ln.get('len', 0), len(ln['text']) * s * 0.66)
    hl = expect / 2 + 2 * s
    x0, y0 = int(ln['x'] - hl - 2 * s), int(ln['y'] - hl - 2 * s)
    x1, y1 = int(ln['x'] + hl + 2 * s), int(ln['y'] + hl + 2 * s)
    H, W = ink.shape
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    if x1 <= x0 or y1 <= y0:
        return
    ys, xs = np.nonzero(ink[y0:y1, x0:x1])
    if len(xs) < 10:
        return
    dx, dy = xs + x0 + 0.5 - ln['x'], ys + y0 + 0.5 - ln['y']
    along = dx * ux + dy * uy
    across = -dx * uy + dy * ux
    sel = (np.abs(across) < 0.8 * s) & (np.abs(along) < hl)
    if sel.sum() < 10:
        return
    al, ac = np.sort(along[sel]), across[sel]
    # непрерывный кусок вокруг центра (разрыв больше 1.6 высоты букв — уже не эта подпись)
    gaps = np.where(np.diff(al) > 1.6 * s)[0]
    starts = np.concatenate([[0], gaps + 1])
    ends = np.concatenate([gaps, [len(al) - 1]])
    k = int(np.argmin([0 if al[a0] <= 0 <= al[a1] else min(abs(al[a0]), abs(al[a1])) for a0, a1 in zip(starts, ends)]))
    lo, hi = al[starts[k]], al[ends[k]]
    new_len = hi - lo
    if not (0.55 * expect <= new_len <= 1.6 * expect + 2 * s):
        return
    mid = (lo + hi) / 2
    acs = ac[(along[sel] >= lo) & (along[sel] <= hi)]
    if len(acs) < 10:
        return
    c_across = float(np.median(acs))
    h = float(np.percentile(acs, 92) - np.percentile(acs, 8))
    ln['x'] = round(ln['x'] + mid * ux - c_across * uy, 1)
    ln['y'] = round(ln['y'] + mid * uy + c_across * ux, 1)
    ln['len'] = round(float(new_len), 1)
    if 0.6 * s < h < 1.6 * s:
        ln['size'] = round(h, 1)


def unboxed_geometry(r):
    out = []
    for ln in r['ulines']:
        pts = ln['pts']
        size = round(max(5.0, ln['size']), 1)
        if len(pts) >= 3:
            (sx, sy), (ex, ey) = pts[0], pts[-1]
            ang = math.degrees(math.atan2(ey - sy, ex - sx))
            out.append({'text': ln['text'], 'size': size, 'path': [[round(x, 1), round(y, 1)] for x, y in pts],
                        'x': round(sum(p[0] for p in pts) / len(pts), 1), 'y': round(sum(p[1] for p in pts) / len(pts), 1),
                        'angle': round(ang if -95 < ang < 95 else ang - 180 * np.sign(ang), 1),
                        'len': round(sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])), 1)})
        else:
            (sx, sy) = pts[0]
            (ex, ey) = pts[-1] if len(pts) > 1 else (sx + 1, sy)
            ang = math.degrees(math.atan2(ey - sy, ex - sx))
            if ang > 95 or ang < -95:
                ang -= 180 * np.sign(ang)
            out.append({'text': ln['text'], 'size': size, 'x': round((sx + ex) / 2, 1), 'y': round((sy + ey) / 2, 1),
                        'angle': round(ang, 1), 'len': round(math.hypot(ex - sx, ey - sy), 1)})
    return {'x': round(r['x'], 1), 'y': round(r['y'], 1), 'lines': out}


def center(r, words=None):
    if r['words']:
        ws = [WORDS[i] for i, _ in r['words']]
        return (sum(w['cx'] for w in ws) / len(ws), sum(w['cy'] for w in ws) / len(ws))
    return (r['x'], r['y'])


WORDS = {}


def build(work, out, src=None):
    ink = ink_mask(src) if src else None
    words = {w['id']: w for w in json.load(open(os.path.join(work, 'words.json')))}
    WORDS.update(words)
    tiles = {t['id']: t for t in json.load(open(os.path.join(work, 'tiles.json')))}
    raw = []
    files = {os.path.basename(f): f for f in glob.glob(os.path.join(work, 'draft', '*.json'))}
    files.update({os.path.basename(f): f for f in glob.glob(os.path.join(work, 'read', '*.json'))})
    for f in sorted(files.values()):
        try:
            data = json.load(open(f))
        except Exception as e:  # битый файл агента не должен ронять сборку
            print('skip', f, e)
            continue
        for t in data.get('tiles', []):
            tile = tiles.get(t.get('tile_id'))
            if not tile:
                continue
            for lab in t.get('labels', []):
                ws = [(int(x['id']), x.get('text', '')) for x in lab.get('words', []) if int(x['id']) in words]
                if not ws or not lab.get('text', '').strip():
                    continue
                raw.append({'text': lab['text'].strip(), 'kind': lab.get('kind', 'other'), 'words': ws,
                            'conf': lab.get('confidence', 'medium'), 'tile': tile['id'],
                            'continues': bool(lab.get('continues_outside'))})
            for u in t.get('unboxed', []):
                if not u.get('text', '').strip():
                    continue
                sc = tile['scale']
                lines = []
                for ln in u.get('lines', []) or []:
                    pts = [(tile['x0'] + float(x) / sc, tile['y0'] + float(y) / sc) for x, y in (ln.get('path') or [])]
                    if not pts:
                        continue
                    lines.append({'text': ln.get('text') or u['text'], 'pts': pts, 'size': float(ln.get('size') or 16) / sc})
                if not lines:
                    continue
                xs = [p[0] for l in lines for p in l['pts']]
                ys = [p[1] for l in lines for p in l['pts']]
                raw.append({'text': u['text'].strip(), 'kind': u.get('kind', 'other'), 'words': [],
                            'conf': u.get('confidence', 'low'), 'tile': tile['id'], 'ulines': lines,
                            'x': sum(xs) / len(xs), 'y': sum(ys) / len(ys), 'continues': False})
    print('raw labels', len(raw))
    # слово может попасть в две подписи (соседние тайлы) — оставляем первую, более уверенную
    rank = {'high': 0, 'medium': 1, 'low': 2}
    raw.sort(key=lambda r: (rank.get(r['conf'], 1), -len(r['words'])))
    used, labels = set(), []
    for r in raw:
        ws = [(i, t) for i, t in r['words'] if i not in used]
        if r['words'] and not ws:
            continue
        r['words'] = ws
        used.update(i for i, _ in ws)
        labels.append(r)
    # подписи, разрезанные границей тайлов: одинаковый полный текст и близкие слова → сливаем
    merged = []
    by_text = {}
    for r in labels:
        key = norm(r['text'])
        hit = None
        for m in by_text.get(key, []):
            if r['words'] and m['words'] and min(math.hypot(words[a]['cx'] - words[b]['cx'], words[a]['cy'] - words[b]['cy'])
                                                 for a, _ in r['words'] for b, _ in m['words']) < 250:
                hit = m
                break
            if math.hypot(*np.subtract(center(r), center(m))) < 150 and (not r['words'] or not m['words']):
                hit = m
                break
        if hit:
            hit['words'] += r['words']
            continue
        by_text.setdefault(key, []).append(r)
        merged.append(r)
    places = []
    for i, r in enumerate(merged):
        p = {'id': f'p{i + 1}', 'name': r['text'], 'kind': r['kind'] if r['kind'] in KINDS else 'other', 'conf': r['conf']}
        if r['words']:
            p.update(geometry(r, words))
        else:
            p.update(unboxed_geometry(r))
        for ln in p['lines']:
            refine(ln, ink)
        places.append(p)
    link_settlements(places, out)
    json.dump(places, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('places', len(places))


def hgt(w):
    """Высота букв: у слова — короткая сторона рамки, у одиночной буквы — длинная."""
    return w['h'] if w['len'] > 1.8 * w['h'] else max(w['len'], w['h'])


def geometry(r, words):
    """Строки подписи: слова в порядке чтения, разбитые на строки по направлению между центрами."""
    ws = [(words[i], t) for i, t in r['words']]
    pts = np.array([(w['cx'], w['cy']) for w, _ in ws], float)
    # общее направление подписи (для одиночных букв наклон рамки бессмыслен)
    elong = [w for w, _ in ws if w['len'] > 1.8 * w['h']]
    if elong:
        # надёжнее всего наклон самого длинного многобуквенного слова
        w = max(elong, key=lambda w: w['len'])
        a = math.radians(w['angle'])
        u = np.array([math.cos(a), math.sin(a)])
    elif len(ws) >= 2:
        c = pts - pts.mean(0)
        u = np.linalg.svd(c, full_matrices=False)[2][0]
        if u[0] < 0:
            u = -u
    else:
        w = ws[0][0]
        a = math.radians(w['angle'] if w['len'] > 1.6 * w['h'] else 0)
        u = np.array([math.cos(a), math.sin(a)])
    # направление чтения — по порядку слов
    if len(ws) >= 2 and float((pts[-1] - pts[0]) @ u) < 0:
        u = -u
    hmed = float(np.median([hgt(w) for w, _ in ws]))
    lines = [[0]]
    for k in range(1, len(ws)):
        cur = lines[-1]
        prev = pts[cur[-1]]
        d = u
        if len(cur) >= 2:
            dd = (pts[cur[-1]] - pts[cur[0]]) / (np.linalg.norm(pts[cur[-1]] - pts[cur[0]]) or 1)
            if float(dd @ u) > 0.5:  # изогнутая строка — следуем за ней, но не разворачиваемся
                d = dd
        v = pts[k] - prev
        along, across = float(v @ d), float(-v[0] * d[1] + v[1] * d[0])
        if along < -0.3 * hmed or (abs(across) > 1.1 * hmed and abs(across) > abs(along)):
            lines.append([k])
        else:
            cur.append(k)
    # текст строк — по полному названию: раздаём буквы строкам по числу букв в их рамках
    full = r['text']
    letters = [i for i, ch in enumerate(full) if ch.isalnum()]
    pos, texts = 0, []
    for li, ln in enumerate(lines):
        n = sum(sum(ch.isalnum() for ch in ws[k][1]) for k in ln)
        if li == len(lines) - 1 or pos + n >= len(letters):
            a0 = letters[pos] if pos < len(letters) else len(full)
            texts.append(full[a0:].strip())
            pos = len(letters)
        else:
            a0 = letters[pos] if pos < len(letters) else len(full)
            a1 = letters[min(len(letters) - 1, pos + n)]
            texts.append(full[a0:a1].strip())
            pos += n
    out = []
    for ln, text in zip(lines, texts):
        if not text:
            continue
        lw = [ws[k][0] for k in ln]
        size = float(np.median([hgt(w) for w in lw])) * 0.92
        if len(lw) == 1:
            w = lw[0]
            ang = w['angle'] if w['len'] > 1.6 * w['h'] else math.degrees(math.atan2(u[1], u[0]))
            ext = w['len'] if w['len'] > 1.6 * w['h'] else max(w['len'], len(text) * size * 0.66)
            out.append({'text': text, 'x': round(w['cx'], 1), 'y': round(w['cy'], 1), 'angle': round(ang, 1),
                        'size': round(size, 1), 'len': round(ext, 1)})
            continue
        P = np.array([(w['cx'], w['cy']) for w in lw], float)
        d = P[-1] - P[0]
        dn = d / (np.linalg.norm(d) or 1)
        el = [w for w in lw if w['len'] > 1.8 * w['h']]
        if el:
            a = math.radians(max(el, key=lambda w: w['len'])['angle'])
            de = np.array([math.cos(a), math.sin(a)])
            if de @ dn < 0:
                de = -de
            if de @ dn > 0.9:  # почти прямая строка: наклон по слову точнее, чем по центрам букв разной высоты
                dn = de
        first, last = lw[0], lw[-1]
        start = P[0] - dn * first['len'] / 2 if first['len'] > 1.6 * first['h'] else P[0] - dn * size * 0.35
        end = P[-1] + dn * last['len'] / 2 if last['len'] > 1.6 * last['h'] else P[-1] + dn * size * 0.35
        path = np.vstack([start, P, end])
        ang = math.degrees(math.atan2(dn[1], dn[0]))
        dev = float(np.max(np.abs(-(P[:, 0] - start[0]) * dn[1] + (P[:, 1] - start[1]) * dn[0])))
        line = {'text': text, 'size': round(size, 1)}
        if dev > 0.35 * size and len(lw) >= 3:
            line['path'] = [[round(float(x), 1), round(float(y), 1)] for x, y in path]
        line.update({'x': round(float((start[0] + end[0]) / 2), 1), 'y': round(float((start[1] + end[1]) / 2), 1),
                     'angle': round(ang if -95 < ang < 95 else ang - 180 * np.sign(ang), 1),
                     'len': round(float(np.linalg.norm(end - start)), 1)})
        out.append(line)
    return {'x': round(float(pts[:, 0].mean()), 1), 'y': round(float(pts[:, 1].mean()), 1), 'lines': out}


SETTLE = {'city', 'town', 'village', 'castle', 'ruin', 'site'}


def link_settlements(places, out):
    """Подписи поселений привязываем к ближайшему значку; значок получает имя."""
    path = os.path.join(os.path.dirname(out), 'settlements.json')
    if not os.path.exists(path):
        return
    marks = json.load(open(path))
    taken = set()
    for p in sorted(places, key=lambda p: p['kind'] not in SETTLE):
        if p['kind'] not in SETTLE:
            continue
        best, bd = None, 1e9
        for i, m in enumerate(marks):
            if i in taken:
                continue
            for ln in p['lines']:
                hl = ln.get('len', ln['size'] * len(ln['text']) * 0.7) / 2
                a = math.radians(ln['angle'])
                dx, dy = m['x'] - ln['x'], m['y'] - ln['y']
                along = abs(dx * math.cos(a) + dy * math.sin(a))
                across = abs(-dx * math.sin(a) + dy * math.cos(a))
                d = math.hypot(max(0, along - hl), max(0, across - ln['size'] / 2))
                if d < bd:
                    best, bd = i, d
        if best is not None and bd < 26:
            taken.add(best)
            p['marker'] = [marks[best]['x'], marks[best]['y']]
            p['markerType'] = marks[best]['type']


if __name__ == '__main__':
    if sys.argv[1] == 'prep':
        prep(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == 'build':
        build(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
