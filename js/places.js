// Места карты (газеттир/энциклопедия) и их подписи шрифтом.
// Базовые данные — data/places.json (собраны с подписей карты), правки мастера — в состоянии кампании (S.placeEdits),
// собственные места мастера — S.customPlaces. Подписи рисуются на 2D-слое поверх карты.

export const KIND_NAMES = {
  city: 'Город', town: 'Городок', village: 'Деревня', castle: 'Крепость', ruin: 'Руины', site: 'Место',
  kingdom: 'Государство', region: 'Область', forest: 'Лес', mountains: 'Горы', hills: 'Холмы', desert: 'Пустыня',
  swamp: 'Болото', plain: 'Равнина', river: 'Река', lake: 'Озеро', sea: 'Море', bay: 'Залив', island: 'Остров',
  road: 'Дорога', pass: 'Перевал', other: 'Прочее',
};
export const SETTLEMENT = new Set(['city', 'town', 'village', 'castle', 'ruin', 'site']);

// Стиль подписи по типу: шрифт, цвет, размеры, диапазон масштабов, приоритет
const SANS = '"Alegreya SC", "Palatino Linotype", Georgia, serif';
const ITAL = 'italic 500 {s}px "Alegreya", "Palatino Linotype", Georgia, serif';
const STYLE = {
  kingdom: { font: '600 {s}px "Cinzel", "Alegreya SC", Georgia, serif', color: '#f1e3c4', spacing: 0.22, min: 0.1, max: 2.2, pri: 90, lo: 13, hi: 44 },
  region: { font: `500 {s}px ${SANS}`, color: '#efe4cb', spacing: 0.14, min: 0.18, max: 4, pri: 70, lo: 11, hi: 32 },
  forest: { font: `500 {s}px ${SANS}`, color: '#e6ecd2', spacing: 0.12, min: 0.25, max: 6, pri: 60, lo: 11, hi: 28 },
  mountains: { font: `500 {s}px ${SANS}`, color: '#f0ece4', spacing: 0.14, min: 0.2, max: 6, pri: 62, lo: 11, hi: 30 },
  hills: { font: `500 {s}px ${SANS}`, color: '#efe6d2', spacing: 0.12, min: 0.3, max: 6, pri: 50, lo: 11, hi: 24 },
  desert: { font: `500 {s}px ${SANS}`, color: '#f6e7c3', spacing: 0.16, min: 0.15, max: 4, pri: 66, lo: 12, hi: 34 },
  swamp: { font: `500 {s}px ${SANS}`, color: '#e4e6cf', spacing: 0.12, min: 0.3, max: 6, pri: 52, lo: 11, hi: 24 },
  plain: { font: `500 {s}px ${SANS}`, color: '#efe6cb', spacing: 0.12, min: 0.3, max: 6, pri: 50, lo: 11, hi: 24 },
  island: { font: `500 {s}px ${SANS}`, color: '#efe6cb', spacing: 0.1, min: 0.25, max: 6, pri: 55, lo: 11, hi: 24 },
  sea: { font: ITAL, color: '#cfe6e8', spacing: 0.18, min: 0.08, max: 3, pri: 80, lo: 12, hi: 38 },
  bay: { font: ITAL, color: '#cfe6e8', spacing: 0.1, min: 0.25, max: 6, pri: 54, lo: 11, hi: 24 },
  lake: { font: ITAL, color: '#d4ebee', spacing: 0.06, min: 0.35, max: 6, pri: 48, lo: 11, hi: 22 },
  river: { font: ITAL, color: '#d4ebee', spacing: 0.06, min: 0.55, max: 6, pri: 40, lo: 11, hi: 20 },
  road: { font: ITAL, color: '#eadcc0', spacing: 0.05, min: 0.8, max: 6, pri: 30, lo: 11, hi: 18 },
  pass: { font: ITAL, color: '#eadcc0', spacing: 0.05, min: 0.7, max: 6, pri: 35, lo: 11, hi: 18 },
  other: { font: `500 {s}px ${SANS}`, color: '#efe6cb', spacing: 0.08, min: 0.6, max: 6, pri: 30, lo: 11, hi: 20 },
};
// Поселения: подпись под значком, размер в экранных пикселях
const TOWN = {
  city: { w: 700, base: 15, min: 0.16, pri: 100 },
  castle: { w: 700, base: 13, min: 0.45, pri: 85 },
  town: { w: 500, base: 13, min: 0.4, pri: 84 },
  village: { w: 500, base: 12, min: 0.8, pri: 74 },
  ruin: { w: 500, base: 12, min: 0.7, pri: 72 },
  site: { w: 500, base: 12, min: 0.7, pri: 72 },
};

export class Places {
  constructor() {
    this.base = [];
    this.byId = new Map();
    this.list = [];
    this.ready = fetch('data/places.json').then(r => (r.ok ? r.json() : [])).catch(() => []).then(d => {
      this.base = d;
      this.version = 0;
    });
  }

  // Слить базовые места с правками мастера; вызывается при изменении состояния
  merge(S) {
    const edits = S.placeEdits || {};
    const out = [];
    for (const p of this.base) {
      const e = edits[p.id];
      if (e && e.deleted) continue;
      out.push(e ? { ...p, ...e } : p);
    }
    for (const p of S.customPlaces || []) {
      const e = edits[p.id];
      out.push(e ? { ...p, ...e } : p);
    }
    this.list = out;
    this.byId = new Map(out.map(p => [p.id, p]));
    this.version = (this.version || 0) + 1;
    return out;
  }

  displayName(p, lang) {
    return (lang === 'ru' && p.name_ru) ? p.name_ru : p.name;
  }

  search(q, limit = 60) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const res = [];
    for (const p of this.list) {
      const a = (p.name || '').toLowerCase(), b = (p.name_ru || '').toLowerCase();
      const i = Math.min(a.indexOf(s) < 0 ? 1e9 : a.indexOf(s), b.indexOf(s) < 0 ? 1e9 : b.indexOf(s));
      if (i < 1e9) res.push([i, (p.name || '').length, p]);
    }
    res.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    return res.slice(0, limit).map(r => r[2]);
  }
}

const widthCache = new Map();
function measure(ctx, font, text, spacing, size) {
  const key = font + '|' + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w + spacing * size * Math.max(0, text.length - 1);
}

function fontFor(st, size) { return st.font.replace('{s}', size.toFixed(1)); }

// Пересечение повёрнутых прямоугольников проверяем грубо — по описанным окружностям сегментов
class Occupancy {
  constructor() { this.boxes = []; this.grid = new Map(); }
  key(x, y) { return ((x >> 6) & 0xffff) | (((y >> 6) & 0xffff) << 16); }
  fits(b) {
    const x0 = b.x0 >> 6, x1 = b.x1 >> 6, y0 = b.y0 >> 6, y1 = b.y1 >> 6;
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const list = this.grid.get(gx * 100003 + gy);
      if (!list) continue;
      for (const o of list) {
        if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) {
          if (!b.circles || !o.circles) return false;
          for (const c of b.circles) for (const d of o.circles) {
            if (Math.hypot(c[0] - d[0], c[1] - d[1]) < c[2] + d[2]) return false;
          }
        }
      }
    }
    return true;
  }
  add(b) {
    const x0 = b.x0 >> 6, x1 = b.x1 >> 6, y0 = b.y0 >> 6, y1 = b.y1 >> 6;
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = gx * 100003 + gy;
      let list = this.grid.get(k);
      if (!list) this.grid.set(k, list = []);
      list.push(b);
    }
    this.boxes.push(b);
  }
}

// Точки вдоль ломаной (экранные координаты): длина и положение/угол на расстоянии t
function polyMeasure(pts) {
  const seg = [];
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    seg.push(l);
    L += l;
  }
  return { seg, L };
}
function polyAt(pts, seg, t) {
  let i = 0;
  while (i < seg.length - 1 && t > seg[i]) { t -= seg[i]; i++; }
  const a = pts[i], b = pts[i + 1], l = seg[i] || 1;
  const k = Math.max(0, Math.min(1, t / l));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[1] - a[1], b[0] - a[0])];
}

// Подписи мест. opts: player — экран игроков (скрывать неизвестное под туманом)
export function placeLabelLayer(places, getState, fog, { player = false, onPlaced } = {}) {
  let placed = [];
  return {
    hits: () => placed,
    draw(ctx, v) {
      const S = getState();
      placed = [];
      if (!S.showLabels || !v.renderer) return;
      const mixA = Math.max(0, 1 - (S.styleMix || 0) * 1.8);
      if (mixA <= 0.02) return;
      const lang = S.labelLang || 'en';
      const r = v.viewRect();
      const pad = 400;
      const cand = [];
      for (const p of places.list) {
        if (p.hiddenLabel) continue;
        if (p.x < r.x - pad || p.y < r.y - pad || p.x > r.x + r.w + pad || p.y > r.y + r.h + pad) continue;
        const town = SETTLEMENT.has(p.kind) && p.marker ? TOWN[p.kind] : null;
        const st = STYLE[p.kind] || STYLE.other;
        if (town ? v.scale < town.min : (v.scale < st.min || v.scale > st.max)) continue;
        if (player && S.fogEnabled && !p.known) {
          const ax = town ? p.marker[0] : p.x, ay = town ? p.marker[1] : p.y;
          if (fog.hiddenAt(ax, ay)) continue;
        }
        cand.push([town ? town.pri : st.pri + Math.min(10, (p.lines?.[0]?.size || 8) / 4), p, town, st]);
      }
      cand.sort((a, b) => b[0] - a[0]);
      const occ = new Occupancy();
      // значки поселений тоже занимают место
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      for (const [, p, town, st] of cand) {
        const name = places.displayName(p, lang);
        if (town) drawTownName(ctx, v, p, name, town, occ, placed, mixA);
        else drawAreaName(ctx, v, p, name, st, occ, placed, mixA, lang);
      }
      ctx.restore();
      if (onPlaced) onPlaced(placed);
    },
  };
}

function textStroke(ctx, text, x, y, color, a) {
  ctx.globalAlpha = a;
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = 'rgba(18,13,8,0.78)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawTownName(ctx, v, p, name, t, occ, placed, mixA) {
  const [mx, my] = v.toScreen(p.marker[0], p.marker[1]);
  const size = Math.round(Math.min(t.base * 1.45, t.base * (0.85 + 0.25 * Math.sqrt(v.scale))));
  const font = `${t.w} ${size}px "Alegreya SC", "Palatino Linotype", Georgia, serif`;
  ctx.font = font;
  const w = ctx.measureText(name).width;
  const k = Math.max(0.55, Math.min(1.6, Math.sqrt(v.scale)));
  const y = my + 8 * k + size * 0.55;
  const box = { x0: mx - w / 2 - 3, x1: mx + w / 2 + 3, y0: y - size * 0.6, y1: y + size * 0.6 };
  if (!occ.fits(box)) return;
  occ.add(box);
  // значок
  occ.add({ x0: mx - 12 * k, x1: mx + 12 * k, y0: my - 14 * k, y1: my + 6 * k });
  textStroke(ctx, name, mx, y, '#f4ead2', 0.95 * mixA);
  placed.push({ id: p.id, x0: Math.min(box.x0, mx - 12 * k), x1: Math.max(box.x1, mx + 12 * k), y0: my - 14 * k, y1: box.y1 });
}

function drawAreaName(ctx, v, p, name, st, occ, placed, mixA, lang) {
  const lines = p.lines && p.lines.length ? p.lines : [{ text: name, x: p.x, y: p.y, angle: 0, size: 8 }];
  // при показе русского названия переносим его на геометрию: одна строка по самой длинной линии
  const useLines = (lang === 'ru' && p.name_ru) || p.renamed
    ? [{ ...lines.reduce((a, b) => ((b.len || 0) > (a.len || 0) ? b : a)), text: name, x: p.x, y: p.y }]
    : lines;
  const boxes = [];
  const draws = [];
  for (const ln of useLines) {
    const size = Math.max(st.lo, Math.min(st.hi, ln.size * 1.05 * v.scale));
    const font = fontFor(st, size);
    const text = ln.text;
    const sp = st.spacing * size;
    const tw = measure(ctx, font, text, st.spacing, size);
    let path;
    if (ln.path && ln.path.length >= 3) {
      path = ln.path.map(([x, y]) => v.toScreen(x, y));
      // читаемость: путь слева направо
      if (path[path.length - 1][0] < path[0][0]) path.reverse();
    } else {
      const a = (ln.angle || 0) * Math.PI / 180;
      const [cx, cy] = v.toScreen(ln.x, ln.y);
      const half = Math.max(tw / 2, ((ln.len || 0) * v.scale) / 2);
      path = [[cx - Math.cos(a) * half, cy - Math.sin(a) * half], [cx + Math.cos(a) * half, cy + Math.sin(a) * half]];
    }
    const { seg, L } = polyMeasure(path);
    // буквы равномерно вдоль пути; если путь длиннее текста — разрядка как на карте (до 2.5×)
    const extra = Math.max(0, Math.min(L - tw, tw * 1.5));
    const chars = [...text];
    const gap = chars.length > 1 ? extra / (chars.length - 1) : 0;
    const start = (L - (tw + extra)) / 2;
    ctx.font = font;
    let t = start;
    const glyphs = [];
    for (const ch of chars) {
      const cw = ctx.measureText(ch).width;
      const [x, y, ang] = polyAt(path, seg, Math.max(0, Math.min(L, t + cw / 2)));
      glyphs.push([ch, x, y, ang]);
      t += cw + sp + gap;
    }
    const circles = glyphs.filter((_, i) => i % 2 === 0).map(([, x, y]) => [x, y, size * 0.7]);
    const xs = glyphs.map(g => g[1]), ys = glyphs.map(g => g[2]);
    const box = { x0: Math.min(...xs) - size, x1: Math.max(...xs) + size, y0: Math.min(...ys) - size, y1: Math.max(...ys) + size, circles };
    if (!occ.fits(box)) return;  // строка не влезла — не рисуем подпись целиком
    boxes.push(box);
    draws.push({ font, glyphs, size });
  }
  for (const b of boxes) occ.add(b);
  const fade = Math.min(1, (v.scale - st.min) / (st.min * 0.6 + 0.02)) * Math.min(1, (st.max - v.scale) / (st.max * 0.3));
  const a = Math.max(0, Math.min(1, fade)) * 0.9 * mixA;
  for (const d of draws) {
    ctx.font = d.font;
    for (const [ch, x, y, ang] of d.glyphs) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      textStroke(ctx, ch, 0, 0, st.color, a);
      ctx.restore();
    }
  }
  const all = boxes.reduce((m, b) => ({ x0: Math.min(m.x0, b.x0), x1: Math.max(m.x1, b.x1), y0: Math.min(m.y0, b.y0), y1: Math.max(m.y1, b.y1) }),
    { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 });
  placed.push({ id: p.id, ...all });
}
