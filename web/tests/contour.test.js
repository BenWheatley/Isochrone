import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractContourRings,
  ringContainsPoint,
  ringSignedArea,
} from '../src/render/contour.js';

const FIELD_WIDTH = 41;
const FIELD_HEIGHT = 41;
const CENTRE_X = 20;
const CENTRE_Y = 20;

/** Travel time as plain distance from a point, so a contour is a circle of
 *  known radius and the extracted area has an exact value to be judged
 *  against. */
function radialField(transform = (distance) => distance) {
  const field = new Float32Array(FIELD_WIDTH * FIELD_HEIGHT);
  for (let y = 0; y < FIELD_HEIGHT; y += 1) {
    for (let x = 0; x < FIELD_WIDTH; x += 1) {
      field[y * FIELD_WIDTH + x] = transform(Math.hypot(x - CENTRE_X, y - CENTRE_Y), x, y);
    }
  }
  return field;
}

function extractOne(field, threshold, overrides = {}) {
  const [result] = extractContourRings(field, {
    width: FIELD_WIDTH,
    height: FIELD_HEIGHT,
    threshold,
    ...overrides,
  });
  return result.rings;
}

function ringCentroid(ring) {
  let x = 0;
  let y = 0;
  const count = ring.points.length / 2;
  for (let index = 0; index < count; index += 1) {
    x += ring.points[index * 2];
    y += ring.points[index * 2 + 1];
  }
  return [x / count, y / count];
}

test('extractContourRings recovers a known circle to within a fraction of a percent', () => {
  const rings = extractOne(radialField(), 10);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].isHole, false);

  const expectedArea = Math.PI * 10 * 10;
  assert.ok(
    Math.abs(rings[0].signedArea - expectedArea) / expectedArea < 0.01,
    `area ${rings[0].signedArea} is not within 1% of ${expectedArea}`,
  );

  // Closed by construction: the walk is a cycle, so the last point joins the
  // first without the ring having to repeat it.
  const [firstX, firstY] = [rings[0].points[0], rings[0].points[1]];
  assert.ok(Number.isFinite(firstX) && Number.isFinite(firstY));
});

test('extractContourRings returns an unreachable pocket as an inner ring', () => {
  // A park, a lake or an industrial estate: reachable all around, not through.
  const rings = extractOne(radialField((distance) => (distance < 4 ? Infinity : distance)), 10);
  assert.equal(rings.length, 2);

  const outer = rings.find((ring) => !ring.isHole);
  const hole = rings.find((ring) => ring.isHole);
  assert.ok(outer && hole, 'expected exactly one outer ring and one hole');
  // Opposite winding is what lets even-odd fill punch the hole out without
  // anything having to classify the two.
  assert.ok(Math.sign(outer.signedArea) !== Math.sign(hole.signedArea));

  const [holeX, holeY] = ringCentroid(hole);
  assert.ok(ringContainsPoint(outer.points, holeX, holeY), 'hole is not inside the outer ring');
  const [outerX, outerY] = ringCentroid(outer);
  assert.ok(!ringContainsPoint(hole.points, outerX + 9, outerY), 'outer ring fell inside the hole');
});

test('extractContourRings separates disjoint regions, as a transit isochrone produces', () => {
  // Two reachable islands with nothing between them - what happens when a
  // train drops the rider somewhere far from where they started.
  const field = new Float32Array(FIELD_WIDTH * FIELD_HEIGHT).fill(Number.POSITIVE_INFINITY);
  for (const [centreX, centreY] of [[10, 10], [30, 30]]) {
    for (let y = 0; y < FIELD_HEIGHT; y += 1) {
      for (let x = 0; x < FIELD_WIDTH; x += 1) {
        const distance = Math.hypot(x - centreX, y - centreY);
        if (distance < 6) {
          field[y * FIELD_WIDTH + x] = Math.min(field[y * FIELD_WIDTH + x], distance);
        }
      }
    }
  }

  const rings = extractOne(field, 4);
  assert.equal(rings.length, 2);
  // Both are outer boundaries: neither is a hole in the other.
  assert.deepEqual(rings.map((ring) => ring.isHole), [false, false]);
  const [firstX, firstY] = ringCentroid(rings[0]);
  assert.ok(!ringContainsPoint(rings[1].points, firstX, firstY));
});

test('extractContourRings closes a region that runs off the edge of the raster', () => {
  // Reachability increasing left to right, so the contour would be an open
  // line were the raster not treated as bounded by unreachable ground.
  const field = new Float32Array(FIELD_WIDTH * FIELD_HEIGHT);
  for (let y = 0; y < FIELD_HEIGHT; y += 1) {
    for (let x = 0; x < FIELD_WIDTH; x += 1) {
      field[y * FIELD_WIDTH + x] = x;
    }
  }

  const rings = extractOne(field, 10);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].isHole, false);
  // Half of the raster's height beyond the contour, plus the half-cell the
  // midpoint rule puts outside each border.
  assert.ok(rings[0].signedArea > 0);
  assert.ok(ringContainsPoint(rings[0].points, 5, 20), 'the reachable side is not inside the ring');
  assert.ok(!ringContainsPoint(rings[0].points, 30, 20), 'the far side is inside the ring');
});

test('extractContourRings nests every band in one pass over the raster', () => {
  const results = extractContourRings(radialField(), {
    width: FIELD_WIDTH,
    height: FIELD_HEIGHT,
    thresholds: [4, 8, 12],
  });
  assert.deepEqual(results.map((result) => result.threshold), [4, 8, 12]);
  assert.deepEqual(results.map((result) => result.rings.length), [1, 1, 1]);

  const areas = results.map((result) => result.rings[0].signedArea);
  assert.ok(areas[0] < areas[1] && areas[1] < areas[2], `bands are not nested: ${areas}`);

  // And each one agrees with the same threshold asked for on its own.
  for (const result of results) {
    const alone = extractOne(radialField(), result.threshold);
    assert.equal(alone.length, result.rings.length);
    assert.ok(Math.abs(alone[0].signedArea - result.rings[0].signedArea) < 1e-9);
  }
});

test('extractContourRings resolves a saddle without leaving a ring unclosed', () => {
  // A col between two reachable areas: the classic ambiguous cell, where the
  // two diagonal corners are inside and the other two are not.
  const field = new Float32Array(FIELD_WIDTH * FIELD_HEIGHT);
  for (let y = 0; y < FIELD_HEIGHT; y += 1) {
    for (let x = 0; x < FIELD_WIDTH; x += 1) {
      const u = (x - CENTRE_X) / 8;
      const v = (y - CENTRE_Y) / 8;
      field[y * FIELD_WIDTH + x] = u * u - v * v;
    }
  }

  for (const threshold of [-0.5, 0, 0.5]) {
    const rings = extractOne(field, threshold);
    assert.ok(rings.length > 0, `no rings at threshold ${threshold}`);
    for (const ring of rings) {
      assert.ok(ring.points.length >= 6);
      assert.ok(Number.isFinite(ring.signedArea));
    }
  }
});

test('ringSignedArea measures a unit square and reverses with its winding', () => {
  const clockwise = Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1]);
  const anticlockwise = Float64Array.from([0, 1, 1, 1, 1, 0, 0, 0]);
  assert.equal(ringSignedArea(clockwise), 1);
  assert.equal(ringSignedArea(anticlockwise), -1);
});

test('extractContourRings rejects a field it cannot index', () => {
  assert.throws(
    () => extractContourRings(new Float32Array(4), { width: 10, height: 10, threshold: 1 }),
    /too few/,
  );
  assert.throws(
    () => extractContourRings(new Float32Array(100), { width: 10, height: 10, thresholds: [] }),
    /non-empty/,
  );
  assert.throws(
    () => extractContourRings(new Float32Array(100), { width: 10, height: 10, thresholds: [5, 3] }),
    /ascending/,
  );
});
