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
    float f = texture(uFog, vMap / uMap).a;
    alpha *= 1.0 - smoothstep(0.3, 0.7, f) * uFogStrength;
  }
  o = vec4(col, alpha);
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
out vec4 o;
uniform sampler2D uT0, uT1, uT2, uT3, uFog, uBase;
uniform vec2 uMap;
uniform float uScale, uTime, uSeason, uMix;
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

// ---------- скалы: «конусы» на ячеистой сетке, размер ячейки зависит от зума ----------
float peaks(vec2 p, float c, float sharp) {
  vec2 g = floor(p / c);
  float h = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = g + vec2(float(i), float(j));
      vec2 r = hash2(id + c * 3.7);
      vec2 ctr = (id + 0.2 + 0.6 * r) * c;
      float rad = c * (0.7 + 0.4 * hash(id + 9.1 + c));
      float k = max(0.0, 1.0 - length(p - ctr) / rad);
      h = max(h, (0.55 + 0.45 * r.x) * pow(k, sharp));
    }
  }
  return h;
}
// screenPx — желаемый размер скалы на экране; при отдалении ячейка ограничена сверху
float peaksLod(vec2 p, float screenPx, float sharp) {
  float lv = log2(clamp(screenPx / uScale, 3.0, 40.0));
  float l0 = floor(lv);
  float fr = smoothstep(0.0, 1.0, lv - l0);
  return mix(peaks(p, exp2(l0), sharp), peaks(p, exp2(l0 + 1.0), sharp), fr);
}

// высота рельефа для отмывки
float heightAt(vec2 p) {
  vec3 a = T0(p), b = T1(p);
  float mm = smoothstep(-6.0, 14.0, sd(a.b, SDF_R));
  float mh = smoothstep(-6.0, 14.0, sd(b.r, SDF_R));
  float h = 0.0;
  if (mm > 0.0) {
    // крупный масштаб: в глубине хребта выше (там лежит снег), плюс острые пики и гребни
    float macro = clamp(sd(a.b, SDF_R) / 24.0, 0.0, 1.0) * 0.6 + fbm(p * 0.012, 3, uScale / 0.012) * 0.4;
    h += mm * (0.5 * peaksLod(p, 22.0, 0.9) + 0.12 * ridged(p * 0.07, 4, uScale / 0.07) + 0.38 * macro);
  }
  if (mh > 0.0) h += mh * 0.32 * peaksLod(p + vec2(37.0, 11.0), 36.0, 2.0);
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
  float dRoad = t2.b * LINE_R;
  float dRiver = t3.r * LINE_R;
  float depth = t3.g;
  float lat = p.y / uMap.y;

  // снег: зимой линия снега спускается к югу, горы заснежены выше
  float hm = smoothstep(-10.0, 30.0, sd(t0.b, SDF_R)) * (0.6 + 0.4 * t3.b);
  float snowLine = seasf(0.14, 0.05, 0.12, 0.38) + hm * seasf(0.12, 0.06, 0.1, 0.3);
  float snow = smoothstep(-0.02, 0.03, snowLine - lat + (fbm(p * 0.01, 4, uScale / 0.01) - 0.5) * 0.14);
  snow = max(snow, smoothstep(-aa, aa, sI));

  vec3 col = vec3(0.0);
  vec3 painted = vec3(0.0), orig = vec3(0.0);

  if (uMix > 0.001) {
    // ---------- оригинальная карта + сезоны поверх ----------
    orig = texture(uBase, vScr).rgb;
    float l = dot(orig, vec3(0.3, 0.59, 0.11));
    vec3 autumn = mix(vec3(l * 1.3, l * 0.82, l * 0.42), vec3(l * 1.25, l * 1.05, l * 0.45), noise(p * 0.08));
    orig = mix(orig, autumn, mF * SW.z * 0.65);
    orig = mix(orig, vec3(0.97, 0.98, 1.0) * mix(0.55, 1.05, smoothstep(0.15, 0.85, l)), snow * (1.0 - mW) * 0.85);
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
    float e = max(px * 1.5, 0.8);
    float h0 = heightAt(p);
    float hx = heightAt(p + vec2(e, 0.0)), hy = heightAt(p + vec2(0.0, e));
    vec3 rock = mix(vec3(0.33, 0.31, 0.27), vec3(0.58, 0.58, 0.56), smoothstep(0.15, 0.7, h0));
    col = mix(col, rock, mM);
    // тёмная кромка у подножия гор
    col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 2.5 * aa + 1.0, abs(sM))) * step(-2.0 * aa, sM);

    // отмывка
    vec3 n = normalize(vec3(-(hx - h0) / e * 28.0, -(hy - h0) / e * 28.0, 1.0));
    vec3 L = normalize(vec3(-1.0, -1.0, 1.2));
    float shade = clamp(dot(n, L) / L.z, 0.35, 1.45);
    col *= mix(1.0, shade, 0.9 * (1.0 - mW));

    // снежные шапки и зимний снег (серый, с разводами, как в BB)
    float cap = smoothstep(seasf(0.64, 0.72, 0.66, 0.42), seasf(0.72, 0.8, 0.74, 0.5), h0) * mM;
    float sn = max(snow, cap);
    vec3 snowCol = vec3(0.86, 0.88, 0.89) * (0.9 + 0.1 * noise(p * 0.3)) * mix(0.75, 1.08, clamp(shade, 0.0, 1.3));
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
    water += (noise(p * 0.15 + vec2(uTime * 0.2, uTime * 0.07)) - 0.5) * 0.04 * rv;
    // пена у берега
    float foam = (1.0 - smoothstep(0.3 * aa, 1.6 * aa + 0.6, abs(sW - (1.2 + 0.6 * sin(uTime * 0.8 + p.x * 0.05)))));
    water = mix(water, vec3(0.75, 0.78, 0.74), foam * 0.6 * smoothstep(0.3, 0.9, uScale));
    water = mix(water, vec3(0.75, 0.82, 0.84), snow * SW.w * (1.0 - smoothstep(3.0, 12.0, dpx + noise(p * 0.05) * 8.0)) * 0.7);
    // песчаный пляж с суши
    float beach = smoothstep(-(1.5 + 1.2 * aa), -0.2, sW) * (1.0 - mW) * (1.0 - mC) * (1.0 - mM * 0.7);
    col = mix(col, mix(vec3(0.6, 0.57, 0.44), snowCol, snow * 0.8), beach * 0.85);
    col = mix(col, water, mW);

    // реки
    float rw = 0.8 + 0.35 * px;
    float river = (1.0 - smoothstep(rw - aa, rw + aa, dRiver)) * (1.0 - mW);
    vec3 riverCol = mix(shallow * 1.1, vec3(0.75, 0.82, 0.84), snow * SW.w * 0.7);
    float bank = (1.0 - smoothstep(rw + aa * 0.5, rw + 1.5 * aa + 0.4, dRiver)) * (1.0 - mW) * smoothstep(0.5, 1.5, uScale);
    col = mix(col, col * 0.7, bank * 0.6);
    col = mix(col, riverCol, river * smoothstep(0.06, 0.18, uScale));

    // сельские дороги: утоптанная земля с неровными краями и колеёй
    float wobble = (noise(p * 0.35) - 0.5) * 0.5;
    float wr = 0.6 + 0.6 * px + wobble * 0.3;
    float road = (1.0 - smoothstep(wr - aa * 0.7, wr + aa * 0.7, dRoad)) * (1.0 - mW);
    float worn = 0.75 + 0.25 * noise(p * 0.6);
    vec3 dirt = mix(vec3(0.26, 0.2, 0.12), vec3(0.47, 0.39, 0.26), smoothstep(wr * 0.7, 0.0, dRoad) * smoothstep(1.5, 4.0, uScale));
    dirt = mix(dirt, vec3(0.72, 0.72, 0.7), snow * 0.5);
    col = mix(col, dirt, road * worn * smoothstep(0.12, 0.3, uScale));

    // деревья при приближении; при отдалении — просто тёмный лес
    float tv = smoothstep(0.3, 0.6, uScale) * uDetail;
    if (tv > 0.0 && sF > -40.0) {
      float cell = 10.0 / uScale;
      float lv = log2(max(cell, 1.6));
      float l0 = floor(lv);
      float fr = smoothstep(0.0, 1.0, lv - l0);
      vec4 tr = mix(trees(p, exp2(l0), lat, snow), trees(p, exp2(l0 + 1.0), lat, snow), fr);
      if (tr.a > 0.001) col = mix(col, tr.rgb / tr.a, tr.a * tv);
    }
    // лёгкая «бумага»
    col *= 0.96 + 0.08 * noise(p * 0.7 + 3.0);
    painted = col;
  }

  col = mix(painted, orig, uMix);

  // ---------- облака и их тени ----------
  if (uClouds > 0.5) {
    vec2 wind = vec2(1.0, 0.3) * uTime * 4.0;
    float f = 0.006;
    float cpx = uScale / f;
    float cov = seasf(0.64, 0.67, 0.63, 0.62);
    vec2 q = (p - wind) * f;
    vec2 qw = q + vec2(fbm(q * 1.3, 3, cpx * 1.3), fbm(q * 1.3 + 5.2, 3, cpx * 1.3)) * 0.35;
    float c = fbm(qw, 6, cpx);
    float cl = smoothstep(cov, cov + 0.05, c);
    vec2 qs = (p - wind - vec2(30.0, 24.0)) * f;
    vec2 qsw = qs + vec2(fbm(qs * 1.3, 3, cpx * 1.3), fbm(qs * 1.3 + 5.2, 3, cpx * 1.3)) * 0.35;
    float sh = smoothstep(cov, cov + 0.1, fbm(qsw, 6, cpx));
    col *= 1.0 - 0.35 * sh;
    // сами облака: пухлые, светлее в середине, серые снизу
    float thick = smoothstep(cov, cov + 0.25, c);
    vec3 cloudCol = mix(vec3(0.66, 0.68, 0.7), vec3(0.97, 0.97, 0.98), thick);
    float vis = (1.0 - smoothstep(1.0, 2.8, uScale)) * 0.92;
    col = mix(col, cloudCol, cl * vis);
  }

  // ---------- туман войны ----------
  if (uFogOn > 0.5) {
    float fm = ins ? texture(uFog, uv).a : 1.0;
    float fe = smoothstep(0.35, 0.7, fm + (fbm(p * 0.04 + uTime * 0.02, 4, uScale / 0.04) - 0.5) * 0.5);
    if (fe > 0.0) {
      float g = dot(col, vec3(0.3, 0.59, 0.11));
      vec3 ghost = vec3(g * 1.02, g * 0.97, g * 0.88) * 0.62;
      vec2 mq = p * 0.0025 + vec2(uTime * 0.006, uTime * 0.002);
      float mpx = uScale / 0.0025;
      float m1 = fbm(mq + vec2(fbm(mq * 1.7, 3, mpx * 1.7), fbm(mq * 1.7 + 3.3, 3, mpx * 1.7)) * 0.9, 4, mpx);
      float m2 = fbm(p * 0.008 - vec2(uTime * 0.02, uTime * 0.006), 3, uScale / 0.008);
      float mist = clamp(m1 * 0.9 + m2 * 0.3 - 0.12, 0.0, 1.0);
      vec3 mistCol = mix(vec3(0.46, 0.48, 0.5), vec3(0.86, 0.86, 0.87), smoothstep(0.25, 0.7, mist));
      float cover = clamp(0.62 + mist * 0.5 - uFogGhost * 0.6, 0.0, 1.0);
      vec3 hidden = mix(ghost, mistCol, cover);
      col *= 1.0 - 0.3 * fe * (1.0 - fe) * 4.0 * uFogStrength;
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
  // opts.getSettings() → { styleMix, season, clouds, animate, fogOn, fogStrength, fogGhost, detail, resScale, labels }
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
    this.tile = program(gl, VS_RECT, FS_TILE);
    this.label = program(gl, VS_RECT, FS_LABEL);
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
    this.labelTex = new Map();  // key → { tex, ok, used }
    this.labelInfo = null;
    this.fogVersion = -1;
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
    fetch('labels/info.json').then(r => r.json()).then(info => {
      info.sets = Object.fromEntries(Object.entries(info.tiles).map(([l, list]) => [l, new Set(list)]));
      this.labelInfo = info;
      this.viewer.invalidate();
    }).catch(() => {});
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
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
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
    const mix = Math.min(1, Math.max(0, set.styleMix));
    if (mix > 0.001) this.drawTiles();
    if (v.frame % 120 === 0) this.gcTiles();

    const P = this.fx;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(P.p);
    gl.uniform3f(P.u.uView, v.cx, v.cy, v.scale);
    gl.uniform2f(P.u.uRes, v.vw, v.vh);
    gl.uniform2f(P.u.uMap, v.W, v.H);
    gl.uniform1f(P.u.uScale, v.scale);
    gl.uniform1f(P.u.uTime, set.animate ? ((now - this.start) / 1000) % 3600 : 0);
    gl.uniform1f(P.u.uSeason, set.season);
    gl.uniform1f(P.u.uMix, mix);
    gl.uniform1f(P.u.uFogOn, set.fogOn ? 1 : 0);
    gl.uniform1f(P.u.uFogStrength, set.fogStrength);
    gl.uniform1f(P.u.uFogGhost, set.fogGhost);
    gl.uniform1f(P.u.uClouds, set.clouds ? 1 : 0);
    gl.uniform1f(P.u.uDetail, set.detail ?? 1);
    const units = [['uT0', this.tex.t0], ['uT1', this.tex.t1], ['uT2', this.tex.t2], ['uT3', this.tex.t3],
      ['uFog', this.fogTex], ['uBase', mix > 0.001 ? this.baseTex : this.fogTex]];
    units.forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(P.u[name], i);
    });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
    this.drawLabels(set);
  }
}
