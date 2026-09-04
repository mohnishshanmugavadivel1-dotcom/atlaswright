// chart.js — chart overlay drawing, ink strokes, undo, export/import
import { initNoise } from './noise.js';
import {
  heightAt, buildTerrain, assignLandmarkHeights,
  calcExplored, landmarks, beacons, beaconCount, bearings, lastFix, hasFix,
} from './world.js';
import { playPublishSound } from './audio.js';

const EXPORT_VERSION = 2;

// Chart state — owned by this module
export const chart = { strokes: [], fixes: [], currentStroke: [], published: false };
let chartCanvas, chartCtx;

export function initChart(canvasEl) {
  chartCanvas = canvasEl;
  chartCtx = chartCanvas.getContext('2d');
}

export function drawChart() {
  if (!chartCtx) return;
  const cw = chartCanvas.width, ch = chartCanvas.height, ext = 260;
  // Paper base
  chartCtx.fillStyle = '#ede8df';
  chartCtx.fillRect(0, 0, cw, ch);
  // Paper grain texture
  const grainSeed = 12345;
  let gr = grainSeed;
  for (let i = 0; i < 2000; i++) {
    gr = (gr * 1103515245 + 12345) & 0x7fffffff;
    const gx = (gr % cw);
    gr = (gr * 1103515245 + 12345) & 0x7fffffff;
    const gy = (gr % ch);
    gr = (gr * 1103515245 + 12345) & 0x7fffffff;
    const alpha = 0.02 + (gr % 30) * 0.001;
    chartCtx.fillStyle = `rgba(160,140,100,${alpha})`;
    chartCtx.fillRect(gx, gy, 1, 1);
  }
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
  // Strokes with ink bleed variation
  chartCtx.lineCap = 'round'; chartCtx.lineJoin = 'round';
  function drawInkStroke(pts) {
    if (pts.length < 2) return;
    for (let i = 1; i < pts.length; i++) {
      const w = 1.5 + Math.sin(i * 0.3) * 0.5 + Math.random() * 0.3;
      chartCtx.strokeStyle = `rgba(31,28,24,${0.7 + Math.random() * 0.3})`;
      chartCtx.lineWidth = w;
      chartCtx.beginPath(); chartCtx.moveTo(pts[i - 1].x, pts[i - 1].y); chartCtx.lineTo(pts[i].x, pts[i].y); chartCtx.stroke();
    }
  }
  chart.strokes.forEach(drawInkStroke);
  drawInkStroke(chart.currentStroke);
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

export function openChart(setMode, setStatus) {
  setMode(1);
  document.getElementById('chart-overlay').classList.add('visible');
  document.getElementById('mode-label').textContent = 'CHART';
  chartCanvas.width = chartCanvas.parentElement.clientWidth;
  chartCanvas.height = chartCanvas.parentElement.clientHeight;
  drawChart();
}

export function closeChart(setMode, setStatus) {
  setMode(0);
  document.getElementById('chart-overlay').classList.remove('visible');
  document.getElementById('mode-label').textContent = 'FIELD';
  chart.currentStroke = [];
}

export function toggleChart(setMode, setStatus) {
  // mode is read via closure — caller passes current mode
}

export function doPlotFix(setStatus, scheduleSave) {
  if (!hasFix || !lastFix) { setStatus('No fix to plot.'); return; }
  const ext = 260, cw = chartCanvas.width, ch = chartCanvas.height;
  chart.fixes.push({ x: (lastFix.x + ext) / (2 * ext) * cw, z: (lastFix.z + ext) / (2 * ext) * ch });
  drawChart();
  setStatus('Fix plotted on chart.');
  scheduleSave();
}

export function doUndoStroke(setStatus) {
  if (chart.strokes.length > 0) { chart.strokes.pop(); drawChart(); setStatus('Stroke undone.'); }
}

export function doPublishChart(state, setStatus, scheduleSave) {
  chart.published = true;
  document.getElementById('publish-overlay').classList.add('visible');
  playPublishSound();
  document.getElementById('publish-stats').innerHTML =
    '<strong>Beacons placed:</strong> ' + beaconCount + '<br>' +
    '<strong>Fixes computed:</strong> ' + chart.fixes.length + '<br>' +
    '<strong>Chart strokes:</strong> ' + chart.strokes.length + '<br>' +
    '<strong>Terrain explored:</strong> ' + calcExplored() + '%';
  if (state.startTime) {
    const elapsed = Math.round((Date.now() - state.startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    document.getElementById('publish-time').textContent = 'Expedition duration: ' + min + 'm ' + sec + 's';
  }
  const goalEl = document.getElementById('publish-goal');
  if (state.personalGoal) {
    goalEl.style.display = 'block';
    goalEl.textContent = 'Your goal: ' + state.personalGoal;
  }
  setTimeout(() => { document.getElementById('published-text').classList.add('visible'); }, 500);
  scheduleSave();
}

export function exportChartJSON(state) {
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
  return JSON.stringify(data);
}

export function importChartJSON(jsonStr, state) {
  try {
    const data = JSON.parse(jsonStr);
    if (data.v !== 1 && data.v !== EXPORT_VERSION) return { ok: false, reason: 'Unsupported chart version.' };
    const seed = data.seed || 1337;
    initNoise(seed);
    buildTerrain(seed);
    assignLandmarkHeights();
    state.seed = seed;
    chart.strokes = data.chart.strokes || [];
    chart.fixes = data.chart.fixes || [];
    chart.published = true;
    if (data.beacons) {
      beacons.length = 0;
      data.beacons.forEach(b => beacons.push(b));
    }
    return { ok: true, seed };
  } catch (e) { return { ok: false, reason: 'Invalid chart file.' }; }
}

// Setup chart canvas drawing (mouse events)
export function initChartInput(state) {
  let drawing = false, lastCx = 0, lastCy = 0;
  chartCanvas.addEventListener('mousedown', e => { if (chart.published) return; drawing = true; lastCx = e.offsetX; lastCy = e.offsetY; });
  chartCanvas.addEventListener('mousemove', e => {
    if (!drawing || chart.published) return;
    if (chart.currentStroke.length === 0) chart.currentStroke.push({ x: lastCx, y: lastCy });
    chart.currentStroke.push({ x: e.offsetX, y: e.offsetY });
    lastCx = e.offsetX; lastCy = e.offsetY; drawChart();
  });
  chartCanvas.addEventListener('mouseup', () => { drawing = false; });
}
