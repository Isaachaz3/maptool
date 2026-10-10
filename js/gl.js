// WebGL-рендер карты: рисованная местность по разметке, тени облаков,
// туман войны «как в Battle Brothers», сезоны. Оверлеи (отряд, метки) рисует 2D-слой поверх.

const VS_TILE = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;      // прямоугольник квада в px карты
uniform vec3 uView;      // cx, cy, scale
uniform vec2 uRes;       // размер экрана, css px
out vec2 vUV;
void main() {
  vec2 m = uRect.xy + aPos * uRect.zw;
  vec2 s = (m - uView.xy) * uView.z + uRes * 0.5;
  gl_Position = vec4(s / uRes * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vUV = aPos;
}`;

const FS_TILE = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTile;
out vec4 o;
void main() { o = vec4(texture(uTile, vUV).rgb, 1.0); }`;

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
out vec4 o;
uniform sampler2D uT0, uT1, uT2, uT3, uFog, uBase;
uniform vec2 uMap;
uniform float uScale, uTime, uSeason, uOriginal;
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
// градиентный шум (без «квадратов», которые даёт value noise вблизи)
vec2 grad(vec2 i) { float a = hash(i) * 6.2831853; return vec2(cos(a), sin(a)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f), b = dot(grad(i + vec2(1, 0)), f - vec2(1, 0));
  float c = dot(grad(i + vec2(0, 1)), f - vec2(0, 1)), d = dot(grad(i + vec2(1, 1)), f - vec2(1, 1));
  return clamp(0.5 + 0.75 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y), 0.0, 1.0);
}
// fbm с отсечением октав мельче пары экранных пикселей (иначе рябь при отдалении)
// px — сколько экранных пикселей в одной единице p
float fbm(vec2 p, int oct, float px) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    float vis = smoothstep(1.5, 5.0, px);
    s += a * mix(0.5, noise(p), vis);
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
    float vis = smoothstep(1.5, 5.0, px);
    float r = 1.0 - abs(noise(p) * 2.0 - 1.0);
    s += a * mix(0.6, r * r, vis);
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

bool inside(vec2 p) { return p.x >= 0.0 && p.y >= 0.0 && p.x < uMap.x && p.y < uMap.y; }
vec3 T0(vec2 p) { return inside(p) ? texture(uT0, p / uMap).rgb : vec3(1.0, 0.0, 0.0); }
vec3 T1(vec2 p) { return inside(p) ? texture(uT1, p / uMap).rgb : vec3(0.0); }

// высота рельефа для отмывки
float heightAt(vec2 p) {
  vec3 a = T0(p), b = T1(p);
  float hm = smoothstep(-14.0, 18.0, sd(a.b, SDF_R));
  float hh = smoothstep(-14.0, 18.0, sd(b.r, SDF_R));
  float hf = smoothstep(-6.0, 10.0, sd(a.g, SDF_R));
  float px = uScale;
  float h = hm * (0.35 + 0.65 * ridged(p * 0.045, 5, px / 0.045));
  h += hh * 0.28 * fbm(p * 0.05, 4, px / 0.05);
  h += hf * 0.04 * noise(p * 0.4);
  h -= smoothstep(0.0, 20.0, sd(a.r, SDF_R)) * 0.05;
  return h;
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
      float f = sd(T0(ctr).g, SDF_R);
      if (f < c * 0.15) continue;
      if (sd(T0(ctr).r, SDF_R) > -2.0) continue;
      float k = hash(id + 7.7 + c);
      if (k < 0.12) continue; // поляны
      float r = c * (0.38 + 0.2 * hash(id + 3.1 + c));
      vec2 d = (p - ctr) / r;
      float e = px / r * 1.5; // ширина сглаживания в долях радиуса
      bool conifer = hash(id + 11.0) < mix(0.15, 0.85, smoothstep(0.35, 0.12, lat));
      // тень на земле — вправо-вниз (солнце с северо-запада)
      vec2 ds = d - vec2(0.35, 0.3);
      float sh = 1.0 - smoothstep(0.75 - e, 0.95 + e, length(ds * vec2(1.0, 1.35)));
      acc = over(acc, vec3(0.08, 0.1, 0.05), sh * 0.35);
      vec3 base;
      float a;
      float shade;
      if (conifer) {
        float w = (d.y + 1.1) * 0.5;
        float inT = min(min(d.y + 1.1, 0.75 - d.y), w - abs(d.x));
        a = smoothstep(-e, e, inT);
        base = seas(vec3(0.22, 0.38, 0.22), vec3(0.18, 0.33, 0.19), vec3(0.2, 0.32, 0.2), vec3(0.2, 0.3, 0.24));
        shade = 0.8 + 0.45 * smoothstep(0.3, -0.3, d.x);
        // ствол
        float trunk = step(abs(d.x), 0.08) * step(0.7, d.y) * step(d.y, 1.0);
        acc = over(acc, vec3(0.3, 0.2, 0.12), trunk);
      } else {
        a = 1.0 - smoothstep(1.0 - e, 1.0 + e, length(d));
        vec3 autumn = mix(vec3(0.78, 0.38, 0.1), vec3(0.85, 0.66, 0.15), hash(id + 5.0));
        base = seas(vec3(0.42, 0.62, 0.3), vec3(0.3, 0.5, 0.24), autumn, vec3(0.42, 0.37, 0.32));
        shade = 0.72 + 0.5 * clamp(0.5 - dot(d, vec2(0.6, 0.6)) * 0.6, 0.0, 1.0);
        a *= mix(1.0, 0.65, SW.w); // зимой лиственные «голые»
      }
      vec3 col = base * (0.85 + 0.3 * k) * shade;
      // снег на кронах
      col = mix(col, vec3(0.93, 0.95, 0.98) * shade, snow * smoothstep(0.2, -0.6, d.y) * 0.8);
      // контур
      float edge = conifer ? 0.0 : smoothstep(0.75, 1.0, length(d));
      col *= 1.0 - edge * 0.35;
      acc = over(acc, col, a);
    }
  }
  return acc;
}

void main() {
  vec2 p = vMap;
  float px = 1.0 / uScale;   // px карты в одном экранном пикселе
  float s = mod(uSeason, 4.0);
  SW = vec4(max(0.0, 1.0 - min(s, 4.0 - s)), max(0.0, 1.0 - abs(s - 1.0)), max(0.0, 1.0 - abs(s - 2.0)), max(0.0, 1.0 - abs(s - 3.0)));
  SW /= (SW.x + SW.y + SW.z + SW.w);

  bool ins = inside(p);
  vec2 uv = p / uMap;
  vec3 t0 = T0(p), t1 = T1(p);
  vec3 t2 = ins ? texture(uT2, uv).rgb : vec3(0.0, 0.0, 1.0);
  vec3 t3 = ins ? texture(uT3, uv).rgb : vec3(1.0, 1.0, 0.0);

  // органичные края: смещаем границы шумом
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
  float mI = smoothstep(-aa, aa, sI);
  float mC = smoothstep(-aa, aa, sC);
  float dRoad = t2.b * LINE_R;
  float dRiver = t3.r * LINE_R;
  float depth = t3.g;
  float lat = p.y / uMap.y;

  // снег: зимой линия снега спускается к югу, горы заснежены выше
  float hm = smoothstep(-10.0, 30.0, sd(t0.b, SDF_R)) * (0.6 + 0.4 * t3.b);
  float snowLine = SW.w * 0.42 + SW.x * 0.14 + SW.z * 0.12 + SW.y * 0.05 + hm * (SW.x * 0.12 + SW.y * 0.06 + SW.z * 0.1 + SW.w * 0.3);
  float snow = smoothstep(-0.02, 0.03, snowLine - lat + (fbm(p * 0.01, 4, uScale / 0.01) - 0.5) * 0.14);
  snow = max(snow, mI);

  vec3 col;
  if (uOriginal > 0.5) {
    // ---------- оригинальная карта + сезоны поверх ----------
    col = texture(uBase, vScr).rgb;
    float l = dot(col, vec3(0.3, 0.59, 0.11));
    vec3 autumn = mix(vec3(l * 1.3, l * 0.82, l * 0.42), vec3(l * 1.25, l * 1.05, l * 0.45), noise(p * 0.08));
    col = mix(col, autumn, mF * SW.z * 0.65);
    col = mix(col, col * vec3(1.04, 1.0, 0.9), SW.y * 0.4 * (1.0 - mW));
    col = mix(col, vec3(0.97, 0.98, 1.0) * mix(0.55, 1.05, smoothstep(0.15, 0.85, l)), snow * (1.0 - mW) * 0.85);
  } else {
    // ---------- рисованная карта ----------
    float gpx = uScale;
    float var = fbm(p * 0.03, 5, gpx / 0.03);
    vec3 plain = seas(vec3(0.74, 0.79, 0.5), vec3(0.84, 0.79, 0.53), vec3(0.8, 0.68, 0.45), vec3(0.74, 0.72, 0.66));
    vec3 grass = seas(vec3(0.6, 0.72, 0.4), vec3(0.7, 0.72, 0.42), vec3(0.72, 0.6, 0.38), vec3(0.66, 0.66, 0.6));
    col = mix(plain, grass, smoothstep(0.35, 0.7, var)) * (0.94 + 0.12 * noise(p * 0.25));

    // пустыня с дюнами
    vec3 desert = vec3(0.9, 0.77, 0.5) * (0.95 + 0.08 * var);
    float dunes = sin(dot(p, vec2(0.22, 0.09)) + fbm(p * 0.02, 3, gpx / 0.02) * 10.0);
    desert *= 1.0 + 0.05 * dunes * smoothstep(0.4, 1.5, uScale);
    col = mix(col, desert, mDs);

    // болото: заросли и лужи
    vec3 swamp = seas(vec3(0.42, 0.52, 0.34), vec3(0.4, 0.48, 0.3), vec3(0.5, 0.47, 0.3), vec3(0.5, 0.52, 0.48));
    float pools = smoothstep(0.6, 0.66, fbm(p * 0.09, 3, gpx / 0.09));
    swamp = mix(swamp, vec3(0.38, 0.52, 0.55), pools * 0.8);
    col = mix(col, swamp, mSw);

    vec3 hills = mix(plain, seas(vec3(0.6, 0.64, 0.42), vec3(0.7, 0.67, 0.5), vec3(0.7, 0.6, 0.44), vec3(0.7, 0.68, 0.64)), 0.5);
    col = mix(col, hills, mH);
    vec3 forest = seas(vec3(0.34, 0.5, 0.25), vec3(0.25, 0.41, 0.2), mix(vec3(0.62, 0.36, 0.14), vec3(0.7, 0.55, 0.18), var), vec3(0.32, 0.36, 0.3));
    col = mix(col, forest * (0.9 + 0.2 * noise(p * 0.5)), mF);
    vec3 rock = mix(vec3(0.55, 0.5, 0.45), vec3(0.65, 0.6, 0.53), var);
    col = mix(col, rock, mM);

    // отмывка рельефа
    float e = max(px * 1.5, 1.0);
    float h0 = heightAt(p);
    float hx = heightAt(p + vec2(e, 0.0)), hy = heightAt(p + vec2(0.0, e));
    vec3 n = normalize(vec3(-(hx - h0) / e * 28.0, -(hy - h0) / e * 28.0, 1.0));
    vec3 L = normalize(vec3(-1.0, -1.0, 1.3));
    float shade = clamp(dot(n, L) / L.z, 0.4, 1.35);
    col *= mix(1.0, shade, 0.85 * (1.0 - mW));

    // снег
    col = mix(col, vec3(0.94, 0.96, 0.99) * mix(0.8, 1.05, clamp(shade, 0.0, 1.2)), snow * (1.0 - mW) * 0.95);

    // провалы (Подземье)
    vec3 chasm = vec3(0.12, 0.08, 0.1) + vec3(0.35, 0.1, 0.4) * (1.0 - smoothstep(0.0, 14.0, sC)) * 0.6;
    col = mix(col, chasm, mC);

    // вода
    float dpx = depth * DEPTH_R;
    vec3 shallow = seas(vec3(0.5, 0.72, 0.78), vec3(0.48, 0.72, 0.8), vec3(0.45, 0.64, 0.72), vec3(0.55, 0.66, 0.72));
    vec3 deep = seas(vec3(0.18, 0.36, 0.52), vec3(0.16, 0.36, 0.55), vec3(0.15, 0.31, 0.46), vec3(0.2, 0.31, 0.42));
    vec3 water = mix(shallow, deep, smoothstep(0.0, 0.45, depth));
    float rv = smoothstep(0.35, 1.2, uScale);
    float ring1 = 1.0 - smoothstep(0.4 * px, 1.4 * px, abs(dpx - 6.0));
    float ring2 = 1.0 - smoothstep(0.4 * px, 1.4 * px, abs(dpx - 14.0));
    water = mix(water, water * 0.82, (ring1 * 0.5 + ring2 * 0.3) * rv);
    water += (noise(p * 0.12 + vec2(uTime * 0.25, uTime * 0.1)) - 0.5) * 0.05 * rv;
    // замёрзшие берега зимой
    water = mix(water, vec3(0.86, 0.92, 0.96), snow * SW.w * (1.0 - smoothstep(3.0, 12.0, dpx + noise(p * 0.05) * 8.0)) * 0.7);
    col = mix(col, water, mW);
    // береговая линия
    float shore = 1.0 - smoothstep(0.6 * aa, 1.8 * aa, abs(sW));
    col = mix(col, vec3(0.2, 0.25, 0.28), shore * 0.55);

    // реки
    float rw = 0.9 + 0.35 * px;
    float river = (1.0 - smoothstep(rw - aa, rw + aa, dRiver)) * (1.0 - mW);
    col = mix(col, mix(shallow * 0.9, vec3(0.86, 0.92, 0.96), snow * 0.6), river * smoothstep(0.06, 0.18, uScale));

    // дороги
    float wr = 0.45 + 0.4 * px;
    float road = (1.0 - smoothstep(wr - aa * 0.7, wr + aa * 0.7, dRoad)) * (1.0 - mW);
    col = mix(col, vec3(0.38, 0.27, 0.18), road * 0.85 * smoothstep(0.12, 0.3, uScale));

    // деревья при приближении; при отдалении — просто цвет леса
    float tv = smoothstep(0.35, 0.7, uScale) * uDetail;
    if (tv > 0.0 && sF > -40.0) {
      float cell = 11.0 / uScale;
      float lv = log2(max(cell, 1.6));
      float l0 = floor(lv);
      float fr = smoothstep(0.0, 1.0, lv - l0);
      vec4 ta = trees(p, exp2(l0), lat, snow);
      vec4 tb = trees(p, exp2(l0 + 1.0), lat, snow);
      vec4 tr = mix(ta, tb, fr);
      if (tr.a > 0.001) col = mix(col, tr.rgb / tr.a, tr.a * tv);
    }
  }

  // ---------- облака и их тени ----------
  if (uClouds > 0.5) {
    vec2 wind = vec2(1.0, 0.3) * uTime * 3.0;
    float f = 0.0045;
    float cpx = uScale / f;
    float cov = mix(0.56, 0.5, SW.w + SW.z * 0.5);
    vec2 q = (p - wind) * f;
    vec2 qw = q + vec2(fbm(q * 1.3, 3, cpx * 1.3), fbm(q * 1.3 + 5.2, 3, cpx * 1.3)) * 1.2;
    float cl = smoothstep(cov, cov + 0.16, fbm(qw, 5, cpx));
    vec2 qs = (p - wind - vec2(26.0, 20.0)) * f;
    vec2 qsw = qs + vec2(fbm(qs * 1.3, 3, cpx * 1.3), fbm(qs * 1.3 + 5.2, 3, cpx * 1.3)) * 1.2;
    float sh = smoothstep(cov, cov + 0.2, fbm(qsw, 5, cpx));
    col *= 1.0 - 0.3 * sh;
    float showClouds = (1.0 - smoothstep(0.18, 0.7, uScale)) * 0.6;
    col = mix(col, vec3(0.98, 0.98, 1.0), cl * showClouds);
  }

  // ---------- туман войны ----------
  if (uFogOn > 0.5) {
    float fm = ins ? texture(uFog, uv).a : 1.0;
    float fe = smoothstep(0.35, 0.7, fm + (fbm(p * 0.03 + uTime * 0.02, 3, uScale / 0.03) - 0.5) * 0.3);
    if (fe > 0.0) {
      float g = dot(col, vec3(0.3, 0.59, 0.11));
      vec3 ghost = vec3(g * 1.02, g * 0.97, g * 0.88) * 0.62;
      // крупные клубы, медленно плывущие, и мелкая дымка поверх
      vec2 mq = p * 0.0025 + vec2(uTime * 0.006, uTime * 0.002);
      float mpx = uScale / 0.0025;
      float m1 = fbm(mq + vec2(fbm(mq * 1.7, 3, mpx * 1.7), fbm(mq * 1.7 + 3.3, 3, mpx * 1.7)) * 0.9, 4, mpx);
      float m2 = fbm(p * 0.008 - vec2(uTime * 0.02, uTime * 0.006), 3, uScale / 0.008);
      float mist = clamp(m1 * 0.9 + m2 * 0.3 - 0.12, 0.0, 1.0);
      vec3 mistCol = mix(vec3(0.5, 0.52, 0.56), vec3(0.9, 0.9, 0.92), smoothstep(0.25, 0.7, mist));
      float cover = clamp(0.62 + mist * 0.5 - uFogGhost * 0.6, 0.0, 1.0);
      vec3 hidden = mix(ghost, mistCol, cover);
      // тёмная кромка у границы видимости
      col *= 1.0 - 0.3 * fe * (1.0 - fe) * 4.0 * uFogStrength;
      col = mix(col, hidden, fe * uFogStrength);
    }
  }
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

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
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

export class MapRenderer {
  // opts.getSettings() → { style, season, clouds, fogOn, fogStrength, fogGhost, detail, resScale }
  constructor(canvas, viewer, fog, opts) {
    this.canvas = canvas;
    this.viewer = viewer;
    this.fog = fog;
    this.opts = opts;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.gl = gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.software = /swiftshader|llvmpipe|software|basic render/i.test(name);
    this.tile = program(gl, VS_TILE, FS_TILE);
    this.fx = program(gl, VS_FX, FS_FX);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.tex = {};
    this.tileTex = new Map();
    this.fogVersion = -1;
    this.fogTex = this.makeTex();
    this.ready = false;
    this.start = performance.now();
  }

  makeTex(filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
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
  }

  syncFog() {
    if (this.fog.version === this.fogVersion) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.fog.canvas);
    this.fogVersion = this.fog.version;
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

  // GL-текстура тайла; сами картинки грузит и вытесняет Viewer
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
      if (!this.viewer.cache.has(e.key) || this.viewer.cache.get(e.key) !== t) {
        this.gl.deleteTexture(e.tex);
        this.tileTex.delete(t);
      }
    }
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
    const rect = v.viewRect();
    const eff = v.scale * (this.canvas.width / v.vw);
    const target = Math.max(0, Math.min(v.levels.length - 1, Math.floor(Math.log2(1 / eff))));
    const drawLevel = (l, load) => {
      const L = v.levels[l], T = v.T;
      const tw = T * L.fx, th = T * L.fy;
      const c0 = Math.max(0, Math.floor(rect.x / tw)), c1 = Math.min(L.cols - 1, Math.floor((rect.x + rect.w) / tw));
      const r0 = Math.max(0, Math.floor(rect.y / th)), r1 = Math.min(L.rows - 1, Math.floor((rect.y + rect.h) / th));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        if (!load && !v.cache.has(`${l}/${c}_${r}`)) continue;
        const tex = this.tileTexture(l, c, r);
        if (!tex) continue;
        const img = v.cache.get(`${l}/${c}_${r}`).img;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4f(P.u.uRect, c * tw, r * th, img.naturalWidth * L.fx, img.naturalHeight * L.fy);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    };
    for (let l = v.levels.length - 1; l > target; l--) drawLevel(l, false);
    drawLevel(target, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  animating() {
    const s = this.opts.getSettings();
    return this.ready && s.animate && (s.clouds || s.fogOn);
  }

  render(now) {
    const gl = this.gl, v = this.viewer, set = this.opts.getSettings();
    this.resize();
    if (!this.ready) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.745, 0.847, 0.906, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    this.syncFog();
    const original = set.style === 'original';
    if (original) this.drawTiles();
    if (v.frame % 120 === 0) this.gcTiles();

    const P = this.fx;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(P.p);
    gl.uniform3f(P.u.uView, v.cx, v.cy, v.scale);
    gl.uniform2f(P.u.uRes, v.vw, v.vh);
    gl.uniform2f(P.u.uMap, v.W, v.H);
    gl.uniform1f(P.u.uScale, v.scale);
    const t = set.animate ? ((now - this.start) / 1000) % 3600 : 0;
    gl.uniform1f(P.u.uTime, t);
    gl.uniform1f(P.u.uSeason, set.season);
    gl.uniform1f(P.u.uOriginal, original ? 1 : 0);
    gl.uniform1f(P.u.uFogOn, set.fogOn ? 1 : 0);
    gl.uniform1f(P.u.uFogStrength, set.fogStrength);
    gl.uniform1f(P.u.uFogGhost, set.fogGhost);
    gl.uniform1f(P.u.uClouds, set.clouds ? 1 : 0);
    gl.uniform1f(P.u.uDetail, set.detail ?? 1);
    const units = [['uT0', this.tex.t0], ['uT1', this.tex.t1], ['uT2', this.tex.t2], ['uT3', this.tex.t3],
      ['uFog', this.fogTex], ['uBase', original ? this.baseTex : this.fogTex]];
    units.forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(P.u[name], i);
    });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }
}
