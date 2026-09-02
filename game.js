// game.js � orchestrator: state, init, update, render, gameLoop
import { initNoise } from './noise.js';
import { WORLD, SR, heightAt, buildTerrain, assignLandmarkHeights, revealFog, calcExplored, beacons, beaconCount, bearings, lastFix, hasFix } from './world.js';
import { initCanvas, render, setStatus } from './renderer.js';
import { initInput } from './input.js';
import { initChart } from './chart.js';

// --- Shared game state ---
export const state = {
  mode: 0, started: false,
  px: 512, pz: 512, pvelx: 0, pvely: 0,
  camAngle: 0, dt: 0, lastTS: 0,
  keys: {}, mouseDown: false, lastMX: 0, lastMY: 0, pointerLocked: false,
  onGround: false, exploredPct: 0,
  setStatus
};

let _exploredTimer = 0;

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
  if (_exploredTimer >= 1) { _exploredTimer = 0; state.exploredPct = calcExplored(); }
}

function gameLoop(ts) {
  if (!state.lastTS) state.lastTS = ts;
  state.dt = Math.min((ts - state.lastTS) / 1000, 0.05);
  state.lastTS = ts;
  update(state.dt);
  if (state.mode === 0) render(state, beacons, lastFix, hasFix);
  requestAnimationFrame(gameLoop);
}

function startGame() {
  state.started = true;
  document.getElementById('start-overlay').classList.add('hidden');
  document.getElementById('world-canvas').requestPointerLock();
  // Show first-launch hint, fade after 6s
  const hint = document.getElementById('first-hint');
  if (hint) { hint.classList.add('visible'); setTimeout(() => hint.classList.remove('visible'), 6000); }
}

window.addEventListener('DOMContentLoaded', () => {
  initCanvas();
  initNoise(1337);
  buildTerrain();
  assignLandmarkHeights();
  initInput(state, {
    canvas: document.getElementById('world-canvas'),
    hasFix: () => hasFix,
    lastFix: () => lastFix,
    beaconCount: () => beaconCount,
    startGame
  });
  initChart();
  // Spawn on dry ground
  state.px = WORLD / 2; state.pz = WORLD / 2;
  let h = heightAt(state.px, state.pz);
  while (h <= 1 && state.px < WORLD - 10) { state.px += 5; h = heightAt(state.px, state.pz); }
  revealFog(state.px, state.pz, SR);
  render(state, beacons, lastFix, hasFix);
  requestAnimationFrame(gameLoop);
});
