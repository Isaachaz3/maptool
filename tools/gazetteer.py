"""Газеттир: из подписей карты — список мест с точной геометрией подписей.

  python3 tools/gazetteer.py prep  assets/faerun-full.jpg WORKDIR
      находит слова (группы букв) и режет карту на тайлы для чтения:
      WORKDIR/words.json, WORKDIR/tiles.json, WORKDIR/tiles/<id>_clean.jpg, <id>_ann.jpg
  python3 tools/gazetteer.py build WORKDIR data/places.json
      собирает распознанные подписи (WORKDIR/read/*.json) в data/places.json

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


def build(work, out):
    words = {w['id']: w for w in json.load(open(os.path.join(work, 'words.json')))}
    tiles = {t['id']: t for t in json.load(open(os.path.join(work, 'tiles.json')))}
    raw = []
    for f in sorted(glob.glob(os.path.join(work, 'read', '*.json'))):
        data = json.load(open(f))
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
                s = tile['scale']
                raw.append({'text': u['text'].strip(), 'kind': u.get('kind', 'other'), 'words': [],
                            'conf': u.get('confidence', 'low'), 'tile': tile['id'],
                            'x': tile['x0'] + float(u['x']) / s, 'y': tile['y0'] + float(u['y']) / s,
                            'angle': float(u.get('angle', 0)), 'size': float(u.get('size', 16)) / s,
                            'continues': False})
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
                                                 for a, _ in r['words'] for b, _ in m['words']) < 120:
                hit = m
                break
            if not r['words'] and not m['words'] and math.hypot(r['x'] - m['x'], r['y'] - m['y']) < 60:
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
            p.update({'x': round(r['x'], 1), 'y': round(r['y'], 1),
                      'lines': [{'text': r['text'], 'x': round(r['x'], 1), 'y': round(r['y'], 1),
                                 'angle': r['angle'], 'size': round(max(6.0, r['size']), 1)}]})
        places.append(p)
    link_settlements(places, out)
    json.dump(places, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('places', len(places))


def geometry(r, words):
    """Строки подписи: слова в порядке чтения, разбитые на строки по смещению поперёк."""
    ws = [(words[i], t) for i, t in r['words']]
    lines = []
    for w, t in ws:
        if lines:
            prev = lines[-1][-1][0]
            a = math.radians(prev['angle'])
            dx, dy = w['cx'] - prev['cx'], w['cy'] - prev['cy']
            along = dx * math.cos(a) + dy * math.sin(a)
            across = -dx * math.sin(a) + dy * math.cos(a)
            hgt = max(prev['h'], w['h'])
            # новая строка: заметный сдвиг поперёк строки или возврат назад
            if abs(across) > 0.7 * hgt and abs(across) > abs(along) * 0.6:
                lines.append([(w, t)])
                continue
        if lines:
            lines[-1].append((w, t))
        else:
            lines.append([(w, t)])
    out = []
    for ln in lines:
        text = ' '.join(t for _, t in ln if t).strip() or r['text']
        hs = [w['h'] for w, _ in ln]
        size = float(np.median(hs)) * 0.92
        pts = [(w['cx'], w['cy']) for w, _ in ln]
        if len(ln) == 1:
            w = ln[0][0]
            out.append({'text': text, 'x': round(w['cx'], 1), 'y': round(w['cy'], 1), 'angle': round(w['angle'], 1),
                        'size': round(size, 1), 'len': round(w['len'], 1)})
            continue
        # концы строки: от начала первого слова до конца последнего
        first, last = ln[0][0], ln[-1][0]
        a0, a1 = math.radians(first['angle']), math.radians(last['angle'])
        dirx, diry = last['cx'] - first['cx'], last['cy'] - first['cy']
        d = math.hypot(dirx, diry) or 1
        dirx, diry = dirx / d, diry / d
        start = (first['cx'] - dirx * first['len'] / 2, first['cy'] - diry * first['len'] / 2)
        end = (last['cx'] + dirx * last['len'] / 2, last['cy'] + diry * last['len'] / 2)
        path = [start] + pts + [end]
        # прямая или изогнутая?
        ang = math.degrees(math.atan2(diry, dirx))
        dev = max(abs(-(px - start[0]) * diry + (py - start[1]) * dirx) for px, py in pts)
        line = {'text': text, 'size': round(size, 1)}
        cx = sum(p[0] for p in path) / len(path)
        cy = sum(p[1] for p in path) / len(path)
        if dev > 0.35 * size and len(pts) >= 3:
            line['path'] = [[round(px, 1), round(py, 1)] for px, py in path]
        line.update({'x': round((start[0] + end[0]) / 2, 1), 'y': round((start[1] + end[1]) / 2, 1),
                     'angle': round(ang if -95 < ang < 95 else ang - 180 * np.sign(ang), 1),
                     'len': round(math.hypot(end[0] - start[0], end[1] - start[1]), 1)})
        out.append(line)
    allpts = [(w['cx'], w['cy']) for w, _ in ws]
    return {'x': round(sum(p[0] for p in allpts) / len(allpts), 1), 'y': round(sum(p[1] for p in allpts) / len(allpts), 1),
            'lines': out}


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
        build(sys.argv[2], sys.argv[3])
