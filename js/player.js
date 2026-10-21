// Экран игроков: только то, что открыл мастер.
import { Viewer, loadInfo } from './viewer.js?v=bf52099b';
import { Fog } from './fog.js?v=bf52099b';
import { loadState, loadFogData, loadView, saveView, channel, defaultState } from './state.js?v=bf52099b';
import { trailLayer, waypointLayer, partyLayer, pingLayer, drawRuler, scaleBarLayer, settlementLayer } from './layers.js?v=bf52099b';
import { enemyLayer } from './enemies.js?v=bf52099b';
import { MapRenderer } from './gl.js?v=bf52099b';
import { Places, placeLabelLayer } from './places.js?v=bf52099b';
import { renderSettings } from './state.js?v=bf52099b';

const $ = id => document.getElementById(id);
const info = await loadInfo();
let S = loadState();
const viewer = new Viewer($('map'), info);
const fog = new Fog(info.width, info.height);
window.mapViewer = viewer; // для отладки из консоли
const bc = channel();
const pings = pingLayer();
let ruler = null;
let connected = false;

await fog.load(loadFogData());
const places = new Places();
places.ready.then(() => { places.merge(S); viewer.invalidate(); });
try {
  viewer.renderer = new MapRenderer($('gl'), viewer, fog, {
    getSettings: () => ({ ...renderSettings(S, true), labels: S.showLabels && !places.list.length }),
  });
  viewer.renderer.load().catch(e => { console.error(e); viewer.renderer = null; });
} catch (e) {
  console.warn('WebGL недоступен, обычный режим', e);
}
viewer.fps = renderSettings(S, true).fps;

viewer.layers.push(
  trailLayer(() => S, () => S.showTrailToPlayers),
  settlementLayer(() => S, fog, { player: true }),
  placeLabelLayer(places, () => S, fog, { player: true }),
  fog.layer(() => 1, () => S.fogEnabled),
  // метки, которые мастер сделал видимыми, показываем даже в тумане — игроки о них «слышали»
  waypointLayer(() => S.waypoints.filter(w => w.visible !== false)),
  enemyLayer(() => S, { player: true, onlySeen: true }),
  partyLayer(() => S),
  pings,
  { draw(ctx, v) { if (ruler) drawRuler(ctx, v, ruler.a, ruler.b, S.kmPerPx); } },
  scaleBarLayer(() => S.kmPerPx),
);

// ---------- камера ----------
// по умолчанию — исходное разрешение карты (~1600 км по ширине Full HD)
const saved = loadView('player');
if (saved) viewer.setView(saved.cx, saved.cy, saved.scale, false);
else viewer.setView(S.party.x, S.party.y, 1, false);

let viewTimer = null, lastSent = 0;
function sendView() {
  bc.postMessage({ t: 'playerView', rect: viewer.viewRect() });
  lastSent = performance.now();
}
viewer.onViewChange = () => {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { saveView('player', { cx: viewer.cx, cy: viewer.cy, scale: viewer.scale }); sendView(); }, 120);
  if (performance.now() - lastSent > 100) sendView();
};
setInterval(sendView, 10000);
window.addEventListener('resize', () => setTimeout(sendView, 100));
setTimeout(sendView, 300);
window.addEventListener('beforeunload', () => bc.postMessage({ t: 'bye' }));

// ---------- сообщения от мастера ----------
bc.onmessage = ({ data: m }) => {
  if (!connected) { connected = true; $('conn').textContent = '🟢 связь с мастером есть'; }
  if (m.t === 'state') {
    const moved = !S || S.party.x !== m.state.party.x || S.party.y !== m.state.party.y;
    S = { ...defaultState(), ...m.state };
    viewer.fps = renderSettings(S, true).fps;
    places.merge(S);
    if (moved && S.playerCamera === 'follow') {
      const [sx, sy] = viewer.toScreen(S.party.x, S.party.y);
      // плавно двигаем, только если отряд уходит от центра
      const m2 = Math.min(viewer.vw, viewer.vh) * 0.25;
      if (Math.abs(sx - viewer.vw / 2) > m2 || Math.abs(sy - viewer.vh / 2) > m2) viewer.animateTo(S.party.x, S.party.y, viewer.scale, 700);
    }
    viewer.invalidate();
  } else if (m.t === 'fog') {
    fog.apply(m.op); viewer.invalidate();
  } else if (m.t === 'fogFull') {
    fog.load(m.data).then(() => viewer.invalidate());
  } else if (m.t === 'view') {
    const f = viewer.fitRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
    viewer.animateTo(f.cx, f.cy, f.scale, m.ms ?? 600);
  } else if (m.t === 'ping') {
    pings.add(m.x, m.y, m.color); viewer.invalidate();
  } else if (m.t === 'enemySpotted') {
    pings.add(m.x, m.y, '#ff6a4a'); viewer.invalidate();
    notice(`Замечен отряд: ${m.name}`);
  } else if (m.t === 'enemyContact') {
    notice(`${m.name} настигли отряд!`);
  } else if (m.t === 'showPlace') {
    showPlaceCard(m.place);
  } else if (m.t === 'ruler') {
    ruler = m.ruler; viewer.invalidate();
  }
};
bc.postMessage({ t: 'hello' });
setTimeout(() => { if (!connected) $('conn').textContent = '⚪ мастер не отвечает — откройте эту страницу кнопкой с экрана мастера'; }, 1500);

// ---------- ввод ----------
viewer.onClick = p => {
  pings.add(p[0], p[1], '#4fd1ff');
  bc.postMessage({ t: 'ping', x: p[0], y: p[1], color: '#4fd1ff' });
  viewer.invalidate();
};
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
window.addEventListener('keydown', e => {
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'KeyC') viewer.animateTo(S.party.x, S.party.y, viewer.scale);
  if (e.code === 'Equal' || e.code === 'NumpadAdd') viewer.zoomAt(viewer.vw / 2, viewer.vh / 2, 1.25);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') viewer.zoomAt(viewer.vw / 2, viewer.vh / 2, 0.8);
});
$('map').addEventListener('dblclick', toggleFullscreen);

// Подсказка прячется сама и появляется при движении мыши
let hintTimer;
function showHint() {
  $('hint').classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => $('hint').classList.add('hidden'), 4000);
}
window.addEventListener('mousemove', showHint);
showHint();

// Резерв: если BroadcastChannel недоступен, подтягиваем из хранилища
window.addEventListener('storage', e => {
  if (connected) return;
  if (e.key === 'faerun-walker:state:v1' && e.newValue) { S = { ...defaultState(), ...JSON.parse(e.newValue) }; viewer.invalidate(); }
  if (e.key === 'faerun-walker:fog:v1' && e.newValue) fog.load(e.newValue).then(() => viewer.invalidate());
});

// ---------- карточка места от мастера ----------
let cardTimer = null;
function showPlaceCard(p) {
  const el = $('placeCard');
  el.querySelector('.pkind').textContent = p.kind || '';
  el.querySelector('h3').textContent = p.name;
  el.querySelector('p').textContent = p.desc || '';
  el.classList.remove('hidden');
  if (p.x != null) viewer.animateTo(p.x, p.y, Math.max(viewer.scale, 1.2), 900);
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => el.classList.add('hidden'), 25000);
}
window.addEventListener('keydown', e => { if (e.code === 'Escape') $('placeCard').classList.add('hidden'); });
$('placeCard').addEventListener('click', () => $('placeCard').classList.add('hidden'));

window.__appStarted = true;

// крупное уведомление на экране игроков
let noticeTimer = null;
function notice(text) {
  const el = $('pnotice');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}
