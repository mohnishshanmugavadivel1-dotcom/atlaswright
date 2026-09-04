// world.js — terrain, fog, landmarks, beacons, bearings, resection
// Pure logic only. No DOM access. All state is module-level.
import { seedRng, initNoise, fbm, lerp } from './noise.js';

export const WORLD = 1024, PPM = 2.5, SR = 110, FR = 320, GR = 50, MB = 24, ALG = 0.0698;

// --- Terrain ---
const heightMap = new Float32Array(WORLD * WORLD);
export const colorMap = new Uint8Array(WORLD * WORLD * 3);
export const fogMap = new Uint8Array(WORLD * WORLD); // 0=hidden, 1=revealed, 2=semi-revealed
export let fogVersion = 0;

export function heightAt(x, z) {
  // Movement and logic pass fractional positions (speed 4 cells/s), but the
  // height/color grid is one sample per integer cell. Resolve the cell the
  // point stands in before indexing — the old raw index read a random cell
  // for fractional input, so the player was permanently "blocked" at spawn.
  const ix = Math.round(x), iz = Math.round(z);
  if (ix < 0 || iz < 0 || ix >= WORLD || iz >= WORLD) return -999;
  return heightMap[iz * WORLD + ix];
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

export function buildTerrain(seed) {
  initNoise(seed || 1337);
  for (let z = 0; z < WORLD; z++) for (let x = 0; x < WORLD; x++) {
    const nx = x / 128, nz = z / 128;
    const n = fbm(nx, nz);
    const dx = x - WORLD / 2, dz = z - WORLD / 2, r = Math.sqrt(dx * dx + dz * dz) / (WORLD / 2);
    const mask = 1 - Math.max(0, Math.min(1, (r - 0.5) / 0.52));
    let h = Math.pow(Math.max(0, n * 0.5 + 0.5), 0.7) * 30 * mask - 3;
    const ridgeDist = Math.abs((x - 300) * 0.3 + (z - 600) * 0.1);
    if (h > 0 && ridgeDist < 15) h += (1 - ridgeDist / 15) * 8;
    const inletDist = Math.abs(z - 512);
    if (x > 600 && x < 800 && inletDist < 20 + (x - 600) * 0.3) {
      const carved = 1 - Math.max(0, 1 - inletDist / (20 + (x - 600) * 0.3));
      h -= carved * 5;
    }
    if (h > 0 && h < 1.5) h *= 1 - 0.4 * (1 - h / 1.5);
    const i = z * WORLD + x;
    heightMap[i] = h;
    const c = terrainColor(h, x, z);
    colorMap[i * 3] = c[0]; colorMap[i * 3 + 1] = c[1]; colorMap[i * 3 + 2] = c[2];
  }
}

// --- Fog of war with smooth edges ---
export function revealFog(wx, wz, radius) {
  const cx = Math.floor(wx), cz = Math.floor(wz), rr = Math.ceil(radius);
  for (let z = cz - rr; z <= cz + rr; z++) for (let x = cx - rr; x <= cx + rr; x++) {
    if (x < 0 || z < 0 || x >= WORLD || z >= WORLD) continue;
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz <= radius * radius && fogMap[z * WORLD + x] === 0) {
      fogMap[z * WORLD + x] = 1; fogVersion++;
    }
  }
  // Smooth edges: mark adjacent-to-revealed as semi-revealed (2)
  for (let z = Math.max(0, cz - rr - 1); z <= Math.min(WORLD - 1, cz + rr + 1); z++) {
    for (let x = Math.max(0, cx - rr - 1); x <= Math.min(WORLD - 1, cx + rr + 1); x++) {
      if (fogMap[z * WORLD + x] !== 0) continue;
      // Check if any neighbor is revealed
      let hasRevealedNeighbor = false;
      for (const [ox, oz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx2 = x + ox, nz2 = z + oz;
        if (nx2 >= 0 && nz2 >= 0 && nx2 < WORLD && nz2 < WORLD && fogMap[nz2 * WORLD + nx2] === 1) {
          hasRevealedNeighbor = true; break;
        }
      }
      if (hasRevealedNeighbor) { fogMap[z * WORLD + x] = 2; fogVersion++; }
    }
  }
}

export function calcExplored() {
  let c = 0;
  for (let i = 0; i < fogMap.length; i++) if (fogMap[i] === 1) c++;
  return (c / fogMap.length * 100).toFixed(1);
}

// --- Landmarks ---
export const landmarks = [
  { name: 'CAIRN-A', x: 380, z: 380 },
  { name: 'CAIRN-B', x: 680, z: 520 },
  { name: 'CAIRN-C', x: 460, z: 700 },
  { name: 'WRECK', x: 750, z: 350 },
  { name: 'MARKER', x: 300, z: 250 },
];

// Normalize a radian heading to a display degree in [0, 360). Never negative,
// never NaN-safe for normal input, so HUD text can never read "-236 deg".
export function normalizeDeg(rad) {
  let d = rad * 180 / Math.PI;
  d = ((d % 360) + 360) % 360;
  return Number.isFinite(d) ? d : 0;
}

export function assignLandmarkHeights() {
  landmarks.forEach(l => { l.y = Math.max(heightAt(l.x, l.z), 2) + 4; });
}

// --- Beacons ---
export const beacons = [];
export let beaconCount = 0;

export function placeBeacon(px, pz, camAngle) {
  if (beaconCount >= MB) return { ok: false, reason: 'All ' + MB + ' beacons placed. Open the chart (TAB) and publish.' };
  const wx = px + Math.sin(camAngle) * 10;
  const wz = pz + Math.cos(camAngle) * 10;
  const h = heightAt(wx, wz);
  if (h <= 0) return { ok: false, reason: 'That spot is in the water. Walk to dry land first.' };
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

// Nearest unrecorded marker by pure distance — used for the "walk this way"
// guidance arrow and "move toward a marker" hints (findNearestTarget above is
// biased by aim angle for the E action itself).
export function nearestUnrecordedTarget(px, pz, bearingsList) {
  const recorded = new Set(bearingsList.map(b => b.name));
  let best = null, bestD = Infinity;
  const consider = t => {
    if (recorded.has(t.name)) return;
    const dx = t.x - px, dz = t.z - pz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= FR && d < bestD) { bestD = d; best = t; }
  };
  landmarks.forEach(consider);
  beacons.forEach(consider);
  return best;
}

// How far/which way the player must turn to face the nearest target, plus its
// distance. Used by takeBearing for failure text and by the HUD for guidance.
export function aimInfo(px, pz, camAngle, bearingsList) {
  const t = findNearestTarget(px, pz, camAngle, bearingsList);
  if (!t) return null;
  const dx = t.x - px, dz = t.z - pz;
  const trueB = Math.atan2(dx, -dz);
  let delta = (trueB - camAngle) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return {
    target: t,
    dist: Math.sqrt(dx * dx + dz * dz),
    offRad: Math.abs(delta),
    offDeg: Math.abs(delta) * 180 / Math.PI,
    turn: delta >= 0 ? 'right' : 'left',
  };
}

export function isAligned(px, pz, camAngle, bearingsList) {
  const t = findNearestTarget(px, pz, camAngle, bearingsList);
  if (!t) return false;
  const dx = t.x - px, dz = t.z - pz;
  const trueB = Math.atan2(dx, -dz);
  return angDiff(camAngle, trueB) <= ALG;
}

const DONE_REASON = 'All ' + MB + ' beacons placed. Open the chart (TAB) and publish.';

export function takeBearing(px, pz, camAngle) {
  const tx = findNearestTarget(px, pz, camAngle, bearings);
  if (!tx) return { ok: false, reason: beaconCount >= MB ? DONE_REASON : 'No marker close enough. Walk toward a marker (▲).' };
  const info = aimInfo(px, pz, camAngle, bearings);
  if (!info || info.offRad > ALG) {
    const offDeg = info ? Math.round(info.offDeg) : 0;
    const turn = info ? info.turn : 'left';
    return {
      ok: false,
      reason: beaconCount >= MB ? DONE_REASON : 'Turn ' + turn + ' toward ' + tx.name + ' (' + offDeg + '°), then press E.',
      target: tx.name, offDeg, turn,
    };
  }
  bearings.push({ name: tx.name, x: tx.x, z: tx.z, b: camAngle, err: info.offRad * 180 / Math.PI });
  const fix = tryFix(px, pz);
  return { ok: true, bearing: tx.name, degrees: Math.round(normalizeDeg(camAngle)), fix };
}

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
  lastFix = fix; hasFix = true;
  bearings.length = 0;
  return { x: fix.x, z: fix.z, err };
}

export function resetWorld() {
  fogMap.fill(0); fogVersion = 0;
  beacons.length = 0; beaconCount = 0;
  bearings.length = 0; lastFix = null; hasFix = false;
}

export function restoreState(data) {
  beacons.length = 0;
  data.beacons.forEach(b => beacons.push(b));
  beaconCount = data.beaconCount || 0;
  bearings.length = 0;
  data.bearings.forEach(b => bearings.push(b));
  lastFix = data.lastFix || null;
  hasFix = data.hasFix || false;
}
