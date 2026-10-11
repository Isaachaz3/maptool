// Туман войны.
// Точные данные — список фигур (круги и «капсулы» вдоль пути) поверх растровой подложки.
// WebGL рисует фигуры с точностью экрана на любом зуме; подложка — старый растровый туман
// (1/4 разрешения карты) и результат «открыть/скрыть всё». Растровая копия с фигурами
// (canvas) нужна только для запасного 2D-режима без WebGL.

export const FOG_COLOR = '#11131a';
const CELL = 32; // ячейка пространственного индекса, px карты

export class Fog {
  constructor(W, H, k = 0.25) {
    this.W = W; this.H = H; this.k = k;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = Math.ceil(W * k); c.height = Math.ceil(H * k);
      return c;
    };
    this.base = mk();           // подложка без фигур
    this.baseCtx = this.base.getContext('2d', { willReadFrequently: true });
    this.canvas = mk();         // подложка + фигуры, грубо (запасной режим)
    this.ctx = this.canvas.getContext('2d');
    this.ops = [];              // { x0, y0, x1, y1, r, rev }
    this.grid = new Map();
    this.version = 0;
    this.baseVersion = 0;
    this.baseURL = null;
    this.fill(false);
  }

  // ---------- подложка ----------
  fill(reveal) {
    for (const c of [this.baseCtx, this.ctx]) {
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, this.base.width, this.base.height);
      if (!reveal) { c.fillStyle = FOG_COLOR; c.fillRect(0, 0, this.base.width, this.base.height); }
    }
    this.ops = [];
    this.grid.clear();
    this.baseChanged();
  }

  baseChanged() {
    this.version++;
    this.baseVersion++;
    this.baseURL = null;
    this.basePixels = null;
  }

  // ---------- фигуры ----------
  apply(op) {
    if (op.k === 'all') { this.fill(op.reveal); return; }
    const o = op.k === 'circle'
      ? { x0: op.x, y0: op.y, x1: op.x, y1: op.y, r: op.r, rev: !!op.reveal }
      : { x0: op.x0, y0: op.y0, x1: op.x1, y1: op.y1, r: op.r, rev: !!op.reveal };
    this.addOp(o);
    this.rasterOp(o);
    this.version++;
  }

  addOp(o) {
    const i = this.ops.length;
    this.ops.push(o);
    const x0 = Math.floor((Math.min(o.x0, o.x1) - o.r) / CELL), x1 = Math.floor((Math.max(o.x0, o.x1) + o.r) / CELL);
    const y0 = Math.floor((Math.min(o.y0, o.y1) - o.r) / CELL), y1 = Math.floor((Math.max(o.y0, o.y1) + o.r) / CELL);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const key = gx * 100003 + gy;
      let l = this.grid.get(key);
      if (!l) this.grid.set(key, l = []);
      l.push(i);
    }
  }

  // грубая растровая копия для режима без WebGL
  rasterOp(o) {
    const c = this.ctx, k = this.k;
    c.save();
    c.globalCompositeOperation = o.rev ? 'destination-out' : 'source-over';
    c.strokeStyle = c.fillStyle = o.rev ? '#000' : FOG_COLOR;
    c.lineCap = 'round';
    c.lineWidth = Math.max(1.5, o.r * k * 2);
    c.beginPath();
    c.moveTo(o.x0 * k, o.y0 * k);
    c.lineTo(o.x1 * k + 0.01, o.y1 * k);
    c.stroke();
    c.restore();
  }

  // Скрыта ли точка туманом: решает последняя фигура, накрывающая точку, иначе — подложка
  hiddenAt(x, y) {
    const l = this.grid.get(Math.floor(x / CELL) * 100003 + Math.floor(y / CELL));
    if (l) {
      for (let j = l.length - 1; j >= 0; j--) {
        const o = this.ops[l[j]];
        if (segDist(x, y, o) <= o.r * 0.85) return !o.rev;
      }
    }
    if (!this.basePixels) this.basePixels = this.baseCtx.getImageData(0, 0, this.base.width, this.base.height).data;
    const X = Math.floor(x * this.k), Y = Math.floor(y * this.k);
    if (X < 0 || Y < 0 || X >= this.base.width || Y >= this.base.height) return true;
    return this.basePixels[(Y * this.base.width + X) * 4 + 3] > 140;
  }

  // ---------- сохранение ----------
  serialize() {
    if (!this.baseURL) this.baseURL = this.base.toDataURL('image/png');
    const r1 = v => Math.round(v * 10) / 10;
    const ops = this.ops.map(o => (o.x0 === o.x1 && o.y0 === o.y1)
      ? [0, r1(o.x0), r1(o.y0), r1(o.r), o.rev ? 1 : 0]
      : [1, r1(o.x0), r1(o.y0), r1(o.x1), r1(o.y1), r1(o.r), o.rev ? 1 : 0]);
    return JSON.stringify({ v: 2, base: this.baseURL, ops });
  }

  // Принимает и новый формат (JSON), и старый (data:URL растра)
  async load(data) {
    if (!data) return false;
    let base = data, ops = [];
    if (data[0] === '{') {
      try { const d = JSON.parse(data); base = d.base; ops = d.ops || []; } catch { return false; }
    }
    const ok = await new Promise(res => {
      if (!base) return res(true);
      const img = new Image();
      img.onload = () => {
        for (const c of [this.baseCtx, this.ctx]) {
          c.globalCompositeOperation = 'source-over';
          c.clearRect(0, 0, this.base.width, this.base.height);
          c.drawImage(img, 0, 0, this.base.width, this.base.height);
        }
        res(true);
      };
      img.onerror = () => res(false);
      img.src = base;
    });
    if (!ok) return false;
    this.ops = [];
    this.grid.clear();
    this.baseChanged();
    this.baseURL = base && base.startsWith('data:') ? base : null;
    for (const a of ops) {
      const o = a[0] === 0
        ? { x0: a[1], y0: a[2], x1: a[1], y1: a[2], r: a[3], rev: !!a[4] }
        : { x0: a[1], y0: a[2], x1: a[3], y1: a[4], r: a[5], rev: !!a[6] };
      this.addOp(o);
      this.rasterOp(o);
    }
    this.version++;
    return true;
  }

  // Слой для Viewer без WebGL: рисуется в координатах карты.
  layer(getOpacity, isEnabled) {
    return {
      space: 'map',
      draw: (ctx, v) => {
        if (v.renderer || !isEnabled()) return;
        const a = getOpacity();
        if (a <= 0) return;
        ctx.globalAlpha = a;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.canvas, 0, 0, this.W, this.H);
        const r = v.viewRect(), e = 1 / this.k;
        ctx.fillStyle = FOG_COLOR;
        ctx.beginPath();
        ctx.rect(Math.min(r.x, 0) - 10, Math.min(r.y, 0) - 10,
          Math.max(r.x + r.w, this.W) - Math.min(r.x, 0) + 20, Math.max(r.y + r.h, this.H) - Math.min(r.y, 0) + 20);
        ctx.rect(e, e, this.W - 2 * e, this.H - 2 * e);
        ctx.fill('evenodd');
      },
    };
  }
}

function segDist(x, y, o) {
  const dx = o.x1 - o.x0, dy = o.y1 - o.y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - o.x0) * dx + (y - o.y0) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - o.x0 - dx * t, y - o.y0 - dy * t);
}
