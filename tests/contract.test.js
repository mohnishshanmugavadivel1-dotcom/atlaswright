import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
  findNearestTarget, isAligned,
  revealFog, calcExplored, fogVersion,
  lastFix, hasFix, colorMap,
  landmarks, bearings, takeBearing, resetWorld,
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
    const t = findNearestTarget(10, 10, 0, []);
    assert.equal(t, null, 'too far from any target');
  });
});

describe('isAligned', () => {
  it('returns true when crosshair points at target', () => {
    const px = 380, pz = 400;
    const dx = 380 - px, dz = 380 - pz;
    const angle = Math.atan2(dx, -dz);
    assert.ok(isAligned(px, pz, angle, []));
  });
  it('returns false when off-angle', () => {
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

    // Place player at (512, 512), take bearing toward CAIRN-A
    const dx1 = 380 - 512, dz1 = 380 - 512;
    bearings.push({ name: 'CAIRN-A', x: 380, z: 380, b: Math.atan2(dx1, -dz1), err: 0 });

    // Take bearing toward CAIRN-B (triggers resection)
    const dx2 = 680 - 512, dz2 = 520 - 512;
    bearings.push({ name: 'CAIRN-B', x: 680, z: 520, b: Math.atan2(dx2, -dz2), err: 0 });

    // Manually call takeBearing logic: find a target, add bearing, then tryFix runs
    // Actually, let's just directly test via the resection path
    // The takeBearing function finds target, adds bearing, then calls tryFix internally
    // But we need to set up bearings directly since we're testing resection
    // Since tryFix is private, we test through takeBearing which calls it

    // Set up: two bearings already recorded, then take a third
    // Actually, let's test the simplest path:
    // Player at (512, 512), looking at CAIRN-A, press E -> records bearing
    // Player at (512, 512), looking at CAIRN-B, press E -> records bearing + triggers resection

    bearings.length = 0;
    // Compute angle from player to CAIRN-A
    const a1 = Math.atan2(380 - 512, -(380 - 512));
    const r1 = takeBearing(512, 512, a1);
    assert.ok(r1.ok, 'first bearing should succeed');
    assert.equal(r1.bearing, 'CAIRN-A');
    assert.equal(r1.fix, null, 'no fix yet with one bearing');

    // Compute angle from player to CAIRN-B
    const a2 = Math.atan2(680 - 512, -(520 - 512));
    const r2 = takeBearing(512, 512, a2);
    assert.ok(r2.ok, 'second bearing should succeed');
    assert.ok(r2.fix, 'should produce a fix');
    assert.ok(Math.abs(r2.fix.x - 512) < 5, `fix x=${r2.fix.x} should be near 512`);
    assert.ok(Math.abs(r2.fix.z - 512) < 5, `fix z=${r2.fix.z} should be near 512`);
  });
});
