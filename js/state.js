// Состояние кампании, сохранение в localStorage и связь между окнами.

const KEY = 'faerun-walker:state:v1';
const FOG_KEY = 'faerun-walker:fog:v1';
const VIEW_KEY = 'faerun-walker:view:';

// Шкала на карте: 360 миль = 453 px исходного изображения.
export const DEFAULT_KM_PER_PX = (360 * 1.609344) / 453;

export function defaultState() {
  const start = { x: 3366, y: 1153 }; // Врата Балдура
  return {
    version: 1,
    party: { ...start },
    partyName: 'Отряд',
    trail: [{ x: start.x, y: start.y, km: 0 }],
    turn: 0,
    totalKm: 0,
    bearing: 0,
    stepKm: 6,
    steps: 1,
    kmPerPx: DEFAULT_KM_PER_PX,
    visionKm: 3,
    scoutKm: 5,             // разведка: радиус круга вокруг отряда
    scoutCostsTurn: true,
    autoReveal: true,
    brushKm: 40,
    fogEnabled: true,
    gmFogOpacity: 0.45,
    showTrailToPlayers: true,
    showVisionToGM: true,
    showPlayerRect: true,
    playerCamera: 'follow', // free | follow | mirror
    styleMix: 0,            // 0 — рисованная, 1 — оригинал, между — плавное смешение
    showLabels: true,
    season: 1,              // 0 весна, 1 лето, 2 осень, 3 зима (дробные — переходы)
    clouds: true,
    animate: true,
    fogGhost: 0.2,          // насколько сквозь туман видна местность
    quality: 'medium',      // качество экрана мастера: high | medium | low
    playerQuality: 'high',  // качество экрана игроков
    showSettlements: true,
    labelLang: 'en',        // язык подписей: en | ru
    placeEdits: {},         // правки мастера к местам энциклопедии: id → поля
    customPlaces: [],
    waypoints: [],
    enemy: null,            // настройки противников (заполняются defaultEnemyConfig)
    enemies: [],
    enemyUndo: [],
    enemyLog: [],
    schema: 2,
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const S = { ...defaultState(), ...saved };
      // схема 2: обзор отряда по умолчанию 3 км (был 40), появились противники
      if (!saved.schema || saved.schema < 2) { S.visionKm = 3; S.schema = 2; }
      return S;
    }
  } catch (e) { console.warn('state load failed', e); }
  return defaultState();
}

export function saveState(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); return true; }
  catch (e) { console.warn('state save failed', e); return false; }
}

export function loadFogData() {
  try { return localStorage.getItem(FOG_KEY); } catch { return null; }
}

export function saveFogData(url) {
  try { localStorage.setItem(FOG_KEY, url); return true; }
  catch (e) { console.warn('fog save failed', e); return false; }
}

export function loadView(who) {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY + who)); } catch { return null; }
}

export function saveView(who, v) {
  try { localStorage.setItem(VIEW_KEY + who, JSON.stringify(v)); } catch { /* не критично */ }
}

export function clearAll() {
  for (const k of [KEY, FOG_KEY, VIEW_KEY + 'gm', VIEW_KEY + 'player']) localStorage.removeItem(k);
}

export function channel() {
  return new BroadcastChannel('faerun-walker');
}

// ---------- геометрия ----------
// Азимут: 0° — север (вверх), 90° — восток.
export function stepPoint(x, y, bearing, km, kmPerPx) {
  const d = km / kmPerPx, a = bearing * Math.PI / 180;
  return { x: x + Math.sin(a) * d, y: y - Math.cos(a) * d };
}

export function bearingTo(x0, y0, x1, y1) {
  const b = Math.atan2(x1 - x0, -(y1 - y0)) * 180 / Math.PI;
  return (b + 360) % 360;
}

export function distKm(x0, y0, x1, y1, kmPerPx) {
  return Math.hypot(x1 - x0, y1 - y0) * kmPerPx;
}

const RUMBS = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
export function rumb(b) { return RUMBS[Math.round(((b % 360) + 360) % 360 / 22.5) % 16]; }

export function fmtKm(km) {
  if (km >= 100) return `${Math.round(km)} км`;
  return `${km.toFixed(1).replace(/\.0$/, '')} км`;
}

export function uid() { return Math.random().toString(36).slice(2, 10); }

export const QUALITY = {
  high: { resScale: 2, fps: 60, detail: 1, overScale: 0.5 },
  medium: { resScale: 1, fps: 30, detail: 1, overScale: 0.5 },
  low: { resScale: 0.6, fps: 20, detail: 0, overScale: 0.25 },
};

// Настройки WebGL-рендера из состояния кампании
export function renderSettings(S, isPlayer) {
  const q = QUALITY[isPlayer ? S.playerQuality : S.quality] || QUALITY.medium;
  return {
    styleMix: S.styleMix, labels: S.showLabels, season: S.season, clouds: S.clouds, animate: S.animate,
    fogOn: S.fogEnabled, fogStrength: isPlayer ? 1 : S.gmFogOpacity, fogGhost: S.fogGhost,
    resScale: q.resScale, detail: q.detail, fps: q.fps, overScale: q.overScale,
  };
}
