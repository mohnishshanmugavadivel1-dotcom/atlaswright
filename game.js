// game.js — orchestrator: state, input, persistence, game loop
import { initNoise } from './noise.js';
import {
  WORLD, SR, PPM, MB, ALG,
  heightAt, buildTerrain, assignLandmarkHeights,
  revealFog, calcExplored,
  beacons, beaconCount, bearings, lastFix, hasFix,
  placeBeacon as placeBeaconLogic, takeBearing as takeBearingLogic, restoreState,
} from './world.js';
import { initAudio, playBeaconSound, playBearingSound, toggleAudio } from './audio.js';
import {
  chart, initChart, drawChart, openChart, closeChart,
  doPlotFix as chartPlotFix, doUndoStroke as chartUndoStroke,
  doPublishChart as chartPublish, exportChartJSON, importChartJSON,
  initChartInput,
} from './chart.js';
import { initRender, render as renderFrame } from './render.js';

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
  if (state.mode === 0) renderFrame(state);
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

// --- Init ---
window.addEventListener('DOMContentLoaded', () => {
  initRender(document.getElementById('world-canvas'), document.getElementById('minimap'));
  initChart(document.getElementById('chart-canvas'));

  initNoise(1337);
  buildTerrain(1337);
  assignLandmarkHeights();
  initInput();

  // Spawn on dry ground
  state.px = WORLD / 2; state.pz = WORLD / 2;
  let h = heightAt(state.px, state.pz);
  while (h <= 1 && state.px < WORLD - 10) { state.px += 5; h = heightAt(state.px, state.pz); }
  revealFog(state.px, state.pz, SR);
  renderFrame(state);
  requestAnimationFrame(gameLoop);
});
