// Общие слои для экрана мастера и экрана игроков (рисуют в экранных координатах).
import { fmtKm, rumb } from './state.js';

export function trailLayer(getState, visible = () => true) {
  return {
    draw(ctx, v) {
      const s = getState();
      if (!visible() || s.trail.length < 2) return;
      ctx.lineJoin = ctx.lineCap = 'round';
      const path = () => {
        ctx.beginPath();
        s.trail.forEach((p, i) => {
          const [x, y] = v.toScreen(p.x, p.y);
          if (i === 0 || p.jump) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
      };
      path();
      ctx.strokeStyle = 'rgba(40,20,10,0.55)';
      ctx.lineWidth = 5;
      ctx.stroke();
      path();
      ctx.strokeStyle = '#d23c2a';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      // точки ходов — только при достаточном приближении
      if (v.scale * 6 / getState().kmPerPx > 10) {
        ctx.fillStyle = '#d23c2a';
        for (const p of s.trail) {
          const [x, y] = v.toScreen(p.x, p.y);
          ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
        }
      }
    },
  };
}

export function waypointLayer(getWaypoints, { selectedId = () => null } = {}) {
  return {
    draw(ctx, v) {
      const r = v.viewRect();
      for (const w of getWaypoints()) {
        if (w.x < r.x - 200 || w.y < r.y - 200 || w.x > r.x + r.w + 200 || w.y > r.y + r.h + 200) continue;
        const [x, y] = v.toScreen(w.x, w.y);
        const sel = selectedId() === w.id;
        // булавка
        ctx.save();
        ctx.globalAlpha = w.visible === false ? 0.65 : 1;
        ctx.fillStyle = w.color || '#c0392b';
        ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.7)';
        ctx.lineWidth = sel ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x - 4, y - 8, x - 14, y - 14, x - 14, y - 26);
        ctx.arc(x, y - 26, 14, Math.PI, 0);
        ctx.bezierCurveTo(x + 14, y - 14, x + 4, y - 8, x, y);
        ctx.fill(); ctx.stroke();
        ctx.font = '15px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(w.icon || '★', x, y - 26);
        if (w.name) {
          ctx.font = '600 14px Georgia, "Times New Roman", serif';
          ctx.textBaseline = 'top';
          ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(250,244,230,0.92)';
          ctx.strokeText(w.name, x, y + 4);
          ctx.fillStyle = '#2a1a10';
          ctx.fillText(w.name, x, y + 4);
        }
        if (w.visible === false) {
          ctx.font = '12px sans-serif';
          ctx.fillText('🙈', x + 16, y - 40);
        }
        ctx.restore();
      }
    },
  };
}

export function partyLayer(getState) {
  return {
    draw(ctx, v) {
      const s = getState();
      const [x, y] = v.toScreen(s.party.x, s.party.y);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8;
      ctx.fillStyle = '#f2c14e';
      ctx.strokeStyle = '#3b2412'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 13, 0, 7); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.font = '15px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⚔️', x, y + 1);
      if (s.partyName) {
        ctx.font = '700 14px Georgia, serif';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(250,244,230,0.95)';
        ctx.strokeText(s.partyName, x, y + 17);
        ctx.fillStyle = '#3b2412';
        ctx.fillText(s.partyName, x, y + 17);
      }
      ctx.restore();
    },
  };
}

// Пинги: расходящиеся круги на 2.5 секунды
export function pingLayer() {
  const pings = [];
  return {
    pings,
    add(x, y, color = '#ffdd33') { pings.push({ x, y, color, t0: performance.now() }); },
    animating: () => pings.length > 0,
    draw(ctx, v, now) {
      for (let i = pings.length - 1; i >= 0; i--) {
        const p = pings[i], t = (now - p.t0) / 2500;
        if (t >= 1) { pings.splice(i, 1); continue; }
        const [x, y] = v.toScreen(p.x, p.y);
        for (let k = 0; k < 3; k++) {
          const tt = (t * 2 + k / 3) % 1;
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = (1 - tt) * (1 - t * 0.5);
          ctx.lineWidth = 4;
          ctx.beginPath(); ctx.arc(x, y, 8 + tt * 60, 0, 7); ctx.stroke();
        }
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
      }
    },
  };
}

// Линейка: отрезок с подписью расстояния и азимута
export function drawRuler(ctx, v, a, b, kmPerPx, color = '#ffffff') {
  const [x0, y0] = v.toScreen(a.x, a.y), [x1, y1] = v.toScreen(b.x, b.y);
  const km = Math.hypot(b.x - a.x, b.y - a.y) * kmPerPx;
  const brg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash([10, 6]);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  for (const [x, y] of [[x0, y0], [x1, y1]]) { ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
  const label = `${fmtKm(km)} · ${Math.round(brg)}° ${rumb(brg)}`;
  ctx.font = '600 14px system-ui, sans-serif';
  const w = ctx.measureText(label).width + 14;
  const lx = x1 + 12, ly = y1 - 30;
  ctx.fillStyle = 'rgba(20,22,30,0.85)';
  roundRect(ctx, lx, ly, w, 24, 6); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(label, lx + 7, ly + 12);
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Масштабная линейка в углу экрана
export function scaleBarLayer(getKmPerPx, { corner = 'bl' } = {}) {
  return {
    draw(ctx, v) {
      const kmPerScreenPx = getKmPerPx() / v.scale;
      const target = 160 * kmPerScreenPx;
      const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
      let km = nice[0];
      for (const n of nice) if (n <= target) km = n;
      const w = km / kmPerScreenPx;
      const x = corner === 'bl' ? 16 : v.vw - w - 16, y = v.vh - 22;
      ctx.fillStyle = 'rgba(250,244,230,0.85)';
      roundRect(ctx, x - 8, y - 22, w + 16, 36, 6); ctx.fill();
      ctx.fillStyle = '#5a1e14';
      ctx.fillRect(x, y, w / 2, 6);
      ctx.fillStyle = '#fff'; ctx.fillRect(x + w / 2, y, w / 2, 6);
      ctx.strokeStyle = '#2a1a10'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, 6);
      ctx.fillStyle = '#2a1a10'; ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'bottom'; ctx.textAlign = 'left'; ctx.fillText('0', x, y - 2);
      ctx.textAlign = 'right'; ctx.fillText(`${km} км`, x + w, y - 2);
    },
  };
}

// Значки поселений, найденные разметкой: маленькие рисованные городки в духе BB
export function settlementLayer(getState, fog, { player = false } = {}) {
  let pts = [];
  fetch('data/settlements.json').then(r => r.json()).then(d => { pts = d; }).catch(() => {});
  return {
    draw(ctx, v) {
      const S = getState();
      if (!S.showSettlements || !v.renderer || v.scale < 0.25) return;
      const a = Math.min(1, (v.scale - 0.25) / 0.25) * Math.max(0, 1 - S.styleMix * 1.6);
      if (a <= 0.02) return;
      const r = v.viewRect();
      ctx.globalAlpha = a;
      const k = Math.max(0.55, Math.min(1.6, Math.sqrt(v.scale)));
      for (const p of pts) {
        if (p.x < r.x - 20 || p.y < r.y - 20 || p.x > r.x + r.w + 20 || p.y > r.y + r.h + 20) continue;
        if (player && S.fogEnabled && fog.hiddenAt(p.x, p.y)) continue;
        const [x, y] = v.toScreen(p.x, p.y);
        drawTown(ctx, x, y, k, p.type, (p.x * 7 + p.y * 13) | 0);
      }
      ctx.globalAlpha = 1;
    },
  };
}

const ROOFS = ['#3d4a5c', '#5a3326', '#4a4036'];
function house(ctx, x, y, w, h, roof) {
  ctx.fillStyle = '#8a7356';
  ctx.fillRect(x - w / 2, y - h * 0.45, w, h * 0.55);
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(x - w * 0.62, y - h * 0.4); ctx.lineTo(x, y - h); ctx.lineTo(x + w * 0.62, y - h * 0.4);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(20,14,8,0.8)'; ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeRect(x - w / 2, y - h * 0.45, w, h * 0.55);
}

function drawTown(ctx, x, y, k, type, seed) {
  ctx.save();
  // тень
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(x + 2 * k, y + 2 * k, 9 * k, 4 * k, 0, 0, 7); ctx.fill();
  const roof = ROOFS[Math.abs(seed) % 3];
  if (type === 'city') {
    // стена-кольцо с башнями и домами внутри
    ctx.fillStyle = '#6f5d48'; ctx.strokeStyle = 'rgba(20,14,8,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(x, y - 2 * k, 11 * k, 7 * k, 0, 0, 7); ctx.fill(); ctx.stroke();
    house(ctx, x - 4 * k, y - 2 * k, 6 * k, 8 * k, roof);
    house(ctx, x + 4 * k, y - 3 * k, 6 * k, 9 * k, ROOFS[(Math.abs(seed) + 1) % 3]);
    house(ctx, x, y + 1 * k, 5 * k, 7 * k, roof);
    for (const dx of [-11, 11]) {
      ctx.fillStyle = '#7d6a52';
      ctx.fillRect(x + dx * k - 2 * k, y - 8 * k, 4 * k, 8 * k);
      ctx.strokeRect(x + dx * k - 2 * k, y - 8 * k, 4 * k, 8 * k);
      ctx.fillStyle = roof;
      ctx.beginPath(); ctx.moveTo(x + dx * k - 3 * k, y - 8 * k); ctx.lineTo(x + dx * k, y - 12 * k); ctx.lineTo(x + dx * k + 3 * k, y - 8 * k); ctx.fill();
    }
  } else if (type === 'castle') {
    ctx.fillStyle = '#7d6a52'; ctx.strokeStyle = 'rgba(20,14,8,0.9)'; ctx.lineWidth = 1.2;
    ctx.fillRect(x - 6 * k, y - 7 * k, 12 * k, 8 * k); ctx.strokeRect(x - 6 * k, y - 7 * k, 12 * k, 8 * k);
    for (const dx of [-6, 0, 6]) {
      const hh = dx === 0 ? 14 : 10;
      ctx.fillStyle = '#8a775d';
      ctx.fillRect(x + dx * k - 2 * k, y - hh * k, 4 * k, hh * k); ctx.strokeRect(x + dx * k - 2 * k, y - hh * k, 4 * k, hh * k);
      ctx.fillStyle = roof;
      ctx.beginPath(); ctx.moveTo(x + dx * k - 3 * k, y - hh * k); ctx.lineTo(x + dx * k, y - (hh + 4) * k); ctx.lineTo(x + dx * k + 3 * k, y - hh * k); ctx.fill();
    }
  } else {
    house(ctx, x - 3 * k, y, 6 * k, 8 * k, roof);
    house(ctx, x + 3.5 * k, y + 1.5 * k, 5 * k, 6.5 * k, ROOFS[(Math.abs(seed) + 2) % 3]);
  }
  ctx.restore();
}
