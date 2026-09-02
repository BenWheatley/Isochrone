// Filled isochrone bands as polygons, straight from the triangulation.
//
// A triangle is reachable by the time its slowest corner is, so each triangle
// falls in exactly one band. Merging the triangles of a band is then purely
// combinatorial: an edge shared by two triangles of the same band is interior
// and cancels against its own reverse, and whatever is left is the boundary,
// already correctly wound. No boolean geometry, no tolerance, no raster.
//
// Holes and disjoint components need no special handling - a park with no
// paths through it simply has no triangles, and a transit isochrone landing in
// several places simply produces several rings.

/**
 * How far apart two nodes may be and still have the ground between them
 * counted as covered.
 *
 * This is the one length this construction costs, and unlike a raster's cell
 * size it means something: it is the widest gap in the network that should
 * still read as filled. Below it lies a city block; above it lies a river, a
 * railway, an airfield, or the edge of the network - and Delaunay's habit of
 * maximising the minimum angle is what makes those show up as the long thin
 * triangles this then discards.
 */
export const DEFAULT_MAX_TRIANGLE_SPAN_M = 300;

function longestEdgeSquared(coords, a, b, c) {
  const ax = coords[2 * a];
  const ay = coords[2 * a + 1];
  const bx = coords[2 * b];
  const by = coords[2 * b + 1];
  const cx = coords[2 * c];
  const cy = coords[2 * c + 1];
  const ab = (ax - bx) ** 2 + (ay - by) ** 2;
  const bc = (bx - cx) ** 2 + (by - cy) ** 2;
  const ca = (cx - ax) ** 2 + (cy - ay) ** 2;
  return Math.max(ab, bc, ca);
}

/**
 * Boundary rings for each band, given a triangulation and a travel time per
 * point.
 *
 * `bandIndexForSeconds` maps a travel time to a band; returning null drops the
 * triangle. Rings come back in the triangulation's own coordinates, so a
 * caller scales them into whatever it is drawing into - which is the whole
 * point of doing this in vector.
 */
export function buildBandRegions(triangulation, distSeconds, options = {}) {
  const { triangles, coords } = triangulation;
  const bandIndexForSeconds = options.bandIndexForSeconds;
  if (typeof bandIndexForSeconds !== 'function') {
    throw new Error('options.bandIndexForSeconds must be a function');
  }
  const maxSpanM = options.maxTriangleSpanM ?? DEFAULT_MAX_TRIANGLE_SPAN_M;
  const maxSpanSquared = maxSpanM * maxSpanM;
  const pointCount = coords.length >> 1;

  // Directed edges per band. An interior edge meets its own reverse from the
  // neighbouring triangle and both disappear; a boundary edge is left alone.
  const edgesByBand = new Map();
  const addEdge = (bandIndex, from, to) => {
    let edges = edgesByBand.get(bandIndex);
    if (edges === undefined) {
      edges = new Map();
      edgesByBand.set(bandIndex, edges);
    }
    const reverseKey = to * pointCount + from;
    if (edges.has(reverseKey)) {
      edges.delete(reverseKey);
      return;
    }
    edges.set(from * pointCount + to, to);
  };

  let coveredTriangles = 0;
  let spannedTriangles = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    const ta = distSeconds[a];
    const tb = distSeconds[b];
    const tc = distSeconds[c];
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || !Number.isFinite(tc)) {
      continue;
    }
    if (longestEdgeSquared(coords, a, b, c) > maxSpanSquared) {
      spannedTriangles += 1;
      continue;
    }
    // The slowest corner: the ground inside a triangle is not all reachable
    // before every corner of it is.
    const bandIndex = bandIndexForSeconds(Math.max(ta, tb, tc));
    if (bandIndex === null || bandIndex === undefined) {
      continue;
    }
    coveredTriangles += 1;
    addEdge(bandIndex, a, b);
    addEdge(bandIndex, b, c);
    addEdge(bandIndex, c, a);
  }

  const bands = [];
  for (const [bandIndex, edges] of [...edgesByBand.entries()].sort((x, y) => x[0] - y[0])) {
    bands.push({ bandIndex, rings: stitchRings(edges, coords, pointCount) });
  }
  return { bands, coveredTriangles, spannedTriangles, maxTriangleSpanM: maxSpanM };
}

function stitchRings(edges, coords, pointCount) {
  // Several boundary edges can leave one vertex where a region pinches, so the
  // walk consumes edges rather than assuming one successor per point.
  const outgoing = new Map();
  for (const key of edges.keys()) {
    const from = Math.floor(key / pointCount);
    const to = key % pointCount;
    const list = outgoing.get(from);
    if (list === undefined) {
      outgoing.set(from, [to]);
    } else {
      list.push(to);
    }
  }

  const rings = [];
  for (const startPoint of outgoing.keys()) {
    for (;;) {
      const firstList = outgoing.get(startPoint);
      if (firstList === undefined || firstList.length === 0) {
        break;
      }
      const points = [];
      let current = startPoint;
      for (;;) {
        const list = outgoing.get(current);
        if (list === undefined || list.length === 0) {
          break;
        }
        const next = list.pop();
        points.push(coords[2 * current], coords[2 * current + 1]);
        current = next;
        if (current === startPoint) {
          break;
        }
      }
      if (points.length >= 6) {
        const ringPoints = Float64Array.from(points);
        const signedArea = ringSignedArea(ringPoints);
        // The triangulation winds clockwise in these coordinates, so a band's
        // outer boundary comes out negative and the hole it leaves for the
        // band inside it comes out positive. Each band is therefore already a
        // complete annulus - outer plus holes, oppositely wound - and fills
        // correctly under either fill rule with nothing added.
        rings.push({ points: ringPoints, signedArea, isHole: signedArea > 0 });
      }
    }
  }
  return rings;
}

export function ringSignedArea(points) {
  let total = 0;
  const count = points.length / 2;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    total += points[index * 2] * points[next * 2 + 1] - points[next * 2] * points[index * 2 + 1];
  }
  return total / 2;
}
