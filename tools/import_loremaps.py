"""Импорт поселений LoreMaps (github.com/loremaps/LoreMaps, public/data/faerun/*.json).

Их карта Фаэруна — та же картинка, что центральная часть нашей, со сдвигом (DX, DY)
(найден сопоставлением SIFT, ошибка ~0.3 px). Оставляем только наши значки, у которых
есть пара в их списке; места без найденного значка добавляем.

Использование: python3 tools/import_loremaps.py <путь к LoreMaps>/public/data/faerun data
"""
import glob
import json
import math
import os
import sys

DX, DY = 2329.98, -3.01
LAYER_KIND = {'capitals': 'city', 'portcapitals': 'city', 'cities': 'town', 'ports': 'town',
              'fortresses': 'castle', 'ruins': 'ruin', 'temples': 'site', 'sites': 'site'}


def main(src, out):
    ours = json.load(open(os.path.join(out, 'settlements.json')))
    used = set()
    places, marks = [], []
    for f in sorted(glob.glob(os.path.join(src, '*.json'))):
        layer = os.path.splitext(os.path.basename(f))[0]
        for ft in json.load(open(f, encoding='utf-8-sig'))['features']:
            x, y = ft['geometry']['coordinates']
            x, y = x + DX, y + DY
            name = ft['properties']['name'].strip()
            best, bd = None, 1e9
            for i, m in enumerate(ours):
                if i in used:
                    continue
                d = math.hypot(m['x'] - x, m['y'] - y)
                if d < bd:
                    best, bd = i, d
            kind = LAYER_KIND.get(layer, 'site')
            icon = {'city': 'city', 'castle': 'castle', 'ruin': 'ruin', 'site': 'temple' if layer == 'temples' else 'site'}.get(kind, 'town')
            if best is not None and bd < 12:
                used.add(best)
                x, y = ours[best]['x'], ours[best]['y']
                if ours[best]['type'] == 'city' and kind == 'town':
                    icon = 'city'  # на карте кольцо — значит крупный город
            places.append({'id': f'lm-{len(places) + 1}', 'name': name, 'kind': kind, 'layer': layer,
                           'capital': layer in ('capitals', 'portcapitals'), 'port': layer in ('ports', 'portcapitals'),
                           'x': round(x, 1), 'y': round(y, 1), 'marker': [round(x, 1), round(y, 1)], 'markerType': icon,
                           'wiki': name, 'lines': []})
            marks.append({'x': round(x, 1), 'y': round(y, 1), 'type': icon})
    json.dump(places, open(os.path.join(out, 'places.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump(marks, open(os.path.join(out, 'settlements.json'), 'w'), separators=(',', ':'))
    print('мест', len(places), 'совпало со значками', len(used), 'из наших', len(ours))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
