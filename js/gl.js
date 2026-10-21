// WebGL-рендер карты в духе Battle Brothers: местность по разметке, отмывка рельефа,
// деревья и горы, проявляющиеся при приближении, сезоны, облака с тенями, туман-дымка,
// названия с оригинала. Плавный переход «рисованная ↔ оригинал».
// Оверлеи (отряд, метки, значки поселений) рисует 2D-слой поверх.

const VS_RECT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;      // прямоугольник квада в px карты
uniform vec3 uView;      // cx, cy, scale
uniform vec2 uRes;       // размер экрана, css px
out vec2 vUV;
out vec2 vMap;
void main() {
  vec2 m = uRect.xy + aPos * uRect.zw;
  vec2 s = (m - uView.xy) * uView.z + uRes * 0.5;
  gl_Position = vec4(s / uRes * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vUV = aPos;
  vMap = m;
}`;

const FS_TILE = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vMap;
uniform sampler2D uTile;
out vec4 o;
void main() { o = vec4(texture(uTile, vUV).rgb, 1.0); }`;

// Названия: маска букв с оригинала → светлый текст с тёмной тенью, как подписи в BB
const FS_LABEL = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vMap;
uniform sampler2D uLab, uFog;
uniform vec2 uMap;
uniform vec2 uFogSize;
uniform vec2 uTexel;
uniform float uAlpha, uFogOn, uFogStrength;
out vec4 o;
void main() {
  float a = texture(uLab, vUV).r;
  // тень: размытая и сдвинутая вниз-вправо маска
  vec2 off = vec2(0.6, 0.8) * uTexel;
  float sh = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++)
    sh = max(sh, texture(uLab, vUV - off + vec2(float(i), float(j)) * uTexel * 0.8).r);
  vec3 cream = vec3(0.93, 0.89, 0.78);
  vec3 col = mix(vec3(0.05, 0.04, 0.03), cream, smoothstep(0.25, 0.55, a));
  float alpha = max(smoothstep(0.2, 0.5, a) * 0.92, sh * 0.45) * uAlpha;
  if (uFogOn > 0.5) {
    float f = texture(uFog, gl_FragCoord.xy / uFogSize).r;
    alpha *= 1.0 - smoothstep(0.3, 0.7, f) * uFogStrength;
  }
  o = vec4(col, alpha);
}`;

// Туман: экранный буфер «насколько скрыто» (R: 1 — туман). Сначала подложка (растр), затем фигуры:
// открытие — смешивание MIN, скрытие — MAX, в порядке добавления.
const FS_FOGBASE = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vMap;
uniform sampler2D uTile;
out vec4 o;
void main() { o = vec4(texture(uTile, vUV).a); }`;

const VS_FOGOP = `#version 300 es
in vec2 aPos;      // угол квада 0..1
in vec4 aSeg;      // x0, y0, x1, y1 (px карты)
in vec2 aRR;       // радиус, 1 — открыть / 0 — скрыть
uniform vec3 uView;
uniform vec2 uRes;
out vec2 vMap;
flat out vec4 vSeg;
flat out vec2 vRR;
void main() {
  // запас под «лепестки» рваного края (до половины радиуса наружу)
  vec2 lo = min(aSeg.xy, aSeg.zw) - aRR.x * 1.5 - 2.0 / uView.z;
  vec2 hi = max(aSeg.xy, aSeg.zw) + aRR.x * 1.5 + 2.0 / uView.z;
  vec2 m = mix(lo, hi, aPos);
  vec2 s = (m - uView.xy) * uView.z + uRes * 0.5;
  gl_Position = vec4(s / uRes * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vMap = m; vSeg = aSeg; vRR = aRR;
}`;

const FS_FOGOP = `#version 300 es
precision highp float;
in vec2 vMap;
flat in vec4 vSeg;
flat in vec2 vRR;
uniform float uScale;
out vec4 o;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vec2 a = vSeg.xy, b = vSeg.zw, d = b - a;
  float l2 = dot(d, d);
  float t = l2 > 0.0 ? clamp(dot(vMap - a, d) / l2, 0.0, 1.0) : 0.0;
  float dist = length(vMap - a - d * t);
  float r = vRR.x;
  // рваный край: «лепестки» размером с долю радиуса и мелкая бахрома; узор привязан к карте,
  // поэтому у мастера и игроков одинаковый и не меняется при зуме
  vec2 q = vMap / r;
  float rag = (vn(q * 1.6) - 0.5) * 0.55 + (vn(q * 4.1 + 17.0) - 0.5) * 0.25 + (vn(q * 11.0 + 5.0) - 0.5) * 0.1;
  dist += rag * r;
  // мягкий край: часть радиуса, но не уже пары экранных пикселей
  float soft = max(r * 0.22, 1.5 / uScale);
  float cov = 1.0 - smoothstep(r - soft, r, dist);
  o = vec4(vRR.y > 0.5 ? 1.0 - cov : cov);
}`;

// Дороги, тропы и реки — настоящая геометрия (полосы вдоль полилиний), рисуется в два буфера:
// дороги (R покрытие, G «серединность», B тропа/фаза пунктира) и реки (R вода, G середина, B фаза течения, A берег).
const VS_LINE = `#version 300 es
in vec2 aPos;
in vec2 aNrm;
in float aSide;
in float aAlong;
in float aWidth;
in float aKind;     // 0 дорога, 1 тропа, 2 река
uniform vec3 uView;
uniform vec2 uRes;
out float vAcross;
out float vHalf;
out float vBank;
out float vAlong;
out float vKind;
out vec2 vMap;
void main() {
  float minPx = aKind < 0.5 ? 1.8 : (aKind < 1.5 ? 1.3 : 1.5);
  float hw = max(aWidth, minPx * 0.5 / uView.z);
  float bank = aKind > 1.5 ? max(hw * 0.35, 1.2 / uView.z) : 0.0;
  float ext = hw + bank + 1.0 / uView.z;
  vec2 m = aPos + aNrm * aSide * ext;
  vec2 s = (m - uView.xy) * uView.z + uRes * 0.5;
  gl_Position = vec4(s / uRes * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vAcross = aSide * ext;
  vHalf = hw;
  vBank = bank;
  vAlong = aAlong;
  vKind = aKind;
  vMap = m;
}`;

const FS_LINE = `#version 300 es
precision highp float;
precision highp int;
in float vAcross;
in float vHalf;
in float vBank;
in float vAlong;
in float vKind;
in vec2 vMap;
uniform float uScale;
layout(location = 0) out vec4 oRoad;
layout(location = 1) out vec4 oRiver;
uint hu(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v.x ^ v.y;
}
float hash(vec2 p) { return float(hu(uvec2(ivec2(floor(p)) + 65536))) * (1.0 / 4294967295.0); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  float aa = 0.8 / uScale;
  float d = abs(vAcross);
  if (vKind < 1.5) {
    // неровный край грунтовки — заметен только вблизи
    float edge = vHalf * (1.0 + 0.35 * (vnoise(vMap * 1.7) - 0.5) * smoothstep(1.0, 3.0, uScale));
    float cov = 1.0 - smoothstep(edge - aa, edge + aa, d);
    float cen = clamp(1.0 - d / max(edge, 1e-3), 0.0, 1.0);
    float trail = vKind > 0.5 ? 0.5 + 0.5 * fract(vAlong / 6.0) : 0.0;
    oRoad = vec4(cov, cen * cov, trail * cov, cov);
    oRiver = vec4(0.0);
  } else {
    float edge = vHalf * (1.0 + 0.15 * (vnoise(vMap * 0.7) - 0.5));
    float cov = 1.0 - smoothstep(edge - aa, edge + aa, d);
    float bank = 1.0 - smoothstep(edge + vBank - aa, edge + vBank + aa, d);
    float cen = clamp(1.0 - d / max(edge, 1e-3), 0.0, 1.0);
    oRiver = vec4(cov, cen * cov, fract(vAlong / 32.0) * cov, bank);
    oRoad = vec4(0.0);
  }
}`;

const VS_FX = `#version 300 es
in vec2 aPos;
uniform vec3 uView;
uniform vec2 uRes;
out vec2 vMap;
out vec2 vScr;
void main() {
  vec2 s = aPos * uRes;
  vMap = (s - uRes * 0.5) / uView.z + uView.xy;
  vScr = vec2(aPos.x, 1.0 - aPos.y);
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}`;

const FS_FX = `#version 300 es
precision highp float;
precision highp int;
in vec2 vMap;
in vec2 vScr;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 o2;
uniform sampler2D uT0, uT1, uT2, uT3, uFog, uBase, uRoads, uRivers, uTerrain, uOver0, uOver1;
uniform int uPass;
uniform vec2 uMap;
uniform float uScale, uTime, uSeason, uMix, uLines;
uniform float uFogOn, uFogStrength, uFogGhost, uClouds, uDetail;

const float SDF_R = 24.0, LINE_R = 12.0, DEPTH_R = 400.0;

// ---------- шум ----------
uint hu(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v.x ^ v.y;
}
float hash(vec2 p) { return float(hu(uvec2(ivec2(floor(p)) + 65536))) * (1.0 / 4294967295.0); }
vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + vec2(91.0, 37.0))); }
vec2 grad(vec2 i) { float a = hash(i) * 6.2831853; return vec2(cos(a), sin(a)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f), b = dot(grad(i + vec2(1, 0)), f - vec2(1, 0));
  float c = dot(grad(i + vec2(0, 1)), f - vec2(0, 1)), d = dot(grad(i + vec2(1, 1)), f - vec2(1, 1));
  return clamp(0.5 + 0.75 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y), 0.0, 1.0);
}
// fbm с отсечением октав мельче пары экранных пикселей; px — экранных пикселей в единице p
float fbm(vec2 p, int oct, float px) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * mix(0.5, noise(p), smoothstep(1.5, 5.0, px));
    n += a;
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
    px *= 0.5;
  }
  return s / n;
}
float ridged(vec2 p, int oct, float px) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    float r = 1.0 - abs(noise(p) * 2.0 - 1.0);
    s += a * mix(0.6, r * r, smoothstep(1.5, 5.0, px));
    n += a;
    p = p * 2.1 + vec2(5.3, 1.7);
    a *= 0.5;
    px *= 0.5;
  }
  return s / n;
}

float sd(float v, float R) { return (v - 0.5) * 2.0 * R; }

vec4 SW; // веса сезонов: весна, лето, осень, зима
vec3 seas(vec3 a, vec3 b, vec3 c, vec3 d) { return a * SW.x + b * SW.y + c * SW.z + d * SW.w; }
float seasf(float a, float b, float c, float d) { return a * SW.x + b * SW.y + c * SW.z + d * SW.w; }

bool inside(vec2 p) { return p.x >= 0.0 && p.y >= 0.0 && p.x < uMap.x && p.y < uMap.y; }
vec3 T0(vec2 p) { return inside(p) ? texture(uT0, p / uMap).rgb : vec3(1.0, 0.0, 0.0); }
vec3 T1(vec2 p) { return inside(p) ? texture(uT1, p / uMap).rgb : vec3(0.0); }

// ---------- горы: гребни (ridged multifractal) в мировых координатах ----------
// Форма гор не зависит от зума: при приближении проступают мелкие октавы, крупные хребты те же.
// Амплитуда октав падает быстрее частоты, поэтому вблизи склоны гладкие, а не «бугристые».
float rmf(vec2 p, int oct, float px) {
  float s = 0.0, a = 0.5, w = 1.0, n = 0.0;
  mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    float r = 1.0 - abs(noise(p) * 2.0 - 1.0);
    r = r * r * w;
    w = clamp(r * 1.8, 0.0, 1.0);
    s += a * mix(0.3, r, smoothstep(1.0, 4.0, px));
    n += a;
    p = R * p * 2.0 + vec2(3.1, 7.7);
    a *= 0.42;
    px *= 0.5;
  }
  return s / n;
}

// высота рельефа для отмывки
float heightAt(vec2 p) {
  vec3 a = T0(p), b = T1(p);
  float sMo = sd(a.b, SDF_R), sHi = sd(b.r, SDF_R);
  float mm = smoothstep(-8.0, 16.0, sMo);
  float mh = smoothstep(-8.0, 16.0, sHi);
  float h = 0.0;
  if (mm > 0.0) {
    // изгиб хребтов и подъём к середине массива
    vec2 q = p + (vec2(noise(p * 0.017), noise(p * 0.017 + 7.3)) - 0.5) * 40.0;
    float core = clamp(sMo / 24.0, 0.0, 1.0);
    h += mm * (0.2 + 0.3 * core + 0.6 * rmf(q * 0.028, 7, uScale / 0.028));
  }
  if (mh > 0.0) h += mh * 0.28 * fbm(p * 0.04 + 3.0, 5, uScale / 0.04);
  return h;
}

// ---------- трава: еле заметные кустики при сильном приближении ----------
float grassTufts(vec2 p) {
  float c = 1.3;  // ячейка, px карты
  vec2 g = floor(p / c), f = p / c - g;
  vec2 r = hash2(g + 51.0);
  if (r.x * 0.6 + r.y * 0.4 < 0.3) return 0.0;  // не в каждой ячейке
  vec2 base = vec2(0.28 + 0.44 * r.x, 0.62 + 0.25 * r.y);
  float aa = 0.8 / (uScale * c);
  float a = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float ang = -1.5708 + (fk - 1.0) * 0.5 + (hash(g + fk * 7.0) - 0.5) * 0.5;
    vec2 dir = vec2(cos(ang), sin(ang));
    float L = 0.26 + 0.14 * hash(g + fk * 3.0);
    vec2 q = f - base;
    float t = clamp(dot(q, dir), 0.0, L);
    float dist = length(q - dir * t);
    float w = 0.04 * (1.0 - t / L) + 0.008;
    a = max(a, 1.0 - smoothstep(w, w + aa, dist));
  }
  return a;
}

// ---------- деревья ----------
vec4 over(vec4 acc, vec3 c, float a) { return vec4(c * a + acc.rgb * (1.0 - a), a + acc.a * (1.0 - a)); }

vec4 trees(vec2 p, float c, float lat, float snow) {
  vec2 g = floor(p / c);
  vec4 acc = vec4(0.0);
  float px = 1.0 / uScale;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = g + vec2(float(i), float(j));
      vec2 rnd = hash2(id + c * 13.0);
      vec2 ctr = (id + 0.15 + 0.7 * rnd) * c;
      vec3 tc = T0(ctr);
      if (sd(tc.g, SDF_R) < c * 0.1 || sd(tc.r, SDF_R) > -2.0) continue;
      float k = hash(id + 7.7 + c);
      if (k < 0.08) continue; // поляны
      float r = c * (0.42 + 0.2 * hash(id + 3.1 + c));
      vec2 d = (p - ctr) / r;
      float e = px / r * 1.5;
      bool conifer = hash(id + 11.0) < mix(0.25, 0.9, smoothstep(0.35, 0.12, lat));
      // тень на земле вправо-вниз (солнце с северо-запада)
      float sh = 1.0 - smoothstep(0.75 - e, 0.95 + e, length((d - vec2(0.4, 0.35)) * vec2(1.0, 1.3)));
      acc = over(acc, vec3(0.03, 0.04, 0.02), sh * 0.45);
      vec3 base;
      float a, shade;
      if (conifer) {
        float w = (d.y + 1.15) * 0.48;
        a = smoothstep(-e, e, min(min(d.y + 1.15, 0.75 - d.y), w - abs(d.x)));
        base = seas(vec3(0.12, 0.2, 0.12), vec3(0.1, 0.17, 0.1), vec3(0.11, 0.17, 0.1), vec3(0.12, 0.17, 0.13));
        shade = 0.8 + 0.5 * smoothstep(0.3, -0.3, d.x);
      } else {
        a = 1.0 - smoothstep(1.0 - e, 1.0 + e, length(d));
        vec3 autumn = mix(vec3(0.55, 0.26, 0.07), vec3(0.62, 0.44, 0.12), hash(id + 5.0));
        base = seas(vec3(0.24, 0.33, 0.14), vec3(0.18, 0.25, 0.12), autumn, vec3(0.3, 0.26, 0.21));
        // мягкий объём кроны: свет сверху-слева
        shade = 0.7 + 0.55 * clamp(0.55 - dot(d, vec2(0.6, 0.6)) * 0.6, 0.0, 1.0);
        a *= mix(1.0, 0.6, SW.w);
      }
      vec3 col = base * (0.85 + 0.3 * k) * shade;
      col = mix(col, vec3(0.85, 0.88, 0.88) * shade, snow * smoothstep(0.2, -0.6, d.y) * 0.85);
      acc = over(acc, col, a);
    }
  }
  return acc;
}

// Блики на воде во времени t: в проходе местности считаются при t = 0, а в лёгком проходе поверх кэша
// добавляется только разница — так вода «живая», но местность ради неё не пересчитывается.
float riverGlint(vec2 p, vec4 RV, float t, float zr) {
  float flow = sin(6.2832 * (RV.b * 4.0) - t * 2.4 + (noise(p * 0.3) - 0.5) * 5.0);
  return smoothstep(0.7, 1.0, flow) * noise(p * 0.9 + t * 0.25) * 0.14 * zr * smoothstep(0.15, 0.6, RV.g)
       + (noise(p * 0.45 + vec2(t * 0.35, t * 0.1)) - 0.5) * 0.05 * zr;
}
float waterGlint(vec2 p, float t) { return (noise(p * 0.15 + vec2(t * 0.2, t * 0.07)) - 0.5) * 0.04; }

// Погодное облако уровня n: (плотность облака, тень). Узор уровня фиксирован — переход по зуму плавный.
vec2 weatherCloud(vec2 p, float n, vec2 wind, float cov) {
  float f = 0.006 * exp2(n);
  float cpx = uScale / f;
  vec2 off = vec2(hash(vec2(n + 31.0, 7.0)), hash(vec2(3.0, n + 47.0))) * 100.0;
  vec2 q = (p - wind) * f + off;
  vec2 qw = q + vec2(fbm(q * 1.3, 3, cpx * 1.3), fbm(q * 1.3 + 5.2, 3, cpx * 1.3)) * 0.35;
  float c = fbm(qw, 6, cpx);
  // тень смещена на постоянную долю облака; искажение то же (оно плавное) — не пересчитываем
  vec2 qsw = qw - vec2(30.0, 24.0) * 0.006;
  float sh = smoothstep(cov, cov + 0.1, fbm(qsw, 6, cpx));
  float cl = smoothstep(cov, cov + 0.05, c) * (0.6 + 0.4 * smoothstep(cov, cov + 0.25, c));
  return vec2(cl, sh);
}

// Облака тумана: уровень n — свой фиксированный узор (частота 2^n), поэтому при зуме
// соседние уровни плавно перетекают друг в друга без скачков. Возвращает (плотность, освещённость).
vec2 fogLevel(vec2 p, float n, vec2 drift, float seed, bool lit) {
  float f = 0.006 * exp2(n);
  vec2 off = vec2(hash(vec2(n + 50.0, seed)), hash(vec2(seed, n + 90.0))) * 100.0;
  vec2 q = (p + drift * 0.3) * f + off;  // дрейф в px карты в секунду
  vec2 w = q + vec2(fbm(q * 0.7, 3, 8.0), fbm(q * 0.7 + 4.3, 3, 8.0)) * 1.2;
  float c = fbm(w, 4, 8.0);
  if (!lit) return vec2(c, 0.5);   // освещение нужно только клубам, не кромке и не дымке
  float c2 = fbm(w + vec2(0.07), 4, 8.0);
  return vec2(c, clamp((c - c2) * 4.0 + 0.55, 0.0, 1.0));
}
vec2 fogLod(vec2 p, float lz, vec2 drift, float seed, bool lit) {
  float l0 = floor(lz), lf = lz - l0;
  lf = lf * lf * (3.0 - 2.0 * lf);
  return mix(fogLevel(p, l0, drift, seed, lit), fogLevel(p, l0 + 1.0, drift, seed, lit), lf);
}

void main() {
  vec2 p = vMap;
  float px = 1.0 / uScale;   // px карты в одном экранном пикселе
  float s = mod(uSeason, 4.0);
  SW = vec4(max(0.0, 1.0 - min(s, 4.0 - s)), max(0.0, 1.0 - abs(s - 1.0)), max(0.0, 1.0 - abs(s - 2.0)), max(0.0, 1.0 - abs(s - 3.0)));
  SW /= (SW.x + SW.y + SW.z + SW.w);

  vec3 col;
  if (uPass >= 1) {
    // местность уже посчитана и лежит в кэше (в проходе 2 не нужна)
    col = uPass == 1 ? texture(uTerrain, vScr).rgb : vec3(0.0);
  } else {
  bool ins = inside(p);
  vec2 uv = p / uMap;
  vec3 t0 = T0(p), t1 = T1(p);
  vec3 t2 = ins ? texture(uT2, uv).rgb : vec3(0.0, 0.0, 1.0);
  vec3 t3 = ins ? texture(uT3, uv).rgb : vec3(1.0, 1.0, 0.0);

  float warp = (fbm(p * 0.08, 4, uScale / 0.08) - 0.5) * 8.0;
  float aa = max(px, 0.5);
  float sW = sd(t0.r, SDF_R) + warp * 0.5;
  float sF = sd(t0.g, SDF_R) + warp;
  float sM = sd(t0.b, SDF_R) + warp;
  float sH = sd(t1.r, SDF_R) + warp;
  float sDs = sd(t1.g, SDF_R) + warp;
  float sSw = sd(t1.b, SDF_R) + warp;
  float sI = sd(t2.r, SDF_R) + warp * 0.5;
  float sC = sd(t2.g, SDF_R) + warp * 0.3;
  float mW = smoothstep(-aa, aa, sW);
  float mF = smoothstep(-aa, aa, sF);
  float mM = smoothstep(-aa, aa, sM);
  float mH = smoothstep(-aa, aa, sH);
  float mDs = smoothstep(-aa, aa, sDs);
  float mSw = smoothstep(-aa, aa, sSw);
  float mC = smoothstep(-aa, aa, sC);
    float depth = t3.g;
  float lat = p.y / uMap.y;

  // снег: зимой линия снега спускается к югу, горы заснежены выше
  float hm = smoothstep(-10.0, 30.0, sd(t0.b, SDF_R)) * (0.6 + 0.4 * t3.b);
  float snowLine = seasf(0.14, 0.05, 0.12, 0.38) + hm * seasf(0.12, 0.06, 0.1, 0.3);
  float snow = smoothstep(-0.02, 0.03, snowLine - lat + (fbm(p * 0.01, 4, uScale / 0.01) - 0.5) * 0.14);
  snow = max(snow, smoothstep(-aa, aa, sI));

  col = vec3(0.0);
  vec3 painted = vec3(0.0), orig = vec3(0.0);
  // высота рельефа и её наклон (конечные разности) — одна на рисованную карту и оригинал
  float he = max(px * 1.2, 0.3);
  float h0 = heightAt(p);
  vec2 hg = vec2(heightAt(p + vec2(he, 0.0)) - h0, heightAt(p + vec2(0.0, he)) - h0) / he;

  if (uMix > 0.001) {
    // ---------- оригинальная карта + сезоны поверх ----------
    orig = texture(uBase, vScr).rgb;
    float l = dot(orig, vec3(0.3, 0.59, 0.11));
    vec3 autumn = mix(vec3(l * 1.3, l * 0.82, l * 0.42), vec3(l * 1.25, l * 1.05, l * 0.45), noise(p * 0.08));
    orig = mix(orig, autumn, mF * SW.z * 0.65);
    orig = mix(orig, vec3(0.97, 0.98, 1.0) * mix(0.55, 1.05, smoothstep(0.15, 0.85, l)), snow * (1.0 - mW) * 0.85);
    // цветокоррекция: чуть контрастнее и насыщеннее
    // контраст без засветки: светлое не трогаем, середину и тени углубляем (гамма + мягкая S-кривая к 0.75)
    orig = pow(orig, vec3(1.25));
    orig = clamp((orig - 0.75) * 1.12 + 0.75, 0.0, 1.0) * 0.97;
    orig = clamp(mix(vec3(dot(orig, vec3(0.3, 0.59, 0.11))), orig, 1.15), 0.0, 1.0);
    // отмывка рельефа по разметке — горы на картинке становятся объёмными
    if (sd(t0.b, SDF_R) > -10.0 || sd(t1.r, SDF_R) > -10.0) {
      vec3 no = normalize(vec3(-hg * 18.0, 1.0));
      vec3 Lo = normalize(vec3(-1.0, -1.0, 1.2));
      orig *= mix(1.0, clamp(dot(no, Lo) / Lo.z, 0.5, 1.3), 0.55);
    }
  }

  if (uMix < 0.999) {
    // ---------- рисованная карта ----------
    float gpx = uScale;
    float var = fbm(p * 0.03, 5, gpx / 0.03);
    // трава: тёмная оливковая с пятнами и «кочками»
    vec3 grassA = seas(vec3(0.3, 0.38, 0.18), vec3(0.33, 0.34, 0.19), vec3(0.37, 0.34, 0.19), vec3(0.42, 0.42, 0.38));
    vec3 grassB = seas(vec3(0.38, 0.44, 0.22), vec3(0.42, 0.41, 0.24), vec3(0.45, 0.39, 0.22), vec3(0.5, 0.5, 0.47));
    col = mix(grassA, grassB, smoothstep(0.3, 0.75, var));
    float tuft = noise(p * 0.9) * 0.6 + noise(p * 2.3) * 0.4;
    col *= 0.88 + 0.24 * mix(0.5, tuft, smoothstep(0.8, 3.0, uScale));
    // осенние рыжие пятна, как у BB
    col = mix(col, vec3(0.5, 0.3, 0.13), SW.z * smoothstep(0.62, 0.7, fbm(p * 0.02 + 9.0, 3, gpx / 0.02)) * 0.7);

    // пустыня: охра, рябь дюн
    vec3 desert = vec3(0.6, 0.48, 0.23) * (0.94 + 0.12 * var);
    float dunes = sin(dot(p, vec2(0.35, 0.12)) + fbm(p * 0.03, 3, gpx / 0.03) * 12.0);
    desert = mix(desert, vec3(0.5, 0.39, 0.18), smoothstep(0.6, 1.0, dunes) * 0.6 * smoothstep(0.5, 1.5, uScale));
    col = mix(col, desert, mDs);

    // болото: рыжий камыш, серые лужи
    vec3 swamp = seas(vec3(0.33, 0.33, 0.2), vec3(0.38, 0.32, 0.2), vec3(0.42, 0.33, 0.19), vec3(0.45, 0.44, 0.4));
    swamp *= 0.85 + 0.3 * noise(p * vec2(1.8, 0.5));
    float pools = smoothstep(0.58, 0.63, fbm(p * 0.09, 3, gpx / 0.09));
    swamp = mix(swamp, vec3(0.26, 0.31, 0.28), pools * 0.9);
    col = mix(col, swamp, mSw);

    // холмы: трава с каменистыми буграми
    vec3 hills = mix(col, vec3(0.42, 0.4, 0.31), 0.35);
    col = mix(col, hills, mH);

    // лес: почти чёрно-зелёный подлесок
    vec3 forest = seas(vec3(0.14, 0.2, 0.1), vec3(0.11, 0.15, 0.08), vec3(0.36, 0.2, 0.08), vec3(0.17, 0.19, 0.16));
    col = mix(col, forest * (0.85 + 0.3 * noise(p * 0.5)), mF);

    // горы: серый камень
    vec3 n = normalize(vec3(-hg * 22.0, 1.0));
    vec3 L = normalize(vec3(-1.0, -1.0, 1.2));
    float shade = clamp(dot(n, L) / L.z, 0.3, 1.45);
    vec3 rock = mix(vec3(0.3, 0.29, 0.25), vec3(0.6, 0.6, 0.57), smoothstep(0.25, 0.95, h0));
    // слоистость и осыпи вблизи
    float zoomR = smoothstep(1.0, 3.0, uScale);
    rock *= 1.0 + zoomR * (0.08 * (noise(vec2(p.x * 0.08, h0 * 30.0)) - 0.5) + 0.06 * (noise(p * 1.1) - 0.5));
    rock = mix(rock, vec3(0.42, 0.39, 0.32), (1.0 - smoothstep(0.2, 0.5, h0)) * 0.4);
    col = mix(col, rock, mM);
    // тёмная кромка у подножия гор
    col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 2.5 * aa + 1.0, abs(sM))) * step(-2.0 * aa, sM);
    col *= mix(1.0, shade, 0.9 * (1.0 - mW));

    // снежные шапки (на пологих вершинах больше) и зимний снег
    float cap = smoothstep(seasf(0.78, 0.86, 0.8, 0.5), seasf(0.86, 0.95, 0.88, 0.6), h0 + (n.z - 0.85) * 0.5) * mM;
    float sn = max(snow, cap);
    vec3 snowCol = vec3(0.86, 0.88, 0.89) * (0.92 + 0.08 * noise(p * 0.3)) * mix(0.72, 1.1, clamp(shade, 0.0, 1.3));
    col = mix(col, snowCol, sn * (1.0 - mW) * 0.95);

    // провалы (Подземье)
    vec3 chasm = vec3(0.08, 0.06, 0.07) + vec3(0.3, 0.08, 0.2) * (1.0 - smoothstep(0.0, 14.0, sC)) * 0.5;
    col = mix(col, chasm, mC);

    // вода: тёмная бирюза, светлее у берега, пена и песчаная кромка
    float dpx = depth * DEPTH_R;
    vec3 shallow = seas(vec3(0.2, 0.34, 0.32), vec3(0.2, 0.35, 0.33), vec3(0.19, 0.31, 0.3), vec3(0.24, 0.32, 0.33));
    vec3 deep = seas(vec3(0.11, 0.22, 0.22), vec3(0.1, 0.22, 0.22), vec3(0.1, 0.2, 0.2), vec3(0.13, 0.2, 0.22));
    vec3 water = mix(shallow, deep, smoothstep(2.0, 60.0, dpx + (noise(p * 0.03) - 0.5) * 30.0));
    float rv = smoothstep(0.4, 1.4, uScale);
    water += waterGlint(p, uTime) * rv;
    // пена у берега
    float foam = (1.0 - smoothstep(0.3 * aa, 1.6 * aa + 0.6, abs(sW - (1.2 + 0.6 * sin(uTime * 0.8 + p.x * 0.05)))));
    water = mix(water, vec3(0.75, 0.78, 0.74), foam * 0.6 * smoothstep(0.3, 0.9, uScale));
    water = mix(water, vec3(0.75, 0.82, 0.84), snow * SW.w * (1.0 - smoothstep(3.0, 12.0, dpx + noise(p * 0.05) * 8.0)) * 0.7);
    // песчаный пляж с суши
    float beach = smoothstep(-(1.5 + 1.2 * aa), -0.2, sW) * (1.0 - mW) * (1.0 - mC) * (1.0 - mM * 0.7);
    col = mix(col, mix(vec3(0.6, 0.57, 0.44), snowCol, snow * 0.8), beach * 0.85);
    col = mix(col, water, mW);

    // деревья при приближении; при отдалении — просто тёмный лес
    float tv = smoothstep(0.3, 0.6, uScale) * uDetail;
    if (tv > 0.0 && sF > -40.0) {
      float cell = 10.0 / uScale;
      float lv = log2(max(cell, 1.6));
      float l0 = floor(lv);
      float fr = smoothstep(0.0, 1.0, lv - l0);
      // второй уровень деревьев считаем только на переходе между уровнями
      vec4 tr = fr < 0.02 ? trees(p, exp2(l0), lat, snow)
              : fr > 0.98 ? trees(p, exp2(l0 + 1.0), lat, snow)
              : mix(trees(p, exp2(l0), lat, snow), trees(p, exp2(l0 + 1.0), lat, snow), fr);
      if (tr.a > 0.001) col = mix(col, tr.rgb / tr.a, tr.a * tv);
    }

    // трава на открытых местах
    float gv = smoothstep(1.3, 2.6, uScale) * uDetail * (1.0 - mF) * (1.0 - mW) * (1.0 - mM) * (1.0 - mDs) * (1.0 - mC) * (1.0 - snow);
    if (gv > 0.01) {
      float gt = grassTufts(p) + grassTufts(p * 1.37 + 11.0) * 0.7;
      vec3 blade = seas(vec3(0.26, 0.34, 0.14), vec3(0.27, 0.29, 0.14), vec3(0.42, 0.33, 0.16), vec3(0.4, 0.4, 0.36));
      col = mix(col, blade, clamp(gt, 0.0, 1.0) * 0.4 * gv);
    }

    if (uLines > 0.5) {
      // реки: вода как у озёр — глубже к середине, мокрый берег, пена у кромки, блики по течению
      vec4 RV = texture(uRivers, vScr);
      if (RV.a > 0.002) {
        float wcov = RV.r, cen = RV.g, ph = RV.b, bankc = RV.a;
        float zr = smoothstep(0.6, 2.5, uScale);
        col = mix(col, col * 0.72, (bankc - wcov) * 0.7 * zr);  // мокрый тёмный берег
        vec3 rc = mix(shallow * 1.15, mix(shallow, deep, 0.6), smoothstep(0.1, 0.95, cen) * (0.35 + 0.65 * zr));
        rc += riverGlint(p, RV, uTime, zr);
        float edgeF = (1.0 - smoothstep(0.0, 0.22, cen)) * zr;
        rc = mix(rc, vec3(0.66, 0.7, 0.66), edgeF * 0.45);
        rc = mix(rc, vec3(0.78, 0.84, 0.87), snow * SW.w * 0.65);
        col = mix(col, rc, wcov * smoothstep(0.05, 0.15, uScale));
      }
      // дороги: утоптанная грунтовка с обочиной, колеёй и камешками; тропы уже и бледнее
      vec4 RD = texture(uRoads, vScr);
      if (RD.r > 0.002) {
        bool trail = RD.b > 0.25;
        float cen = RD.g;
        float zr = smoothstep(1.2, 3.5, uScale);
        vec3 dirt = mix(vec3(0.27, 0.2, 0.11), vec3(0.52, 0.42, 0.27), smoothstep(0.15, 0.85, cen) * (0.35 + 0.65 * zr));
        float rut = (1.0 - smoothstep(0.05, 0.13, abs(cen - 0.5))) * zr * (trail ? 0.3 : 1.0);
        dirt *= 1.0 - 0.22 * rut;
        dirt *= 0.86 + 0.28 * mix(0.5, noise(p * 2.4), zr);
        float pebble = step(0.82, noise(p * 3.3)) * zr;
        dirt = mix(dirt, vec3(0.55, 0.52, 0.46), pebble * 0.5);
        dirt = mix(dirt, vec3(0.76, 0.77, 0.78), snow * 0.5);
        float a = RD.r * smoothstep(0.12, 0.3, uScale);
        if (trail) a *= 0.8 * (0.75 + 0.25 * noise(p * 0.6));
        col = mix(col, col * 0.78, (1.0 - smoothstep(0.0, 0.3, cen)) * RD.r * 0.5 * zr);  // обочина
        col = mix(col, dirt, a * mix(1.0, 0.9, 1.0 - smoothstep(0.0, 0.2, cen)));
      }
    }

    // лёгкая «бумага»
    col *= 0.96 + 0.08 * noise(p * 0.7 + 3.0);
    painted = col;
  }

  col = mix(painted, orig, uMix);
  o = vec4(col, 1.0);
  return;
  }

  // ---------- облака и клубы тумана: считаются в пониженном разрешении (проход 2) ----------
  if (uPass == 2) {
    vec4 w = vec4(0.0, 0.0, 0.5, 0.5);
    if (uClouds > 0.5) {
      // Издалека — крупные редкие облака; вблизи уровни растут с зумом: мельче и чаще
      vec2 wind = vec2(1.0, 0.3) * uTime * 0.4;
      float cov = seasf(0.64, 0.67, 0.63, 0.62);
      float lzc = max(0.0, log2(uScale / 0.5) * 0.8);
      float l0 = floor(lzc), lf = lzc - l0;
      lf = lf * lf * (3.0 - 2.0 * lf);
      w.xy = mix(weatherCloud(p, l0, wind, cov), weatherCloud(p, l0 + 1.0, wind, cov), lf);
    }
    vec4 fc = vec4(0.0, 0.0, 0.0, 1.0);  // клубы тумана: hidden = основа * a + rgb
    // там, где туман уже открыт (с запасом на рваную кромку), клубы не нужны
    if (uFogOn > 0.5 && texture(uFog, vScr).r > 0.08) {
      float lz = log2(uScale);
      w.w = fogLod(p, lz + 2.5, vec2(uTime * 0.4, uTime * 0.15), 7.0, false).x;
      w.z = fogLod(p, lz - 1.0, vec2(uTime * 0.3, -uTime * 0.2), 3.0, false).x;
      // три слоя: крупный на восток, средний на северо-запад, мелкий на юг
      vec2 dirs[3] = vec2[3](vec2(1.6, 0.4), vec2(-1.1, -0.9), vec2(0.3, 1.4));
      float bias[3] = float[3](-0.6, 0.2, 1.0);
      float wgt = mix(0.85, 0.45, uFogGhost);
      for (int k = 0; k < 3; k++) {
        if (uDetail < 0.5 && k != 1) continue;
        vec2 cl = fogLod(p, lz + bias[k], dirs[k] * uTime, 11.0 + float(k) * 17.0, true);
        float dens = smoothstep(0.46, 0.64, cl.x);
        float shade = 1.0 - 0.18 * dens;          // тень слоя на том, что под ним
        vec3 cc = mix(vec3(0.42, 0.42, 0.43), vec3(0.8, 0.79, 0.76), cl.y) * (0.92 + 0.05 * float(k));
        float dw = dens * wgt;
        fc.a *= shade * (1.0 - dw);
        fc.rgb = fc.rgb * shade * (1.0 - dw) + cc * dw;
      }
    }
    o = w;
    o2 = fc;
    return;
  }

  // живая вода поверх кэша местности (разница бликов между «сейчас» и t = 0)
  if (uTime > 0.0 && uMix < 0.999) {
    float paint = 1.0 - uMix;
    float mWa = smoothstep(-0.5, 0.5, sd(T0(p).r, SDF_R));
    col += (waterGlint(p, uTime) - waterGlint(p, 0.0)) * smoothstep(0.4, 1.4, uScale) * mWa * paint;
    if (uLines > 0.5) {
      vec4 RV = texture(uRivers, vScr);
      if (RV.r > 0.01) {
        float zr = smoothstep(0.6, 2.5, uScale);
        col += vec3(riverGlint(p, RV, uTime, zr) - riverGlint(p, RV, 0.0, zr)) * RV.r * smoothstep(0.05, 0.15, uScale) * paint;
      }
    }
  }

  vec4 W = texture(uOver0, vScr), FC = texture(uOver1, vScr);
  if (uClouds > 0.5) {
    float near = smoothstep(1.0, 6.0, uScale);
    col *= 1.0 - 0.35 * W.y * (1.0 - 0.3 * near);
    vec3 cloudCol = mix(vec3(0.66, 0.68, 0.7), vec3(0.97, 0.97, 0.98), smoothstep(0.0, 1.0, W.x));
    col = mix(col, cloudCol, W.x * mix(0.92, 0.72, near));
  }

  // ---------- солнце сверху: тёплый свет, лёгкие лучи, верх светлее низа ----------
  {
    vec2 sun = vec2(0.3 + 0.12 * sin(uTime * 0.013), -0.25);
    vec2 dv = (vScr - sun) * vec2(1.5, 1.0);
    float d = length(dv);
    float ang = atan(dv.x, dv.y);
    float rays = 0.5 + 0.5 * sin(ang * 23.0 + uTime * 0.05) * sin(ang * 9.0 - uTime * 0.03);
    float glow = exp(-d * d * 1.6);
    vec3 sunC = vec3(1.0, 0.85, 0.58) * (0.13 * glow + 0.05 * glow * rays);
    col = mix(col + sunC, col * (1.0 + sunC * vec3(0.6, 0.35, -0.2)), uMix);
    col *= mix(mix(1.05, 0.92, smoothstep(0.0, 1.0, vScr.y)), mix(1.0, 0.9, smoothstep(0.0, 1.0, vScr.y)), uMix);
    col *= vec3(1.02, 1.0, 0.96);
  }

  // ---------- туман войны ----------
  if (uFogOn > 0.5) {
    float fm = texture(uFog, vScr).r;
    float fe = smoothstep(0.4, 0.6, fm + (W.w - 0.5) * 0.3);
    if (fe > 0.0) {
      // подложка: светлая дымка; сквозь неё — приглушённая местность (ползунок мастера)
      vec3 base = mix(vec3(0.33, 0.34, 0.36), vec3(0.5, 0.5, 0.51), smoothstep(0.3, 0.7, W.z));
      float g = dot(col, vec3(0.3, 0.59, 0.11));
      vec3 ghost = mix(vec3(g), col, 0.35) * 0.8 + vec3(0.04, 0.035, 0.03);
      base = mix(base, ghost, uFogGhost * 0.85);
      vec3 hidden = base * FC.a + FC.rgb;
      float rim = fe * (1.0 - fe) * 4.0;
      col = mix(col, col * vec3(0.6, 0.52, 0.42), rim * 0.5 * uFogStrength);
      col = mix(col, hidden, fe * uFogStrength);
    }
  }
  // виньетка
  col *= 1.0 - 0.22 * smoothstep(0.45, 0.95, length((vScr - 0.5) * vec2(1.25, 1.0)));
  o = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader: ' + log);
  }
  return sh;
}

function program(gl, vs, fs, attribs = ['aPos']) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('не загрузилось: ' + url));
    img.src = url;
  });
}

// Сглаживание ломаной (Чайкин): убирает пиксельные изломы скелета. Точки [x, y, (w)].
function chaikin(pts, iters) {
  for (let it = 0; it < iters; it++) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push(a.map((v, k) => v * 0.75 + b[k] * 0.25));
      out.push(a.map((v, k) => v * 0.25 + b[k] * 0.75));
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

// Полилинии → вершины полос (по 2 на точку) и индексы треугольников
function buildStrips(lines) {
  let nv = 0, ni = 0;
  for (const l of lines) { nv += l.pts.length * 2; ni += Math.max(0, l.pts.length - 1) * 6; }
  const V = new Float32Array(nv * 8);
  const I = new Uint32Array(ni);
  let v = 0, ii = 0;
  for (const { pts, kind, width } of lines) {
    const n = pts.length;
    if (n < 2) continue;
    const base = v / 8 / 1;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i > 0) along += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      let nx = -ty, ny = tx;
      // миттер: на изгибе полоса не сужается
      if (i > 0 && i < n - 1) {
        const sx = p[0] - a[0], sy = p[1] - a[1], sl = Math.hypot(sx, sy) || 1;
        const n0x = -sy / sl, n0y = sx / sl;
        const dot = nx * n0x + ny * n0y;
        const k = 1 / Math.max(0.4, dot);
        nx *= k; ny *= k;
      }
      const w = p.length > 2 ? p[2] : width;
      for (const side of [-1, 1]) {
        V[v++] = p[0]; V[v++] = p[1]; V[v++] = nx; V[v++] = ny;
        V[v++] = side; V[v++] = along; V[v++] = w; V[v++] = kind;
      }
    }
    const b0 = base;
    for (let i = 0; i < n - 1; i++) {
      const a0 = b0 + i * 2, a1 = a0 + 1, c0 = a0 + 2, c1 = a0 + 3;
      I[ii++] = a0; I[ii++] = a1; I[ii++] = c0;
      I[ii++] = a1; I[ii++] = c1; I[ii++] = c0;
    }
  }
  return { V, I, count: ii };
}

const MOVE_MS = 180;  // столько мс после последнего сдвига/зума карта считается «в движении»

export class MapRenderer {
  // opts.getSettings() → { styleMix, season, clouds, animate, fogOn, fogStrength, fogGhost, detail, resScale, labels }
  constructor(canvas, viewer, fog, opts) {
    this.canvas = canvas;
    this.viewer = viewer;
    this.fog = fog;
    this.opts = opts;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.gl = gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.software = /swiftshader|llvmpipe|software|basic render/i.test(name);
    this.tile = program(gl, VS_RECT, FS_TILE);
    this.label = program(gl, VS_RECT, FS_LABEL);
    this.fx = program(gl, VS_FX, FS_FX);
    this.lineProg = program(gl, VS_LINE, FS_LINE, ['aPos', 'aNrm', 'aSide', 'aAlong', 'aWidth', 'aKind']);
    this.fogBaseProg = program(gl, VS_RECT, FS_FOGBASE);
    this.fogOpProg = program(gl, VS_FOGOP, FS_FOGOP, ['aPos', 'aSeg', 'aRR']);
    this.fogOps = { vao: null, buf: null, count: 0, version: -1, batches: [] };
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.lines = null;
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.tex = {};
    this.tileTex = new Map();
    this.labelTex = new Map();  // key → { tex, ok, used }
    this.labelInfo = null;
    this.fogBaseVersion = -1;
    this.fogTex = this.makeTex();
    this.ready = false;
    this.start = performance.now();
  }

  makeTex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  async load(base = 'data/') {
    const gl = this.gl;
    const imgs = await Promise.all(['t0', 't1', 't2', 't3'].map(n => loadImage(`${base}${n}.png`)));
    imgs.forEach((img, i) => {
      const t = this.makeTex();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, img);
      this.tex['t' + i] = t;
    });
    this.ready = true;
    this.viewer.invalidate();
    this.loadLines(base).catch(e => console.warn('линии не загрузились', e));
    fetch('labels/info.json').then(r => r.json()).then(info => {
      info.sets = Object.fromEntries(Object.entries(info.tiles).map(([l, list]) => [l, new Set(list)]));
      this.labelInfo = info;
      this.viewer.invalidate();
    }).catch(() => {});
  }

  async loadLines(base) {
    const [roads, rivers] = await Promise.all([
      fetch(`${base}roads.json`).then(r => r.json()),
      fetch(`${base}rivers.json`).then(r => r.json()),
    ]);
    const lines = [];
    for (const r of roads) lines.push({ pts: chaikin(r.p, 2), kind: r.t === 'trail' ? 1 : 0, width: r.t === 'trail' ? 0.5 : 0.85 });
    for (const r of rivers) {
      // полуширина реки: по маске, но не меньше 0.8 px карты; сглаживаем и ширину
      const pts = chaikin(r.p.map(([x, y, w]) => [x, y, Math.max(0.8, w * 0.9)]), 2);
      lines.push({ pts, kind: 2, width: 1 });
    }
    const { V, I, count } = buildStrips(lines);
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, V, gl.STATIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
    const stride = 8 * 4;
    const layout = [[0, 2, 0], [1, 2, 2], [2, 1, 4], [3, 1, 5], [4, 1, 6], [5, 1, 7]];
    for (const [loc, size, off] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
    }
    gl.bindVertexArray(null);
    this.lines = { vao, count };
    this.viewer.invalidate();
  }

  ensureLineFbo() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (this.lineFbo && this.lineFbo.w === w && this.lineFbo.h === h) return;
    const mk = () => {
      const t = this.makeTex();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t;
    };
    const f = this.lineFbo || { fb: gl.createFramebuffer() };
    if (f.roads) { gl.deleteTexture(f.roads); gl.deleteTexture(f.rivers); }
    f.roads = mk(); f.rivers = mk(); f.w = w; f.h = h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.roads, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, f.rivers, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lineFbo = f;
  }

  drawLines() {
    const gl = this.gl, v = this.viewer, P = this.lineProg;
    this.ensureLineFbo();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lineFbo.fb);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.p);
    gl.uniform3f(P.u.uView, v.cx, v.cy, v.scale);
    gl.uniform2f(P.u.uRes, v.vw, v.vh);
    gl.uniform1f(P.u.uScale, v.scale);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);   // перекрытия на стыках не накапливаются
    gl.bindVertexArray(this.lines.vao);
    gl.drawElements(gl.TRIANGLES, this.lines.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(this.quadVao);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  syncFog() {
    const gl = this.gl, f = this.fog;
    if (f.baseVersion !== this.fogBaseVersion) {
      gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.base);
      this.fogBaseVersion = f.baseVersion;
    }
    const F = this.fogOps;
    if (F.version === f.version) return;
    F.version = f.version;
    const ops = f.ops;
    const data = new Float32Array(ops.length * 6);
    F.batches = [];
    ops.forEach((o, i) => {
      data.set([o.x0, o.y0, o.x1, o.y1, o.r, o.rev ? 1 : 0], i * 6);
      const last = F.batches[F.batches.length - 1];
      if (last && last.rev === o.rev) last.n++;
      else F.batches.push({ rev: o.rev, start: i, n: 1 });
    });
    if (!F.vao) {
      F.vao = gl.createVertexArray();
      F.buf = gl.createBuffer();
      gl.bindVertexArray(F.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, F.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data.length ? data : new Float32Array(6), gl.DYNAMIC_DRAW);
    F.count = ops.length;
  }

  ensureOverFbo(k) {
    const gl = this.gl;
    const w = Math.max(1, Math.round(this.canvas.width * k)), h = Math.max(1, Math.round(this.canvas.height * k));
    if (this.overFbo && this.overFbo.w === w && this.overFbo.h === h) return this.overFbo;
    const f = this.overFbo || { fb: gl.createFramebuffer() };
    for (const t of ['t0', 't1']) {
      if (f[t]) gl.deleteTexture(f[t]);
      f[t] = this.makeTex();
      gl.bindTexture(gl.TEXTURE_2D, f[t]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.t0, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, f.t1, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    f.w = w; f.h = h;
    this.overFbo = f;
    return f;
  }

  // Буфер местности: полный (k = 1) и половинный (k = 0.5, пока карту двигают)
  ensureTerrainFbo(k) {
    const gl = this.gl;
    const w = Math.max(1, Math.round(this.canvas.width * k)), h = Math.max(1, Math.round(this.canvas.height * k));
    this.terrainFbos = this.terrainFbos || {};
    let f = this.terrainFbos[k];
    if (f && f.w === w && f.h === h) return f;
    if (!f) f = this.terrainFbos[k] = { fb: gl.createFramebuffer(), k };
    if (f.tex) gl.deleteTexture(f.tex);
    f.tex = this.makeTex();
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    f.w = w; f.h = h; f.key = null;
    return f;
  }

  // экранный буфер тумана (R = насколько скрыто)
  drawFog() {
    const gl = this.gl, v = this.viewer, w = this.canvas.width, h = this.canvas.height;
    if (!this.fogFbo || this.fogFbo.w !== w || this.fogFbo.h !== h) {
      const f = this.fogFbo || { fb: gl.createFramebuffer() };
      if (f.tex) gl.deleteTexture(f.tex);
      f.tex = this.makeTex();
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
      f.w = w; f.h = h;
      this.fogFbo = f;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fogFbo.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // подложка по всей карте
    let P = this.fogBaseProg;
    gl.useProgram(P.p);
    gl.bindVertexArray(this.quadVao);
    gl.uniform3f(P.u.uView, v.cx, v.cy, v.scale);
    gl.uniform2f(P.u.uRes, v.vw, v.vh);
    gl.uniform4f(P.u.uRect, 0, 0, v.W, v.H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.uniform1i(P.u.uTile, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // фигуры
    const F = this.fogOps;
    if (F.count) {
      P = this.fogOpProg;
      gl.useProgram(P.p);
      gl.uniform3f(P.u.uView, v.cx, v.cy, v.scale);
      gl.uniform2f(P.u.uRes, v.vw, v.vh);
      gl.uniform1f(P.u.uScale, v.scale);
      gl.bindVertexArray(F.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, F.buf);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (const b of F.batches) {
        gl.blendEquation(b.rev ? gl.MIN : gl.MAX);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, b.start * 24);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, b.start * 24 + 16);
        gl.vertexAttribDivisor(2, 1);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
      }
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.quadVao);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize() {
    const v = this.viewer, set = this.opts.getSettings();
    const k = Math.min(window.devicePixelRatio || 1, set.resScale ?? 1);
    const w = Math.max(1, Math.round(v.vw * k)), h = Math.max(1, Math.round(v.vh * k));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.fbo = null;
    }
  }

  ensureFbo() {
    if (this.fbo) return;
    const gl = this.gl;
    if (!this.baseTex) this.baseTex = this.makeTex();
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    if (!this.fboObj) this.fboObj = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboObj);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.baseTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fbo = true;
  }

  // GL-текстура тайла оригинала; сами картинки грузит и вытесняет Viewer
  tileTexture(l, c, r) {
    const t = this.viewer.tile(l, c, r);
    if (!t.ok) return null;
    let e = this.tileTex.get(t);
    if (!e) {
      const gl = this.gl;
      const tex = this.makeTex();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, t.img);
      e = { tex, key: `${l}/${c}_${r}` };
      this.tileTex.set(t, e);
    }
    return e.tex;
  }

  gcTiles() {
    for (const [t, e] of this.tileTex) {
      if (this.viewer.cache.get(e.key) !== t) {
        this.gl.deleteTexture(e.tex);
        this.tileTex.delete(t);
      }
    }
    if (this.labelTex.size > 120) {
      const items = [...this.labelTex.entries()].filter(([, e]) => e.ok && e.used < this.viewer.frame - 120);
      for (const [k, e] of items) { this.gl.deleteTexture(e.tex); this.labelTex.delete(k); }
    }
  }

  visibleTiles(levels, l, T, fx, fy) {
    const v = this.viewer, rect = v.viewRect();
    const tw = T * fx, th = T * fy;
    const cols = Math.ceil(levels[l].w / T), rows = Math.ceil(levels[l].h / T);
    const out = [];
    const c0 = Math.max(0, Math.floor(rect.x / tw)), c1 = Math.min(cols - 1, Math.floor((rect.x + rect.w) / tw));
    const r0 = Math.max(0, Math.floor(rect.y / th)), r1 = Math.min(rows - 1, Math.floor((rect.y + rect.h) / th));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push([c, r, c * tw, r * th]);
    return out;
  }

  drawTiles() {
    const gl = this.gl, v = this.viewer, P = this.tile;
    this.ensureFbo();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboObj);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.745, 0.847, 0.906, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.p);
    gl.uniform3f(P.u.uView, v.cx, v.cy, v.scale);
    gl.uniform2f(P.u.uRes, v.vw, v.vh);
    gl.uniform1i(P.u.uTile, 0);
    gl.activeTexture(gl.TEXTURE0);
    const eff = v.scale * (this.canvas.width / v.vw);
    const target = Math.max(0, Math.min(v.levels.length - 1, Math.floor(Math.log2(1 / eff))));
    const drawLevel = (l, load) => {
      const L = v.levels[l];
      for (const [c, r, x, y] of this.visibleTiles(v.levels, l, v.T, L.fx, L.fy)) {
        if (!load && !v.cache.has(`${l}/${c}_${r}`)) continue;
        const tex = this.tileTexture(l, c, r);
        if (!tex) continue;
        const img = v.cache.get(`${l}/${c}_${r}`).img;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4f(P.u.uRect, x, y, img.naturalWidth * L.fx, img.naturalHeight * L.fy);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    };
    for (let l = v.levels.length - 1; l > target; l--) drawLevel(l, false);
    drawLevel(target, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  labelTexture(l, c, r) {
    const key = `${l}/${c}_${r}`;
    let e = this.labelTex.get(key);
    if (!e) {
      const gl = this.gl;
      e = { tex: null, ok: false, used: 0 };
      this.labelTex.set(key, e);
      loadImage(`labels/${key}.png`).then(img => {
        e.tex = this.makeTex();
        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, img);
        e.ok = true;
        this.viewer.invalidate();
      }).catch(() => {});
    }
    e.used = this.viewer.frame;
    return e.ok ? e.tex : null;
  }

  drawLabels(set) {
    const info = this.labelInfo, v = this.viewer, gl = this.gl, P = this.label;
    if (!info || !set.labels) return;
    // названия проявляются при приближении; на оригинале они и так нарисованы
    // при очень сильном приближении буквы огромные и мыльные — делаем их тише
    const alpha = (1 - set.styleMix) * Math.min(1, Math.max(0, (v.scale - 0.3) / 0.25)) * (1 - 0.5 * Math.min(1, Math.max(0, (v.scale - 1.8) / 1.5)));
    if (alpha <= 0.01) return;
    const eff = v.scale * (this.canvas.width / v.vw);
    const l = Math.max(0, Math.min(info.levels - 1, Math.floor(Math.log2(1 / eff) + 0.3)));
    const levels = [];
    let w = info.width, h = info.height;
    for (let i = 0; i < info.levels; i++) { levels.push({ w, h }); w = Math.floor(w / 2); h = Math.floor(h / 2); }
    const fx = info.width / levels[l].w, fy = info.height / levels[l].h;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(P.p);
    gl.uniform3f(P.u.uView, v.cx, v.cy, v.scale);
    gl.uniform2f(P.u.uRes, v.vw, v.vh);
    gl.uniform2f(P.u.uMap, v.W, v.H);
    gl.uniform2f(P.u.uTexel, 1 / info.tileSize, 1 / info.tileSize);
    gl.uniform1f(P.u.uAlpha, alpha);
    gl.uniform1f(P.u.uFogOn, set.fogOn ? 1 : 0);
    gl.uniform1f(P.u.uFogStrength, set.fogStrength);
    gl.uniform1i(P.u.uLab, 0);
    gl.uniform1i(P.u.uFog, 1);
    gl.uniform2f(P.u.uFogSize, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, set.fogOn && this.fogFbo ? this.fogFbo.tex : this.fogTex);
    gl.activeTexture(gl.TEXTURE0);
    const T = info.tileSize, have = info.sets[l];
    for (const [c, r, x, y] of this.visibleTiles(levels, l, T, fx, fy)) {
      if (!have.has(`${c}_${r}`)) continue;
      const tex = this.labelTexture(l, c, r);
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const tw = Math.min(T, levels[l].w - c * T), th = Math.min(T, levels[l].h - r * T);
      gl.uniform4f(P.u.uRect, x, y, tw * fx, th * fy);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
  }

  animating() {
    const s = this.opts.getSettings();
    return this.ready && s.animate && (s.clouds || s.fogOn);
  }

  // Нужен ли кадр, чтобы досчитать местность в полном разрешении после движения карты
  pending(now) {
    return this.ready && !!this.terrainCur && this.terrainCur.k < 1 && now - (this.viewChangedAt || 0) >= MOVE_MS;
  }

  render(now) {
    const gl = this.gl, v = this.viewer, set = this.opts.getSettings();
    this.resize();
    if (!this.ready) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.1, 0.2, 0.2, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    this.syncFog();
    gl.bindVertexArray(this.quadVao);
    const mix = Math.min(1, Math.max(0, set.styleMix));

    const P = this.fx;
    const time = set.animate ? ((now - this.start) / 1000) % 3600 : 0;
    // Пока карту двигают — местность в половинном разрешении; остановились — досчитываем полное.
    const viewKey = [v.cx, v.cy, v.scale, this.canvas.width, this.canvas.height].join('|');
    if (viewKey !== this.lastViewKey) { this.lastViewKey = viewKey; this.viewChangedAt = now; }
    const moving = now - (this.viewChangedAt || 0) < MOVE_MS;
    const tf = this.ensureTerrainFbo(moving ? 0.5 : 1);
    // Местность пересчитываем только когда изменился вид или настройки (и изредка — ради бликов воды).
    const key = [viewKey, set.season, mix, set.detail, v.tilesLoaded || 0, this.lines ? 1 : 0].join('|');
    const stale = key !== tf.key;
    this.terrainCur = tf;
    gl.useProgram(P.p);
    const uni = () => {
      gl.uniform3f(P.u.uView, v.cx, v.cy, v.scale);
      gl.uniform2f(P.u.uRes, v.vw, v.vh);
      gl.uniform2f(P.u.uMap, v.W, v.H);
      gl.uniform1f(P.u.uScale, v.scale);
      gl.uniform1f(P.u.uTime, time);
      gl.uniform1f(P.u.uSeason, set.season);
      gl.uniform1f(P.u.uMix, mix);
      gl.uniform1f(P.u.uFogOn, set.fogOn ? 1 : 0);
      gl.uniform1f(P.u.uFogStrength, set.fogStrength);
      gl.uniform1f(P.u.uFogGhost, set.fogGhost);
      gl.uniform1f(P.u.uClouds, set.clouds ? 1 : 0);
      gl.uniform1f(P.u.uDetail, set.detail ?? 1);
    };
    uni();
    const bindUnits = units => units.forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(P.u[name], i);
    });
    if (stale) {
      if (mix > 0.001) this.drawTiles();
      const lines = !!this.lines && mix < 0.999;
      if (lines) this.drawLines();
      gl.useProgram(P.p);
      gl.bindVertexArray(this.quadVao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, tf.fb);
      gl.viewport(0, 0, tf.w, tf.h);
      gl.uniform1i(P.u.uPass, 0);
      gl.uniform1f(P.u.uLines, lines ? 1 : 0);
      gl.uniform1f(P.u.uTime, 0);  // местность статична; движение воды добавляет проход поверх
      bindUnits([['uT0', this.tex.t0], ['uT1', this.tex.t1], ['uT2', this.tex.t2], ['uT3', this.tex.t3],
        ['uBase', mix > 0.001 ? this.baseTex : this.fogTex],
        ['uRoads', lines ? this.lineFbo.roads : this.fogTex], ['uRivers', lines ? this.lineFbo.rivers : this.fogTex],
        ['uFog', this.fogTex], ['uTerrain', this.fogTex], ['uOver0', this.fogTex], ['uOver1', this.fogTex]]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      tf.key = key;
      tf.lines = lines;
      gl.uniform1f(P.u.uTime, time);
    }
    // туман перерисовываем только если сдвинулся вид или изменились фигуры
    const fogKey = viewKey + '|' + this.fog.version;
    if (set.fogOn && (fogKey !== this.fogKey || !this.fogFbo)) { this.drawFog(); this.fogKey = fogKey; }
    if (!set.fogOn) this.fogKey = null;
    if (v.frame % 120 === 0) this.gcTiles();
    gl.useProgram(P.p);
    gl.bindVertexArray(this.quadVao);
    const dummy = [['uT0', this.tex.t0], ['uT1', this.tex.t1], ['uT2', this.tex.t2], ['uT3', this.tex.t3],
      ['uBase', this.fogTex], ['uRoads', this.fogTex], ['uRivers', this.fogTex]];
    // облака и клубы тумана — в пониженном разрешении (они мягкие, разницы не видно)
    const ov = this.ensureOverFbo(set.overScale || 0.5);
    if (set.clouds || set.fogOn) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, ov.fb);
      gl.viewport(0, 0, ov.w, ov.h);
      gl.uniform1i(P.u.uPass, 2);
      bindUnits([...dummy, ['uTerrain', this.fogTex], ['uFog', set.fogOn && this.fogFbo ? this.fogFbo.tex : this.fogTex],
        ['uOver0', this.fogTex], ['uOver1', this.fogTex]]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1i(P.u.uPass, 1);
    gl.uniform1f(P.u.uLines, tf.lines ? 1 : 0);
    if (tf.lines && this.lineFbo) dummy[6] = ['uRivers', this.lineFbo.rivers];
    bindUnits([...dummy, ['uTerrain', tf.tex], ['uFog', set.fogOn ? this.fogFbo.tex : this.fogTex],
      ['uOver0', ov.t0], ['uOver1', ov.t1]]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
    this.drawLabels(set);
  }
}
