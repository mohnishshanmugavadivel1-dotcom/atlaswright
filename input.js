// input.js — pointer lock, WASD/mouse/jump, keyboard bindings
import { placeBeacon, takeBearing, MB } from './world.js';
import { toggleChart, closeChart, undoStroke, plotFix, drawChart, publishChart, chartState } from './chart.js';

let canvas;

export function initInput(state, callbacks) {
  canvas = callbacks.canvas;
  document.addEventListener('keydown', e => {
    if (!state.started) return;
    state.keys[e.code] = true;
    if (e.code === 'Tab') { e.preventDefault(); toggleChart(state); }
    if (e.code === 'KeyE' && state.mode === 0) takeBearing(state);
    if (e.code === 'KeyF' && state.mode === 0 && callbacks.hasFix()) plotFix(state, callbacks.lastFix(), callbacks.hasFix());
    if (e.code === 'KeyZ' && state.mode === 1) undoStroke(state);
    if (e.code === 'Escape' && state.mode === 1) closeChart(state);
    if (e.code === 'Space' && state.mode === 0) { e.preventDefault(); jump(state); }
  });
  document.addEventListener('keyup', e => { state.keys[e.code] = false; });
  document.addEventListener('mousedown', e => {
    if (!state.started || state.mode !== 0) return;
    state.lastMX = e.clientX; state.lastMY = e.clientY; state.mouseDown = true;
    if (!state.pointerLocked) canvas.requestPointerLock();
  });
  document.addEventListener('mousemove', e => {
    if (state.pointerLocked) { state.camAngle += e.movementX * 0.003; }
    else if (state.mouseDown) { state.camAngle += (e.clientX - state.lastMX) * 0.003; state.lastMX = e.clientX; state.lastMY = e.clientY; }
  });
  document.addEventListener('pointerlockchange', () => { state.pointerLocked = !!document.pointerLockElement; });
  document.addEventListener('mouseup', e => {
    if (e.button === 0 && state.mode === 0 && state.started) { state.mouseDown = false; placeBeacon(state); }
  });
  // Chart canvas drawing
  const cc = document.getElementById('chart-canvas');
  let drawing = false, lastCx = 0, lastCy = 0;
  cc.addEventListener('mousedown', e => { if (chartState.published) return; drawing = true; lastCx = e.offsetX; lastCy = e.offsetY; });
  cc.addEventListener('mousemove', e => {
    if (!drawing || chartState.published) return;
    if (chartState.currentStroke.length === 0) chartState.currentStroke.push({ x: lastCx, y: lastCy });
    chartState.currentStroke.push({ x: e.offsetX, y: e.offsetY });
    lastCx = e.offsetX; lastCy = e.offsetY; drawChart();
  });
  cc.addEventListener('mouseup', () => { drawing = false; });
  // Button bindings
  document.getElementById('btn-undo').onclick = () => undoStroke(state);
  document.getElementById('btn-stamp').onclick = () => plotFix(state, callbacks.lastFix(), callbacks.hasFix());
  document.getElementById('btn-publish').onclick = () => publishChart(state, callbacks.beaconCount());
  document.getElementById('btn-start').onclick = () => callbacks.startGame();
  document.getElementById('btn-new-session').onclick = () => { location.reload(); };
}

function jump(state) {
  if (state.onGround) { state.pvely = -12; state.onGround = false; }
}
