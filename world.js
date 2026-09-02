// world.js � terrain, fog, landmarks, beacons, bearings, resection
import { seedRng, initNoise, fbm, lerp } from './noise.js';

export const WORLD = 1024, SIG = 1337, PPM = 2.5, SR = 200, FR = 320, GR = 50, MB = 24, ALG = 0.0698;

// Terrain data
export const heightMap = new Float32Array(WORLD * WORLD);
export const colorMap = new Uint8Array(WORLD * WORLD * 3);
export const fogMap = new Uint8Array(WORLD * WORLD);
export let fogVersion = 0;

export function heightAt(x, z) {
  if (x < 0 || z < 0 || x >= WORLD || z >= WORLD) return -999;
  return heightMap[z * WORLD + x];
}

function terrainColor(h, x, z) {
  const rng = seedRng(x * 7919 + z * 104729 + SIG);
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

// Fog of war
export function revealFog(wx, wz, radius) {
  const cx = Math.floor(wx), cz = Math.floor(wz), rr = Math.ceil(radius);
  for (let z = cz - rr; z <= cz + rr; z++) for (let x = cx - rr; x <= cx + rr; x++) {
    if (x < 0 || z < 0 || x >= WORLD || z >= WORLD) continue;
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz <= radius * radius) { if (!fogMap[z * WORLD + x]) { fogMap[z * WORLD + x] = 1; fogVersion++; } }
  }
}

export function calcExplored() {
  let c = 0;
  for (let i = 0; i < fogMap.length; i++) if (fogMap[i]) c++;
  return (c / fogMap.length * 100).toFixed(1);
}

// Landmarks
export const landmarks = [
  { name: 'CAIRN-A', x: 380, z: 380 },
  { name: 'CAIRN-B', x: 680, z: 520 },
  { name: 'CAIRN-C', x: 460, z: 700 }
];

// Heights must be assigned AFTER buildTerrain() populates heightMap.
// Called from game.js init: assignLandmarkHeights();
export function assignLandmarkHeights() {
  landmarks.forEach(l => { l.y = Math.max(heightAt(l.x, l.z), 2) + 4; });
}

// Beacons
export const beacons = [];
export let beaconCount = 0;
export function placeBeacon(state) {
  if (beaconCount >= MB) { state.setStatus('Beacon cap reached (' + MB + ').'); return; }
  const wx = state.px + Math.sin(state.camAngle) * 10;
  const wz = state.pz + Math.cos(state.camAngle) * 10;
  const h = heightAt(wx, wz);
  if (h <= 0) { state.setStatus('Cannot place in water.'); return; }
  beaconCount++;
  const bn = 'BEACON-' + String(beaconCount).padStart(2, '0');
  beacons.push({ name: bn, x: wx, z: wz, y: h + 0.85 });
  state.setStatus(bn + ' planted.');
  document.getElementById('beacon-count').textContent = 'Beacons: ' + beaconCount + '/' + MB;
}

// Bearings & position fix
export const bearings = [];
export let lastFix = null, hasFix = false;

// Shared target finder � used by both takeBearing() and render() alignment check
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

function angDiff(a, b) {
  return Math.abs(((a - b + Math.PI) % (Math.PI * 2)) - Math.PI);
}



export function takeBearing(state) {
  const tx = findNearestTarget(state.px, state.pz, state.camAngle, bearings);
  if (!tx) { state.setStatus('Nothing in range.'); return; }
  const dx = tx.x - state.px, dz = tx.z - state.pz;
  const trueB = Math.atan2(dx, -dz);
  const off = angDiff(state.camAngle, trueB);
  if (off > ALG) {
    state.setStatus('Sight ' + (off * 180 / Math.PI).toFixed(1) + ' deg off ' + tx.name + ' - line up and press E again.');
    return;
  }
  bearings.push({ name: tx.name, x: tx.x, z: tx.z, b: state.camAngle, err: off * 180 / Math.PI });
  state.setStatus('Bearing to ' + tx.name + ': ' + Math.round(state.camAngle * 180 / Math.PI) + ' deg');
  tryFix(state);
}

export function tryFix(state) {
  let a = null, b = null;
  for (let i = bearings.length - 1; i >= 0; i--) {
    if (!a) a = bearings[i];
    else if (bearings[i].name !== a.name) { b = bearings[i]; break; }
  }
  if (!a || !b) return;
  const u1x = Math.sin(a.b), u1z = -Math.cos(a.b);
  const u2x = Math.sin(b.b), u2z = -Math.cos(b.b);
  const det = u1x * (-u2z) - (-u2x) * u1z;
  if (Math.abs(det) < 0.0005) { state.setStatus('Bearings nearly parallel.'); return; }
  const rhsx = a.x - b.x, rhsz = a.z - b.z;
  const t1 = (rhsx * (-u2z) - (-u2x) * rhsz) / det;
  const t2 = (u1x * rhsz - rhsx * u1z) / det;
  if (t1 <= 0 || t2 <= 0) { state.setStatus('Bad geometry - reposition.'); return; }
  const o1x = a.x - u1x * t1, o1z = a.z - u1z * t1;
  const o2x = b.x - u2x * t2, o2z = b.z - u2z * t2;
  lastFix = { x: (o1x + o2x) / 2, z: (o1z + o2z) / 2 };
  hasFix = true;
  const err = Math.sqrt((lastFix.x - state.px) ** 2 + (lastFix.z - state.pz) ** 2);
  const spread = Math.sqrt((o1x - o2x) ** 2 + (o1z - o2z) ** 2);
  state.setStatus('POSITION FIX - error ' + err.toFixed(1) + 'm - closure ' + spread.toFixed(1) + 'm - F plots on chart');
  bearings.length = 0;
  const fi = document.getElementById('fix-info');
  fi.style.display = 'block';
  fi.textContent = 'Fix: (' + Math.round(lastFix.x) + ', ' + Math.round(lastFix.z) + ') err: ' + err.toFixed(1) + 'm';
}
