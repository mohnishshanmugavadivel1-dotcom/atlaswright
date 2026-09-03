// render.js — canvas rendering: terrain, landmarks, beacons, crosshair, player, minimap
import {
  WORLD, FR, GR, PPM,
  heightAt, fogVersion, colorMap, fogMap,
  beacons, bearings, lastFix, hasFix, landmarks,
  findNearestTarget, isAligned,
} from './world.js';

// Module-level state (owned by this module)
let ctx, cW, cH;
let minimapCtx;
let _minimapDirty = true, _lastMinimapPx = -1, _lastMinimapPz = -1;
let _terrainCache = null, _terrainCacheKey = '';

export function initRender(worldCanvas, minimapCanvasEl) {
  ctx = worldCanvas.getContext('2d');
  minimapCtx = minimapCanvasEl.getContext('2d');
  function resize() {
    const w = window.innerWidth || 960, h = window.innerHeight || 640;
    worldCanvas.width = w; worldCanvas.height = h; cW = w; cH = h;
  }
  resize();
  window.addEventListener('resize', resize);
}

function worldToScreen(wx, wz, state) {
  return { x: (wx - state.px) * PPM + cW / 2, z: (wz - state.pz) * PPM + cH / 2 };
}

export function render(state) {
  ctx.fillStyle = '#1a3a5a'; ctx.fillRect(0, 0, cW, cH);
  // Terrain
  const viewR = FR / PPM;
  const sx = Math.max(0, Math.floor(state.px - viewR));
  const sz = Math.max(0, Math.floor(state.pz - viewR));
  const ex = Math.min(WORLD, Math.ceil(state.px + viewR));
  const ez = Math.min(WORLD, Math.ceil(state.pz + viewR));
  const tw = Math.ceil(ex - sx), th = Math.ceil(ez - sz);
  const cacheKey = sx + ',' + sz + ',' + tw + ',' + th + ':' + fogVersion;
  let imgData;
  if (_terrainCache && _terrainCacheKey === cacheKey) {
    imgData = _terrainCache;
  } else {
    imgData = ctx.createImageData(tw, th);
    for (let wz = sz; wz < ez; wz++) for (let wx = sx; wx < ex; wx++) {
      const h = heightAt(wx, wz);
      const pi = ((wz - sz) | 0) * tw + ((wx - sx) | 0);
      if (h <= 0) {
        imgData.data[pi * 4] = 40; imgData.data[pi * 4 + 1] = 85; imgData.data[pi * 4 + 2] = 130; imgData.data[pi * 4 + 3] = 255;
      } else {
        const ci = (wz * WORLD + wx) * 3;
        const explored = fogMap[wz * WORLD + wx];
        imgData.data[pi * 4] = colorMap[ci]; imgData.data[pi * 4 + 1] = colorMap[ci + 1]; imgData.data[pi * 4 + 2] = colorMap[ci + 2];
        imgData.data[pi * 4 + 3] = explored ? 255 : 40;
      }
    }
    _terrainCache = imgData; _terrainCacheKey = cacheKey;
  }
  ctx.putImageData(imgData, Math.floor((sx - state.px) * PPM + cW / 2), Math.floor((sz - state.pz) * PPM + cH / 2));
  // Grid
  ctx.strokeStyle = 'rgba(100,90,70,0.25)'; ctx.lineWidth = 0.5;
  for (let gx = Math.floor((state.px - FR / PPM) / GR) * GR; gx < state.px + FR / PPM; gx += GR) {
    const s = worldToScreen(gx, state.pz, state);
    ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, cH); ctx.stroke();
  }
  for (let gz = Math.floor((state.pz - FR / PPM) / GR) * GR; gz < state.pz + FR / PPM; gz += GR) {
    const s = worldToScreen(state.px, gz, state);
    ctx.beginPath(); ctx.moveTo(0, s.z); ctx.lineTo(cW, s.z); ctx.stroke();
  }
  // Landmarks
  landmarks.forEach(l => {
    const s = worldToScreen(l.x, l.z, state);
    if (s.x < -40 || s.x > cW + 40 || s.z < -40 || s.z > cH + 40) return;
    ctx.fillStyle = fogMap[l.z * WORLD + l.x] ? '#c08030' : '#5a4a30';
    ctx.beginPath(); ctx.moveTo(s.x, s.z - 16); ctx.lineTo(s.x - 8, s.z); ctx.lineTo(s.x + 8, s.z); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(s.x, s.z); ctx.lineTo(s.x - 12, s.z + 12); ctx.lineTo(s.x + 12, s.z + 12); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Georgia'; ctx.textAlign = 'center'; ctx.fillText(l.name, s.x, s.z - 20);
  });
  // Beacons
  beacons.forEach(b => {
    const s = worldToScreen(b.x, b.z, state);
    if (s.x < -20 || s.x > cW + 20 || s.z < -20 || s.z > cH + 20) return;
    ctx.fillStyle = '#e88a20'; ctx.fillRect(s.x - 3, s.z - 10, 6, 20);
    ctx.fillStyle = '#ff6600'; ctx.fillRect(s.x - 1, s.z - 14, 4, 6);
    ctx.fillStyle = '#fff'; ctx.font = '9px Georgia'; ctx.textAlign = 'center'; ctx.fillText(b.name, s.x, s.z - 18);
  });
  // Crosshair — shape changes when aligned (non-color cue for colorblind)
  const target = findNearestTarget(state.px, state.pz, state.camAngle, bearings);
  const aligned = target && isAligned(state.px, state.pz, state.camAngle, bearings);
  const cx = cW / 2, cy = cH / 2;
  if (aligned) {
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
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 4, cy);
    ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 4);
    ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 12);
    ctx.stroke();
  }
  if (aligned && target) {
    ctx.fillStyle = 'rgba(255,180,0,0.9)';
    ctx.font = 'bold 13px "Source Sans 3", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(target.name, cx, cy + 28);
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,180,0,0.7)';
    ctx.fillText('press E', cx, cy + 42);
  }
  // Player
  const ps = worldToScreen(state.px, state.pz, state);
  ctx.fillStyle = '#e8d8b0'; ctx.beginPath(); ctx.arc(ps.x, ps.z, 6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c08030'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ps.x, ps.z, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#ff6600'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ps.x, ps.z);
  ctx.lineTo(ps.x + Math.sin(state.camAngle) * 20, ps.z + Math.cos(state.camAngle) * 20); ctx.stroke();
  // Fix marker
  if (hasFix && lastFix) {
    const fs = worldToScreen(lastFix.x, lastFix.z, state);
    ctx.strokeStyle = '#ff3333'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(fs.x - 8, fs.z - 8); ctx.lineTo(fs.x + 8, fs.z + 8);
    ctx.moveTo(fs.x + 8, fs.z - 8); ctx.lineTo(fs.x - 8, fs.z + 8); ctx.stroke();
  }
  // Atmosphere: subtle cloud shadows
  const cloudT = Date.now() * 0.0001;
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (let i = 0; i < 3; i++) {
    const cx = cW * (0.3 + 0.4 * Math.sin(cloudT + i * 2.1));
    const cy = cH * (0.3 + 0.3 * Math.cos(cloudT * 0.7 + i * 1.7));
    ctx.beginPath(); ctx.arc(cx, cy, 120 + i * 40, 0, Math.PI * 2); ctx.fill();
  }
  // Compass
  const deg = Math.round((state.camAngle * 180 / Math.PI + 360) % 360);
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  document.getElementById('compass').textContent = String(deg).padStart(3, '0') + ' deg ' + dirs[Math.round(deg / 45) % 8];
  // Minimap
  const mpx = Math.floor(state.px), mpz = Math.floor(state.pz);
  if (mpx !== _lastMinimapPx || mpz !== _lastMinimapPz) { _minimapDirty = true; _lastMinimapPx = mpx; _lastMinimapPz = mpz; }
  if (_minimapDirty) { renderMinimap(state); _minimapDirty = false; }
}

function renderMinimap(state) {
  const mw = 160, mh = 160, sc = WORLD / mw;
  const id = minimapCtx.createImageData(mw, mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const wx = Math.floor(x * sc), wz = Math.floor(y * sc);
    const h = heightAt(wx, wz);
    const pi = (y * mw + x) * 4;
    if (h <= 0) { id.data[pi] = 40; id.data[pi + 1] = 85; id.data[pi + 2] = 130; id.data[pi + 3] = 255; }
    else { const ci = (wz * WORLD + wx) * 3; const ex = fogMap[wz * WORLD + wx]; id.data[pi] = colorMap[ci]; id.data[pi + 1] = colorMap[ci + 1]; id.data[pi + 2] = colorMap[ci + 2]; id.data[pi + 3] = ex ? 255 : 30; }
  }
  minimapCtx.putImageData(id, 0, 0);
  minimapCtx.strokeStyle = 'rgba(200,180,120,0.5)'; minimapCtx.lineWidth = 1; minimapCtx.strokeRect(0, 0, mw, mh);
  const ppx = (state.px / WORLD) * mw, ppz = (state.pz / WORLD) * mh;
  minimapCtx.fillStyle = '#ff6600'; minimapCtx.beginPath(); minimapCtx.arc(ppx, ppz, 3, 0, Math.PI * 2); minimapCtx.fill();
}
