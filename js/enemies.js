// Вражеские отряды: живут только в круге вокруг отряда игроков, бродят, замечают отряд
// (обзором или разведкой), могут заинтересоваться и пойти на перехват.
// Симуляция идёт на экране мастера; игроки видят только тех, кого их отряд заметил.

import { uid } from './state.js?v=b9bdb967';

export const ENEMY_TYPES = [
  { name: 'Бандиты', icon: '🗡️' }, { name: 'Орки', icon: '🪓' }, { name: 'Гоблины', icon: '👺' },
  { name: 'Волки', icon: '🐺' }, { name: 'Нежить', icon: '💀' }, { name: 'Гноллы', icon: '🐾' },
  { name: 'Культисты', icon: '🕯️' }, { name: 'Огр', icon: '👹' }, { name: 'Наёмники', icon: '⚔️' },
  { name: 'Разбойники', icon: '🏹' }, { name: 'Тролль', icon: '🧌' }, { name: 'Дозор', icon: '🛡️' },
];

export function defaultEnemyConfig() {
  return {
    enabled: false,
    count: 6,           // сколько отрядов держать в круге
    radiusKm: 100,      // радиус симуляции вокруг отряда игроков
    spawnMinKm: 15,     // ближе этого новые не появляются
    visionKm: 5,        // обзор противника
    stepKm: 3,          // шаг при блуждании
    chaseMinKm: 3,      // шаг при погоне — случайно в этих пределах
    chaseMaxKm: 7,
    noticeMin: 0.35,    // шанс заметить отряд в зоне обзора — у каждого отряда свой, в этих пределах
    noticeMax: 0.85,
    interestMin: 0.3,   // шанс заинтересоваться замеченным отрядом
    interestMax: 0.9,
    scoutChance: 0.15,  // шанс, что противник проведёт разведку за ход
    scoutKm: 5,         // радиус разведки противника
    playerNotice: 0.8,  // шанс игроков заметить противника в своём обзоре
    trackKm: 10,        // в этом радиусе игроки продолжают видеть уже замеченных
    showVision: true,   // мастеру — круги обзора противников
  };
}

// ---------- местность: вода и провалы непроходимы ----------
export class Terrain {
  constructor(W, H) {
    this.W = W; this.H = H; this.ready = false;
    this.done = Promise.all(['data/t0.png', 'data/t2.png'].map(load)).then(([a, b]) => {
      this.w = a.width; this.h = a.height;
      this.t0 = pixels(a); this.t2 = pixels(b);
      this.ready = true;
    }).catch(e => console.warn('местность для противников не загрузилась', e));
  }
  blocked(x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return true;
    if (!this.ready) return false;
    const i = (Math.floor(y * this.h / this.H) * this.w + Math.floor(x * this.w / this.W)) * 4;
    return this.t0[i] > 132 || this.t2[i + 1] > 132;  // R t0 — вода, G t2 — провал
  }
}
function load(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
function pixels(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
}

const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

// ---------- симуляция ----------
export class EnemySim {
  // ctx: { S(), terrain, kmPerPx(), log(msg, kind), spotted(enemy, how) }
  constructor(ctx) { this.c = ctx; }

  get cfg() { return this.c.S().enemy; }
  km(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) * this.c.S().kmPerPx; }
  px(km) { return km / this.c.S().kmPerPx; }

  // Создать отряд в случайной точке кольца [spawnMinKm, radiusKm] вокруг игроков
  spawn(near) {
    const S = this.c.S(), cfg = this.cfg, P = near || S.party;
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * Math.PI * 2;
      const R = Math.max(1, cfg.radiusKm), m = Math.min(cfg.spawnMinKm, R * 0.5);
      const d = Math.sqrt(rnd((m / R) ** 2, 1)) * R;
      const x = P.x + Math.cos(a) * this.px(d), y = P.y + Math.sin(a) * this.px(d);
      if (this.c.terrain.blocked(x, y)) continue;
      const t = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)];
      return {
        id: uid(), name: t.name, icon: t.icon, x, y,
        heading: Math.random() * 360, chase: false, seen: false, ignore: 0,
        nq: Math.random(), iq: Math.random(),  // место отряда внутри пределов шансов (пределы можно менять)
      };
    }
    return null;
  }

  // Убрать ушедших за круг, добрать до нужного числа
  populate() {
    const S = this.c.S(), cfg = this.cfg;
    if (!cfg.enabled) return;
    const before = S.enemies.length;
    S.enemies = S.enemies.filter(e => e.pinned || this.km(e, S.party) <= cfg.radiusKm * 1.05);
    let guard = 0;
    while (S.enemies.filter(e => !e.pinned).length < cfg.count && guard++ < cfg.count * 3) {
      const e = this.spawn();
      if (e) S.enemies.push(e);
    }
    while (S.enemies.filter(e => !e.pinned).length > cfg.count) {
      // лишние — самые дальние и незамеченные
      const free = S.enemies.filter(e => !e.pinned && !e.seen && !e.chase).sort((a, b) => this.km(b, S.party) - this.km(a, S.party));
      if (!free.length) break;
      S.enemies.splice(S.enemies.indexOf(free[0]), 1);
    }
    return S.enemies.length !== before;
  }

  // Шаг отряда в направлении (градусы, 0 — север), с обходом воды; возвращает пройденные км
  stepToward(e, heading, km) {
    const t = this.c.terrain;
    const tries = [0, 25, -25, 50, -50, 80, -80, 120, -120, 180];
    for (const off of tries) {
      const h = heading + off, a = h * Math.PI / 180;
      // проверяем путь по кусочкам ~1 км, чтобы не перескакивать реки и проливы
      const n = Math.max(1, Math.ceil(km));
      let ok = true;
      for (let i = 1; i <= n; i++) {
        const d = this.px(km * i / n);
        if (t.blocked(e.x + Math.sin(a) * d, e.y - Math.cos(a) * d)) { ok = false; break; }
      }
      if (!ok) continue;
      const d = this.px(km);
      e.x += Math.sin(a) * d; e.y -= Math.cos(a) * d;
      e.heading = (h + 360) % 360;
      return km;
    }
    e.heading = (e.heading + 150 + Math.random() * 60) % 360;  // упёрлись — разворот
    return 0;
  }

  noticeOf(e) { const c = this.cfg; return c.noticeMin + (e.nq ?? 0.5) * (c.noticeMax - c.noticeMin); }
  interestOf(e) { const c = this.cfg; return c.interestMin + (e.iq ?? 0.5) * (c.interestMax - c.interestMin); }

  // Противник в точке (x, y), если там не вода
  makeAt(x, y, extra = {}) {
    if (this.c.terrain.blocked(x, y)) return null;
    const t = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)];
    return { id: uid(), name: t.name, icon: t.icon, x, y, heading: Math.random() * 360, chase: false, seen: false,
      ignore: 0, nq: Math.random(), iq: Math.random(), ...extra };
  }

  // Свободен ли путь по прямой (проверка каждые ~1 км)
  clearPath(a, b) {
    const km = this.km(a, b), n = Math.max(1, Math.ceil(km));
    for (let i = 1; i <= n; i++) if (this.c.terrain.blocked(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n)) return false;
    return true;
  }

  bearingTo(e, p) { return (Math.atan2(p.x - e.x, -(p.y - e.y)) * 180 / Math.PI + 360) % 360; }

  // Противник замечает отряд (обзором или разведкой) и решает, интересно ли
  perceive(e, how) {
    const S = this.c.S();
    if (e.chase) return;
    if (e.ignore > 0) return;
    if (Math.random() >= this.interestOf(e)) {
      e.ignore = 3;  // заметил, но не заинтересовался — какое-то время не обращает внимания
      this.c.log(`${e.name} заметили отряд, но не заинтересовались`, 'info', e);
      return;
    }
    e.chase = true;
    this.c.log(`${e.name} ${how === 'scout' ? 'разведкой нашли' : 'заметили'} отряд и идут на перехват`, 'warn', e);
  }

  // Ход противников (после хода игроков или их ожидания)
  enemyTurn() {
    const S = this.c.S(), cfg = this.cfg, P = S.party;
    if (!cfg.enabled) return;
    for (const e of S.enemies) {
      if (e.frozen) continue;
      if (e.ignore > 0) e.ignore--;
      // восприятие до движения
      if (!e.chase) {
        const d = this.km(e, P);
        if (d <= cfg.visionKm && Math.random() < this.noticeOf(e)) this.perceive(e, 'sight');
        else if (Math.random() < cfg.scoutChance) {
          e.scoutedAt = S.turn;
          if (d <= cfg.scoutKm) this.perceive(e, 'scout');
        }
      }
      if (e.chase) {
        const d = this.km(e, P);
        const step = rnd(cfg.chaseMinKm, cfg.chaseMaxKm);
        const a = Math.atan2(e.x - P.x, e.y - P.y);
        const spot = { x: P.x + Math.sin(a) * this.px(0.4), y: P.y + Math.cos(a) * this.px(0.4) };
        if (step >= d - 0.5 && !this.c.terrain.blocked(spot.x, spot.y) && this.clearPath(e, spot)) {
          // догнали: встаём вплотную
          e.x = spot.x; e.y = spot.y;
          if (!e.contact) this.c.log(`${e.name} настигли отряд!`, 'alarm', e);
          if (!e.seen) { e.seen = true; this.c.spotted(e, 'contact'); }
          e.contact = true;
        } else {
          this.stepToward(e, this.bearingTo(e, P), step);
          e.contact = false;
        }
      } else {
        e.contact = false;
        this.stepToward(e, e.heading + gauss() * 40, cfg.stepKm);
      }
    }
  }

  // Игроки замечают противников: точки пути с обзором visionKm (с шансом) или разведка (гарантированно)
  playerSpot(path, radiusKm, chance, how) {
    const S = this.c.S(), end = path[path.length - 1];
    for (const e of S.enemies) {
      if (e.seen) continue;
      if (this.km(e, end) > this.cfg.trackKm) continue;          // всё равно сразу потеряли бы из виду
      if (how === 'sight' && e.rolledTurn === S.turn) continue;  // уже бросали в этот ход
      if (how === 'sight') e.rolledTurn = S.turn;
      let d = Infinity;
      for (let i = 0; i < path.length; i++) {
        const a = path[i], b = path[i + 1] || a;
        d = Math.min(d, segKm(e, a, b, S.kmPerPx));
      }
      if (d > radiusKm) { if (how === 'sight') e.rolledTurn = -1; continue; }
      if (Math.random() < chance) {
        e.seen = true;
        this.c.spotted(e, how);
      }
    }
  }

  // После всех перемещений: кто ушёл за круг сопровождения — потерян и теряет интерес
  track() {
    const S = this.c.S(), cfg = this.cfg;
    for (const e of S.enemies) {
      const d = this.km(e, S.party);
      if (d > cfg.trackKm) {
        if (e.seen) { e.seen = false; this.c.log(`${e.name} скрылись из виду`, 'info', e); }
        if (e.chase) { e.chase = false; e.ignore = 2; this.c.log(`${e.name} потеряли след отряда`, 'info', e); }
      }
    }
  }
}

function segKm(e, a, b, k) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((e.x - a.x) * dx + (e.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(e.x - a.x - dx * t, e.y - a.y - dy * t) * k;
}

// ---------- отрисовка ----------
export function enemyLayer(getState, { player = false, onlySeen = false } = {}) {
  return {
    draw(ctx, v) {
      const S = getState();
      const cfg = S.enemy;
      if (!cfg || !cfg.enabled || !S.enemies) return;
      const kpp = S.kmPerPx;
      const [px, py] = v.toScreen(S.party.x, S.party.y);
      ctx.save();
      if (!player) {
        // круг симуляции и круг сопровождения
        ctx.setLineDash([10, 8]); ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(200,60,50,0.35)';
        ctx.beginPath(); ctx.arc(px, py, cfg.radiusKm / kpp * v.scale, 0, 7); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,200,90,0.45)';
        ctx.beginPath(); ctx.arc(px, py, cfg.trackKm / kpp * v.scale, 0, 7); ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const e of S.enemies) {
        if (onlySeen && !e.seen) continue;
        const [x, y] = v.toScreen(e.x, e.y);
        if (x < -60 || y < -60 || x > v.vw + 60 || y > v.vh + 60) continue;
        if (!player && cfg.showVision) {
          ctx.fillStyle = 'rgba(200,50,40,0.08)';
          ctx.strokeStyle = 'rgba(200,50,40,0.45)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, cfg.visionKm / kpp * v.scale, 0, 7); ctx.fill(); ctx.stroke();
        }
        if (e.chase && (!player || e.seen)) {
          // стрелка к отряду игроков
          const a = Math.atan2(py - y, px - x), L = Math.min(Math.hypot(px - x, py - y) - 18, 46);
          if (L > 8) {
            ctx.strokeStyle = 'rgba(230,60,40,0.9)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 16, y + Math.sin(a) * 16);
            const tx = x + Math.cos(a) * (16 + L), ty = y + Math.sin(a) * (16 + L);
            ctx.lineTo(tx, ty); ctx.stroke();
            ctx.fillStyle = 'rgba(230,60,40,0.9)';
            ctx.beginPath();
            ctx.moveTo(tx + Math.cos(a) * 8, ty + Math.sin(a) * 8);
            ctx.lineTo(tx + Math.cos(a + 2.5) * 8, ty + Math.sin(a + 2.5) * 8);
            ctx.lineTo(tx + Math.cos(a - 2.5) * 8, ty + Math.sin(a - 2.5) * 8);
            ctx.fill();
          }
        }
        // знамя
        ctx.globalAlpha = !player && !e.seen ? 0.8 : 1;
        ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6;
        ctx.fillStyle = e.chase ? '#8e1f17' : '#4a1d18';
        ctx.strokeStyle = e.seen ? '#f2c14e' : '#1b0d0a';
        ctx.lineWidth = e.seen && !player ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(x - 12, y - 14); ctx.lineTo(x + 12, y - 14); ctx.lineTo(x + 12, y + 6);
        ctx.lineTo(x, y + 14); ctx.lineTo(x - 12, y + 6); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.font = '14px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(e.icon || '⚔️', x, y - 3);
        if (v.scale > 0.5 || e.seen) {
          ctx.font = '600 12px "Alegreya SC", Georgia, serif';
          ctx.textBaseline = 'top';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(18,13,8,0.85)';
          const label = e.name + (!player && e.chase ? ' ⚔' : '');
          ctx.strokeText(label, x, y + 16);
          ctx.fillStyle = e.chase ? '#ffb4a8' : '#f0d9c8';
          ctx.fillText(label, x, y + 16);
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    },
  };
}
