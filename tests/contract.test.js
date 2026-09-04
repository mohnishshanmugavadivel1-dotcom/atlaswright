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
  landmarks, beacons, bearings, beaconCount,
  placeBeacon, takeBearing, resetWorld, restoreState,
  normalizeDeg, nearestUnrecordedTarget, aimInfo,
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
  it('resolves fractional positions to their terrain cell (player can move)', () => {
    buildTerrain();
    const cell = heightAt(512, 512);
    assert.ok(cell > 0, 'spawn cell must be land for the seed-1337 world');
    // Movement advances positions by fractions of a cell per frame; every
    // fraction inside the spawn cell must read the same land height, never water.
    for (const [x, z] of [[512.06, 512], [512.49, 512], [512, 512.49], [511.51, 511.51], [512.49, 512.49]]) {
      const h = heightAt(x, z);
      assert.ok(h > 0, `heightAt(${x}, ${z}) = ${h} — fractional lookup fell into water`);
      assert.equal(h, cell);
    }
  });
  it('snaps to the neighbouring cell past the half-way mark', () => {
    buildTerrain();
    const cell = heightAt(512, 512);
    const next = heightAt(513, 512);
    assert.equal(heightAt(512.6, 512), next);
    assert.equal(heightAt(512.4, 512), cell);
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
    const t = findNearestTarget(380, 400, 0, []);
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

describe('normalizeDeg', () => {
  it('normalizes to [0, 360)', () => {
    assert.equal(normalizeDeg(0), 0);
    assert.equal(normalizeDeg(Math.PI), 180);
    assert.equal(normalizeDeg(2 * Math.PI), 0);
  });
  it('never returns negatives for large negative angles', () => {
    // This used to produce "-236 deg undefined" in the HUD
    for (const rad of [-12, -6.28, -3 * Math.PI, -100, -0.9, 20 * Math.PI]) {
      const d = normalizeDeg(rad);
      assert.ok(d >= 0 && d < 360, `normalizeDeg(${rad}) = ${d} should be in [0, 360)`);
    }
  });
  it('handles NaN gracefully (never renders NaN to the HUD)', () => {
    assert.equal(normalizeDeg(NaN), 0);
  });
});

describe('nearestUnrecordedTarget', () => {
  it('returns the closest marker by distance regardless of aim', () => {
    const t = nearestUnrecordedTarget(600, 500, []);
    assert.ok(t, 'should find a marker');
    assert.equal(t.name, 'CAIRN-B');
  });
  it('excludes recorded markers', () => {
    const t = nearestUnrecordedTarget(600, 500, [{ name: 'CAIRN-B' }]);
    assert.notEqual(t.name, 'CAIRN-B');
  });
  it('returns null outside FR', () => {
    assert.equal(nearestUnrecordedTarget(10, 10, []), null);
  });
});

describe('aimInfo', () => {
  // WRECK sits at (750, 350) with no other landmark closer than ~170m,
  // so the aim-biased nearest-target pick is deterministic around it.
  it('reports right when the target is east of the player', () => {
    const info = aimInfo(690, 350, 0, []); // west of WRECK, looking north
    assert.ok(info, 'should find a target');
    assert.equal(info.target.name, 'WRECK');
    assert.equal(info.turn, 'right');
    assert.ok(info.dist > 55 && info.dist < 65, `dist ${info.dist}`);
    assert.ok(info.offDeg > 85 && info.offDeg < 95, `offDeg ${info.offDeg}`);
  });
  it('reports left when the target is west of the player', () => {
    const info = aimInfo(810, 350, 0, []); // east of WRECK, looking north
    assert.equal(info.target.name, 'WRECK');
    assert.equal(info.turn, 'left');
  });
  it('reports near-zero offset when facing the target', () => {
    const info = aimInfo(810, 350, -Math.PI / 2, []); // looking west at WRECK
    assert.equal(info.target.name, 'WRECK');
    assert.ok(info.offRad <= ALG, `offRad ${info.offRad} should be aligned`);
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

describe('restoreState', () => {
  it('restores beacons, bearings, and fix from saved data', () => {
    resetWorld();
    const saved = {
      beacons: [{ name: 'BEACON-01', x: 520, z: 520, y: 5 }],
      beaconCount: 1,
      bearings: [{ name: 'CAIRN-A', x: 380, z: 380, b: -0.78, err: 0.5 }],
      lastFix: { x: 510, z: 511 },
      hasFix: true,
    };
    restoreState(saved);
    assert.equal(beacons.length, 1, 'beacon restored');
    assert.equal(beacons[0].name, 'BEACON-01');
    assert.equal(beaconCount, 1, 'beaconCount restored');
    assert.equal(bearings.length, 1, 'bearing restored');
    assert.equal(bearings[0].name, 'CAIRN-A');
    assert.deepEqual(lastFix, { x: 510, z: 511 }, 'lastFix restored');
    assert.equal(hasFix, true, 'hasFix restored');
  });
});

// --- chart.js export/import ---
import { chart, exportChartJSON, importChartJSON } from '../chart.js';

describe('exportChartJSON', () => {
  it('serializes state with seed', () => {
    const state = { seed: 4242, px: 500, pz: 500, camAngle: 0.5, startTime: 0, personalGoal: '' };
    const json = exportChartJSON(state);
    const data = JSON.parse(json);
    assert.equal(data.v, 2);
    assert.equal(data.seed, 4242);
    assert.equal(data.px, 500);
  });
  it('serializes chart strokes and fixes', () => {
    chart.strokes = [[{ x: 10, y: 20 }, { x: 30, y: 40 }]];
    chart.fixes = [{ x: 100, z: 200 }];
    const state = { seed: 1337, px: 0, pz: 0, camAngle: 0 };
    const data = JSON.parse(exportChartJSON(state));
    assert.equal(data.chart.strokes.length, 1);
    assert.equal(data.chart.fixes.length, 1);
    // Clean up
    chart.strokes = []; chart.fixes = [];
  });
});

describe('importChartJSON', () => {
  it('imports v2 chart with seed and rebuilds terrain', () => {
    resetWorld();
    const exportData = {
      v: 2, seed: 4242, px: 500, pz: 500, camAngle: 0,
      beacons: [{ name: 'BEACON-01', x: 520, z: 520, y: 5 }],
      beaconCount: 1, bearings: [], lastFix: null, hasFix: false,
      chart: { strokes: [[{ x: 10, y: 20 }]], fixes: [{ x: 100, z: 200 }], published: false },
    };
    const state = { seed: 1337 };
    const result = importChartJSON(JSON.stringify(exportData), state);
    assert.equal(result.ok, true);
    assert.equal(result.seed, 4242);
    assert.equal(state.seed, 4242);
    assert.equal(chart.strokes.length, 1);
    assert.equal(chart.fixes.length, 1);
    assert.equal(beacons.length, 1);
    assert.equal(beacons[0].name, 'BEACON-01');
  });

  it('imports v1 chart (no seed) with default seed 1337', () => {
    resetWorld();
    const v1Data = {
      v: 1, px: 400, pz: 400, camAngle: 0,
      beacons: [], beaconCount: 0, bearings: [], lastFix: null, hasFix: false,
      chart: { strokes: [], fixes: [], published: false },
    };
    const state = { seed: 9999 };
    const result = importChartJSON(JSON.stringify(v1Data), state);
    assert.equal(result.ok, true);
    assert.equal(result.seed, 1337, 'v1 defaults to seed 1337');
    assert.equal(state.seed, 1337);
  });

  it('rejects unsupported version', () => {
    const badData = { v: 99 };
    const result = importChartJSON(JSON.stringify(badData), {});
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('Unsupported'));
  });

  it('rejects invalid JSON', () => {
    const result = importChartJSON('not json', {});
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('Invalid'));
  });
});

// --- Terrain seed persistence ---
describe('terrain seed persistence', () => {
  it('same seed produces same terrain after rebuild', () => {
    initNoise(1337); buildTerrain(1337);
    const h1 = heightAt(300, 300);
    initNoise(4242); buildTerrain(4242);
    const h2 = heightAt(300, 300);
    assert.notEqual(h1, h2, 'different seeds produce different terrain');
    initNoise(1337); buildTerrain(1337);
    const h3 = heightAt(300, 300);
    assert.equal(h1, h3, 'same seed reproduces same terrain');
  });

  it('import switches terrain to imported seed', () => {
    initNoise(1337); buildTerrain(1337);
    const before = heightAt(400, 400);
    const state = { seed: 1337 };
    const data = { v: 2, seed: 4242, px: 0, pz: 0, camAngle: 0,
      beacons: [], beaconCount: 0, bearings: [], lastFix: null, hasFix: false,
      chart: { strokes: [], fixes: [], published: false } };
    importChartJSON(JSON.stringify(data), state);
    const after = heightAt(400, 400);
    assert.notEqual(before, after, 'terrain changed after import');
  });
});
