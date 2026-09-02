import assert from 'node:assert/strict';
import test from 'node:test';

import { triangulate } from '../src/render/delaunay.js';
import {
  buildBandRegions,
  DEFAULT_MAX_TRIANGLE_SPAN_M,
  ringSignedArea,
} from '../src/render/band-regions.js';

const GRID_SIZE = 60;
const SPACING_M = 10;

/** A regular lattice of nodes, with travel time as distance from the centre,
 *  so the bands should come out as a disc inside concentric annuli of known
 *  area. */
function radialLattice(timeFor = (radius) => radius * SPACING_M) {
  const points = new Float64Array(GRID_SIZE * GRID_SIZE * 2);
  const seconds = new Float64Array(GRID_SIZE * GRID_SIZE);
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const index = y * GRID_SIZE + x;
      points[index * 2] = x * SPACING_M;
      points[index * 2 + 1] = y * SPACING_M;
      seconds[index] = timeFor(Math.hypot(x - GRID_SIZE / 2, y - GRID_SIZE / 2), x, y);
    }
  }
  return { points, seconds };
}

const bandEvery = (width, limit) => (secs) => (secs > limit ? null : Math.floor(secs / width));

test('triangulate finds a Delaunay triangulation', () => {
  const square = Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1]);
  assert.equal(triangulate(square).triangles.length / 3, 2);

  // Every triangle's circumcircle must be empty; checked exhaustively on a
  // small set rather than trusted.
  const count = 90;
  const points = new Float64Array(count * 2);
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let index = 0; index < count; index += 1) {
    points[index * 2] = random() * 100;
    points[index * 2 + 1] = random() * 100;
  }
  const { triangles } = triangulate(points);
  assert.ok(triangles.length > 0);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (let p = 0; p < count; p += 1) {
      if (p === a || p === b || p === c) continue;
      const dx = points[a * 2] - points[p * 2];
      const dy = points[a * 2 + 1] - points[p * 2 + 1];
      const ex = points[b * 2] - points[p * 2];
      const ey = points[b * 2 + 1] - points[p * 2 + 1];
      const fx = points[c * 2] - points[p * 2];
      const fy = points[c * 2 + 1] - points[p * 2 + 1];
      const determinant =
        dx * (ey * (fx * fx + fy * fy) - (ex * ex + ey * ey) * fy)
        - dy * (ex * (fx * fx + fy * fy) - (ex * ex + ey * ey) * fx)
        + (dx * dx + dy * dy) * (ex * fy - ey * fx);
      assert.ok(determinant >= -1e-9, `point ${p} lies inside a circumcircle`);
    }
  }
});

test('a band comes out as a complete annulus, not a disc needing its neighbour', () => {
  const { points, seconds } = radialLattice();
  const result = buildBandRegions(triangulate(points), seconds, {
    bandIndexForSeconds: bandEvery(100, 250),
    maxTriangleSpanM: 30,
  });

  assert.deepEqual(result.bands.map((band) => band.bandIndex), [0, 1, 2]);

  // The innermost band is a disc: one ring, no hole.
  const [innermost, middle] = result.bands;
  assert.equal(innermost.rings.length, 1);
  assert.equal(innermost.rings[0].isHole, false);

  // Every band beyond it is an annulus in its own right - an outer boundary
  // and the hole its neighbour occupies, wound oppositely - so it fills
  // correctly under either fill rule with nothing added to it.
  const outer = middle.rings.filter((ring) => !ring.isHole);
  const holes = middle.rings.filter((ring) => ring.isHole);
  assert.equal(outer.length, 1);
  assert.equal(holes.length, 1);
  assert.ok(Math.sign(outer[0].signedArea) !== Math.sign(holes[0].signedArea));

  // The hole is exactly the band inside it.
  assert.ok(Math.abs(Math.abs(holes[0].signedArea) - Math.abs(innermost.rings[0].signedArea)) < 1e-6);
});

test('band areas match the circles they stand for', () => {
  const { points, seconds } = radialLattice();
  const result = buildBandRegions(triangulate(points), seconds, {
    bandIndexForSeconds: bandEvery(100, 250),
    maxTriangleSpanM: 30,
  });
  const outerArea = (band) => Math.abs(
    band.rings.filter((ring) => !ring.isHole)
      .reduce((total, ring) => total + ring.signedArea, 0),
  );

  // A band's outer boundary is the circle of that travel time. The lattice is
  // 10 m apart, so a few percent of polygonal error is expected.
  for (const [bandIndex, radius] of [[0, 100], [1, 200]]) {
    const expected = Math.PI * radius * radius;
    const actual = outerArea(result.bands[bandIndex]);
    assert.ok(
      Math.abs(actual - expected) / expected < 0.15,
      `band ${bandIndex} covers ${actual.toFixed(0)}, expected about ${expected.toFixed(0)}`,
    );
  }
});

test('an unreachable pocket becomes a hole, and a gap is not bridged', () => {
  // A lake in the middle of the lattice: no nodes, so no triangles - except
  // the long ones that would span it, which the span limit is there to drop.
  const { points, seconds } = radialLattice();
  const kept = [];
  const keptSeconds = [];
  for (let index = 0; index < seconds.length; index += 1) {
    const x = points[index * 2];
    const y = points[index * 2 + 1];
    if (Math.hypot(x - 300, y - 300) < 80) {
      continue;
    }
    kept.push(x, y);
    keptSeconds.push(seconds[index]);
  }
  const lattice = Float64Array.from(kept);
  const result = buildBandRegions(triangulate(lattice), Float64Array.from(keptSeconds), {
    bandIndexForSeconds: () => 0,
    maxTriangleSpanM: 30,
  });

  assert.ok(result.spannedTriangles > 0, 'nothing was dropped for spanning the lake');
  const holes = result.bands[0].rings.filter((ring) => ring.isHole);
  assert.equal(holes.length, 1, 'the lake did not come out as a hole');
  const lakeArea = Math.abs(holes[0].signedArea);
  const expected = Math.PI * 80 * 80;
  assert.ok(lakeArea > expected * 0.5, `hole covers only ${lakeArea.toFixed(0)}`);
});

test('disjoint reachable areas come back as separate rings', () => {
  // What a transit isochrone does: reachable here, and also over there.
  const points = [];
  const seconds = [];
  for (const [centreX, centreY] of [[0, 0], [2000, 0]]) {
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        points.push(centreX + x * 20, centreY + y * 20);
        seconds.push(100);
      }
    }
  }
  const result = buildBandRegions(
    triangulate(Float64Array.from(points)),
    Float64Array.from(seconds),
    { bandIndexForSeconds: () => 0, maxTriangleSpanM: 50 },
  );
  const outers = result.bands[0].rings.filter((ring) => !ring.isHole);
  assert.equal(outers.length, 2, 'the two islands did not come back separately');
});

test('the span limit is the one length this costs, and it is in metres', () => {
  assert.equal(typeof DEFAULT_MAX_TRIANGLE_SPAN_M, 'number');
  assert.ok(DEFAULT_MAX_TRIANGLE_SPAN_M > 0);

  const { points, seconds } = radialLattice();
  const triangulation = triangulate(points);
  // Below the lattice spacing nothing survives; above it everything does.
  const tight = buildBandRegions(triangulation, seconds, {
    bandIndexForSeconds: () => 0,
    maxTriangleSpanM: 1,
  });
  assert.equal(tight.coveredTriangles, 0);
  const loose = buildBandRegions(triangulation, seconds, {
    bandIndexForSeconds: () => 0,
    maxTriangleSpanM: 1000,
  });
  assert.ok(loose.coveredTriangles > 6000);
});

test('ringSignedArea measures a unit square and reverses with its winding', () => {
  assert.equal(ringSignedArea(Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1])), 1);
  assert.equal(ringSignedArea(Float64Array.from([0, 1, 1, 1, 1, 0, 0, 0])), -1);
});
