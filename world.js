// world.js — terrain, fog, landmarks, beacons, bearings, resection
// Pure logic only. No DOM access. All state is module-level.
import { seedRng, initNoise, fbm, lerp } from './noise.js';

export const WORLD = 1024, PPM = 2.5, SR = 200, FR = 320, GR = 50, MB = 24, ALG = 0.0698;

// --- Terrain ---
const heightMap = new Float32Array(WORLD * WORLD);
export const colorMap = new Uint8Array(WORLD * WORLD * 3);
export const fogMap = new Uint8Array(WORLD * WORLD);
export let fogVersion = 0;

export function heightAt(x, z) {
  if (x < 0 || z < 0 || x >= WORLD || z >= WORLD) return -999;
  return heightMap[z * WORLD + x];
}

function terrainColor(h, x, z) {
  const rng = seedRng(x * 7919 + z * 104729 + 1337);
  const v = rng();
  if (h < 0) return [40, 85, 130];
  if (h < 0.4) return v > 0.5 ? [210, 195, 155] : [200, 185, 145];
  if (h < 3) { const t = (h - 0.4) / 2.6; return [lerp(195, 95, t) + v * 8, lerp(175, 150, t) + v * 8, lerp(130, 70, t)]; }
  if (h < 6) { const t = (h - 3) / 3; return [lerp(95, 75, t) + v * 6, lerp(150, 120, t) + v * 6, lerp(70, 55, t) + v * 4]; }
  if (h < 12) { const t = (h - 6) / 6; return [lerp(75, 145, t) + v * 6, lerp(120, 135, t) + v * 6, lerp(55, 120, t) + v * 4]; }
  if (h < 22) { const t = (h - 12) / 10; return [lerp(145, 230, t) + v * 4, lerp(135, 230, t) + v * 4, lerp(120, 225, t) + v * 4]; }
  return [240, 240, 235];
}

export function buildTerrain() {
  for (let z = 0; z < WORLD; z++) for (let x = 0; x < WORLD; x++) {
    const nx = x / 128, nz = z / 128;
    const n = fbm(nx, nz);
    const dx = x - WORLD / 2, dz = z - WORLD / 2, r = Math.sqrt(dx * dx + dz * dz) / (WORLD / 2);
    const mask = 1 - Math.max(0, Math.min(1, (r - 0.5) / 0.52));
    let h = Math.pow(Math.max(0, n * 0.5 + 0.5), 0.7) * 30 * mask - 3;
    if (h > 0 && h < 1.5) h *= 1 - 0.4 * (1 - h / 1.5);
    const i = z * WORLD + x;
    heightMap[i] = h;
    const c = terrainColor(h, x, z);
    colorMap[i * 3] = c[0]; colorMap[i * 3 + 1] = c[1]; colorMap[i * 3 + 2] = c[2];
  }
}

// --- Fog of war ---
export function revealFog(wx, wz, radius) {
  const cx = Math.floor(wx), cz = Math.floor(wz), rr = Math.ceil(radius);
  for (let z = cz - rr; z <= cz + rr; z++) for (let x = cx - rr; x <= cx + rr; x++) {
    if (x < 0 || z < 0 || x >= WORLD || z >= WORLD) continue;
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz <= radius * radius && !fogMap[z * WORLD + x]) { fogMap[z * WORLD + x] = 1; fogVersion++; }
  }
}

export function calcExplored() {
  let c = 0;
  for (let i = 0; i < fogMap.length; i++) if (fogMap[i]) c++;
  return (c / fogMap.length * 100).toFixed(1);
}

// --- Landmarks ---
export const landmarks = [
  { name: 'CAIRN-A', x: 380, z: 380 },
  { name: 'CAIRN-B', x: 680, z: 520 },
  { name: 'CAIRN-C', x: 460, z: 700 }
];

export function assignLandmarkHeights() {
  landmarks.forEach(l => { l.y = Math.max(heightAt(l.x, l.z), 2) + 4; });
}

// --- Beacons ---
export const beacons = [];
export let beaconCount = 0;

// Returns { ok: true, name } or { ok: false, reason }
export function placeBeacon(px, pz, camAngle) {
  if (beaconCount >= MB) return { ok: false, reason: 'Maximum beacons placed (' + MB + '/' + MB + '). Open your chart to publish.' };
  const wx = px + Math.sin(camAngle) * 10;
  const wz = pz + Math.cos(camAngle) * 10;
  const h = heightAt(wx, wz);
  if (h <= 0) return { ok: false, reason: 'Beacons must be on dry land. Move inland.' };
  beaconCount++;
  const bn = 'BEACON-' + String(beaconCount).padStart(2, '0');
  beacons.push({ name: bn, x: wx, z: wz, y: h + 0.85 });
  return { ok: true, name: bn };
}

// --- Bearings & resection ---
export const bearings = [];
export let lastFix = null, hasFix = false;

function angDiff(a, b) {
  return Math.abs(((a - b + Math.PI) % (Math.PI * 2)) - Math.PI);
}

export function findNearestTarget(px, pz, camAngle, bearingsList) {
  const recorded = new Set(bearingsList.map(b => b.name));
  let best = null, bestScore = Infinity;
  const all = [];
  landmarks.forEach(l => { if (!recorded.has(l.name)) all.push(l); });
  beacons.forEach(b => { if (!recorded.has(b.name)) all.push(b); });
  for (const t of all) {
    const dx = t.x - px, dz = t.z - pz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > FR) continue;
    const trueB = Math.atan2(dx, -dz);
    const off = angDiff(camAngle, trueB);
    const score = off * 1000 + d;
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

export function isAligned(px, pz, camAngle, bearingsList) {
  const t = findNearestTarget(px, pz, camAngle, bearingsList);
  if (!t) return false;
  const dx = t.x - px, dz = t.z - pz;
  const trueB = Math.atan2(dx, -dz);
  return angDiff(camAngle, trueB) <= ALG;
}

// Returns { ok, reason?, bearing?, fix? }
export function takeBearing(px, pz, camAngle) {
  const tx = findNearestTarget(px, pz, camAngle, bearings);
  if (!tx) return { ok: false, reason: 'No targets in range. Move closer to a cairn or beacon.' };
  const dx = tx.x - px, dz = tx.z - pz;
  const trueB = Math.atan2(dx, -dz);
  const off = angDiff(camAngle, trueB);
  if (off > ALG) return { ok: false, reason: 'Crosshair is ' + (off * 180 / Math.PI).toFixed(1) + '° off ' + tx.name + '. Adjust aim and press E.' };
  bearings.push({ name: tx.name, x: tx.x, z: tx.z, b: camAngle, err: off * 180 / Math.PI });
  const fix = tryFix(px, pz);
  return { ok: true, bearing: tx.name, degrees: Math.round(camAngle * 180 / Math.PI), fix };
}

// Returns null or { x, z, err, spread }
function tryFix(px, pz) {
  let a = null, b = null;
  for (let i = bearings.length - 1; i >= 0; i--) {
    if (!a) a = bearings[i];
    else if (bearings[i].name !== a.name) { b = bearings[i]; break; }
  }
  if (!a || !b) return null;
  const u1x = Math.sin(a.b), u1z = -Math.cos(a.b);
  const u2x = Math.sin(b.b), u2z = -Math.cos(b.b);
  const det = u1x * (-u2z) - (-u2x) * u1z;
  if (Math.abs(det) < 0.0005) return null;
  const rhsx = a.x - b.x, rhsz = a.z - b.z;
  const t1 = (rhsx * (-u2z) - (-u2x) * rhsz) / det;
  const t2 = (u1x * rhsz - rhsx * u1z) / det;
  if (t1 <= 0 || t2 <= 0) return null;
  const o1x = a.x - u1x * t1, o1z = a.z - u1z * t1;
  const o2x = b.x - u2x * t2, o2z = b.z - u2z * t2;
  const fix = { x: (o1x + o2x) / 2, z: (o1z + o2z) / 2 };
  const err = Math.sqrt((fix.x - px) ** 2 + (fix.z - pz) ** 2);
  const spread = Math.sqrt((o1x - o2x) ** 2 + (o1z - o2z) ** 2);
  lastFix = fix; hasFix = true;
  bearings.length = 0;
  return { x: fix.x, z: fix.z, err, spread };
}

// Reset all game state
export function resetWorld() {
  fogMap.fill(0); fogVersion = 0;
  beacons.length = 0; beaconCount = 0;
  bearings.length = 0; lastFix = null; hasFix = false;
}
