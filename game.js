// game.js — orchestrator: state, init, update, render, input, chart, game loop
import { initNoise } from './noise.js';
import {
  WORLD, SR, FR, GR, PPM, MB, ALG,
  heightAt, buildTerrain, assignLandmarkHeights,
  revealFog, calcExplored, fogVersion, colorMap, fogMap,
  beacons, beaconCount, bearings, lastFix, hasFix,
  landmarks, findNearestTarget, isAligned,
  placeBeacon as placeBeaconLogic, takeBearing as takeBearingLogic, resetWorld, restoreState,
} from './world.js';

// --- State ---
const state = {
  mode: 0, started: false,
  px: 512, pz: 512, pvelx: 0, pvely: 0,
  camAngle: 0, dt: 0, lastTS: 0,
  keys: {}, mouseDown: false, lastMX: 0, lastMY: 0, pointerLocked: false,
  onGround: false, exploredPct: 0,
  startTime: 0, personalGoal: '',
};

// --- DOM refs ---
let canvas, ctx, cW, cH;
let minimapCanvas, minimapCtx;
let _minimapDirty = true, _lastMinimapPx = -1, _lastMinimapPz = -1;
let _terrainCache = null, _terrainCacheKey = '';
let _exploredTimer = 0;

// --- Chart state ---
const chart = { strokes: [], fixes: [], currentStroke: [], published: false };
let chartCanvas, chartCtx;

// --- Persistence ---
const SAVE_KEY = 'atlaswright-save';
const EXPORT_VERSION = 1;

function saveGame() {
  const data = {
    v: EXPORT_VERSION,
    px: state.px, pz: state.pz, camAngle: state.camAngle,
    beacons: beacons.map(b => ({ name: b.name, x: b.x, z: b.z, y: b.y })),
    beaconCount,
    bearings: bearings.map(b => ({ name: b.name, x: b.x, z: b.z, b: b.b, err: b.err })),
    lastFix, hasFix,
    chart: { strokes: chart.strokes, fixes: chart.fixes, published: chart.published },
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* quota exceeded */ }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.v !== EXPORT_VERSION) return null;
    return data;
  } catch (e) { return null; }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}

function importChart(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    if (data.v !== EXPORT_VERSION) return { ok: false, reason: 'Unsupported chart version.' };
    // Load into chart overlay for viewing
    chart.strokes = data.chart.strokes || [];
    chart.fixes = data.chart.fixes || [];
    chart.published = true;
    // Restore landmarks and beacons for display
    if (data.beacons) {
      beacons.length = 0;
      data.beacons.forEach(b => beacons.push(b));
    }
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'Invalid chart file.' }; }
}

function exportChart() {
  const data = {
    v: EXPORT_VERSION,
    px: state.px, pz: state.pz, camAngle: state.camAngle,
    beacons: beacons.map(b => ({ name: b.name, x: b.x, z: b.z, y: b.y })),
    beaconCount,
    bearings: bearings.map(b => ({ name: b.name, x: b.x, z: b.z, b: b.b, err: b.err })),
    lastFix, hasFix,
    chart: { strokes: chart.strokes, fixes: chart.fixes, published: chart.published },
  };
  return JSON.stringify(data);
}

// Auto-save on meaningful changes
let _autoSaveTimer = null;
function scheduleSave() {
  if (_autoSaveTimer) return;
  _autoSaveTimer = setTimeout(() => { _autoSaveTimer = null; saveGame(); }, 500);
}

function setStatus(s) { document.getElementById('status-bar').textContent = s; }
function worldToScreen(wx, wz) { return { x: (wx - state.px) * PPM + cW / 2, z: (wz - state.pz) * PPM + cH / 2 }; }

// --- Input ---
function initInput() {
  const cc = document.getElementById('world-canvas');
  document.addEventListener('keydown', e => {
    if (!state.started) return;
    state.keys[e.code] = true;
    if (e.code === 'Tab') { e.preventDefault(); toggleChart(); }
    if (e.code === 'KeyE' && state.mode === 0) doTakeBearing();
    if (e.code === 'KeyF' && state.mode === 0 && hasFix) doPlotFix();
    if (e.code === 'KeyZ' && state.mode === 1) doUndoStroke();
    if (e.code === 'Escape' && state.mode === 1) closeChart();
    if (e.code === 'Space' && state.mode === 0) { e.preventDefault(); if (state.onGround) { state.pvely = -12; state.onGround = false; } }
  });
  document.addEventListener('keyup', e => { state.keys[e.code] = false; });
  document.addEventListener('mousedown', e => {
    if (!state.started || state.mode !== 0) return;
    state.lastMX = e.clientX; state.lastMY = e.clientY; state.mouseDown = true;
    if (!state.pointerLocked) cc.requestPointerLock();
  });
  document.addEventListener('mousemove', e => {
    if (state.pointerLocked) state.camAngle += e.movementX * 0.003;
    else if (state.mouseDown) { state.camAngle += (e.clientX - state.lastMX) * 0.003; state.lastMX = e.clientX; state.lastMY = e.clientY; }
  });
  document.addEventListener('pointerlockchange', () => { state.pointerLocked = !!document.pointerLockElement; });
  document.addEventListener('mouseup', e => {
    if (e.button === 0 && state.mode === 0 && state.started) { state.mouseDown = false; doPlaceBeacon(); }
  });
  // Chart canvas drawing
  let drawing = false, lastCx = 0, lastCy = 0;
  chartCanvas.addEventListener('mousedown', e => { if (chart.published) return; drawing = true; lastCx = e.offsetX; lastCy = e.offsetY; });
  chartCanvas.addEventListener('mousemove', e => {
    if (!drawing || chart.published) return;
    if (chart.currentStroke.length === 0) chart.currentStroke.push({ x: lastCx, y: lastCy });
    chart.currentStroke.push({ x: e.offsetX, y: e.offsetY });
    lastCx = e.offsetX; lastCy = e.offsetY; drawChart();
  });
  chartCanvas.addEventListener('mouseup', () => { drawing = false; });
  // Button bindings
  document.getElementById('btn-undo').onclick = doUndoStroke;
  document.getElementById('btn-stamp').onclick = doPlotFix;
  document.getElementById('btn-publish').onclick = doPublishChart;
  document.getElementById('btn-export').onclick = doExportChart;
  document.getElementById('btn-import').onclick = doImportChart;
  document.getElementById('btn-export-published').onclick = doExportChart;
  document.getElementById('btn-start').onclick = startGame;
  document.getElementById('btn-new-session').onclick = () => { clearSave(); location.reload(); };
  // Resume prompt
  const saved = loadGame();
  if (saved && saved.beacons && saved.beacons.length > 0) {
    document.getElementById('resume-prompt').style.display = 'block';
    document.getElementById('btn-resume').onclick = () => { resumeGame(saved); };
    document.getElementById('btn-fresh').onclick = () => { clearSave(); startGame(); };
  }
}

// --- Game actions (DOM-coupled) ---
function doPlaceBeacon() {
  const r = placeBeaconLogic(state.px, state.pz, state.camAngle);
  setStatus(r.reason || r.name + ' planted.');
  document.getElementById('beacon-count').textContent = 'Beacons: ' + beaconCount + '/' + MB;
  if (r.ok) scheduleSave();
}

function doTakeBearing() {
  const r = takeBearingLogic(state.px, state.pz, state.camAngle);
  if (!r.ok) { setStatus(r.reason); return; }
  setStatus('Bearing recorded: ' + r.bearing + ' at ' + r.degrees + '°. Take a second bearing to fix your position.');
  scheduleSave();
  if (r.fix) {
    setStatus('Position fixed! Error: ' + r.fix.err.toFixed(1) + 'm. Press F to plot on your chart, or TAB to open it.');
    const fi = document.getElementById('fix-info');
    fi.style.display = 'block';
    fi.textContent = 'Fix: (' + Math.round(r.fix.x) + ', ' + Math.round(r.fix.z) + ') err: ' + r.fix.err.toFixed(1) + 'm';
  }
}

function doPlotFix() {
  if (!hasFix || !lastFix) { setStatus('No fix to plot.'); return; }
  const ext = 260, cw = chartCanvas.width, ch = chartCanvas.height;
  chart.fixes.push({ x: (lastFix.x + ext) / (2 * ext) * cw, z: (lastFix.z + ext) / (2 * ext) * ch });
  drawChart();
  setStatus('Fix plotted on chart.');
  scheduleSave();
}

function doUndoStroke() {
  if (chart.strokes.length > 0) { chart.strokes.pop(); drawChart(); setStatus('Stroke undone.'); }
}

// --- Chart ---
function openChart() {
  state.mode = 1;
  document.getElementById('chart-overlay').classList.add('visible');
  document.getElementById('mode-label').textContent = 'CHART';
  chartCanvas.width = chartCanvas.parentElement.clientWidth;
  chartCanvas.height = chartCanvas.parentElement.clientHeight;
  drawChart();
}

function closeChart() {
  state.mode = 0;
  document.getElementById('chart-overlay').classList.remove('visible');
  document.getElementById('mode-label').textContent = 'FIELD';
  chart.currentStroke = [];
  setStatus('Back in the field.');
}

function toggleChart() { state.mode === 1 ? closeChart() : openChart(); }

function drawChart() {
  if (!chartCtx) return;
  const cw = chartCanvas.width, ch = chartCanvas.height, ext = 260;
  chartCtx.fillStyle = '#ede8df';
  chartCtx.fillRect(0, 0, cw, ch);
  // Hint when empty
  if (chart.strokes.length === 0 && chart.fixes.length === 0) {
    chartCtx.fillStyle = 'rgba(90,74,48,0.25)';
    chartCtx.font = 'italic 14px "Instrument Serif", Georgia, serif';
    chartCtx.textAlign = 'center';
    chartCtx.fillText('Draw what you see from this vantage point', cw / 2, ch / 2 - 10);
    chartCtx.font = '12px "Source Sans 3", sans-serif';
    chartCtx.fillText('Use the ink to sketch terrain, landmarks, and bearings', cw / 2, ch / 2 + 14);
  }
  // Grid
  chartCtx.strokeStyle = 'rgba(180,165,130,0.4)'; chartCtx.lineWidth = 0.5;
  for (let k = -5; k <= 5; k++) {
    const gx = (k * 50 + ext) / (2 * ext) * cw;
    chartCtx.beginPath(); chartCtx.moveTo(gx, 0); chartCtx.lineTo(gx, ch); chartCtx.stroke();
  }
  for (let k = -5; k <= 5; k++) {
    const gz = (k * 50 + ext) / (2 * ext) * ch;
    chartCtx.beginPath(); chartCtx.moveTo(0, gz); chartCtx.lineTo(cw, gz); chartCtx.stroke();
  }
  // Major axes
  chartCtx.strokeStyle = 'rgba(140,120,80,0.6)'; chartCtx.lineWidth = 1.5;
  const ax = ext / (2 * ext) * cw, az = ext / (2 * ext) * ch;
  chartCtx.beginPath(); chartCtx.moveTo(ax, 0); chartCtx.lineTo(ax, ch); chartCtx.stroke();
  chartCtx.beginPath(); chartCtx.moveTo(0, az); chartCtx.lineTo(cw, az); chartCtx.stroke();
  // Border
  chartCtx.strokeStyle = '#1f1c18'; chartCtx.lineWidth = 2; chartCtx.strokeRect(1, 1, cw - 2, ch - 2);
  // Strokes
  chartCtx.strokeStyle = '#1f1c18'; chartCtx.lineWidth = 2; chartCtx.lineCap = 'round'; chartCtx.lineJoin = 'round';
  chart.strokes.forEach(s => {
    if (s.length < 2) return;
    chartCtx.beginPath(); chartCtx.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < s.length; i++) chartCtx.lineTo(s[i].x, s[i].y);
    chartCtx.stroke();
  });
  if (chart.currentStroke.length > 1) {
    chartCtx.beginPath(); chartCtx.moveTo(chart.currentStroke[0].x, chart.currentStroke[0].y);
    for (let i = 1; i < chart.currentStroke.length; i++) chartCtx.lineTo(chart.currentStroke[i].x, chart.currentStroke[i].y);
    chartCtx.stroke();
  }
  // Fixes
  chart.fixes.forEach(fx => {
    chartCtx.strokeStyle = 'rgba(180,40,30,0.85)'; chartCtx.lineWidth = 1.5;
    chartCtx.beginPath(); chartCtx.moveTo(fx.x - 8, fx.z - 8); chartCtx.lineTo(fx.x + 8, fx.z + 8);
    chartCtx.moveTo(fx.x + 8, fx.z - 8); chartCtx.lineTo(fx.x - 8, fx.z + 8); chartCtx.stroke();
  });
  // Landmarks
  landmarks.forEach(l => {
    const lx = (l.x + ext) / (2 * ext) * cw, lz = (l.z + ext) / (2 * ext) * ch;
    chartCtx.fillStyle = '#8a5a22'; chartCtx.font = '10px Georgia'; chartCtx.textAlign = 'center';
    chartCtx.fillText(l.name, lx, lz - 6);
    chartCtx.fillStyle = '#c08030'; chartCtx.beginPath(); chartCtx.arc(lx, lz, 3, 0, Math.PI * 2); chartCtx.fill();
  });
}

function doPublishChart() {
  chart.published = true;
  document.getElementById('publish-overlay').classList.add('visible');
  // Expedition summary
  document.getElementById('publish-stats').innerHTML =
    '<strong>Beacons placed:</strong> ' + beaconCount + '<br>' +
    '<strong>Fixes computed:</strong> ' + chart.fixes.length + '<br>' +
    '<strong>Chart strokes:</strong> ' + chart.strokes.length + '<br>' +
    '<strong>Terrain explored:</strong> ' + calcExplored() + '%';
  // Time summary
  if (state.startTime) {
    const elapsed = Math.round((Date.now() - state.startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    document.getElementById('publish-time').textContent =
      'Expedition duration: ' + min + 'm ' + sec + 's';
  }
  // Personal goal
  const goalEl = document.getElementById('publish-goal');
  if (state.personalGoal) {
    goalEl.style.display = 'block';
    goalEl.textContent = 'Your goal: ' + state.personalGoal;
  }
  setTimeout(() => { document.getElementById('published-text').classList.add('visible'); }, 500);
  scheduleSave();
}

function doExportChart() {
  const json = exportChart();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'atlaswright-chart.json'; a.click();
  URL.revokeObjectURL(url);
  setStatus('Chart exported. Share the file with someone!');
}

function doImportChart() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = importChart(reader.result);
      if (result.ok) {
        openChart();
        setStatus('Chart imported. View it on the chart overlay.');
      } else {
        setStatus('Import failed: ' + result.reason);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function resumeGame(data) {
  state.px = data.px; state.pz = data.pz; state.camAngle = data.camAngle;
  restoreState(data);
  // Rebuild fog around saved position
  revealFog(state.px, state.pz, 200);
  // Restore chart
  chart.strokes = data.chart.strokes || [];
  chart.fixes = data.chart.fixes || [];
  chart.published = data.chart.published || false;
  startGame();
}

// --- Rendering ---
function render() {
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
    const s = worldToScreen(gx, state.pz);
    ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, cH); ctx.stroke();
  }
  for (let gz = Math.floor((state.pz - FR / PPM) / GR) * GR; gz < state.pz + FR / PPM; gz += GR) {
    const s = worldToScreen(state.px, gz);
    ctx.beginPath(); ctx.moveTo(0, s.z); ctx.lineTo(cW, s.z); ctx.stroke();
  }
  // Landmarks
  landmarks.forEach(l => {
    const s = worldToScreen(l.x, l.z);
    if (s.x < -40 || s.x > cW + 40 || s.z < -40 || s.z > cH + 40) return;
    ctx.fillStyle = fogMap[l.z * WORLD + l.x] ? '#c08030' : '#5a4a30';
    ctx.beginPath(); ctx.moveTo(s.x, s.z - 16); ctx.lineTo(s.x - 8, s.z); ctx.lineTo(s.x + 8, s.z); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(s.x, s.z); ctx.lineTo(s.x - 12, s.z + 12); ctx.lineTo(s.x + 12, s.z + 12); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Georgia'; ctx.textAlign = 'center'; ctx.fillText(l.name, s.x, s.z - 20);
  });
  // Beacons
  beacons.forEach(b => {
    const s = worldToScreen(b.x, b.z);
    if (s.x < -20 || s.x > cW + 20 || s.z < -20 || s.z > cH + 20) return;
    ctx.fillStyle = '#e88a20'; ctx.fillRect(s.x - 3, s.z - 10, 6, 20);
    ctx.fillStyle = '#ff6600'; ctx.fillRect(s.x - 1, s.z - 14, 4, 6);
    ctx.fillStyle = '#fff'; ctx.font = '9px Georgia'; ctx.textAlign = 'center'; ctx.fillText(b.name, s.x, s.z - 18);
  });
  // Crosshair
  const target = findNearestTarget(state.px, state.pz, state.camAngle, bearings);
  const aligned = target && isAligned(state.px, state.pz, state.camAngle, bearings);
  ctx.strokeStyle = aligned ? 'rgba(255,180,0,0.9)' : 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  const cx = cW / 2, cy = cH / 2;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 4, cy);
  ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 4);
  ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 12);
  ctx.stroke();
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
  const ps = worldToScreen(state.px, state.pz);
  ctx.fillStyle = '#e8d8b0'; ctx.beginPath(); ctx.arc(ps.x, ps.z, 6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c08030'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ps.x, ps.z, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#ff6600'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ps.x, ps.z);
  ctx.lineTo(ps.x + Math.sin(state.camAngle) * 20, ps.z + Math.cos(state.camAngle) * 20); ctx.stroke();
  // Fix marker
  if (hasFix && lastFix) {
    const fs = worldToScreen(lastFix.x, lastFix.z);
    ctx.strokeStyle = '#ff3333'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(fs.x - 8, fs.z - 8); ctx.lineTo(fs.x + 8, fs.z + 8);
    ctx.moveTo(fs.x + 8, fs.z - 8); ctx.lineTo(fs.x - 8, fs.z + 8); ctx.stroke();
  }
  // Compass
  const deg = Math.round((state.camAngle * 180 / Math.PI + 360) % 360);
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  document.getElementById('compass').textContent = String(deg).padStart(3, '0') + ' deg ' + dirs[Math.round(deg / 45) % 8];
  // Minimap
  const mpx = Math.floor(state.px), mpz = Math.floor(state.pz);
  if (mpx !== _lastMinimapPx || mpz !== _lastMinimapPz) { _minimapDirty = true; _lastMinimapPx = mpx; _lastMinimapPz = mpz; }
  if (_minimapDirty) { renderMinimap(); _minimapDirty = false; }
}

function renderMinimap() {
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

// --- Update ---
function update(delta) {
  if (state.mode !== 0 || !state.started) return;
  if (!document.pointerLockElement) { state.pvelx = 0; return; }
  const speed = (state.keys['ShiftLeft'] || state.keys['ShiftRight']) ? 7 : 4;
  let mx = 0, mz = 0;
  if (state.keys['KeyW']) { mx += Math.sin(state.camAngle); mz += Math.cos(state.camAngle); }
  if (state.keys['KeyS']) { mx -= Math.sin(state.camAngle); mz -= Math.cos(state.camAngle); }
  if (state.keys['KeyA']) { mx += Math.cos(state.camAngle); mz -= Math.sin(state.camAngle); }
  if (state.keys['KeyD']) { mx -= Math.cos(state.camAngle); mz += Math.sin(state.camAngle); }
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len > 0) { mx /= len; mz /= len; }
  state.pvelx = mx * speed;
  state.pvely += 20 * delta;
  if (state.pvely > 15) state.pvely = 15;
  const nx = state.px + state.pvelx * delta;
  const nz = state.pz + state.pvely * delta;
  const nh = heightAt(nx, nz);
  const ph = heightAt(state.px, state.pz);
  if (nh <= 0) { state.pvely = 0; }
  else if (nh - ph < 2) { state.pz = nz; state.px = nx; state.onGround = Math.abs(nh - ph) < 0.5; }
  else { state.pvely = 0; }
  if (state.pvely === 0 && nh > 0) state.onGround = true;
  state.px = Math.max(1, Math.min(WORLD - 2, state.px));
  state.pz = Math.max(1, Math.min(WORLD - 2, state.pz));
  revealFog(state.px, state.pz, SR);
  _exploredTimer += delta;
  if (_exploredTimer >= 1) { _exploredTimer = 0; state.exploredPct = calcExplored(); scheduleSave(); }
}

// --- Game loop ---
function gameLoop(ts) {
  if (!state.lastTS) state.lastTS = ts;
  state.dt = Math.min((ts - state.lastTS) / 1000, 0.05);
  state.lastTS = ts;
  update(state.dt);
  if (state.mode === 0) render();
  requestAnimationFrame(gameLoop);
}

function startGame() {
  state.started = true;
  state.startTime = Date.now();
  // Capture personal goal from Atelier
  const goalInput = document.getElementById('personal-goal');
  state.personalGoal = goalInput ? goalInput.value.trim() : '';
  document.getElementById('start-overlay').classList.add('hidden');
  document.getElementById('world-canvas').requestPointerLock();
  const hint = document.getElementById('first-hint');
  if (hint) { hint.classList.add('visible'); setTimeout(() => hint.classList.remove('visible'), 6000); }
}

// --- Init ---
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('world-canvas');
  ctx = canvas.getContext('2d');
  minimapCanvas = document.getElementById('minimap');
  minimapCtx = minimapCanvas.getContext('2d');
  chartCanvas = document.getElementById('chart-canvas');
  chartCtx = chartCanvas.getContext('2d');

  // Resize
  function resize() {
    const w = window.innerWidth || 960, h = window.innerHeight || 640;
    canvas.width = w; canvas.height = h; cW = w; cH = h;
  }
  resize();
  window.addEventListener('resize', resize);

  initNoise(1337);
  buildTerrain();
  assignLandmarkHeights();
  initInput();

  // Spawn on dry ground
  state.px = WORLD / 2; state.pz = WORLD / 2;
  let h = heightAt(state.px, state.pz);
  while (h <= 1 && state.px < WORLD - 10) { state.px += 5; h = heightAt(state.px, state.pz); }
  revealFog(state.px, state.pz, SR);
  render();
  requestAnimationFrame(gameLoop);
});
