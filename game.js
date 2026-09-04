// game.js — orchestrator: state, input, persistence, game loop
const EXPORT_VERSION = 2;

import { initNoise } from './noise.js';
import {
  WORLD, SR, MB, ALG,
  heightAt, buildTerrain, assignLandmarkHeights,
  revealFog, calcExplored,
  beacons, beaconCount, bearings, lastFix, hasFix,
  placeBeacon as placeBeaconLogic, takeBearing as takeBearingLogic, restoreState,
  aimInfo, nearestUnrecordedTarget,
} from './world.js';
import { initAudio, playBeaconSound, playBearingSound, playPublishSound, toggleAudio, playFootstepSound } from './audio.js';
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
  px: 512, pz: 512, pvelx: 0, velZ: 0, pvely: 0, py: 0,
  camAngle: 0, dt: 0, lastTS: 0,
  keys: {}, mouseDown: false, lastMX: 0, lastMY: 0, pointerLocked: false,
  onGround: false, exploredPct: 0,
  moving: false, moved: false, blocked: false, blockedReason: '',
  lastRevealX: -1, lastRevealZ: -1, justLocked: false,
  startTime: 0, personalGoal: '', seed: 1337,
};

let _exploredTimer = 0;
let stamina = 100;
let bobPhase = 0;
let stepAcc = 0;
let dragDist = 0;
let blockedElapsed = 0;
let _hudTimer = 0;
let _lastStatus = '';
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

// Transient chart actions also toast, so their feedback survives the
// phase-driven status line that updateHud() owns.
function setStatusWithToast(s) { setStatus(s); showToast(s); }

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
    // Any key dismisses the click-to-play overlay so keyboard-only play works
    const ctp = document.getElementById('click-to-play');
    if (ctp && !ctp.classList.contains('hidden')) ctp.classList.add('hidden');
    state.keys[e.code] = true;
    if (e.code === 'Tab') { e.preventDefault(); toggleChart(); }
    if (e.code === 'KeyE' && state.mode === 0) doTakeBearing();
    if (e.code === 'KeyF' && state.mode === 0 && hasFix) chartPlotFix(setStatusWithToast, scheduleSave);
    if (e.code === 'KeyZ' && state.mode === 1) chartUndoStroke(setStatusWithToast);
    if (e.code === 'Escape' && state.mode === 1) closeChart(m => state.mode = m, setStatusWithToast);
    if (e.code === 'Space' && state.mode === 0) {
      e.preventDefault();
      if (state.onGround) { state.pvely = -8.5; state.onGround = false; }
    }
  });
  document.addEventListener('keyup', e => { state.keys[e.code] = false; });

  // Mouse: click acquires pointer lock (best effort), then drag looks around.
  // A short click that isn't a look-drag plants a beacon.
  cc.addEventListener('mousedown', e => {
    if (!state.started || state.mode !== 0) return;
    state.lastMX = e.clientX; state.lastMY = e.clientY;
    state.mouseDown = true;
    dragDist = 0;
    state.justLocked = !state.pointerLocked;
    if (!state.pointerLocked) {
      // Best-effort pointer lock. If it fails (sandboxed iframe, denied
      // permission), this click is a normal click so beacons still plant.
      try {
        const p = cc.requestPointerLock();
        if (p && p.catch) p.catch(() => { state.justLocked = false; });
      } catch (err) { state.justLocked = false; }
    }
  });
  document.addEventListener('pointerlockerror', () => { state.justLocked = false; });
  document.addEventListener('mousemove', e => {
    if (state.pointerLocked) {
      state.camAngle += e.movementX * 0.003;
    } else if (state.mouseDown) {
      const dx = e.clientX - state.lastMX, dy = e.clientY - state.lastMY;
      state.camAngle += dx * 0.003;
      dragDist += Math.abs(dx) + Math.abs(dy);
      state.lastMX = e.clientX; state.lastMY = e.clientY;
    }
  });
  document.addEventListener('pointerlockchange', () => {
    state.pointerLocked = !!document.pointerLockElement;
    if (state.pointerLocked) document.getElementById('click-to-play').classList.add('hidden');
  });
  document.addEventListener('mouseup', e => {
    if (e.button !== 0 || state.mode !== 0 || !state.started) return;
    state.mouseDown = false;
    const wasDrag = dragDist > 8;
    const wasLockRequest = state.justLocked;
    dragDist = 0;
    state.justLocked = false;
    if (!wasLockRequest && !wasDrag) doPlaceBeacon();
  });

  // CLICK TO PLAY: the overlay must dismiss itself — an auto requestPointerLock
  // outside a user gesture is rejected, which previously deadlocked the game.
  const ctpEl = document.getElementById('click-to-play');
  if (ctpEl) ctpEl.addEventListener('click', () => {
    ctpEl.classList.add('hidden');
    if (!window.matchMedia || !window.matchMedia('(pointer:coarse)').matches) {
      try { const p = cc.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) {}
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
  document.getElementById('btn-undo').onclick = () => chartUndoStroke(setStatusWithToast);
  document.getElementById('btn-stamp').onclick = () => chartPlotFix(setStatusWithToast, scheduleSave);
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
    showToast(r.name + ' planted — it marks your route.');
    playBeaconSound();
    scheduleSave();
  } else {
    showToast(r.reason);
  }
  document.getElementById('beacon-count').textContent = 'Beacons: ' + beaconCount + '/' + MB;
  updateHud();
}

function doTakeBearing() {
  const r = takeBearingLogic(state.px, state.pz, state.camAngle);
  if (!r.ok) { showToast(r.reason); updateHud(); return; }
  playBearingSound();
  scheduleSave();
  if (r.fix) {
    showToast('Recorded ' + r.degrees + '° to ' + r.bearing + '. Position located — press F to plot it on the chart.');
    const fi = document.getElementById('fix-info');
    fi.style.display = 'block';
    fi.textContent = 'Fix: (' + Math.round(r.fix.x) + ', ' + Math.round(r.fix.z) + ') err: ' + r.fix.err.toFixed(1) + 'm';
  } else {
    const n = bearings.length;
    showToast('Recorded direction to ' + r.bearing + ' — ' + r.degrees + '°' + (n === 1 ? '. Find a different marker and record a second.' : ' (' + n + ' recorded).'));
  }
  updateHud();
}

function toggleChart() {
  state.mode === 1 ? closeChart(m => state.mode = m, setStatusWithToast) : openChart(m => state.mode = m, setStatusWithToast);
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
  revealFog(state.px, state.pz, SR);
  state.lastRevealX = state.px; state.lastRevealZ = state.pz;
  state.py = 0; state.moved = true;
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
  state.py = 0; state.moved = false; state.lastRevealX = -1;
  revealFog(state.px, state.pz, SR);
  state.lastRevealX = state.px; state.lastRevealZ = state.pz;
  // Let the player's own click/keypress dismiss this and request pointer lock —
  // requesting it here (outside a user gesture) is silently rejected.
  document.getElementById('click-to-play').classList.remove('hidden');
  const hint = document.getElementById('first-hint');
  if (hint) { hint.classList.add('visible'); setTimeout(() => hint.classList.remove('visible'), 8000); }
  updateHud();
}

// --- Update ---
function update(delta) {
  if (state.mode !== 0 || !state.started || state.countdown > 0) return;

  const isTouch = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
  const hasKeyboard = Object.values(state.keys).some(v => v);

  // Allow movement without pointer lock if keyboard is used (fallback)
  if (!isTouch && !state.pointerLocked && !hasKeyboard) {
    state.pvelx = 0; state.velZ = 0;
    state.moving = false; state.blocked = false;
    return;
  }

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
  if (len > 0) { mx /= len; mz /= len; }

  state.pvelx = mx * speed;
  state.velZ = mz * speed;

  const ox = state.px, oz = state.pz;

  // Move X
  const nx = state.px + state.pvelx * delta;
  const nhx = heightAt(nx, state.pz);
  const phx = heightAt(state.px, state.pz);
  if (nhx > 0 && nhx - phx < 4) { state.px = nx; }

  // Move Z
  const nz = state.pz + state.velZ * delta;
  const nhz = heightAt(state.px, nz);
  const phz = heightAt(state.px, state.pz);
  if (nhz > 0 && nhz - phz < 4) { state.pz = nz; }

  // Jump / gravity — vertical eye height, so Space visibly bounces the view
  state.pvely += 20 * delta;
  if (state.pvely > 15) state.pvely = 15;
  state.py += state.pvely * delta;
  if (state.py < 0) { state.py = 0; state.pvely = 0; }
  state.onGround = heightAt(state.px, state.pz) > 0;

  state.px = Math.max(1, Math.min(WORLD - 2, state.px));
  state.pz = Math.max(1, Math.min(WORLD - 2, state.pz));

  // Did we actually change position this frame?
  const dx = state.px - ox, dz = state.pz - oz;
  const movedThisFrame = dx * dx + dz * dz > 1e-4;
  state.moving = movedThisFrame;
  if (movedThisFrame && !state.moved) state.moved = true;

  // Blocked detection: keys held but no displacement (water, cliffs)
  const moveKeyHeld = state.keys['KeyW'] || state.keys['KeyS'] || state.keys['KeyA'] || state.keys['KeyD'];
  if (moveKeyHeld && !movedThisFrame) {
    blockedElapsed += delta;
    if (blockedElapsed > 0.4 && !state.blocked) {
      state.blocked = true;
      const hx = state.px + Math.sin(state.camAngle) * 4;
      const hz = state.pz - Math.cos(state.camAngle) * 4;
      state.blockedReason = heightAt(hx, hz) <= 0 ? 'water ahead — turn around' : 'a steep slope blocks you — walk around it';
      showToast('Blocked: ' + state.blockedReason + '.');
    }
  } else {
    blockedElapsed = 0;
    state.blocked = false;
  }

  // Reveal fog only when the player has actually moved (keeps it cheap)
  const dr2 = (state.px - state.lastRevealX) * (state.px - state.lastRevealX) + (state.pz - state.lastRevealZ) * (state.pz - state.lastRevealZ);
  if (dr2 > 2.25 || state.lastRevealX < 0) {
    revealFog(state.px, state.pz, SR);
    state.lastRevealX = state.px; state.lastRevealZ = state.pz;
  }

  // Footsteps + camera bob when actually walking
  if (movedThisFrame) {
    bobPhase += delta * (sprinting ? 12 : 9);
    stepAcc += delta;
    if (stepAcc > 0.34) {
      stepAcc = 0;
      if (state.py < 0.2) playFootstepSound();
    }
  } else {
    bobPhase *= 0.9; // ease out
  }

  _exploredTimer += delta;
  if (_exploredTimer >= 1) { _exploredTimer = 0; state.exploredPct = calcExplored(); scheduleSave(); }
}

// --- State-driven HUD ---
// Owns the status line, the step tracker, the movement indicator, and counters.
// Every string is plain language; no unexplained jargon, no filler.
const STEP_LABELS = {
  'st-move': '1 · Move',
  'st-find': '2 · Find a marker',
  'st-aim': '3 · Center it',
  'st-e': '4 · Press E',
};

function updateHud() {
  const instructionsEl = document.getElementById('instructions');
  const flashEl = document.getElementById('move-flash');
  if (!state.started || state.mode !== 0) {
    if (instructionsEl) instructionsEl.style.display = 'none';
    if (flashEl) { flashEl.classList.remove('visible'); flashEl.classList.remove('blocked'); }
    return;
  }
  if (instructionsEl) instructionsEl.style.display = '';

  // Phase machine — the "not moved yet" gate comes first so a nearby marker
  // never skips the opening instruction ("Walk with WASD…")
  let phase;
  if (beaconCount >= MB) phase = 'done';
  else if (hasFix) phase = 'fix';
  else if (!state.moved) phase = 'intro';
  else {
    const info = aimInfo(state.px, state.pz, state.camAngle, bearings);
    if (info) phase = info.offRad <= ALG ? 'ready' : 'aim';
    else phase = 'explore';
  }

  // Status line
  let status;
  if (state.blocked) {
    status = 'Blocked — ' + state.blockedReason + '.';
  } else if (phase === 'intro') {
    status = 'Walk with WASD — the island and map reveal as you move.';
  } else if (phase === 'explore') {
    const near = nearestUnrecordedTarget(state.px, state.pz, bearings);
    if (near) {
      status = 'Move toward ' + near.name + ' (' + Math.round(Math.sqrt((near.x - state.px) ** 2 + (near.z - state.pz) ** 2)) + 'm away).';
      if (bearings.length === 1) status += ' A direction from a different spot locates you.';
    } else {
      status = bearings.length === 1
        ? 'Walk to a different marker (▲) and record a direction — two recordings pinpoint you.'
        : 'Walk the island to find a marker (▲). Stand close, face it, press E.';
    }
  } else if (phase === 'aim') {
    const info = aimInfo(state.px, state.pz, state.camAngle, bearings);
    status = info
      ? info.target.name + ' is ' + Math.round(info.dist) + 'm ahead — turn ' + info.turn + ' to center it, then press E.'
      : 'Press E when a marker is centered.';
  } else if (phase === 'ready') {
    const info = aimInfo(state.px, state.pz, state.camAngle, bearings);
    status = info ? info.target.name + ' centered — press E to record its direction.' : 'Press E to record the direction.';
  } else if (phase === 'fix') {
    status = 'Position located! Press F to plot it on the chart, or TAB to view the chart.';
  } else if (phase === 'done') {
    status = 'All ' + MB + ' beacons placed! Press TAB to open your chart, then PUBLISH CHART.';
  } else {
    status = '';
  }
  if (status !== _lastStatus) { setStatus(status); _lastStatus = status; }

  // Step tracker
  const steps = [
    { id: 'st-move', done: state.moved, active: phase === 'intro' },
    { id: 'st-find', done: phase !== 'intro' && phase !== 'explore', active: phase === 'explore' },
    { id: 'st-aim', done: phase === 'ready' || phase === 'fix' || phase === 'done', active: phase === 'aim' },
    { id: 'st-e', done: phase === 'fix' || phase === 'done', active: phase === 'ready' },
  ];
  steps.forEach(s => {
    const el = document.getElementById(s.id);
    if (!el) return;
    const base = STEP_LABELS[s.id] || s.id;
    let cls = 'step';
    let txt = base;
    if (s.done) { cls += ' done'; txt = '✓ ' + base; }
    else if (s.active) cls += ' active';
    if (el.className !== cls) el.className = cls;
    if (el.textContent !== txt) el.textContent = txt;
  });

  // Movement / blocked indicator
  if (flashEl) {
    if (state.blocked) {
      flashEl.textContent = 'BLOCKED';
      flashEl.classList.add('visible');
      flashEl.classList.add('blocked');
    } else if (state.moving) {
      flashEl.textContent = 'MOVING';
      flashEl.classList.add('visible');
      flashEl.classList.remove('blocked');
    } else {
      flashEl.classList.remove('visible');
      flashEl.classList.remove('blocked');
    }
  }

  // Counters
  document.getElementById('beacon-count').textContent = 'Beacons: ' + beaconCount + '/' + MB;
  document.getElementById('bearing-count').textContent = 'Directions: ' + bearings.length + ' recorded';
  document.getElementById('explored').textContent = 'Explored: ' + state.exploredPct + '%';
}

// --- Game loop ---
function gameLoop(ts) {
  try {
    if (!state.lastTS) state.lastTS = ts;
    state.dt = Math.min((ts - state.lastTS) / 1000, 0.05);
    state.lastTS = ts;
    update(state.dt);
    if (state.mode === 0 && state.started) {
      const bobOffset = Math.sin(bobPhase) * 3;
      renderFrame(state, stamina, bobOffset);
    }
    // Confetti overlay
    if (confetti.length > 0) {
      const c = document.getElementById('world-canvas');
      if (c) drawConfetti(c.getContext('2d'));
    }
    _hudTimer += state.dt;
    if (_hudTimer >= 0.1) { _hudTimer = 0; updateHud(); }
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
    state.lastRevealX = state.px; state.lastRevealZ = state.pz;
    renderFrame(state, 100, 0);
    updateHud();
    requestAnimationFrame(gameLoop);
  } catch (e) {
    console.error('ATLASWRIGHT init failed:', e);
  }
});
