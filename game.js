// game.js — orchestrator: state, input, rendering, persistence, game loop
import { initNoise } from './noise.js';
import {
  WORLD, SR, FR, GR, PPM, MB, ALG,
  heightAt, buildTerrain, assignLandmarkHeights,
  revealFog, calcExplored, fogVersion, colorMap, fogMap,
  beacons, beaconCount, bearings, lastFix, hasFix,
  landmarks, findNearestTarget, isAligned,
  placeBeacon as placeBeaconLogic, takeBearing as takeBearingLogic, resetWorld, restoreState,
} from './world.js';
import { initAudio, playBeaconSound, playBearingSound, playPublishSound, toggleAudio } from './audio.js';
import {
  chart, initChart, drawChart, openChart, closeChart,
  doPlotFix as chartPlotFix, doUndoStroke as chartUndoStroke,
  doPublishChart as chartPublish, exportChartJSON, importChartJSON,
  initChartInput,
} from './chart.js';

// --- State ---
const state = {
  mode: 0, started: false,
  px: 512, pz: 512, pvelx: 0, pvely: 0,
  camAngle: 0, dt: 0, lastTS: 0,
  keys: {}, mouseDown: false, lastMX: 0, lastMY: 0, pointerLocked: false,
  onGround: false, exploredPct: 0,
  startTime: 0, personalGoal: '', seed: 1337,
};

// --- DOM refs ---
let canvas, ctx, cW, cH;
let minimapCanvas, minimapCtx;
let _minimapDirty = true, _lastMinimapPx = -1, _lastMinimapPz = -1;
let _terrainCache = null, _terrainCacheKey = '';
let _exploredTimer = 0;



// --- Persistence ---
const SAVE_KEY = 'atlaswright-save';

function saveGame() {
  const data = {
    v: EXPORT_VERSION,
    seed: state.seed,
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
    if (data.v !== 1 && data.v !== EXPORT_VERSION) return null;
    if (!data.seed) data.seed = 1337; // v1 saves lacked seed
    return data;
  } catch (e) { return null; }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
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
    if (e.code === 'KeyF' && state.mode === 0 && hasFix) chartPlotFix(setStatus, scheduleSave);
    if (e.code === 'KeyZ' && state.mode === 1) chartUndoStroke(setStatus);
    if (e.code === 'Escape' && state.mode === 1) closeChart(m => state.mode = m, setStatus);
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
    else if (state.mouseDown || (window.matchMedia && window.matchMedia('(pointer:coarse)').matches)) {
      state.camAngle += (e.clientX - state.lastMX) * 0.003; state.lastMX = e.clientX; state.lastMY = e.clientY;
    }
  });
  document.addEventListener('pointerlockchange', () => { state.pointerLocked = !!document.pointerLockElement; });
  document.addEventListener('mouseup', e => {
    if (e.button === 0 && state.mode === 0 && state.started) { state.mouseDown = false; doPlaceBeacon(); }
  });
  // Chart canvas drawing (delegated to chart.js)
  initChartInput(state);
  // Touch support
  let touchStartX = 0, touchStartY = 0;
  document.addEventListener('touchstart', e => {
    if (!state.started || state.mode !== 0) return;
    const t = e.touches[0];
    touchStartX = t.clientX; touchStartY = t.clientY;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!state.started || state.mode !== 0) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStartX;
    state.camAngle += dx * 0.005;
    touchStartX = t.clientX; touchStartY = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!state.started || state.mode !== 0) return;
    // Tap = beacon placement
    doPlaceBeacon();
  });
  // Virtual joystick for mobile
  const joyEl = document.getElementById('joystick');
  if (joyEl) {
    let joyActive = false, joyX = 0, joyY = 0;
    const joyKnob = document.getElementById('joystick-knob');
    joyEl.addEventListener('touchstart', e => { e.preventDefault(); joyActive = true; });
    document.addEventListener('touchmove', e => {
      if (!joyActive) return;
      const t = e.touches[0];
      const rect = joyEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      joyX = Math.max(-1, Math.min(1, (t.clientX - cx) / (rect.width / 2)));
      joyY = Math.max(-1, Math.min(1, (t.clientY - cy) / (rect.height / 2)));
      if (joyKnob) {
        joyKnob.style.transform = `translate(${joyX * 20}px, ${joyY * 20}px)`;
      }
      // Map joystick to WASD keys
      state.keys['KeyW'] = joyY < -0.3;
      state.keys['KeyS'] = joyY > 0.3;
      state.keys['KeyA'] = joyX < -0.3;
      state.keys['KeyD'] = joyX > 0.3;
    }, { passive: true });
    document.addEventListener('touchend', () => {
      joyActive = false; joyX = 0; joyY = 0;
      if (joyKnob) joyKnob.style.transform = '';
      state.keys['KeyW'] = false; state.keys['KeyS'] = false;
      state.keys['KeyA'] = false; state.keys['KeyD'] = false;
    });
  }
  // Button bindings
  document.getElementById('btn-undo').onclick = () => chartUndoStroke(setStatus);
  document.getElementById('btn-stamp').onclick = () => chartPlotFix(setStatus, scheduleSave);
  document.getElementById('btn-publish').onclick = () => chartPublish(state, setStatus, scheduleSave);
  document.getElementById('btn-export').onclick = doExportChart;
  document.getElementById('btn-import').onclick = doImportChart;
  document.getElementById('btn-export-published').onclick = doExportChart;
  document.getElementById('btn-start').onclick = () => { initAudio(); startGame(); };
  document.getElementById('btn-new-session').onclick = () => { clearSave(); location.reload(); };
  document.getElementById('btn-audio').onclick = toggleAudio;
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
  if (r.ok) { scheduleSave(); playBeaconSound(); }
}

function doTakeBearing() {
  const r = takeBearingLogic(state.px, state.pz, state.camAngle);
  if (!r.ok) { setStatus(r.reason); return; }
  setStatus('Bearing recorded: ' + r.bearing + ' at ' + r.degrees + '°. Take a second bearing to fix your position.');
  scheduleSave();
  playBearingSound();
  if (r.fix) {
    setStatus('Position fixed! Error: ' + r.fix.err.toFixed(1) + 'm. Press F to plot on your chart, or TAB to open it.');
    const fi = document.getElementById('fix-info');
    fi.style.display = 'block';
    fi.textContent = 'Fix: (' + Math.round(r.fix.x) + ', ' + Math.round(r.fix.z) + ') err: ' + r.fix.err.toFixed(1) + 'm';
  }
}

function doPlotFix() {
  chartPlotFix(setStatus, scheduleSave);
}

function doUndoStroke() {
  chartUndoStroke(setStatus);
}

function toggleChart() { state.mode === 1 ? closeChart(m => state.mode = m, setStatus) : openChart(m => state.mode = m, setStatus); }

function doPublishChart() {
  chartPublish(state, setStatus, scheduleSave);
}

function doExportChart() {
  const json = exportChartJSON(state);
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
      const result = importChartJSON(reader.result, state);
      if (result.ok) {
        openChart(m => state.mode = m, setStatus);
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
  state.seed = data.seed || 1337;
  // Rebuild terrain with saved seed
  initNoise(state.seed);
  buildTerrain(state.seed);
  assignLandmarkHeights();
  state.px = data.px; state.pz = data.pz; state.camAngle = data.camAngle;
  restoreState(data);
  revealFog(state.px, state.pz, 200);
  chart.strokes = data.chart.strokes || [];
  chart.fixes = data.chart.fixes || [];
  chart.published = data.chart.published || false;
  // Start without re-reading the dropdown (terrain already built)
  state.started = true;
  state.startTime = Date.now();
  document.getElementById('start-overlay').classList.add('hidden');
  if (window.matchMedia && !window.matchMedia('(pointer:coarse)').matches) {
    document.getElementById('world-canvas').requestPointerLock();
  }
  const hint = document.getElementById('first-hint');
  if (hint) { hint.classList.add('visible'); setTimeout(() => hint.classList.remove('visible'), 6000); }
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
  // Crosshair — shape changes when aligned (non-color cue for colorblind)
  const target = findNearestTarget(state.px, state.pz, state.camAngle, bearings);
  const aligned = target && isAligned(state.px, state.pz, state.camAngle, bearings);
  const cx = cW / 2, cy = cH / 2;
  if (aligned) {
    // Aligned: circle + thicker lines + pulse effect
    const pulse = 1 + Math.sin(Date.now() * 0.008) * 0.15;
    ctx.strokeStyle = 'rgba(255,180,0,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, 16 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    // Crosshair lines extend beyond circle
    ctx.beginPath();
    ctx.moveTo(cx - 22, cy); ctx.lineTo(cx - 18, cy);
    ctx.moveTo(cx + 18, cy); ctx.lineTo(cx + 22, cy);
    ctx.moveTo(cx, cy - 22); ctx.lineTo(cx, cy - 18);
    ctx.moveTo(cx, cy + 18); ctx.lineTo(cx, cy + 22);
    ctx.stroke();
  } else {
    // Not aligned: simple cross
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
  const isTouch = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
  if (!isTouch && !document.pointerLockElement) { state.pvelx = 0; return; }
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
  // Capture region and personal goal from Atelier
  const regionSelect = document.getElementById('region-select');
  const regionSeed = regionSelect ? parseInt(regionSelect.value) : 1337;
  state.seed = regionSeed;
  const goalInput = document.getElementById('personal-goal');
  state.personalGoal = goalInput ? goalInput.value.trim() : '';
  // Build terrain with selected seed
  initNoise(regionSeed);
  buildTerrain(regionSeed);
  assignLandmarkHeights();
  // Spawn on dry ground
  state.px = WORLD / 2; state.pz = WORLD / 2;
  let h = heightAt(state.px, state.pz);
  while (h <= 1 && state.px < WORLD - 10) { state.px += 5; h = heightAt(state.px, state.pz); }
  revealFog(state.px, state.pz, SR);
  document.getElementById('start-overlay').classList.add('hidden');
  // Pointer lock only on desktop (not touch devices)
  if (window.matchMedia && !window.matchMedia('(pointer:coarse)').matches) {
    document.getElementById('world-canvas').requestPointerLock();
  }
  const hint = document.getElementById('first-hint');
  if (hint) { hint.classList.add('visible'); setTimeout(() => hint.classList.remove('visible'), 6000); }
  // Mobile button handlers
  const mobileBearing = document.getElementById('btn-mobile-bearing');
  if (mobileBearing) mobileBearing.onclick = doTakeBearing;
  const mobileChart = document.getElementById('btn-mobile-chart');
  if (mobileChart) mobileChart.onclick = () => toggleChart();
}

// --- Audio ---
// --- Init ---
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('world-canvas');
  ctx = canvas.getContext('2d');
  minimapCanvas = document.getElementById('minimap');
  minimapCtx = minimapCanvas.getContext('2d');
  initChart(document.getElementById('chart-canvas'));

  // Resize
  function resize() {
    const w = window.innerWidth || 960, h = window.innerHeight || 640;
    canvas.width = w; canvas.height = h; cW = w; cH = h;
  }
  resize();
  window.addEventListener('resize', resize);

  initNoise(1337);
  buildTerrain(1337);
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
