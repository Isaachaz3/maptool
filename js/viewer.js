// Тайловый просмотрщик карты: панорама, зум, слои поверх карты.
// Все координаты карты — в пикселях исходного изображения (уровень 0).

const SEA = '#bed8e7';

export class Viewer {
  constructor(canvas, info, { base = 'tiles/' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.info = info;
    this.base = base;
    this.W = info.width;
    this.H = info.height;
    this.T = info.tileSize;
    this.levels = [];
    let lw = info.width, lh = info.height;
    for (let i = 0; i < info.levels; i++) {
      this.levels.push({ w: lw, h: lh, fx: this.W / lw, fy: this.H / lh,
        cols: Math.ceil(lw / this.T), rows: Math.ceil(lh / this.T) });
      lw = Math.max(1, Math.floor(lw / 2));
      lh = Math.max(1, Math.floor(lh / 2));
    }
    this.cache = new Map();
    this.frame = 0;
    this.cx = this.W / 2;
    this.cy = this.H / 2;
    this.scale = 0.2;
    this.maxScale = 24;
    this.layers = [];          // (ctx, viewer) => void, рисуют в экранных координатах
    this.tool = null;          // { down, move, up, hover, leave, cursor }
    this.onViewChange = null;
    this.panButtons = new Set([1, 2]); // средняя и правая кнопки всегда двигают карту
    this.anim = null;
    this.dirty = true;
    this.pointers = new Map();
    this.spaceDown = false;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bindEvents();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    // Самые грубые уровни грузим сразу — это подложка, пока не подгрузятся детальные.
    for (let l = Math.max(0, this.levels.length - 3); l < this.levels.length; l++) {
      const L = this.levels[l];
      for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) this.tile(l, c, r);
    }
  }

  // ---------- геометрия ----------
  get vw() { return this.canvas.clientWidth; }
  get vh() { return this.canvas.clientHeight; }
  toScreen(x, y) { return [(x - this.cx) * this.scale + this.vw / 2, (y - this.cy) * this.scale + this.vh / 2]; }
  toMap(sx, sy) { return [(sx - this.vw / 2) / this.scale + this.cx, (sy - this.vh / 2) / this.scale + this.cy]; }
  get minScale() { return Math.min(this.vw / this.W, this.vh / this.H) * 0.8; }
  viewRect() {
    const [x0, y0] = this.toMap(0, 0), [x1, y1] = this.toMap(this.vw, this.vh);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.invalidate();
  }

  invalidate() { this.dirty = true; }

  setView(cx, cy, scale, notify = true) {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, scale));
    this.cx = Math.min(this.W, Math.max(0, cx));
    this.cy = Math.min(this.H, Math.max(0, cy));
    this.invalidate();
    if (notify && this.onViewChange) this.onViewChange();
  }

  zoomAt(sx, sy, factor) {
    this.anim = null;
    const [mx, my] = this.toMap(sx, sy);
    const ns = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    // точка под курсором остаётся на месте
    const cx = mx - (sx - this.vw / 2) / ns;
    const cy = my - (sy - this.vh / 2) / ns;
    this.setView(cx, cy, ns);
  }

  fitRect(x, y, w, h, pad = 1) {
    const s = Math.min(this.vw / (w * pad), this.vh / (h * pad));
    return { cx: x + w / 2, cy: y + h / 2, scale: s };
  }

  animateTo(cx, cy, scale, ms = 600) {
    if (ms <= 0) { this.setView(cx, cy, scale); return; }
    const from = { cx: this.cx, cy: this.cy, ls: Math.log(this.scale) };
    const to = { cx, cy, ls: Math.log(Math.min(this.maxScale, Math.max(this.minScale, scale))) };
    this.anim = { from, to, t0: performance.now(), ms };
    this.invalidate();
  }

  // ---------- тайлы ----------
  tile(l, c, r) {
    const key = `${l}/${c}_${r}`;
    let t = this.cache.get(key);
    if (!t) {
      const img = new Image();
      t = { img, ok: false, used: this.frame, l };
      img.onload = () => { t.ok = true; this.invalidate(); };
      img.onerror = () => { t.err = true; };
      img.src = `${this.base}${key}.jpg`;
      this.cache.set(key, t);
    }
    t.used = this.frame;
    return t;
  }

  drawLevel(ctx, l, rect, load) {
    const L = this.levels[l];
    const tw = this.T * L.fx, th = this.T * L.fy;
    const c0 = Math.max(0, Math.floor(rect.x / tw)), c1 = Math.min(L.cols - 1, Math.floor((rect.x + rect.w) / tw));
    const r0 = Math.max(0, Math.floor(rect.y / th)), r1 = Math.min(L.rows - 1, Math.floor((rect.y + rect.h) / th));
    const bleed = 0.5 / this.scale; // перекрытие против щелей между тайлами
    let missing = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let t;
        if (load) t = this.tile(l, c, r);
        else {
          t = this.cache.get(`${l}/${c}_${r}`);
          if (t) t.used = this.frame;
        }
        if (!t || !t.ok) { missing++; continue; }
        const x = c * tw, y = r * th;
        const w = t.img.naturalWidth * L.fx, h = t.img.naturalHeight * L.fy;
        ctx.drawImage(t.img, x, y, w + bleed, h + bleed);
      }
    }
    return missing;
  }

  evict() {
    if (this.cache.size < 350) return;
    const keep = this.levels.length - 3;
    const items = [...this.cache.entries()].filter(([, t]) => t.l < keep && t.used < this.frame - 30)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [k, t] of items.slice(0, this.cache.size - 250)) {
      t.img.src = '';
      this.cache.delete(k);
    }
  }

  // ---------- отрисовка ----------
  loop(now) {
    if (this.anim) {
      const a = this.anim;
      let k = Math.min(1, (now - a.t0) / a.ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.setView(a.from.cx + (a.to.cx - a.from.cx) * e, a.from.cy + (a.to.cy - a.from.cy) * e,
        Math.exp(a.from.ls + (a.to.ls - a.from.ls) * e), k >= 1);
      if (k >= 1) this.anim = null;
    }
    // постоянная анимация (облака, туман) идёт с ограничением кадров, действия пользователя — сразу
    const anim = this.continuous && now - (this.lastDraw || 0) >= 1000 / (this.fps || 30) - 2;
    if (this.dirty || anim) {
      this.dirty = false;
      this.lastDraw = now;
      this.draw(now);
    }
    requestAnimationFrame(this.loop);
  }

  // Слой может попросить постоянную перерисовку (анимации пингов и т.п.)
  set continuous(v) { this._cont = v; }
  get continuous() {
    return this._cont || (this.renderer && this.renderer.animating()) || this.layers.some(l => l.animating && l.animating());
  }

  draw(now) {
    this.frame++;
    const ctx = this.ctx, dpr = this.dpr, s = this.scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.renderer) {
      // карту рисует WebGL на нижнем холсте, здесь только оверлеи
      ctx.clearRect(0, 0, this.vw, this.vh);
      this.renderer.render(now);
    } else {
      ctx.fillStyle = SEA;
      ctx.fillRect(0, 0, this.vw, this.vh);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (this.vw / 2 - this.cx * s), dpr * (this.vh / 2 - this.cy * s));
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const rect = this.viewRect();
      const eff = s * dpr;
      const target = Math.max(0, Math.min(this.levels.length - 1, Math.floor(Math.log2(1 / eff))));
      // подложка: самый грубый уровень целиком, затем уже загруженные промежуточные
      for (let l = this.levels.length - 1; l > target; l--) this.drawLevel(ctx, l, rect, false);
      this.drawLevel(ctx, target, rect, true);
    }

    for (const layer of this.layers) {
      ctx.save();
      if (layer.space === 'map') {
        layer.draw(ctx, this, now);
      } else {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        layer.draw(ctx, this, now);
      }
      ctx.restore();
    }
    if (this.frame % 60 === 0) this.evict();
  }

  // ---------- ввод ----------
  bindEvents() {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-d * 0.0015));
    }, { passive: false });

    window.addEventListener('keydown', e => { if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; this.updateCursor(); } });
    window.addEventListener('keyup', e => { if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); } });

    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      const p = { sx: e.clientX - r.left, sy: e.clientY - r.top };
      this.pointers.set(e.pointerId, p);
      this.anim = null;
      if (this.pointers.size === 2) {
        // начало щипка — отменяем действие инструмента
        if (this.drag && this.drag.tool && this.tool && this.tool.cancel) this.tool.cancel();
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy), mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2 };
        this.drag = null;
        return;
      }
      const mp = this.toMap(p.sx, p.sy);
      const wantsPan = this.panButtons.has(e.button) || this.spaceDown || !this.tool;
      if (!wantsPan && this.tool.down && this.tool.down(mp, e) !== false) {
        this.drag = { tool: true };
      } else {
        this.drag = { pan: true, sx: p.sx, sy: p.sy, cx: this.cx, cy: this.cy, moved: 0, button: e.button, mp, e };
      }
      this.updateCursor();
    });

    c.addEventListener('pointermove', e => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { sx, sy });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.sx - b.sx, a.sy - b.sy);
        const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
        this.cx -= (mx - this.pinch.mx) / this.scale;
        this.cy -= (my - this.pinch.my) / this.scale;
        this.zoomAt(mx, my, d / this.pinch.d);
        this.pinch = { d, mx, my };
        return;
      }
      const mp = this.toMap(sx, sy);
      this.mouse = mp;
      if (this.drag && this.drag.pan) {
        const dx = sx - this.drag.sx, dy = sy - this.drag.sy;
        this.drag.moved = Math.max(this.drag.moved, Math.hypot(dx, dy));
        this.setView(this.drag.cx - dx / this.scale, this.drag.cy - dy / this.scale, this.scale);
      } else if (this.drag && this.drag.tool) {
        this.tool.move && this.tool.move(mp, e);
      } else if (this.tool && this.tool.hover) {
        this.tool.hover(mp, e);
      }
      if (this.onHover) this.onHover(mp);
    });

    const end = e => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const r = c.getBoundingClientRect();
      const mp = this.toMap(e.clientX - r.left, e.clientY - r.top);
      if (this.drag && this.drag.tool) {
        this.tool.up && this.tool.up(mp, e);
      } else if (this.drag && this.drag.pan && this.drag.moved < 4 && this.onClick && e.type === 'pointerup') {
        // клик без перетаскивания в режиме обзора
        this.onClick(mp, this.drag.e);
      }
      this.drag = null;
      this.updateCursor();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.mouse = null; this.tool && this.tool.leave && this.tool.leave(); this.invalidate(); });
  }

  updateCursor() {
    let cur = 'grab';
    if (this.drag && this.drag.pan) cur = 'grabbing';
    else if (!this.spaceDown && this.tool && this.tool.cursor) cur = this.tool.cursor;
    this.canvas.style.cursor = cur;
  }
}

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export async function loadInfo(base = 'tiles/') {
  const r = await fetch(base + 'info.json');
  return r.json();
}
