// Туман войны: маска в пониженном разрешении (1/4 карты), непрозрачное = скрыто.

export const FOG_COLOR = '#11131a';

export class Fog {
  constructor(W, H, k = 0.25) {
    this.W = W; this.H = H; this.k = k;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.ceil(W * k);
    this.canvas.height = Math.ceil(H * k);
    this.ctx = this.canvas.getContext('2d');
    this.fill(false);
  }

  fill(reveal) {
    const c = this.ctx;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!reveal) {
      c.fillStyle = FOG_COLOR;
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  // Мягкая круглая кисть. x, y, r — в пикселях карты.
  stamp(x, y, r, reveal) {
    const c = this.ctx, k = this.k;
    const X = x * k, Y = y * k, R = Math.max(1.5, r * k);
    const g = c.createRadialGradient(X, Y, R * 0.6, X, Y, R);
    if (reveal) {
      c.globalCompositeOperation = 'destination-out';
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      c.globalCompositeOperation = 'source-over';
      g.addColorStop(0, hexA(FOG_COLOR, 1));
      g.addColorStop(1, hexA(FOG_COLOR, 0));
    }
    c.fillStyle = g;
    c.beginPath();
    c.arc(X, Y, R, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
  }

  line(x0, y0, x1, y1, r, reveal) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(1, r / 4);
    const n = Math.max(1, Math.ceil(d / step));
    for (let i = 1; i <= n; i++) this.stamp(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, r, reveal);
  }

  apply(op) {
    if (op.k === 'all') this.fill(op.reveal);
    else if (op.k === 'circle') this.stamp(op.x, op.y, op.r, op.reveal);
    else if (op.k === 'line') this.line(op.x0, op.y0, op.x1, op.y1, op.r, op.reveal);
  }

  toDataURL() { return this.canvas.toDataURL('image/png'); }

  load(url) {
    return new Promise(res => {
      if (!url) return res(false);
      const img = new Image();
      img.onload = () => {
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
        res(true);
      };
      img.onerror = () => res(false);
      img.src = url;
    });
  }

  // Слой для Viewer: рисуется в координатах карты.
  layer(getOpacity, isEnabled) {
    return {
      space: 'map',
      draw: (ctx, v) => {
        if (!isEnabled()) return;
        const a = getOpacity();
        if (a <= 0) return;
        ctx.globalAlpha = a;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.canvas, 0, 0, this.W, this.H);
        // за пределами карты тоже туман, чтобы край не «светился»; одной фигурой без наложений.
        // Внутренний прямоугольник чуть утоплен в карту — прячет шов на краю маски.
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

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
