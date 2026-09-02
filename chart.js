// chart.js — chart overlay, freehand drawing, fix stamping, publish
import { landmarks, calcExplored } from './world.js';

export const chartState = { strokes: [], fixes: [], currentStroke: [], published: false };
let canvasEl, ctx;

export function initChart() {
  canvasEl = document.getElementById('chart-canvas');
  ctx = canvasEl.getContext('2d');
}

export function openChart(state) {
  state.mode = 1;
  document.getElementById('chart-overlay').classList.add('visible');
  document.getElementById('mode-label').textContent = 'CHART';
  canvasEl.width = canvasEl.parentElement.clientWidth;
  canvasEl.height = canvasEl.parentElement.clientHeight;
  drawChart();
}

export function closeChart(state) {
  state.mode = 0;
  document.getElementById('chart-overlay').classList.remove('visible');
  document.getElementById('mode-label').textContent = 'FIELD';
  chartState.currentStroke = [];
  state.setStatus('Back in the field.');
}

export function toggleChart(state) {
  if (state.mode === 1) closeChart(state); else openChart(state);
}

export function plotFix(state, lastFix, hasFix) {
  if (!hasFix || !lastFix) { state.setStatus('No fix to plot.'); return; }
  const ext = 260, cw = canvasEl.width, ch = canvasEl.height;
  chartState.fixes.push({
    x: (lastFix.x + ext) / (2 * ext) * cw,
    z: (lastFix.z + ext) / (2 * ext) * ch
  });
  drawChart();
  state.setStatus('Fix plotted on chart.');
}

export function undoStroke(state) {
  if (chartState.strokes.length > 0) { chartState.strokes.pop(); drawChart(); state.setStatus('Stroke undone.'); }
}

export function drawChart() {
  if (!ctx) return;
  const cw = canvasEl.width, ch = canvasEl.height;
  ctx.fillStyle = '#ede8df';
  ctx.fillRect(0, 0, cw, ch);
  const ext = 260;
  // Grid
  ctx.strokeStyle = 'rgba(180,165,130,0.4)'; ctx.lineWidth = 0.5;
  for (let k = -5; k <= 5; k++) {
    const gx = (k * 50 + ext) / (2 * ext) * cw;
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, ch); ctx.stroke();
  }
  for (let k = -5; k <= 5; k++) {
    const gz = (k * 50 + ext) / (2 * ext) * ch;
    ctx.beginPath(); ctx.moveTo(0, gz); ctx.lineTo(cw, gz); ctx.stroke();
  }
  // Major axes
  ctx.strokeStyle = 'rgba(140,120,80,0.6)'; ctx.lineWidth = 1.5;
  const ax = (0 + ext) / (2 * ext) * cw, az = (0 + ext) / (2 * ext) * ch;
  ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, ch); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, az); ctx.lineTo(cw, az); ctx.stroke();
  // Border
  ctx.strokeStyle = '#1f1c18'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, cw - 2, ch - 2);
  // Strokes
  ctx.strokeStyle = '#1f1c18'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  chartState.strokes.forEach(s => {
    if (s.length < 2) return;
    ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
    ctx.stroke();
  });
  if (chartState.currentStroke.length > 1) {
    ctx.beginPath(); ctx.moveTo(chartState.currentStroke[0].x, chartState.currentStroke[0].y);
    for (let i = 1; i < chartState.currentStroke.length; i++) ctx.lineTo(chartState.currentStroke[i].x, chartState.currentStroke[i].y);
    ctx.stroke();
  }
  // Fixes
  chartState.fixes.forEach(fx => {
    ctx.strokeStyle = 'rgba(180,40,30,0.85)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(fx.x - 8, fx.z - 8); ctx.lineTo(fx.x + 8, fx.z + 8);
    ctx.moveTo(fx.x + 8, fx.z - 8); ctx.lineTo(fx.x - 8, fx.z + 8); ctx.stroke();
  });
  // Landmark labels
  landmarks.forEach(l => {
    const lx = (l.x + ext) / (2 * ext) * cw, lz = (l.z + ext) / (2 * ext) * ch;
    ctx.fillStyle = '#8a5a22'; ctx.font = '10px Georgia'; ctx.textAlign = 'center';
    ctx.fillText(l.name, lx, lz - 6);
    ctx.fillStyle = '#c08030'; ctx.beginPath(); ctx.arc(lx, lz, 3, 0, Math.PI * 2); ctx.fill();
  });
}

export function publishChart(state, beaconCount) {
  chartState.published = true;
  document.getElementById('publish-overlay').classList.add('visible');
  document.getElementById('publish-stats').textContent =
    'Beacons: ' + beaconCount + ' | Fixes: ' + chartState.fixes.length +
    ' | Strokes: ' + chartState.strokes.length + ' | Explored: ' + calcExplored() + '%';
  setTimeout(() => { document.getElementById('published-text').classList.add('visible'); }, 500);
}
