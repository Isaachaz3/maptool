// Экран мастера.
import { Viewer, loadInfo, isTyping } from './viewer.js?v=b9bdb967';
import { Fog } from './fog.js?v=b9bdb967';
import {
  loadState, saveState, loadFogData, saveFogData, loadView, saveView, clearAll, channel,
  stepPoint, bearingTo, distKm, rumb, fmtKm, uid, defaultState,
} from './state.js?v=b9bdb967';
import { trailLayer, waypointLayer, partyLayer, pingLayer, drawRuler, scaleBarLayer, settlementLayer } from './layers.js?v=b9bdb967';
import { EnemySim, Terrain, enemyLayer, defaultEnemyConfig } from './enemies.js?v=b9bdb967';
import { MapRenderer } from './gl.js?v=b9bdb967';
import { Places, placeLabelLayer, KIND_NAMES, wikiSummary, wikiUrl } from './places.js?v=b9bdb967';
import { renderSettings } from './state.js?v=b9bdb967';

const $ = id => document.getElementById(id);
const ICONS = ['★', '🏰', '🏘️', '⛺', '⚔️', '💀', '🐉', '🗝️', '💰', '❓', '❗', '⛪', '🌲', '⛰️', '🕳️', '⚓', '🔥', '👁️'];

const info = await loadInfo();
let S = loadState();
normalizeEnemies();
function normalizeEnemies() {
  S.enemy = { ...defaultEnemyConfig(), ...(S.enemy || {}) };
  S.enemies = S.enemies || [];
  S.enemyUndo = S.enemyUndo || [];
  S.enemyLog = S.enemyLog || [];
}
const viewer = new Viewer($('map'), info);
const fog = new Fog(info.width, info.height);
window.mapViewer = viewer; // для отладки из консоли
const bc = channel();
const pings = pingLayer();
const places = new Places();
places.ready.then(() => { places.merge(S); renderEnc(); viewer.invalidate(); });
startRenderer();
function startRenderer() {
  try {
    // старые растровые подписи — только пока нет газеттира (data/places.json)
    viewer.renderer = new MapRenderer($('gl'), viewer, fog, {
      getSettings: () => ({ ...renderSettings(S, false), labels: S.showLabels && !places.list.length }),
    });
    if (viewer.renderer.software) {
      setTimeout(() => toast('Браузер рисует карту без видеокарты — будет медленно. Включите аппаратное ускорение или качество «Низкое».'), 800);
    }
    viewer.renderer.load().catch(e => {
      console.error(e);
      viewer.renderer = null;
      setTimeout(() => toast('Разметка карты не загрузилась — показываю оригинал без эффектов'), 500);
    });
  } catch (e) {
    console.warn('WebGL недоступен, обычный режим', e);
    viewer.renderer = null;
  }
}

let tool = 'pan';
let preview = null;       // предпросмотр направления
let ruler = null;         // {a, b}
let brushHover = null;
let selectedWp = null;
let playerRect = null;
let playerSeen = 0;

// ---------- сохранение и синхронизация ----------
let saveTimer = null;
function commit({ broadcast = true } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (!saveState(S)) toast('Не удалось сохранить (переполнено хранилище)'); }, 150);
  if (broadcast) bc.postMessage({ t: 'state', state: S });
  places.merge(S);
  renderPanel();
  viewer.invalidate();
}

let fogTimer = null;
function fogOp(op) {
  fog.apply(op);
  bc.postMessage({ t: 'fog', op });
  viewer.invalidate();
  clearTimeout(fogTimer);
  fogTimer = setTimeout(() => {
    if (!saveFogData(fog.serialize())) toast('Туман не сохранился: переполнено хранилище браузера');
  }, 800);
}

function sendFull() {
  bc.postMessage({ t: 'state', state: S });
  bc.postMessage({ t: 'fogFull', data: fog.serialize() });
}

bc.onmessage = ({ data: m }) => {
  if (m.t === 'hello') {
    sendFull();
    if (S.playerCamera === 'mirror') pushView(0);
  } else if (m.t === 'ping') {
    pings.add(m.x, m.y, m.color);
    viewer.invalidate();
  } else if (m.t === 'playerView') {
    playerRect = m.rect;
    playerSeen = Date.now();
    renderPlayerStatus();
    viewer.invalidate();
  } else if (m.t === 'bye') {
    playerRect = null; playerSeen = 0; renderPlayerStatus(); viewer.invalidate();
  }
};

// ---------- камера ----------
const savedView = loadView('gm');
if (savedView) viewer.setView(savedView.cx, savedView.cy, savedView.scale, false);
else { viewer.setView(S.party.x, S.party.y, 0.6, false); }
let viewTimer = null;
viewer.onViewChange = () => {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => saveView('gm', { cx: viewer.cx, cy: viewer.cy, scale: viewer.scale }), 300);
  if (S.playerCamera === 'mirror') pushViewThrottled();
};

function pushView(ms = 600) {
  bc.postMessage({ t: 'view', rect: viewer.viewRect(), ms });
}
let lastPush = 0;
function pushViewThrottled() {
  const now = performance.now();
  if (now - lastPush > 50) { lastPush = now; pushView(0); }
}

// ---------- противники ----------
const terrain = new Terrain(info.width, info.height);
const sim = new EnemySim({
  S: () => S,
  terrain,
  log: (msg, kind = 'info', e) => enemyLog(msg, kind, e),
  spotted: (e, how) => {
    enemyLog(`Игроки ${how === 'scout' ? 'разведкой нашли' : 'заметили'}: ${e.name}`, 'spot', e);
    bc.postMessage({ t: 'enemySpotted', name: e.name, x: e.x, y: e.y });
    pings.add(e.x, e.y, '#ff6a4a');
  },
});
function enemyLog(msg, kind, e) {
  S.enemyLog.unshift({ t: S.turn, msg, kind });
  S.enemyLog.length = Math.min(S.enemyLog.length, 60);
  if (kind === 'warn' || kind === 'alarm' || kind === 'spot') toast(msg);
  if (kind === 'alarm') bc.postMessage({ t: 'enemyContact', name: e ? e.name : '' });
}
function snapshotEnemies() {
  if (!S.enemy.enabled) return;
  S.enemyUndo.push({ len: S.trail.length, turn: S.turn, enemies: JSON.parse(JSON.stringify(S.enemies)) });
  if (S.enemyUndo.length > 30) S.enemyUndo.shift();
}
// Один «ход мира» после действия отряда: противники действуют, игроки могут их заметить
function worldTurn() {
  if (!S.enemy.enabled) return;
  sim.enemyTurn();
  sim.playerSpot([S.party], S.visionKm, S.enemy.playerNotice, 'sight');
  sim.track();
  sim.populate();
}

// ---------- ходы ----------
function doStep(times = S.steps) {
  let { x, y } = S.party;
  for (let i = 0; i < times; i++) {
    const p = stepPoint(x, y, S.bearing, S.stepKm, S.kmPerPx);
    p.x = Math.min(info.width, Math.max(0, p.x));
    p.y = Math.min(info.height, Math.max(0, p.y));
    snapshotEnemies();
    if (S.autoReveal) fogOp({ k: 'line', x0: x, y0: y, x1: p.x, y1: p.y, r: S.visionKm / S.kmPerPx, reveal: true });
    const km = distKm(x, y, p.x, p.y, S.kmPerPx);
    S.trail.push({ x: p.x, y: p.y, km });
    S.turn++;
    S.totalKm += km;
    // игроки замечают противников по пути
    if (S.enemy.enabled) sim.playerSpot([{ x, y }, p], S.visionKm, S.enemy.playerNotice, 'sight');
    x = p.x; y = p.y;
    S.party = { x, y };
    worldTurn();
  }
  S.party = { x, y };
  commit();
  keepPartyVisible();
}

// Разведка: открыть круг и гарантированно найти противников в нём
function scout() {
  const r = S.scoutKm;
  if (S.scoutCostsTurn) { snapshotEnemies(); S.trail.push({ x: S.party.x, y: S.party.y, km: 0, wait: true }); S.turn++; }
  fogOp({ k: 'circle', x: S.party.x, y: S.party.y, r: r / S.kmPerPx, reveal: true });
  if (S.enemy.enabled) {
    const before = S.enemies.filter(e => e.seen).length;
    sim.playerSpot([S.party], r, 1, 'scout');
    const found = S.enemies.filter(e => e.seen).length - before;
    toast(found ? `Разведка: найдено отрядов — ${found}` : 'Разведка: никого');
    if (S.scoutCostsTurn) worldTurn();
  } else toast(`Разведка: открыт круг ${r * 2} км`);
  commit();
}

// Отряд стоит, мир ходит
function waitTurn() {
  snapshotEnemies();
  S.trail.push({ x: S.party.x, y: S.party.y, km: 0, wait: true });
  S.turn++;
  worldTurn();
  commit();
}

function moveTo(x, y, counted) {
  const from = S.party;
  if (counted) {
    const km = distKm(from.x, from.y, x, y, S.kmPerPx);
    S.trail.push({ x, y, km });
    S.totalKm += km;
    S.turn++;
  } else {
    S.trail.push({ x, y, km: 0, jump: true });
  }
  if (S.autoReveal) {
    const r = S.visionKm / S.kmPerPx;
    if (counted) fogOp({ k: 'line', x0: from.x, y0: from.y, x1: x, y1: y, r, reveal: true });
    else fogOp({ k: 'circle', x, y, r, reveal: true });
  }
  S.party = { x, y };
  if (S.enemy.enabled) { sim.track(); sim.populate(); }
  commit();
}

function undo() {
  if (S.trail.length < 2) return toast('Нечего отменять');
  const last = S.trail.pop();
  if (!last.jump) { S.turn = Math.max(0, S.turn - 1); S.totalKm = Math.max(0, S.totalKm - last.km); }
  const p = S.trail[S.trail.length - 1];
  S.party = { x: p.x, y: p.y };
  // противники возвращаются туда, где были до этого хода
  const snap = S.enemyUndo[S.enemyUndo.length - 1];
  if (!last.jump && snap && snap.len === S.trail.length) { S.enemies = snap.enemies; S.enemyUndo.pop(); }
  commit();
  toast('Ход отменён (открытый туман остаётся)');
}

function keepPartyVisible() {
  const [sx, sy] = viewer.toScreen(S.party.x, S.party.y);
  const m = 80;
  if (sx < m || sy < m || sx > viewer.vw - m || sy > viewer.vh - m) {
    viewer.animateTo(S.party.x, S.party.y, viewer.scale, 400);
  }
}

function setBearing(b) {
  S.bearing = Math.round(((b % 360) + 360) % 360);
  commit({ broadcast: false });
  renderCompass();
}

// ---------- инструменты ----------
const tools = {
  pan: { cursor: 'grab', down: () => false },
  aim: {
    cursor: 'crosshair',
    down(p) { setBearing(bearingTo(S.party.x, S.party.y, p[0], p[1])); this.on = true; },
    move(p) { if (this.on) setBearing(bearingTo(S.party.x, S.party.y, p[0], p[1])); },
    up() { this.on = false; },
  },
  goto: {
    cursor: 'crosshair',
    down(p) {
      setBearing(bearingTo(S.party.x, S.party.y, p[0], p[1]));
      const km = distKm(S.party.x, S.party.y, p[0], p[1], S.kmPerPx);
      toast(`До точки ${fmtKm(km)} — это ${(km / S.stepKm).toFixed(1)} хода по ${S.stepKm} км. Азимут выставлен.`);
    },
    hover(p) { ruler = { a: { ...S.party }, b: { x: p[0], y: p[1] }, live: true }; viewer.invalidate(); },
    leave() { ruler = null; },
  },
  move: {
    cursor: 'copy',
    down(p) { moveTo(p[0], p[1], false); this.on = true; },
    move(p) {
      if (!this.on) return;
      S.trail[S.trail.length - 1] = { x: p[0], y: p[1], km: 0, jump: true };
      S.party = { x: p[0], y: p[1] };
      if (S.autoReveal) fogOp({ k: 'circle', x: p[0], y: p[1], r: S.visionKm / S.kmPerPx, reveal: true });
      commit();
    },
    up() {
      if (this.on && S.enemy.enabled) { sim.track(); sim.populate(); commit(); }
      this.on = false;
    },
  },
  waypoint: {
    cursor: 'cell',
    down(p) {
      const w = hitWaypoint(p);
      if (w) { this.drag = { w, ox: w.x - p[0], oy: w.y - p[1], moved: false }; return; }
      openWpDialog({ id: null, x: p[0], y: p[1], name: '', icon: '★', color: '#c0392b', note: '', visible: true });
    },
    move(p) {
      if (!this.drag) return;
      this.drag.moved = true;
      this.drag.w.x = p[0] + this.drag.ox; this.drag.w.y = p[1] + this.drag.oy;
      commit();
    },
    up() {
      if (this.drag && !this.drag.moved) openWpDialog(this.drag.w);
      this.drag = null;
    },
  },
  reveal: brushTool(true),
  hide: brushTool(false),
  ruler: {
    cursor: 'crosshair',
    down(p) { ruler = { a: { x: p[0], y: p[1] }, b: { x: p[0], y: p[1] } }; sendRuler(); },
    move(p) { if (ruler) { ruler.b = { x: p[0], y: p[1] }; sendRuler(); viewer.invalidate(); } },
    up() { setTimeout(() => { ruler = null; sendRuler(); viewer.invalidate(); }, 2500); },
  },
  ping: { cursor: 'pointer', down(p) { ping(p[0], p[1]); } },
  enemy: {
    cursor: 'cell',
    down(p) {
      const hit = hitEnemy(p);
      if (hit) { this.drag = { e: hit, ox: hit.x - p[0], oy: hit.y - p[1] }; return; }
      const e = sim.makeAt(p[0], p[1], { pinned: true });
      if (!e) return toast('Здесь отряд поставить нельзя (вода)');
      if (!S.enemy.enabled) S.enemy.enabled = true;
      S.enemies.push(e);
      enemyLog(`Мастер поставил отряд: ${e.name}`, 'info', e);
      commit();
    },
    move(p) {
      if (!this.drag) return;
      this.drag.e.x = p[0] + this.drag.ox; this.drag.e.y = p[1] + this.drag.oy;
      viewer.invalidate();
    },
    up() { if (this.drag) { this.drag = null; commit(); } },
  },
};

function brushTool(reveal) {
  return {
    cursor: 'none',
    down(p, e) {
      if (e.shiftKey) { ping(p[0], p[1]); return; }
      this.last = p;
      fogOp({ k: 'circle', x: p[0], y: p[1], r: S.brushKm / S.kmPerPx, reveal });
    },
    move(p) {
      brushHover = p;
      if (!this.last) return;
      fogOp({ k: 'line', x0: this.last[0], y0: this.last[1], x1: p[0], y1: p[1], r: S.brushKm / S.kmPerPx, reveal });
      this.last = p;
    },
    up() { this.last = null; },
    hover(p) { brushHover = p; viewer.invalidate(); },
    leave() { brushHover = null; },
  };
}

// Shift+клик — пинг в любом инструменте
for (const [name, t] of Object.entries(tools)) {
  if (name === 'reveal' || name === 'hide') continue;
  const down = t.down;
  t.down = function (p, e) {
    if (e.shiftKey && e.button === 0) { ping(p[0], p[1]); return; }
    return down ? down.call(this, p, e) : false;
  };
}

function setTool(name) {
  tool = name;
  viewer.tool = tools[name];
  if (name !== 'goto' && name !== 'ruler') ruler = null;
  brushHover = null;
  document.querySelectorAll('#toolbar button').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
  viewer.updateCursor();
  viewer.invalidate();
}

viewer.onClick = (p, e) => {
  if (e.shiftKey) { ping(p[0], p[1]); return; }
  // клик по названию — карточка места
  const [sx, sy] = viewer.toScreen(p[0], p[1]);
  const hit = labelLayer.hits().find(b => sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1);
  if (hit) openPlace(hit.id);
};

function ping(x, y) {
  pings.add(x, y, '#ffdd33');
  bc.postMessage({ t: 'ping', x, y, color: '#ffdd33' });
  viewer.invalidate();
}

function sendRuler() {
  bc.postMessage({ t: 'ruler', ruler: ruler && !ruler.live ? ruler : null });
}

function hitEnemy(p) {
  const [px, py] = viewer.toScreen(p[0], p[1]);
  for (let i = S.enemies.length - 1; i >= 0; i--) {
    const e = S.enemies[i];
    const [x, y] = viewer.toScreen(e.x, e.y);
    if (Math.abs(px - x) < 14 && Math.abs(py - y) < 16) return e;
  }
  return null;
}

function hitWaypoint(p) {
  for (let i = S.waypoints.length - 1; i >= 0; i--) {
    const w = S.waypoints[i];
    const [sx, sy] = viewer.toScreen(w.x, w.y);
    const [px, py] = viewer.toScreen(p[0], p[1]);
    if (Math.hypot(px - sx, py - (sy - 24)) < 17 || Math.hypot(px - sx, py - sy) < 8) return w;
  }
  return null;
}

// ---------- слои ----------
const labelLayer = placeLabelLayer(places, () => S, fog);
viewer.layers.push(
  fog.layer(() => S.gmFogOpacity, () => S.fogEnabled),
  trailLayer(() => S),
  settlementLayer(() => S, fog),
  labelLayer,
  {
    // круг обзора и предпросмотр хода
    draw(ctx, v) {
      const [px, py] = v.toScreen(S.party.x, S.party.y);
      if (S.showVisionToGM) {
        ctx.strokeStyle = 'rgba(255,230,140,0.8)';
        ctx.setLineDash([4, 6]); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(px, py, S.visionKm / S.kmPerPx * v.scale, 0, 7); ctx.stroke();
        ctx.setLineDash([]);
      }
      let x = S.party.x, y = S.party.y;
      const pts = [];
      for (let i = 0; i < S.steps; i++) { const p = stepPoint(x, y, S.bearing, S.stepKm, S.kmPerPx); x = p.x; y = p.y; pts.push(p); }
      const [ex, ey] = v.toScreen(x, y);
      let len = Math.hypot(ex - px, ey - py);
      const a = Math.atan2(ey - py, ex - px);
      // если ход слишком короткий на экране, рисуем хотя бы стрелку направления
      const L = Math.max(len, 40);
      const tx = px + Math.cos(a) * L, ty = py + Math.sin(a) * L;
      ctx.strokeStyle = '#1f6feb'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.setLineDash(len < 40 ? [3, 5] : []);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#1f6feb';
      ctx.beginPath();
      ctx.moveTo(tx + Math.cos(a) * 10, ty + Math.sin(a) * 10);
      ctx.lineTo(tx + Math.cos(a + 2.5) * 10, ty + Math.sin(a + 2.5) * 10);
      ctx.lineTo(tx + Math.cos(a - 2.5) * 10, ty + Math.sin(a - 2.5) * 10);
      ctx.fill();
      if (len >= 6) {
        ctx.fillStyle = 'rgba(31,111,235,0.9)';
        for (const p of pts) { const [sx, sy] = v.toScreen(p.x, p.y); ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, 7); ctx.fill(); }
      }
    },
  },
  waypointLayer(() => S.waypoints, { selectedId: () => selectedWp }),
  enemyLayer(() => S),
  partyLayer(() => S),
  pings,
  {
    draw(ctx, v) {
      if (ruler) drawRuler(ctx, v, ruler.a, ruler.b, S.kmPerPx, ruler.live ? '#9fd0ff' : '#fff');
      if (brushHover && (tool === 'reveal' || tool === 'hide')) {
        const [x, y] = v.toScreen(brushHover[0], brushHover[1]);
        ctx.strokeStyle = tool === 'reveal' ? '#ffe680' : '#8aa0c8'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, S.brushKm / S.kmPerPx * v.scale, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.stroke();
      }
      if (S.showPlayerRect && playerRect && Date.now() - playerSeen < 30000) {
        const [x0, y0] = v.toScreen(playerRect.x, playerRect.y);
        const [x1, y1] = v.toScreen(playerRect.x + playerRect.w, playerRect.y + playerRect.h);
        ctx.strokeStyle = 'rgba(255,90,200,0.9)'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,90,200,0.9)'; ctx.font = '600 12px system-ui';
        ctx.fillText('экран игроков', x0 + 6, y0 + 16);
      }
    },
  },
  scaleBarLayer(() => S.kmPerPx),
);

viewer.onHover = p => {
  const km = distKm(S.party.x, S.party.y, p[0], p[1], S.kmPerPx);
  const b = bearingTo(S.party.x, S.party.y, p[0], p[1]);
  $('status').textContent = `от отряда: ${fmtKm(km)}, ${Math.round(b)}° ${rumb(b)}`;
};

// ---------- компас ----------
const compass = $('compass');
function renderCompass() {
  const labels = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  let h = '<circle r="92" class="ring"/>';
  for (let i = 0; i < 16; i++) {
    const a = i * 22.5 * Math.PI / 180, major = i % 2 === 0;
    const r0 = major ? 70 : 78;
    h += `<line x1="${Math.sin(a) * r0}" y1="${-Math.cos(a) * r0}" x2="${Math.sin(a) * 90}" y2="${-Math.cos(a) * 90}" class="tick"/>`;
    if (major) {
      const r = 56;
      h += `<text x="${Math.sin(a) * r}" y="${-Math.cos(a) * r}" class="lbl${i === 0 ? ' north' : ''}" data-b="${i * 22.5}">${labels[i / 2]}</text>`;
    }
  }
  const a = S.bearing * Math.PI / 180;
  h += `<line x1="0" y1="0" x2="${Math.sin(a) * 86}" y2="${-Math.cos(a) * 86}" class="needle"/>`;
  h += `<circle r="5" class="hub"/>`;
  compass.innerHTML = h;
  $('bearing').value = S.bearing;
  $('bearingName').textContent = rumb(S.bearing);
}
function compassPick(e) {
  const r = compass.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * 200 - 100, y = (e.clientY - r.top) / r.height * 200 - 100;
  if (Math.hypot(x, y) < 10) return;
  let b = Math.atan2(x, -y) * 180 / Math.PI;
  // рядом с основными румбами — прилипание
  const snap = Math.round(b / 22.5) * 22.5;
  if (Math.abs(b - snap) < 4 || e.target.dataset.b) b = e.target.dataset.b ? +e.target.dataset.b : snap;
  setBearing(b);
}
compass.addEventListener('pointerdown', e => { compass.setPointerCapture(e.pointerId); compassPick(e); compass.dragging = true; });
compass.addEventListener('pointermove', e => { if (compass.dragging) compassPick(e); });
compass.addEventListener('pointerup', () => { compass.dragging = false; });

// ---------- панель ----------
function bindNum(id, key, { int = false, min = -Infinity, after } = {}) {
  $(id).addEventListener('change', () => {
    let v = parseFloat($(id).value);
    if (!isFinite(v)) { $(id).value = S[key]; return; }
    if (int) v = Math.round(v);
    S[key] = Math.max(min, v);
    after && after();
    commit();
  });
}
function bindCheck(id, key) {
  $(id).addEventListener('change', () => { S[key] = $(id).checked; commit(); });
}
bindNum('stepKm', 'stepKm', { min: 0.1 });
bindNum('steps', 'steps', { int: true, min: 1 });
bindNum('visionKm', 'visionKm', { min: 1 });
bindNum('kmPerPx', 'kmPerPx', { min: 0.001 });
$('bearing').addEventListener('change', () => setBearing(parseFloat($('bearing').value) || 0));
bindCheck('fogEnabled', 'fogEnabled');
bindCheck('autoReveal', 'autoReveal');
bindCheck('showVisionToGM', 'showVisionToGM');
bindCheck('showTrailToPlayers', 'showTrailToPlayers');
bindCheck('showPlayerRect', 'showPlayerRect');
$('brushKm').addEventListener('input', () => { S.brushKm = +$('brushKm').value; $('brushKmVal').textContent = S.brushKm; viewer.invalidate(); });
$('brushKm').addEventListener('change', () => commit({ broadcast: false }));
$('gmFogOpacity').addEventListener('input', () => { S.gmFogOpacity = +$('gmFogOpacity').value; renderPanel(); viewer.invalidate(); });
$('gmFogOpacity').addEventListener('change', () => commit({ broadcast: false }));
$('partyName').addEventListener('change', () => { S.partyName = $('partyName').value.trim(); commit(); });
document.querySelectorAll('input[name=cam]').forEach(r => r.addEventListener('change', () => {
  S.playerCamera = r.value; commit();
  if (r.value === 'mirror') pushView();
}));

// ---------- вид карты ----------
const SEASONS = ['Весна', 'Лето', 'Осень', 'Зима'];
$('styleMix').addEventListener('input', () => { S.styleMix = +$('styleMix').value; commit(); });
$('seasonSeg').onclick = e => { const b = e.target.closest('button'); if (b) animateSeason(+b.dataset.season); };
$('season').addEventListener('input', () => { S.season = +$('season').value; commit(); });
bindCheck('clouds', 'clouds');
bindCheck('animate', 'animate');
bindCheck('showSettlements', 'showSettlements');
bindCheck('showLabels', 'showLabels');
$('quality').addEventListener('change', () => { S.quality = $('quality').value; commit(); });
$('playerQuality').addEventListener('change', () => { S.playerQuality = $('playerQuality').value; commit(); });
$('fogGhost').addEventListener('input', () => { S.fogGhost = +$('fogGhost').value; commit(); });
// плавная смена сезона вперёд по кругу
let seasonAnim = null;
function animateSeason(target) {
  cancelAnimationFrame(seasonAnim);
  const from = S.season;
  let to = target;
  while (to < from) to += 4;
  if (to - from < 0.001) return;
  const t0 = performance.now(), ms = 1500 * (to - from);
  const step = now => {
    const k = Math.min(1, (now - t0) / ms);
    S.season = (from + (to - from) * k) % 4;
    commit();
    if (k < 1) seasonAnim = requestAnimationFrame(step);
  };
  seasonAnim = requestAnimationFrame(step);
}

$('doStep').onclick = () => doStep();
$('scout').onclick = scout;
$('waitTurn').onclick = waitTurn;
bindNum('scoutKm', 'scoutKm', { min: 0.5 });
bindCheck('scoutCostsTurn', 'scoutCostsTurn');
// настройки противников: id поля → [ключ, множитель (проценты)]
const EN_FIELDS = {
  enCount: ['count', 1], enRadius: ['radiusKm', 1], enVision: ['visionKm', 1], enStep: ['stepKm', 1],
  enChaseMin: ['chaseMinKm', 1], enChaseMax: ['chaseMaxKm', 1], enScoutKm: ['scoutKm', 1], enScoutChance: ['scoutChance', 100],
  enNoticeMin: ['noticeMin', 100], enNoticeMax: ['noticeMax', 100], enInterestMin: ['interestMin', 100], enInterestMax: ['interestMax', 100],
  enPlayerNotice: ['playerNotice', 100], enTrack: ['trackKm', 1],
};
for (const [id, [key, mul]] of Object.entries(EN_FIELDS)) {
  $(id).addEventListener('change', () => {
    let v = parseFloat($(id).value);
    if (!isFinite(v) || v < 0) { $(id).value = Math.round(S.enemy[key] * mul * 100) / 100; return; }
    if (mul === 100) v = Math.min(100, v);
    if (key === 'count') v = Math.min(60, Math.round(v));
    if (key === 'radiusKm') v = Math.max(20, v);
    if (key.endsWith('Km') && key !== 'radiusKm') v = Math.max(0.5, v);
    S.enemy[key] = v / mul;
    // пределы «от/до» не должны перекрещиваться
    for (const [a, b] of [['noticeMin', 'noticeMax'], ['interestMin', 'interestMax'], ['chaseMinKm', 'chaseMaxKm']]) {
      if (S.enemy[a] > S.enemy[b]) { if (key === a) S.enemy[b] = S.enemy[a]; else S.enemy[a] = S.enemy[b]; }
    }
    $(id).value = Math.round(S.enemy[key] * mul * 100) / 100;
    if (key === 'count' || key === 'radiusKm') sim.populate();
    commit();
  });
}
$('enEnabled').addEventListener('change', () => {
  S.enemy.enabled = $('enEnabled').checked;
  if (S.enemy.enabled) { terrain.done.then(() => { sim.populate(); commit(); }); }
  commit();
});
$('enShowVision').addEventListener('change', () => { S.enemy.showVision = $('enShowVision').checked; commit({ broadcast: false }); });
$('enRespawn').onclick = () => {
  if (!confirm('Заменить все отряды противников новыми?')) return;
  S.enemies = S.enemies.filter(e => e.pinned);
  sim.populate(); commit();
};
$('enAdd').onclick = () => {
  // рядом: за пределами обзора отряда, но в круге сопровождения
  const lo = Math.max(S.visionKm * 1.5, 4), hi = Math.max(lo + 1, S.enemy.trackKm);
  for (let k = 0; k < 40; k++) {
    const a = Math.random() * Math.PI * 2, d = (lo + Math.random() * (hi - lo)) / S.kmPerPx;
    const e = sim.makeAt(S.party.x + Math.cos(a) * d, S.party.y + Math.sin(a) * d, { pinned: true });
    if (e) { S.enemies.push(e); enemyLog(`Появился отряд: ${e.name}`, 'info', e); commit(); return; }
  }
  toast('Не нашлось места на суше рядом с отрядом');
};
function renderEnemies() {
  const c = S.enemy;
  $('enEnabled').checked = c.enabled;
  $('enBox').classList.toggle('off', !c.enabled);
  $('enShowVision').checked = c.showVision;
  for (const [id, [key, mul]] of Object.entries(EN_FIELDS)) if (document.activeElement !== $(id)) $(id).value = Math.round(c[key] * mul * 100) / 100;
  const list = $('enList');
  list.innerHTML = '';
  const sorted = [...S.enemies].sort((a, b) => distKm(S.party.x, S.party.y, a.x, a.y, 1) - distKm(S.party.x, S.party.y, b.x, b.y, 1));
  for (const e of sorted) {
    const km = distKm(S.party.x, S.party.y, e.x, e.y, S.kmPerPx);
    const row = document.createElement('div');
    row.className = 'en' + (e.seen ? ' seen' : '') + (e.chase ? ' chase' : '');
    const st = [e.chase ? '⚔ преследует' : (e.ignore > 0 ? 'не интересуется' : 'бродит'), e.seen ? 'видят игроки' : '', e.pinned ? 'поставлен' : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<span class="ic">${esc(e.icon)}</span><span class="nm"><b>${esc(e.name)}</b><small>${fmtKm(km)} · ${st}</small></span>
      <button title="Показать/скрыть игрокам">${e.seen ? '👁️' : '🙈'}</button>
      <button title="Погоня вкл/выкл">${e.chase ? '🏃' : '💤'}</button>
      <button title="Переименовать">✎</button>
      <button title="Убрать">✕</button>`;
    const [bSeen, bChase, bName, bDel] = row.querySelectorAll('button');
    row.querySelector('.nm').onclick = () => viewer.animateTo(e.x, e.y, Math.max(viewer.scale, 2));
    bSeen.onclick = () => { e.seen = !e.seen; commit(); };
    bChase.onclick = () => { e.chase = !e.chase; e.ignore = 0; commit(); };
    bName.onclick = () => { const n = prompt('Название отряда', e.name); if (n) { e.name = n.trim(); commit(); } };
    bDel.onclick = () => { S.enemies = S.enemies.filter(x => x !== e); commit(); };
    list.appendChild(row);
  }
  $('enLog').innerHTML = S.enemyLog.slice(0, 30).map(l => `<div class="${l.kind}">Ход ${l.t}: ${esc(l.msg)}</div>`).join('');
}
$('undo').onclick = undo;
$('centerParty').onclick = () => viewer.animateTo(S.party.x, S.party.y, Math.max(viewer.scale, 0.8));
$('resetCounter').onclick = () => { S.turn = 0; S.totalKm = 0; commit(); };
$('clearTrail').onclick = () => {
  if (!confirm('Стереть весь след отряда?')) return;
  S.trail = [{ x: S.party.x, y: S.party.y, km: 0 }]; S.enemyUndo = []; commit();
};
$('revealAll').onclick = () => { if (confirm('Открыть игрокам всю карту?')) fogOp({ k: 'all', reveal: true }); };
$('hideAll').onclick = () => {
  if (!confirm('Закрыть туманом всю карту?')) return;
  fogOp({ k: 'all', reveal: false });
  if (S.autoReveal) fogOp({ k: 'circle', x: S.party.x, y: S.party.y, r: S.visionKm / S.kmPerPx, reveal: true });
};
$('openPlayer').onclick = openPlayer;
$('pushView').onclick = () => pushView();
$('pullView').onclick = () => {
  if (!playerRect) return toast('Экран игроков не подключён');
  const f = viewer.fitRect(playerRect.x, playerRect.y, playerRect.w, playerRect.h);
  viewer.animateTo(f.cx, f.cy, f.scale);
};
$('addWpHere').onclick = () => openWpDialog({ id: null, x: S.party.x, y: S.party.y, name: '', icon: '★', color: '#c0392b', note: '', visible: true });
$('panelToggle').onclick = togglePanel;
function togglePanel() { document.body.classList.toggle('panel-hidden'); }

$('exportBtn').onclick = () => {
  const data = { app: 'faerun-walker', exported: new Date().toISOString(), state: S, fog: fog.serialize() };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `faerun-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const f = $('importFile').files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'faerun-walker') throw new Error('не тот формат');
    S = { ...defaultState(), ...data.state };
    if (!data.state.schema) S.visionKm = 3;
    normalizeEnemies();
    if (data.fog) { await fog.load(data.fog); saveFogData(fog.serialize()); }
    commit(); sendFull();
    viewer.animateTo(S.party.x, S.party.y, viewer.scale);
    toast('Кампания загружена');
  } catch (e) { alert('Не удалось импортировать: ' + e.message); }
  $('importFile').value = '';
};
$('resetAll').onclick = () => {
  if (!confirm('Сбросить ВСЁ: положение, след, метки, туман? Сначала можно сделать экспорт.')) return;
  clearAll();
  S = defaultState();
  normalizeEnemies();
  fog.fill(false);
  fog.apply({ k: 'circle', x: S.party.x, y: S.party.y, r: S.visionKm / S.kmPerPx, reveal: true });
  saveFogData(fog.serialize());
  commit(); sendFull();
  viewer.animateTo(S.party.x, S.party.y, 0.6);
};

function renderPanel() {
  for (const k of ['stepKm', 'steps', 'visionKm', 'kmPerPx']) if (document.activeElement !== $(k)) $(k).value = k === 'kmPerPx' ? +S[k].toFixed(4) : S[k];
  for (const k of ['fogEnabled', 'autoReveal', 'showVisionToGM', 'showTrailToPlayers', 'showPlayerRect']) $(k).checked = S[k];
  $('brushKm').value = S.brushKm; $('brushKmVal').textContent = S.brushKm;
  $('gmFogOpacity').value = S.gmFogOpacity; $('gmFogVal').textContent = Math.round(S.gmFogOpacity * 100) + '%';
  if (document.activeElement !== $('partyName')) $('partyName').value = S.partyName;
  document.querySelectorAll('input[name=cam]').forEach(r => { r.checked = r.value === S.playerCamera; });
  const days = S.totalKm / 38.6; // нормальный темп D&D: 24 мили в день
  $('stats').innerHTML = `Ход <b>${S.turn}</b> · пройдено <b>${fmtKm(S.totalKm)}</b><br><span class="hint">≈ ${days.toFixed(1)} дн. пути нормальным темпом (24 мили/день)</span>`;
  renderCompass();
  renderWpList();
  if (document.activeElement !== $('styleMix')) $('styleMix').value = S.styleMix;
  const si = Math.round(S.season) % 4;
  document.querySelectorAll('#seasonSeg button').forEach(b => b.classList.toggle('active', +b.dataset.season === si));
  $('seasonName').textContent = SEASONS[si];
  if (document.activeElement !== $('season')) $('season').value = S.season;
  for (const k of ['clouds', 'animate', 'showSettlements', 'showLabels']) $(k).checked = S[k];
  $('quality').value = S.quality;
  $('playerQuality').value = S.playerQuality || 'high';
  $('fogGhost').value = S.fogGhost; $('fogGhostVal').textContent = Math.round(S.fogGhost * 100) + '%';
  viewer.fps = renderSettings(S, false).fps;
  $('labelLang').value = S.labelLang || 'en';
  if (document.activeElement !== $('scoutKm')) $('scoutKm').value = S.scoutKm;
  $('scoutCostsTurn').checked = S.scoutCostsTurn;
  renderEnemies();
}

// ---------- энциклопедия ----------
$('encSearch').addEventListener('input', renderEnc);
$('labelLang').addEventListener('change', () => { S.labelLang = $('labelLang').value; commit(); });
function renderEnc() {
  const q = $('encSearch').value;
  const el = $('encResults');
  if (!places.list.length) { $('encInfo').textContent = 'Список мест ещё не собран (data/places.json).'; el.innerHTML = ''; return; }
  $('encInfo').textContent = `Мест в энциклопедии: ${places.list.length}. Клик по названию на карте открывает карточку.`;
  const res = places.search(q, 50);
  el.innerHTML = '';
  for (const p of res) {
    const ax = p.marker ? p.marker[0] : p.x, ay = p.marker ? p.marker[1] : p.y;
    const km = distKm(S.party.x, S.party.y, ax, ay, S.kmPerPx);
    const row = document.createElement('div');
    row.className = 'pl';
    row.innerHTML = `<b>${esc(p.name)}</b>${p.name_ru ? `<span class="hint">${esc(p.name_ru)}</span>` : ''}<small>${KIND_NAMES[p.kind] || ''} · ${fmtKm(km)}</small>`;
    row.onclick = () => openPlace(p.id);
    el.appendChild(row);
  }
}
$('plKind').innerHTML = Object.entries(KIND_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
let placeOpen = null;
function placeAnchor(p) { return p.marker ? { x: p.marker[0], y: p.marker[1] } : { x: p.x, y: p.y }; }
function openPlace(id) {
  const p = places.byId.get(id);
  if (!p) return;
  placeOpen = p;
  $('plKindLabel').textContent = KIND_NAMES[p.kind] || '';
  $('plTitle').textContent = p.name_ru ? `${p.name} · ${p.name_ru}` : p.name;
  $('plName').value = p.name || '';
  $('plNameRu').value = p.name_ru || '';
  $('plKind').value = p.kind || 'other';
  $('plDesc').value = p.desc_ru || '';
  $('plNotes').value = p.notes || '';
  $('plKnown').checked = !!p.known;
  $('plHidden').checked = !!p.hiddenLabel;
  // статья с Forgotten Realms Wiki
  const wiki = $('plWiki');
  wiki.textContent = '';
  wiki.dataset.text = '';
  const title = p.wiki || p.name;
  if (title) {
    wiki.textContent = 'Загружаю статью с Forgotten Realms Wiki…';
    wikiSummary(title).then(w => {
      if (placeOpen !== p) return;
      wiki.dataset.text = w.text;
      wiki.innerHTML = `${esc(w.text || 'В статье нет вводного текста.')}<a class="wiki-src" href="${w.url}" target="_blank" rel="noopener">Forgotten Realms Wiki: ${esc(w.title)} ↗ (CC BY-SA)</a>`;
    }).catch(err => {
      if (placeOpen !== p) return;
      wiki.innerHTML = `Статья не найдена (${esc(err.message)}). <a href="${wikiUrl(title)}" target="_blank" rel="noopener">Поискать на вики ↗</a>`;
    });
  }
  const pd = $('placeDialog');
  pd.returnValue = '';
  if (!pd.open) pd.showModal();
}
$('plClose').onclick = () => $('placeDialog').close('cancel');
$('plGo').onclick = () => { const a = placeAnchor(placeOpen); $('placeDialog').close('cancel'); viewer.animateTo(a.x, a.y, Math.max(viewer.scale, 1.2)); };
$('plAim').onclick = () => {
  const a = placeAnchor(placeOpen);
  const b = bearingTo(S.party.x, S.party.y, a.x, a.y);
  const km = distKm(S.party.x, S.party.y, a.x, a.y, S.kmPerPx);
  setBearing(b);
  toast(`Азимут на «${placeOpen.name}»: ${Math.round(b)}° ${rumb(b)}, ${fmtKm(km)} (${Math.ceil(km / S.stepKm)} ход.)`);
};
$('plShow').onclick = () => {
  const p = placeOpen, a = placeAnchor(p);
  savePlaceEdits();
  const lang = S.labelLang || 'en';
  bc.postMessage({ t: 'showPlace', place: { name: lang === 'ru' && $('plNameRu').value ? $('plNameRu').value : $('plName').value,
    kind: (p.capital ? 'Столица · ' : '') + (KIND_NAMES[$('plKind').value] || ''),
    desc: $('plDesc').value || $('plWiki').dataset.text || '', x: a.x, y: a.y } });
  toast('Карточка показана игрокам (скрыть — Esc на их экране или кнопка ещё раз через 20 с)');
};
function savePlaceEdits() {
  const p = placeOpen;
  if (!p) return;
  const e = { ...(S.placeEdits[p.id] || {}) };
  const set = (k, v, orig) => { if (v !== (orig ?? '')) e[k] = v; else delete e[k]; };
  const base = places.base.find(b => b.id === p.id) || {};
  set('name', $('plName').value.trim(), base.name);
  set('name_ru', $('plNameRu').value.trim(), base.name_ru);
  set('kind', $('plKind').value, base.kind);
  set('desc_ru', $('plDesc').value, base.desc_ru);
  set('notes', $('plNotes').value, base.notes);
  if ($('plKnown').checked) e.known = true; else delete e.known;
  if ($('plHidden').checked) e.hiddenLabel = true; else delete e.hiddenLabel;
  if (e.name) e.renamed = true; else delete e.renamed;
  if (Object.keys(e).length) S.placeEdits[p.id] = e; else delete S.placeEdits[p.id];
  commit();
}
$('placeDialog').addEventListener('close', () => {
  if ($('placeDialog').returnValue === 'save') { savePlaceEdits(); toast('Сохранено'); renderEnc(); }
});

function renderWpList() {
  const el = $('wpList');
  if (!S.waypoints.length) { el.innerHTML = '<p class="hint">Меток пока нет.</p>'; return; }
  el.innerHTML = '';
  const sorted = [...S.waypoints].sort((a, b) =>
    distKm(S.party.x, S.party.y, a.x, a.y, 1) - distKm(S.party.x, S.party.y, b.x, b.y, 1));
  for (const w of sorted) {
    const km = distKm(S.party.x, S.party.y, w.x, w.y, S.kmPerPx);
    const b = bearingTo(S.party.x, S.party.y, w.x, w.y);
    const row = document.createElement('div');
    row.className = 'wp' + (selectedWp === w.id ? ' sel' : '');
    row.innerHTML = `<span class="ic" style="background:${w.color}">${esc(w.icon)}</span>
      <span class="nm"><b>${esc(w.name || 'Без названия')}</b><small>${fmtKm(km)} · ${Math.round(b)}° ${rumb(b)}</small></span>
      <button title="Видимость для игроков">${w.visible === false ? '🙈' : '👁️'}</button>
      <button title="Направить отряд к метке">🧭</button>
      <button title="Редактировать">✎</button>`;
    const [bVis, bAim, bEdit] = row.querySelectorAll('button');
    row.querySelector('.nm').onclick = () => { selectedWp = w.id; viewer.animateTo(w.x, w.y, Math.max(viewer.scale, 0.6)); renderWpList(); viewer.invalidate(); };
    bVis.onclick = () => { w.visible = w.visible === false; commit(); };
    bAim.onclick = () => { setBearing(b); toast(`Азимут на «${w.name || 'метку'}»: ${Math.round(b)}°, ${fmtKm(km)} (${Math.ceil(km / S.stepKm)} ход.)`); };
    bEdit.onclick = () => openWpDialog(w);
    el.appendChild(row);
  }
}

// ---------- диалог метки ----------
let editing = null;
const dlg = $('wpDialog');
$('wpIcons').innerHTML = ICONS.map(i => `<button type="button" data-i="${i}">${i}</button>`).join('');
$('wpIcons').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  $('wpIcons').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
};
function openWpDialog(w) {
  editing = w;
  $('wpName').value = w.name || '';
  $('wpColor').value = w.color || '#c0392b';
  $('wpNote').value = w.note || '';
  $('wpVisible').checked = w.visible !== false;
  $('wpDelete').style.display = w.id ? '' : 'none';
  $('wpIcons').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.i === (w.icon || '★')));
  dlg.returnValue = '';
  dlg.showModal();
  $('wpName').focus();
}
$('wpCancel').onclick = () => dlg.close('cancel');
$('wpDelete').onclick = () => {
  if (!confirm('Удалить метку?')) return;
  S.waypoints = S.waypoints.filter(x => x.id !== editing.id);
  dlg.close('cancel');
  commit();
};
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save' || !editing) return;
  const active = $('wpIcons').querySelector('button.active');
  const data = {
    name: $('wpName').value.trim(), color: $('wpColor').value, note: $('wpNote').value,
    visible: $('wpVisible').checked, icon: active ? active.dataset.i : '★',
  };
  if (editing.id) Object.assign(editing, data);
  else S.waypoints.push({ id: uid(), x: editing.x, y: editing.y, ...data });
  editing = null;
  commit();
});

// ---------- экран игроков ----------
async function openPlayer() {
  let features = 'popup,width=1280,height=720';
  // На Chrome/Edge можно сразу открыть окно на втором мониторе (Window Management API)
  try {
    if ('getScreenDetails' in window) {
      const sd = await window.getScreenDetails();
      const other = sd.screens.find(s => s !== sd.currentScreen);
      if (other) features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
    }
  } catch { /* пользователь не дал доступ — откроем обычным окном */ }
  const w = window.open('player.html', 'faerun-player', features);
  if (!w) toast('Браузер заблокировал окно — разрешите всплывающие окна для сайта');
  else toast('Перетащите окно на телевизор и нажмите в нём F (или двойной клик) — полный экран');
}

function renderPlayerStatus() {
  const on = playerSeen && Date.now() - playerSeen < 30000;
  $('playerStatus').textContent = on ? '🟢 Экран игроков подключён' : '⚪ Экран игроков не открыт';
}
setInterval(renderPlayerStatus, 5000);

// ---------- клавиатура ----------
const NUMPAD = { Numpad8: 0, Numpad9: 45, Numpad6: 90, Numpad3: 135, Numpad2: 180, Numpad1: 225, Numpad4: 270, Numpad7: 315 };
const HOTKEYS = { KeyE: 'enemy', KeyV: 'pan', KeyD: 'aim', KeyG: 'goto', KeyM: 'move', KeyW: 'waypoint', KeyR: 'reveal', KeyH: 'hide', KeyL: 'ruler', KeyP: 'ping' };
window.addEventListener('keydown', e => {
  if (isTyping(e) || dlg.open || $('placeDialog').open) return;
  if (e.code in NUMPAD) {
    e.preventDefault();
    setBearing(NUMPAD[e.code]);
    // Shift+Numpad при включённом NumLock приходит как стрелка (key != цифра) — это «сразу шаг»
    if (e.shiftKey || !/^\d$/.test(e.key)) doStep();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); doStep(); return; }
  if (e.code === 'Tab') { e.preventDefault(); togglePanel(); return; }
  if (e.code === 'KeyC') { $('centerParty').click(); return; }
  if (e.code === 'KeyS') { scout(); return; }
  if (e.code === 'KeyZ') { waitTurn(); return; }
  if (e.code === 'Escape') { setTool('pan'); return; }
  if (HOTKEYS[e.code]) setTool(HOTKEYS[e.code]);
});
document.querySelectorAll('#toolbar button').forEach(b => b.onclick = () => setTool(b.dataset.tool));

// ---------- мелочи ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Изменения из другой вкладки мастера (на всякий случай)
window.addEventListener('storage', e => {
  if (e.key === 'faerun-walker:state:v1' && e.newValue) { S = { ...defaultState(), ...JSON.parse(e.newValue) }; normalizeEnemies(); renderPanel(); viewer.invalidate(); }
});

// ---------- старт ----------
const fogData = loadFogData();
if (!(await fog.load(fogData))) {
  fog.apply({ k: 'circle', x: S.party.x, y: S.party.y, r: S.visionKm / S.kmPerPx, reveal: true });
  saveFogData(fog.serialize());
}
setTool('pan');
renderPanel();
renderPlayerStatus();
sendFull();
viewer.invalidate();

window.__appStarted = true;
