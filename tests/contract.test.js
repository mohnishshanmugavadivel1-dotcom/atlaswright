import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Mock document for DOM-dependent code
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => ({ style: {}, textContent: '', classList: { add() {}, remove() {} }, getContext: () => ({}) }),
  };
}

// --- noise.js ---
import { seedRng, initNoise, noise2d, fbm, lerp } from '../noise.js';

describe('seedRng', () => {
  it('produces deterministic sequence', () => {
    const a = seedRng(42), b = seedRng(42);
    const seq = Array.from({ length: 5 }, () => a());
    assert.deepEqual(seq, Array.from({ length: 5 }, () => b()));
  });
  it('different seeds produce different sequences', () => {
    const a = seedRng(1), b = seedRng(2);
    assert.notEqual(a(), b());
  });
  it('output in [0, 1]', () => {
    const r = seedRng(99);
    for (let i = 0; i < 100; i++) { const v = r(); assert.ok(v >= 0 && v <= 1); }
  });
});

describe('lerp', () => {
  it('interpolates endpoints', () => { assert.equal(lerp(0, 10, 0), 0); assert.equal(lerp(0, 10, 1), 10); });
  it('interpolates midpoint', () => { assert.equal(lerp(0, 10, 0.5), 5); });
  it('interpolates quarter', () => { assert.equal(lerp(2, 8, 0.25), 3.5); });
});

describe('noise2d', () => {
  it('output in [-1, 1] across grid', () => {
    initNoise(1337);
    for (let x = 0; x < 10; x += 0.7)
      for (let y = 0; y < 10; y += 0.7) {
        const v = noise2d(x, y);
        assert.ok(v >= -1.01 && v <= 1.01, `noise2d(${x},${y}) = ${v}`);
      }
  });
  it('deterministic with same seed', () => {
    initNoise(1337);
    const a = noise2d(3.7, 5.2);
    initNoise(1337);
    const b = noise2d(3.7, 5.2);
    assert.equal(a, b);
  });
});

describe('fbm', () => {
  it('sums 4 octaves of noise', () => {
    initNoise(1337);
    const v = fbm(1, 1);
    assert.ok(typeof v === 'number' && Number.isFinite(v));
  });
  it('deterministic with same seed', () => {
    initNoise(1337); const a = fbm(2, 3);
    initNoise(1337); const b = fbm(2, 3);
    assert.equal(a, b);
  });
});

// --- world.js ---
import {
  WORLD, FR,
  heightAt, buildTerrain, assignLandmarkHeights,
  findNearestTarget, isAligned, tryFix,
  revealFog, calcExplored, fogVersion,
  lastFix, hasFix, colorMap,
  landmarks, bearings,
} from '../world.js';

describe('heightAt', () => {
  it('returns -999 outside world bounds', () => {
    assert.equal(heightAt(-1, 512), -999);
    assert.equal(heightAt(512, -1), -999);
    assert.equal(heightAt(WORLD, 512), -999);
    assert.equal(heightAt(512, WORLD), -999);
  });
  it('returns finite number inside world', () => {
    const h = heightAt(512, 512);
    assert.ok(typeof h === 'number' && Number.isFinite(h));
  });
});

describe('buildTerrain', () => {
  it('produces island shape: center > 0, edges <= 0', () => {
    buildTerrain();
    const center = heightAt(WORLD / 2, WORLD / 2);
    const edge = heightAt(5, 5);
    assert.ok(center > 0, `center height ${center} should be > 0`);
    assert.ok(edge <= 0, `edge height ${edge} should be <= 0`);
  });
  it('fills colorMap', () => {
    const ci = (512 * WORLD + 512) * 3;
    assert.ok(colorMap[ci] > 0 || colorMap[ci + 1] > 0 || colorMap[ci + 2] > 0);
  });
});

describe('assignLandmarkHeights', () => {
  it('assigns terrain-based y to all landmarks', () => {
    buildTerrain();
    assignLandmarkHeights();
    for (const l of landmarks) {
      const h = heightAt(l.x, l.z);
      assert.ok(l.y >= Math.max(h, 2) + 4, `${l.name} y=${l.y} should be >= ${Math.max(h, 2) + 4}`);
    }
  });
});

describe('findNearestTarget', () => {
  buildTerrain();
  assignLandmarkHeights();

  it('finds closest aligned target', () => {
    const t = findNearestTarget(380, 380, 0, []);
    assert.ok(t, 'should find a target');
    assert.equal(t.name, 'CAIRN-A');
  });

  it('excludes recorded targets', () => {
    // Player near CAIRN-A, looking toward it, but CAIRN-A is recorded
    // Should skip to next nearest target (CAIRN-B or CAIRN-C if in range)
    const t = findNearestTarget(380, 400, 0, [{ name: 'CAIRN-A' }]);
    assert.ok(t, 'should find next unrecorded target');
    assert.notEqual(t.name, 'CAIRN-A');
  });

  it('returns null when all targets recorded', () => {
    const all = landmarks.map(l => ({ name: l.name }));
    const t = findNearestTarget(512, 512, 0, all);
    assert.equal(t, null);
  });

  it('respects range limit (FR)', () => {
    // Place player far from all landmarks
    const t = findNearestTarget(10, 10, 0, []);
    assert.equal(t, null, 'too far from any target');
  });
});

describe('isAligned', () => {
  it('returns true when crosshair points at target', () => {
    // Player at 380,380 looking toward CAIRN-A at 380,380 (same spot)
    // Actually need player NOT at landmark. Let's compute the angle.
    const px = 380, pz = 400; // 20 units south of CAIRN-A
    const dx = 380 - px, dz = 380 - pz;
    const angle = Math.atan2(dx, -dz); // should point north
    assert.ok(isAligned(px, pz, angle, []));
  });
  it('returns false when off-angle', () => {
    // CAIRN-A at (380,380), player at (380,400) - target is north
    // Player looking east (angle = PI/2) - should NOT be aligned
    assert.ok(!isAligned(380, 400, Math.PI / 2, []));
  });
});

describe('revealFog', () => {
  it('increments fogVersion on new reveals', () => {
    const before = fogVersion;
    revealFog(100, 100, 5);
    assert.ok(fogVersion > before, 'fogVersion should increase');
  });
  it('does not increment on re-reveal', () => {
    revealFog(100, 100, 5);
    const before = fogVersion;
    revealFog(100, 100, 5);
    assert.equal(fogVersion, before, 'fogVersion should not change on re-reveal');
  });
});

describe('calcExplored', () => {
  it('returns percentage string', () => {
    const result = calcExplored();
    assert.ok(typeof result === 'string');
    assert.ok(parseFloat(result) >= 0 && parseFloat(result) <= 100);
  });
});

describe('resection (two-bearing fix)', () => {
  it('computes correct position from two bearings', () => {
    bearings.length = 0;
    const state = { px: 512, pz: 512, camAngle: 0, setStatus: () => {} };

    // Bearing 1: from (512,512) toward CAIRN-A (380,380)
    const dx1 = 380 - 512, dz1 = 380 - 512;
    bearings.push({ name: 'CAIRN-A', x: 380, z: 380, b: Math.atan2(dx1, -dz1), err: 0 });

    // Bearing 2: from (512,512) toward CAIRN-B (680,520)
    const dx2 = 680 - 512, dz2 = 520 - 512;
    bearings.push({ name: 'CAIRN-B', x: 680, z: 520, b: Math.atan2(dx2, -dz2), err: 0 });

    tryFix(state);

    assert.ok(hasFix, 'should produce a fix');
    assert.ok(Math.abs(lastFix.x - 512) < 5, `fix x=${lastFix.x} should be near 512`);
    assert.ok(Math.abs(lastFix.z - 512) < 5, `fix z=${lastFix.z} should be near 512`);


  });
});
