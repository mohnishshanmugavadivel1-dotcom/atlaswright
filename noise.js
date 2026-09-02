// noise.js — Perlin noise with seeded permutation table
export function seedRng(s) {
  let r = s;
  return () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
}

const _p = [];
export function initNoise(seed) {
  const rng = seedRng(seed);
  _p.length = 0;
  for (let i = 0; i < 512; i++) _p[i] = Math.floor(rng() * 256);
}

export function lerp(a, b, t) { return a + t * (b - a); }

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function grad(h, x, y) {
  const v = h & 3;
  return ((v & 1) ? -x : x) + ((v & 2) ? -y : y);
}

export function noise2d(x, y) {
  const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = _p[(_p[xi] & 255) + yi];
  const ab = _p[(_p[xi] & 255) + yi + 1];
  const ba = _p[(_p[(xi + 1) & 255] & 255) + yi];
  const bb = _p[(_p[(xi + 1) & 255] & 255) + yi + 1];
  return lerp(
    lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
    lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
    v
  );
}

export function fbm(x, y) {
  let v = 0, a = 1, f = 1;
  for (let i = 0; i < 4; i++) { v += a * noise2d(x * f, y * f); a *= 0.5; f *= 2; }
  return v;
}
