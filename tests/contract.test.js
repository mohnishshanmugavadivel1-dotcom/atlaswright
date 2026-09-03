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
  WORLD, FR, ALG, MB,
  heightAt, buildTerrain, assignLandmarkHeights,
  findNearestTarget, isAligned,
  revealFog, calcExplored, fogVersion,
  lastFix, hasFix, colorMap,
  landmarks, beacons, bearings,
  placeBeacon, takeBearing, resetWorld,
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
  it('returns true exactly at ALG threshold', () => {
    // Player at (380, 400), cairn at (380, 380)
    // True bearing = atan2(0, -(-20)) = atan2(0, 20) = 0
    // ALG = 0.0698 rad (~4°)
    // Set camAngle to exactly ALG offset
    assert.ok(isAligned(380, 400, ALG, []), 'exactly at threshold should be aligned');
  });
  it('returns false just over ALG threshold', () => {
    assert.ok(!isAligned(380, 400, ALG + 0.001, []), 'just over threshold should not be aligned');
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

describe('placeBeacon', () => {
  it('places beacon on land', () => {
    resetWorld();
    const r = placeBeacon(512, 512, 0);
    assert.ok(r.ok, `beacon should place: ${r.reason}`);
    assert.ok(r.name.startsWith('BEACON-'));
  });
  it('rejects beacon in water', () => {
    resetWorld();
    const r = placeBeacon(5, 5, 0); // edge is water
    assert.ok(!r.ok, 'should reject water beacon');
    assert.ok(r.reason.includes('dry land'));
  });
  it('enforces beacon cap at MB', () => {
    resetWorld();
    for (let i = 0; i < MB; i++) {
      const r = placeBeacon(512, 512, i * 0.3);
      assert.ok(r.ok, `beacon ${i + 1} should place`);
    }
    const r = placeBeacon(512, 512, 0);
    assert.ok(!r.ok, 'should reject after cap');
    assert.ok(r.reason.includes(String(MB)));
  });
});

describe('resection (two-bearing fix)', () => {
  it('computes correct position from two bearings', () => {
    resetWorld();
    bearings.length = 0;

    // Player at (512, 512), take bearing toward CAIRN-A
    const a1 = Math.atan2(380 - 512, -(380 - 512));
    const r1 = takeBearing(512, 512, a1);
    assert.ok(r1.ok, 'first bearing should succeed');
    assert.equal(r1.bearing, 'CAIRN-A');
    assert.equal(r1.fix, null, 'no fix yet with one bearing');

    // Take bearing toward CAIRN-B (triggers resection)
    const a2 = Math.atan2(680 - 512, -(520 - 512));
    const r2 = takeBearing(512, 512, a2);
    assert.ok(r2.ok, 'second bearing should succeed');
    assert.ok(r2.fix, 'should produce a fix');
    assert.ok(Math.abs(r2.fix.x - 512) < 5, `fix x=${r2.fix.x} should be near 512`);
    assert.ok(Math.abs(r2.fix.z - 512) < 5, `fix z=${r2.fix.z} should be near 512`);
  });

  it('rejects near-parallel bearings (det < 0.0005)', () => {
    resetWorld();
    bearings.length = 0;

    // Two bearings from nearly the same angle (toward same target area)
    // CAIRN-A at (380, 380), player at (512, 512)
    // Bearing 1: toward CAIRN-A
    const a1 = Math.atan2(380 - 512, -(380 - 512));
    const r1 = takeBearing(512, 512, a1);
    assert.ok(r1.ok);

    // Bearing 2: toward a point very close to CAIRN-A in angle
    // Place player slightly offset, look at nearly same angle
    const a2 = a1 + 0.001; // ~0.06° difference, nearly parallel
    const r2 = takeBearing(512, 512, a2);
    // This should either fail (no target in range at that angle)
    // or succeed but the resection should detect near-parallel
    if (r2.ok && r2.fix) {
      // If a fix was produced, the error should be large
      assert.ok(r2.fix.err > 1 || r2.fix.spread > 1, 'near-parallel fix should have large error');
    }
  });

  it('rejects bearing away from all targets', () => {
    resetWorld();
    bearings.length = 0;

    // Player at (512, 512), look at angle where no target exists
    const r = takeBearing(512, 512, Math.PI); // looking south
    assert.ok(!r.ok, 'should fail when no target in view');
  });
});

describe('spawn at shoreline', () => {
  it('finds land near center', () => {
    buildTerrain();
    // Check the area around center for land
    let foundLand = false;
    for (let x = 500; x <= 520; x++) {
      if (heightAt(x, 512) > 0) { foundLand = true; break; }
    }
    assert.ok(foundLand, 'should find land near center for spawn');
  });

  it('shoreline pixels are at water boundary', () => {
    buildTerrain();
    // Find a shoreline pixel: land adjacent to water
    let shorelineFound = false;
    for (let z = 0; z < WORLD && !shorelineFound; z += 20) {
      for (let x = 0; x < WORLD && !shorelineFound; x += 20) {
        if (heightAt(x, z) > 0) {
          // Check if any neighbor is water
          if (heightAt(x + 1, z) <= 0 || heightAt(x - 1, z) <= 0 ||
              heightAt(x, z + 1) <= 0 || heightAt(x, z - 1) <= 0) {
            shorelineFound = true;
          }
        }
      }
    }
    assert.ok(shorelineFound, 'island should have shoreline pixels');
  });
});

describe('resetWorld', () => {
  it('clears all state', () => {
    buildTerrain();
    revealFog(512, 512, 50);
    const vBefore = fogVersion;
    placeBeacon(512, 512, 0);
    bearings.push({ name: 'X', x: 0, z: 0, b: 0, err: 0 });
    resetWorld();
    assert.equal(fogVersion, 0, 'fogVersion reset');
    assert.equal(beacons.length, 0, 'beacons cleared');
    assert.equal(bearings.length, 0, 'bearings cleared');
    assert.equal(hasFix, false, 'hasFix reset');
  });
});
