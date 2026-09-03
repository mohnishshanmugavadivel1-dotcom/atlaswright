// audio.js — Web Audio ambient system, sound cues, mute toggle
let audioCtx = null, masterGain = null, ambientGain = null;
let audioStarted = false, audioMuted = false;

export function initAudio() {
  if (audioStarted) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.3;
    masterGain.connect(audioCtx.destination);
    ambientGain = audioCtx.createGain();
    ambientGain.gain.value = 0.15;
    ambientGain.connect(masterGain);
    // Wind: filtered white noise
    const windBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const windData = windBuf.getChannelData(0);
    for (let i = 0; i < windData.length; i++) windData[i] = Math.random() * 2 - 1;
    const windSrc = audioCtx.createBufferSource();
    windSrc.buffer = windBuf; windSrc.loop = true;
    const windFilter = audioCtx.createBiquadFilter();
    windFilter.type = 'lowpass'; windFilter.frequency.value = 400; windFilter.Q.value = 0.5;
    const windGain = audioCtx.createGain(); windGain.gain.value = 0.4;
    windSrc.connect(windFilter); windFilter.connect(windGain); windGain.connect(ambientGain);
    windSrc.start();
    // Water: modulated noise
    const waterBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 3, audioCtx.sampleRate);
    const waterData = waterBuf.getChannelData(0);
    for (let i = 0; i < waterData.length; i++) waterData[i] = Math.random() * 2 - 1;
    const waterSrc = audioCtx.createBufferSource();
    waterSrc.buffer = waterBuf; waterSrc.loop = true;
    const waterFilter = audioCtx.createBiquadFilter();
    waterFilter.type = 'bandpass'; waterFilter.frequency.value = 800; waterFilter.Q.value = 2;
    const waterGain = audioCtx.createGain(); waterGain.gain.value = 0.15;
    waterSrc.connect(waterFilter); waterFilter.connect(waterGain); waterGain.connect(ambientGain);
    waterSrc.start();
    // Ambient tone: low drone
    const osc = audioCtx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = 55;
    const oscGain = audioCtx.createGain(); oscGain.gain.value = 0.06;
    osc.connect(oscGain); oscGain.connect(ambientGain);
    osc.start();
    audioStarted = true;
  } catch (e) { /* Web Audio not available */ }
}

function playTone(freq, duration, vol = 0.2, type = 'sine') {
  if (!audioCtx || audioMuted) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type; osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain); gain.connect(masterGain);
  osc.start(); osc.stop(audioCtx.currentTime + duration);
}

export function playBeaconSound() { playTone(880, 0.08, 0.15, 'square'); setTimeout(() => playTone(1100, 0.06, 0.1, 'square'), 60); }
export function playBearingSound() { playTone(660, 0.15, 0.12); setTimeout(() => playTone(880, 0.2, 0.1), 100); }
export function playPublishSound() { [440, 554, 660, 880].forEach((f, i) => setTimeout(() => playTone(f, 0.3, 0.08), i * 120)); }

export function toggleAudio() {
  audioMuted = !audioMuted;
  if (masterGain) masterGain.gain.value = audioMuted ? 0 : 0.3;
  document.getElementById('btn-audio').textContent = audioMuted ? '🔇' : '🔊';
}
