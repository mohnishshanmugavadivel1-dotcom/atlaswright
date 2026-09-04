// render.js — pseudo-3D raycasting renderer + HUD elements
import {
  WORLD, FR, ALG, MB,
  heightAt, colorMap, fogMap,
  beacons, bearings, landmarks,
  normalizeDeg, nearestUnrecordedTarget, aimInfo, beaconCount,
} from './world.js';

let ctx, cW, cH;
let minimapCtx;
let _terrainCache = null, _terrainCacheKey = '';
let _skyGradient = null;

export function initRender(worldCanvas, minimapCanvasEl) {
  ctx = worldCanvas.getContext('2d');
  minimapCtx = minimapCanvasEl.getContext('2d');
  function resize() {
    const w = window.innerWidth || 960, h = window.innerHeight || 640;
    worldCanvas.width = w; worldCanvas.height = h; cW = w; cH = h;
    _skyGradient = null; // rebuild on next frame
  }
  resize();
  window.addEventListener('resize', resize);
}

// --- Raycasting engine ---
const FOV = 70 * Math.PI / 180; // 70 degrees
const HALF_FOV = FOV / 2;
const MAX_RAY_DIST = 300;
const WALL_HEIGHT_SCALE = 95; // how tall walls appear
const EYE_HEIGHT = 5.5; // eye level above terrain — low enough that terrain reads as walls

function castRay(ox, oz, angle, maxDist) {
  const dx = Math.sin(angle);
  const dz = -Math.cos(angle);
  const step = 1.5;
  for (let d = 1; d < maxDist; d += step) {
    const wx = Math.floor(ox + dx * d);
    const wz = Math.floor(oz + dz * d);
    if (wx < 0 || wz < 0 || wx >= WORLD || wz >= WORLD) return { dist: maxDist, h: -999, x: wx, z: wz };
    const h = heightAt(wx, wz);
    if (h <= 0) continue; // water — keep going
    return { dist: d, h, x: wx, z: wz };
  }
  return { dist: maxDist, h: -999, x: Math.floor(ox + dx * maxDist), z: Math.floor(oz + dz * maxDist) };
}

function getTerrainColorAt(wx, wz) {
  if (wx < 0 || wz < 0 || wx >= WORLD || wz >= WORLD) return [40, 85, 130];
  const ci = (wz * WORLD + wx) * 3;
  return [colorMap[ci], colorMap[ci + 1], colorMap[ci + 2]];
}

function drawSky() {
  if (!_skyGradient) {
    _skyGradient = ctx.createLinearGradient(0, 0, 0, cH * 0.5);
    _skyGradient.addColorStop(0, '#4a7faa');
    _skyGradient.addColorStop(0.6, '#8ab4d4');
    _skyGradient.addColorStop(1, '#c8dde8');
  }
  ctx.fillStyle = _skyGradient;
  ctx.fillRect(0, 0, cW, cH * 0.5);
}

function drawFloor() {
  ctx.fillStyle = '#1a3a5a';
  ctx.fillRect(0, cH * 0.5, cW, cH * 0.5);
}

function drawRaycastView(state, bobOffset) {
  const numRays = Math.ceil(cW / 2); // one column per 2 pixels for performance
  const halfH = cH / 2 + bobOffset;
  const eyeHeight = EYE_HEIGHT + (state.py || 0); // rises during jumps

  for (let i = 0; i < numRays; i++) {
    const screenX = (i / numRays) * cW;
    const rayAngle = state.camAngle - HALF_FOV + (i / numRays) * FOV;
    const ray = castRay(state.px, state.pz, rayAngle, MAX_RAY_DIST);

    if (ray.h <= 0) {
      // Water or sky
      const waterColor = fogMap[Math.floor(state.pz) * WORLD + Math.floor(state.px)] ? [40, 85, 130] : [30, 60, 100];
      ctx.fillStyle = `rgb(${waterColor[0]},${waterColor[1]},${waterColor[2]})`;
      ctx.fillRect(screenX, halfH, 2, cH - halfH);
      continue;
    }

    // Height difference between eye and terrain
    const heightDiff = eyeHeight - ray.h;
    // Projected wall height
    const projH = (WALL_HEIGHT_SCALE * eyeHeight) / Math.max(ray.dist, 1);
    const wallTop = halfH - projH / 2 + heightDiff * 4;
    const wallBottom = halfH + projH / 2 + heightDiff * 4;

    // Get terrain color with distance fog
    const [r, g, b] = getTerrainColorAt(ray.x, ray.z);
    const fogFactor = Math.min(1, ray.dist / MAX_RAY_DIST);
    const fr = Math.round(r * (1 - fogFactor * 0.6));
    const fg = Math.round(g * (1 - fogFactor * 0.6));
    const fb = Math.round(b * (1 - fogFactor * 0.6) + 130 * fogFactor * 0.6);

    // Fog of war check — hidden ground still readable, revealed ground pops
    const fogIdx = ray.z * WORLD + ray.x;
    const fogVal = fogIdx >= 0 && fogIdx < fogMap.length ? fogMap[fogIdx] : 0;
    let alpha = 1;
    if (fogVal === 0) alpha = 0.35;
    else if (fogVal === 2) alpha = 0.7;

    // Draw ground column
    ctx.fillStyle = `rgba(${fr},${fg},${fb},${alpha})`;
    ctx.fillRect(screenX, Math.max(0, wallTop), 2, Math.min(cH, wallBottom - wallTop));

    // Sky above terrain
    if (wallTop > 0) {
      const skyAlpha = alpha;
      ctx.fillStyle = `rgba(138,180,212,${skyAlpha})`;
      ctx.fillRect(screenX, 0, 2, Math.max(0, wallTop));
    }
  }
}

function drawLandmarkSprites(state) {
  const halfH = cH / 2;
  const sprites = [];

  // Collect visible landmarks and beacons
  landmarks.forEach(l => {
    const dx = l.x - state.px, dz = l.z - state.pz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > MAX_RAY_DIST || dist < 1) return;
    const angle = Math.atan2(dx, -dz);
    let relAngle = angle - state.camAngle;
    while (relAngle > Math.PI) relAngle -= Math.PI * 2;
    while (relAngle < -Math.PI) relAngle += Math.PI * 2;
    if (Math.abs(relAngle) > HALF_FOV + 0.1) return;
    const fogVal = fogMap[l.z * WORLD + l.x] || 0;
    sprites.push({ name: l.name, dist, relAngle, y: l.y || 4, type: 'landmark', fogVal });
  });

  beacons.forEach(b => {
    const dx = b.x - state.px, dz = b.z - state.pz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > MAX_RAY_DIST || dist < 1) return;
    const angle = Math.atan2(dx, -dz);
    let relAngle = angle - state.camAngle;
    while (relAngle > Math.PI) relAngle -= Math.PI * 2;
    while (relAngle < -Math.PI) relAngle += Math.PI * 2;
    if (Math.abs(relAngle) > HALF_FOV + 0.1) return;
    sprites.push({ name: b.name, dist, relAngle, y: b.y || 1, type: 'beacon', fogVal: 1 });
  });

  // Sort back to front
  sprites.sort((a, b) => b.dist - a.dist);

  sprites.forEach(s => {
    const screenX = cW / 2 + (s.relAngle / HALF_FOV) * (cW / 2);
    const scale = WALL_HEIGHT_SCALE / Math.max(s.dist, 1);
    const spriteH = scale * s.y * 8;
    const spriteW = spriteH * 0.5;
    const baseY = cH / 2 + spriteH * 0.3;

    const alpha = s.fogVal === 0 ? 0.35 : s.fogVal === 2 ? 0.7 : 1;

    if (s.type === 'landmark') {
      // Triangle shape for cairns
      ctx.fillStyle = `rgba(192,128,48,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(screenX, baseY - spriteH);
      ctx.lineTo(screenX - spriteW / 2, baseY);
      ctx.lineTo(screenX + spriteW / 2, baseY);
      ctx.closePath();
      ctx.fill();
      // Label
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.font = `${Math.max(8, Math.round(12 * scale * 4))}px Georgia`;
      ctx.textAlign = 'center';
      ctx.fillText(s.name, screenX, baseY - spriteH - 4);
    } else {
      // Beacon: vertical post
      ctx.fillStyle = `rgba(232,138,32,${alpha})`;
      ctx.fillRect(screenX - spriteW * 0.15, baseY - spriteH, spriteW * 0.3, spriteH);
      ctx.fillStyle = `rgba(255,102,0,${alpha})`;
      ctx.fillRect(screenX - spriteW * 0.1, baseY - spriteH - spriteH * 0.3, spriteW * 0.2, spriteH * 0.3);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.font = `${Math.max(6, Math.round(9 * scale * 4))}px Georgia`;
      ctx.textAlign = 'center';
      ctx.fillText(s.name, screenX, baseY - spriteH - spriteH * 0.3 - 4);
    }
  });
}

function drawEdgeArrow(state, target) {
  const dx = target.x - state.px, dz = target.z - state.pz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const angle = Math.atan2(dx, -dz);
  let rel = angle - state.camAngle;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  const ax = rel >= 0 ? cW - 70 : 70;
  const ay = cH / 2;
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(rel);
  ctx.fillStyle = 'rgba(232,168,64,0.95)';
  ctx.beginPath();
  ctx.moveTo(0, -13);
  ctx.lineTo(-8, 3);
  ctx.lineTo(8, 3);
  ctx.closePath();
  ctx.fill();
  ctx.font = '11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(Math.round(dist) + 'm', 0, 20);
  ctx.restore();
}

function drawCrosshair(state) {
  const cx = cW / 2, cy = cH / 2;
  const done = beaconCount >= MB;
  const info = aimInfo(state.px, state.pz, state.camAngle, bearings);

  if (info && info.offRad <= ALG) {
    // READY: aligned with a marker — pulsing gold ring
    const pulse = 1 + Math.sin(Date.now() * 0.008) * 0.15;
    ctx.strokeStyle = 'rgba(255,180,0,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, 16 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 22, cy); ctx.lineTo(cx - 18, cy);
    ctx.moveTo(cx + 18, cy); ctx.lineTo(cx + 22, cy);
    ctx.moveTo(cx, cy - 22); ctx.lineTo(cx, cy - 18);
    ctx.moveTo(cx, cy + 18); ctx.lineTo(cx, cy + 22);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,180,0,0.95)';
    ctx.font = 'bold 13px "Source Sans 3", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(info.target.name, cx, cy + 28);
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,180,0,0.8)';
    ctx.fillText(done ? 'open chart (TAB)' : 'press E', cx, cy + 42);
    return;
  }

  if (info && info.offDeg <= 50) {
    // AIMING: a marker is ahead, just not centered
    ctx.strokeStyle = 'rgba(232,168,64,0.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(232,168,64,0.85)';
    ctx.font = '12px "Source Sans 3", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(info.target.name + ' · ' + Math.round(info.dist) + 'm · turn ' + info.turn, cx, cy + 32);
    return;
  }

  // Plain cross, plus an edge arrow toward the nearest marker if one exists
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 4, cy);
  ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 4);
  ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  const guide = info ? info.target : nearestUnrecordedTarget(state.px, state.pz, bearings);
  if (guide) drawEdgeArrow(state, guide);
}

function drawCompassRose(state) {
  const cx = cW - 50, cy = 60, r = 30;
  const deg = state.camAngle;

  ctx.save();
  ctx.translate(cx, cy);

  // Background circle
  ctx.fillStyle = 'rgba(18,16,12,0.85)';
  ctx.strokeStyle = 'rgba(192,128,48,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, r + 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.rotate(-deg);

  // Cardinal points
  const dirs = [
    { label: 'N', angle: 0, color: '#c08030' },
    { label: 'E', angle: Math.PI / 2, color: '#d4c8a8' },
    { label: 'S', angle: Math.PI, color: '#d4c8a8' },
    { label: 'W', angle: -Math.PI / 2, color: '#d4c8a8' },
  ];

  dirs.forEach(d => {
    const x = Math.sin(d.angle) * (r - 6);
    const y = -Math.cos(d.angle) * (r - 6);
    ctx.fillStyle = d.color;
    ctx.font = 'bold 11px "Source Sans 3", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d.label, x, y);
  });

  // North needle
  ctx.fillStyle = '#c08030';
  ctx.beginPath();
  ctx.moveTo(0, -r + 10);
  ctx.lineTo(-3, -4);
  ctx.lineTo(3, -4);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawSprintBar(state, stamina) {
  const barW = 60, barH = 6;
  const x = cW - 50 - barW / 2, y = 95;
  ctx.fillStyle = 'rgba(18,16,12,0.7)';
  ctx.fillRect(x - 1, y - 1, barW + 2, barH + 2);
  const pct = Math.max(0, Math.min(1, stamina / 100));
  ctx.fillStyle = pct > 0.3 ? '#e8a840' : '#cc3333';
  ctx.fillRect(x, y, barW * pct, barH);
  ctx.strokeStyle = 'rgba(192,128,48,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, barW, barH);
}

function drawMinimap(state) {
  const mw = 176, mh = 176, sc = WORLD / mw;
  const id = minimapCtx.createImageData(mw, mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const wx = Math.floor(x * sc), wz = Math.floor(y * sc);
    const h = heightAt(wx, wz);
    const pi = (y * mw + x) * 4;
    if (h <= 0) { id.data[pi] = 40; id.data[pi + 1] = 85; id.data[pi + 2] = 130; id.data[pi + 3] = 255; }
    else {
      const ci = (wz * WORLD + wx) * 3;
      const fv = fogMap[wz * WORLD + wx];
      id.data[pi] = colorMap[ci]; id.data[pi + 1] = colorMap[ci + 1]; id.data[pi + 2] = colorMap[ci + 2];
      id.data[pi + 3] = fv === 1 ? 255 : fv === 2 ? 128 : 30;
    }
  }
  minimapCtx.putImageData(id, 0, 0);
  minimapCtx.strokeStyle = 'rgba(200,180,120,0.5)'; minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(0, 0, mw, mh);
  // Revealed markers appear on the map as you walk (strong movement feedback)
  landmarks.forEach(l => {
    const fv = fogMap[l.z * WORLD + l.x];
    if (fv !== 1 && fv !== 2) return;
    const lx = (l.x / WORLD) * mw, lz = (l.z / WORLD) * mh;
    minimapCtx.fillStyle = '#c08030';
    minimapCtx.beginPath();
    minimapCtx.moveTo(lx, lz - 4);
    minimapCtx.lineTo(lx - 3.5, lz + 3);
    minimapCtx.lineTo(lx + 3.5, lz + 3);
    minimapCtx.closePath();
    minimapCtx.fill();
  });
  beacons.forEach(b => {
    const fv = fogMap[Math.floor(b.z) * WORLD + Math.floor(b.x)];
    if (fv !== 1 && fv !== 2) return;
    const bx = (b.x / WORLD) * mw, bz = (b.z / WORLD) * mh;
    minimapCtx.fillStyle = '#ff6600';
    minimapCtx.fillRect(bx - 1.5, bz - 1.5, 3, 3);
  });
  // Player dot + facing line
  const ppx = (state.px / WORLD) * mw, ppz = (state.pz / WORLD) * mh;
  minimapCtx.strokeStyle = '#ff6600'; minimapCtx.lineWidth = 2;
  minimapCtx.beginPath();
  minimapCtx.moveTo(ppx, ppz);
  minimapCtx.lineTo(ppx + Math.sin(state.camAngle) * 12, ppz - Math.cos(state.camAngle) * 12);
  minimapCtx.stroke();
  minimapCtx.fillStyle = '#ff6600';
  minimapCtx.beginPath(); minimapCtx.arc(ppx, ppz, 3.5, 0, Math.PI * 2); minimapCtx.fill();
  // Explored percentage
  const pct = state.exploredPct != null ? state.exploredPct : '0.0';
  minimapCtx.fillStyle = 'rgba(232,216,176,0.9)';
  minimapCtx.font = '9px "JetBrains Mono", monospace';
  minimapCtx.textAlign = 'left';
  minimapCtx.fillText('Explored ' + pct + '%', 5, mh - 6);
}

// --- Main render entry point ---
export function render(state, stamina, bobOffset) {
  ctx.clearRect(0, 0, cW, cH);

  // Sky + floor
  drawSky();
  drawFloor();

  // Raycasted 3D terrain
  drawRaycastView(state, bobOffset || 0);

  // Landmark/beacon sprites
  drawLandmarkSprites(state);

  // Crosshair
  drawCrosshair(state);

  // Compass rose
  drawCompassRose(state);

  // Sprint bar
  drawSprintBar(state, stamina != null ? stamina : 100);

  // Compass text — always a valid 0-359 heading with a cardinal direction
  const deg = Math.round(normalizeDeg(state.camAngle));
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  document.getElementById('compass').textContent = String(deg).padStart(3, '0') + '° ' + dirs[Math.round(deg / 45) % 8];

  // Minimap (update every few frames, not every frame)
  if (Math.floor(Date.now() / 200) !== render._lastMinimapTick) {
    drawMinimap(state);
    render._lastMinimapTick = Math.floor(Date.now() / 200);
  }
}
render._lastMinimapTick = 0;
