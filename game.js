// game.js — orchestrator: state, input, persistence, game loop
const EXPORT_VERSION = 2;

import { initNoise } from './noise.js';
import {
  WORLD, SR, PPM, MB, ALG,
  heightAt, buildTerrain, assignLandmarkHeights,
  revealFog, calcExplored,
  beacons, beaconCount, bearings, lastFix, hasFix,
  placeBeacon as placeBeaconLogic, takeBearing as takeBearingLogic, restoreState,
} from './world.js';
import { initAudio, playBeaconSound, playBearingSound, playPublishSound, toggleAudio } from './audio.js';
import {
  chart, initChart, drawChart, openChart, closeChart,
  doPlotFix as chartPlotFix, doUndoStroke as chartUndoStroke,
  doPublishChart as chartPublish, exportChartJSON, importChartJSON,
  initChartInput,
} from './chart.js';
import { initRender, render as renderFrame } from './render.js';

// --- State ---
const state = {
  mode: 0, started: false, countdown: 0,
  px: 512, pz: 512, pvelx: 0, velZ: 0, pvely: 0,
  camAngle: 0, dt: 0, lastTS: 0,
  keys: {}, mouseDown: false, lastMX: 0, lastMY: 0, pointerLocked: false,
  onGround: false, exploredPct: 0,
  startTime: 0, personalGoal: '', seed: 1337,
};

let _exploredTimer = 0;
let stamina = 100;
let bobPhase = 0;
let firstMoveTime = 0;
let confetti = [];

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
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.v !== 1 && data.v !== EXPORT_VERSION) return null;
    if (!data.seed) data.seed = 1337;
    return data;
  } catch (e) { return null; }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}

let _autoSaveTimer = null;
function scheduleSave() {
  if (_autoSaveTimer) return;
  _autoSaveTimer = setTimeout(() => { _autoSaveTimer = null; saveGame(); }, 500);
}

// --- Toast system ---
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
}

function setStatus(s) {
  document.getElementById('status-bar').textContent = s;
}

// --- Movement flash ---
function showMoveFlash() {
  if (firstMoveTime) return;
  firstMoveTime = Date.now();
  const el = document.getElementById('move-flash');
  if (el) { el.classList.add('visible'); setTimeout(() => el.classList.remove('visible'), 3000); }
}

// --- Confetti ---
function spawnConfetti() {
  confetti = [];
  for (let i = 0; i < 80; i++) {
    confetti.push({
      x: Math.random() * window.innerWidth,
      y: -20 - Math.random() * 200,
      vx: (Math.random() - 0.5) * 3,
      vy: 1 + Math.random() * 3,
      size: 4 + Math.random() * 6,
      color: Math.random() > 0.5 ? '#c08030' : '#e8a840',
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.1,
      life: 200 + Math.random() * 200,
    });
  }
}

function drawConfetti(ctx2d) {
  if (confetti.length === 0) return;
  confetti = confetti.filter(p => {
    p.x += p.vx; p.y += p.vy; p.rot += p.rotSpeed; p.life--;
    if (p.life <= 0 || p.y > window.innerHeight + 20) return false;
    ctx2d.save();
    ctx2d.translate(p.x, p.y);
    ctx2d.rotate(p.rot);
    ctx2d.fillStyle = p.color;
    ctx2d.globalAlpha = Math.min(1, p.life / 50);
    ctx2d.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    ctx2d.restore();
    return true;
  });
}

// --- Input ---
function initInput() {
  const cc = document.getElementById('world-canvas');
  let touchStartTime = 0;
  let lastTouchX = 0, lastTouchY = 0;

  document.addEventListener('keydown', e => {
    if (!state.started || state.countdown > 0) return;
    state.keys[e.code] = true;
    if (e.code === 'Tab') { e.preventDefault(); toggleChart(); }
    if (e.code === 'KeyE' && state.mode === 0) doTakeBearing();
    if (e.code === 'KeyF' && state.mode === 0 && hasFix) chartPlotFix(setStatus, scheduleSave);
    if (e.code === 'KeyZ' && state.mode === 1) chartUndoStroke(setStatus);
    if (e.code === 'Escape' && state.mode === 1) closeChart(m => state.mode = m, setStatus);
    if (e.code === 'Space' && state.mode === 0) {
      e.preventDefault();
      if (state.onGround) { state.pvely = -12; state.onGround = false; }
    }
  });
  document.addEventListener('keyup', e => { state.keys[e.code] = false; });

  // Mouse: click to lock, then drag to look
  cc.addEventListener('mousedown', e => {
    if (!state.started || state.mode !== 0) return;
    state.lastMX = e.clientX; state.lastMY = e.clientY;
    if (!state.pointerLocked) {
      cc.requestPointerLock();
      document.getElementById('click-to-play').classList.add('hidden');
      return;
    }
    state.mouseDown = true;
  });
  document.addEventListener('mousemove', e => {
    if (state.pointerLocked) {
      state.camAngle += e.movementX * 0.003;
    } else if (state.mouseDown) {
      state.camAngle += (e.clientX - state.lastMX) * 0.003;
      state.lastMX = e.clientX; state.lastMY = e.clientY;
    }
  });
  document.addEventListener('pointerlockchange', () => {
    state.pointerLocked = !!document.pointerLockElement;
    if (state.pointerLocked) document.getElementById('click-to-play').classList.add('hidden');
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0 && state.mode === 0 && state.started && state.pointerLocked) {
      state.mouseDown = false;
      doPlaceBeacon();
    }
  });

  // Touch support
  cc.addEventListener('touchstart', e => {
    if (!state.started || state.mode !== 0 || state.countdown > 0) return;
    const t = e.touches[0];
    lastTouchX = t.clientX; lastTouchY = t.clientY;
    touchStartTime = Date.now();
  }, { passive: true });
  cc.addEventListener('touchmove', e => {
    if (!state.started || state.mode !== 0) return;
    const t = e.touches[0];
    const dx = t.clientX - lastTouchX;
    state.camAngle += dx * 0.005;
    lastTouchX = t.clientX; lastTouchY = t.clientY;
  }, { passive: true });
  cc.addEventListener('touchend', e => {
    if (!state.started || state.mode !== 0) return;
    // Double-tap = beacon placement
    const elapsed = Date.now() - touchStartTime;
    if (elapsed < 200) {
      // Quick tap — check if not on UI elements
      const joyEl = document.getElementById('joystick');
      if (joyEl && joyEl.contains(e.target)) return;
      doPlaceBeacon();
    }
  });

  // Virtual joystick
  const joyEl = document.getElementById('joystick');
  if (joyEl) {
    let joyActive = false;
    const joyKnob = document.getElementById('joystick-knob');
    joyEl.addEventListener('touchstart', e => { e.preventDefault(); joyActive = true; });
    document.addEventListener('touchmove', e => {
      if (!joyActive) return;
      const t = e.touches[0];
      const rect = joyEl.getBoundingClientRect();
      const jcx = rect.left + rect.width / 2, jcy = rect.top + rect.height / 2;
      const jx = Math.max(-1, Math.min(1, (t.clientX - jcx) / (rect.width / 2)));
      const jy = Math.max(-1, Math.min(1, (t.clientY - jcy) / (rect.height / 2)));
      if (joyKnob) joyKnob.style.transform = `translate(${jx * 20}px, ${jy * 20}px)`;
      state.keys['KeyW'] = jy < -0.3;
      state.keys['KeyS'] = jy > 0.3;
      state.keys['KeyA'] = jx < -0.3;
      state.keys['KeyD'] = jx > 0.3;
    }, { passive: true });
    document.addEventListener('touchend', () => {
      joyActive = false;
      if (joyKnob) joyKnob.style.transform = '';
      state.keys['KeyW'] = false; state.keys['KeyS'] = false;
      state.keys['KeyA'] = false; state.keys['KeyD'] = false;
    });
  }

  // Button bindings
  document.getElementById('btn-undo').onclick = () => chartUndoStroke(setStatus);
  document.getElementById('btn-stamp').onclick = () => chartPlotFix(setStatus, scheduleSave);
  document.getElementById('btn-publish').onclick = () => {
    chartPublish(state, setStatus, scheduleSave);
    spawnConfetti();
  };
  document.getElementById('btn-export').onclick = doExportChart;
  document.getElementById('btn-import').onclick = doImportChart;
  document.getElementById('btn-export-published').onclick = doExportChart;
  document.getElementById('btn-start').onclick = () => { initAudio(); startCountdown(); };
  document.getElementById('btn-new-session').onclick = () => { clearSave(); location.reload(); };
  document.getElementById('btn-audio').onclick = toggleAudio;

  // Mobile buttons
  const mobileBearing = document.getElementById('btn-mobile-bearing');
  if (mobileBearing) mobileBearing.onclick = doTakeBearing;
  const mobileChart = document.getElementById('btn-mobile-chart');
  if (mobileChart) mobileChart.onclick = () => toggleChart();

  // Resume prompt
  const saved = loadGame();
  if (saved && saved.beacons && saved.beacons.length > 0) {
    document.getElementById('resume-prompt').style.display = 'block';
    document.getElementById('btn-resume').onclick = () => resumeGame(saved);
    document.getElementById('btn-fresh').onclick = () => { clearSave(); startCountdown(); };
  }
}

// --- Game actions ---
function doPlaceBeacon() {
  const r = placeBeaconLogic(state.px, state.pz, state.camAngle);
  if (r.ok) {
    showToast(r.name + ' planted');
    playBeaconSound();
    scheduleSave();
  } else {
    showToast(r.reason);
  }
  document.getElementById('beacon-count').textContent = 'Beacons: ' + beaconCount + '/' + MB;
}

function doTakeBearing() {
  const r = takeBearingLogic(state.px, state.pz, state.camAngle);
  if (!r.ok) { showToast(r.reason); return; }
  showToast('Bearing: ' + r.bearing + ' at ' + r.degrees + '°');
  playBearingSound();
  scheduleSave();
  if (r.fix) {
    showToast('Position fixed! Error: ' + r.fix.err.toFixed(1) + 'm');
    const fi = document.getElementById('fix-info');
    fi.style.display = 'block';
    fi.textContent = 'Fix: (' + Math.round(r.fix.x) + ', ' + Math.round(r.fix.z) + ') err: ' + r.fix.err.toFixed(1) + 'm';
  }
}

function toggleChart() {
  state.mode === 1 ? closeChart(m => state.mode = m, setStatus) : openChart(m => state.mode = m, setStatus);
}

function doExportChart() {
  const json = exportChartJSON(state);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'atlaswright-chart.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('Chart exported');
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
        showToast('Chart imported');
      } else {
        showToast('Import failed: ' + result.reason);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function resumeGame(data) {
  state.seed = data.seed || 1337;
  initNoise(state.seed);
  buildTerrain(state.seed);
  assignLandmarkHeights();
  state.px = data.px; state.pz = data.pz; state.camAngle = data.camAngle;
  restoreState(data);
  revealFog(state.px, state.pz, 200);
  chart.strokes = data.chart.strokes || [];
  chart.fixes = data.chart.fixes || [];
  chart.published = data.chart.published || false;
  launchGame();
}

// --- Countdown ---
function startCountdown() {
  state.countdown = 3;
  document.getElementById('start-overlay').classList.add('hidden');
  const countEl = document.getElementById('countdown');
  countEl.classList.add('visible');
  countEl.textContent = '3';
  const tick = () => {
    state.countdown--;
    if (state.countdown > 0) {
      countEl.textContent = String(state.countdown);
      setTimeout(tick, 800);
    } else {
      countEl.textContent = 'GO!';
      setTimeout(() => { countEl.classList.remove('visible'); launchGame(); }, 600);
    }
  };
  setTimeout(tick, 800);
}

function launchGame() {
  state.started = true;
  state.startTime = Date.now();
  const regionSelect = document.getElementById('region-select');
  const regionSeed = regionSelect ? parseInt(regionSelect.value) : 1337;
  state.seed = regionSeed;
  const goalInput = document.getElementById('personal-goal');
  state.personalGoal = goalInput ? goalInput.value.trim() : '';
  initNoise(regionSeed);
  buildTerrain(regionSeed);
  assignLandmarkHeights();
  state.px = WORLD / 2; state.pz = WORLD / 2;
  let h = heightAt(state.px, state.pz);
  while (h <= 1 && state.px < WORLD - 10) { state.px += 5; h = heightAt(state.px, state.pz); }
  revealFog(state.px, state.pz, SR);
  document.getElementById('click-to-play').classList.remove('hidden');
  if (window.matchMedia && !window.matchMedia('(pointer:coarse)').matches) {
    document.getElementById('world-canvas').requestPointerLock();
  }
  const hint = document.getElementById('first-hint');
  if (hint) { hint.classList.add('visible'); setTimeout(() => hint.classList.remove('visible'), 6000); }
}

// --- Update ---
function update(delta) {
  if (state.mode !== 0 || !state.started || state.countdown > 0) return;

  const isTouch = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
  const hasKeyboard = Object.values(state.keys).some(v => v);

  // Allow movement without pointer lock if keyboard is used (fallback)
  if (!isTouch && !state.pointerLocked && !hasKeyboard) { state.pvelx = 0; state.velZ = 0; return; }

  const sprinting = (state.keys['ShiftLeft'] || state.keys['ShiftRight']) && stamina > 0;
  const speed = sprinting ? 7 : 4;

  // Sprint stamina
  if (sprinting && (state.keys['KeyW'] || state.keys['KeyS'] || state.keys['KeyA'] || state.keys['KeyD'])) {
    stamina = Math.max(0, stamina - 30 * delta);
  } else {
    stamina = Math.min(100, stamina + 15 * delta);
  }

  let mx = 0, mz = 0;
  if (state.keys['KeyW']) { mx += Math.sin(state.camAngle); mz += Math.cos(state.camAngle); }
  if (state.keys['KeyS']) { mx -= Math.sin(state.camAngle); mz -= Math.cos(state.camAngle); }
  if (state.keys['KeyA']) { mx += Math.cos(state.camAngle); mz -= Math.sin(state.camAngle); }
  if (state.keys['KeyD']) { mx -= Math.cos(state.camAngle); mz += Math.sin(state.camAngle); }
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len > 0) { mx /= len; mz /= len; showMoveFlash(); }

  state.pvelx = mx * speed;
  state.velZ = mz * speed;

  // Gravity (separate from walking)
  state.pvely += 20 * delta;
  if (state.pvely > 15) state.pvely = 15;

  // Move X
  const nx = state.px + state.pvelx * delta;
  const nhx = heightAt(nx, state.pz);
  const phx = heightAt(state.px, state.pz);
  if (nhx > 0 && nhx - phx < 4) { state.px = nx; }
  else if (nhx > 0 && nhx - phx >= 4) { /* blocked by steep slope */ }

  // Move Z (walking direction, separate from gravity)
  const nz = state.pz + state.velZ * delta;
  const nhz = heightAt(state.px, nz);
  const phz = heightAt(state.px, state.pz);
  if (nhz > 0 && nhz - phz < 4) { state.pz = nz; }

  // Vertical movement (jump/gravity)
  const ny = state.pz; // for now, vertical is ground-only
  const nh = heightAt(state.px, state.pz);
  if (nh <= 0) { state.pvely = 0; }
  else if (state.pvely < 0 && heightAt(state.px, state.pz) > 0) {
    // Jumping up — allow
  }
  state.onGround = nh > 0;

  state.px = Math.max(1, Math.min(WORLD - 2, state.px));
  state.pz = Math.max(1, Math.min(WORLD - 2, state.pz));

  revealFog(state.px, state.pz, SR);

  // Camera bob when walking
  if (len > 0) {
    bobPhase += delta * 8;
  } else {
    bobPhase *= 0.9; // ease out
  }

  _exploredTimer += delta;
  if (_exploredTimer >= 1) { _exploredTimer = 0; state.exploredPct = calcExplored(); scheduleSave(); }
}

// --- Game loop ---
function gameLoop(ts) {
  try {
    if (!state.lastTS) state.lastTS = ts;
    state.dt = Math.min((ts - state.lastTS) / 1000, 0.05);
    state.lastTS = ts;
    update(state.dt);
    if (state.mode === 0 && state.started) {
      const bobOffset = Math.sin(bobPhase) * 2;
      renderFrame(state, stamina, bobOffset);
    }
    // Confetti overlay
    if (confetti.length > 0) {
      const c = document.getElementById('world-canvas');
      if (c) drawConfetti(c.getContext('2d'));
    }
  } catch (e) {
    console.error('Game loop error:', e);
  }
  requestAnimationFrame(gameLoop);
}

// --- Init ---
window.addEventListener('DOMContentLoaded', () => {
  try {
    const worldCanvas = document.getElementById('world-canvas');
    const minimapEl = document.getElementById('minimap');
    initRender(worldCanvas, minimapEl);
    initChart(document.getElementById('chart-canvas'));
    initInput();
    initNoise(1337);
    buildTerrain(1337);
    assignLandmarkHeights();
    state.px = WORLD / 2; state.pz = WORLD / 2;
    let h = heightAt(state.px, state.pz);
    while (h <= 1 && state.px < WORLD - 10) { state.px += 5; h = heightAt(state.px, state.pz); }
    revealFog(state.px, state.pz, SR);
    renderFrame(state, 100, 0);
    requestAnimationFrame(gameLoop);
  } catch (e) {
    console.error('ATLASWRIGHT init failed:', e);
  }
});
