// Filled isochrone bands as polygons, from the triangulation.
//
// A band is the set of ground whose travel time falls between two thresholds,
// so each triangle is *clipped* to the bands it overlaps rather than assigned
// whole to one of them. Assigning whole triangles - by the time of the slowest
// corner, say - decides a smoothly varying field one triangle at a time, and
// neighbours flip bands wherever the field crosses a threshold: the fills come
// out peppered with single-triangle specks. Clipping puts the boundary exactly
// where the travel time reaches the threshold, so a band edge is a smooth line
// through the triangles rather than a staircase around them.
//
// Merging the pieces is then combinatorial rather than geometric. Along a
// shared triangle edge, both triangles cut at the same interpolated point -
// the same two corner values give the same answer - so their boundary pieces
// are identical and cancel against each other. Whatever is left is the band's
// boundary, already correctly wound. No boolean geometry, no tolerance.
//
// Holes and disjoint components need no handling at all: a park with no paths
// simply has no triangles, and an isochrone landing in several places simply
// produces several rings.

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
  return Math.max(
    (ax - bx) ** 2 + (ay - by) ** 2,
    (bx - cx) ** 2 + (by - cy) ** 2,
    (cx - ax) ** 2 + (cy - ay) ** 2,
  );
}

/**
 * Vertex identity for the pieces a clip produces.
 *
 * A corner of a triangle is itself. A point where a threshold crosses a
 * triangle edge is fixed by that edge and that threshold, and both triangles
 * sharing the edge compute it from the same two values - so identifying it by
 * (edge, threshold) makes their pieces cancel on integer equality, with no
 * floating-point comparison anywhere in the merge.
 */
function createVertexTable(coords, pointCount) {
  const crossingIds = new Map();
  const crossingX = [];
  const crossingY = [];

  return {
    cornerKey(pointIndex) {
      return pointIndex;
    },
    crossingKey(a, b, thresholdIndex, thresholdSeconds, secondsAt) {
      const low = a < b ? a : b;
      const high = a < b ? b : a;
      const edgeKey = low * pointCount + high;
      const key = `${edgeKey}:${thresholdIndex}`;
      const existing = crossingIds.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const lowSeconds = secondsAt(low);
      const highSeconds = secondsAt(high);
      const span = highSeconds - lowSeconds;
      const fraction = span === 0 ? 0.5 : (thresholdSeconds - lowSeconds) / span;
      const clamped = Math.min(1, Math.max(0, fraction));
      const id = pointCount + crossingX.length;
      crossingX.push(coords[2 * low] + (coords[2 * high] - coords[2 * low]) * clamped);
      crossingY.push(coords[2 * low + 1] + (coords[2 * high + 1] - coords[2 * low + 1]) * clamped);
      crossingIds.set(key, id);
      return id;
    },
    positionOf(key) {
      if (key < pointCount) {
        return [coords[2 * key], coords[2 * key + 1]];
      }
      const index = key - pointCount;
      return [crossingX[index], crossingY[index]];
    },
  };
}

/**
 * Clips a polygon, whose vertices carry a travel time, against one half-plane
 * in value space: keep where `inside` says so, and cut on the threshold.
 */
function clipToValue(polygon, thresholdSeconds, thresholdIndex, keepBelow, vertices) {
  const output = [];
  const count = polygon.length;
  for (let index = 0; index < count; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % count];
    const currentInside = keepBelow
      ? current.seconds <= thresholdSeconds
      : current.seconds >= thresholdSeconds;
    const nextInside = keepBelow
      ? next.seconds <= thresholdSeconds
      : next.seconds >= thresholdSeconds;
    if (currentInside) {
      output.push(current);
    }
    if (currentInside !== nextInside) {
      // The cut lands on a triangle edge only when both ends are corners; a
      // cut against a previous threshold has already produced a point, and
      // cutting it again would be cutting a straight line at its own value.
      if (current.pointIndex !== null && next.pointIndex !== null) {
        const key = vertices.crossingKey(
          current.pointIndex,
          next.pointIndex,
          thresholdIndex,
          thresholdSeconds,
          (pointIndex) => (pointIndex === current.pointIndex ? current.seconds : next.seconds),
        );
        output.push({ key, pointIndex: null, seconds: thresholdSeconds });
      } else {
        const span = next.seconds - current.seconds;
        const fraction = span === 0 ? 0.5 : (thresholdSeconds - current.seconds) / span;
        output.push({
          key: null,
          pointIndex: null,
          seconds: thresholdSeconds,
          interpolated: { from: current, to: next, fraction },
        });
      }
    }
  }
  return output;
}

/**
 * Boundary rings per band, given a triangulation and a travel time per point.
 *
 * `thresholds` are the bands' upper bounds in seconds, ascending. Rings come
 * back in the triangulation's own coordinates, so a caller scales them into
 * whatever it is drawing into - which is the point of doing this in vector.
 */
export function buildBandRegions(triangulation, distSeconds, options = {}) {
  const { triangles, coords } = triangulation;
  const thresholds = options.thresholds;
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    throw new Error('options.thresholds must be a non-empty ascending array of seconds');
  }
  const maxSpanM = options.maxTriangleSpanM ?? DEFAULT_MAX_TRIANGLE_SPAN_M;
  // Generalisation, not smoothing. The small pockets that survive clipping are
  // real - a cul-de-sac's far end is minutes away along the road and metres
  // away across the grass, so its interior genuinely falls in the next band -
  // but a map does not draw a feature too small to read, and hundreds of them
  // register as noise rather than as information. Dropping a tiny outer ring
  // loses the pocket; dropping a tiny hole fills it. Both say the same thing:
  // below this size the distinction is not being drawn.
  const minimumRingArea = options.minimumRingArea ?? 0;
  const maxSpanSquared = maxSpanM * maxSpanM;
  const pointCount = coords.length >> 1;
  const vertices = createVertexTable(coords, pointCount);

  const edgesByBand = new Map();
  const interpolatedPoints = [];
  const resolveKey = (vertex) => {
    if (vertex.key !== null) {
      return vertex.key;
    }
    // A cut across an already-cut edge. It belongs to one triangle alone, so
    // it needs no shared identity - only a unique one.
    const [fromX, fromY] = vertices.positionOf(vertex.interpolated.from.key);
    const [toX, toY] = vertices.positionOf(vertex.interpolated.to.key);
    const id = -1 - interpolatedPoints.length / 2;
    interpolatedPoints.push(
      fromX + (toX - fromX) * vertex.interpolated.fraction,
      fromY + (toY - fromY) * vertex.interpolated.fraction,
    );
    vertex.key = id;
    return id;
  };
  const positionOf = (key) => (key < 0
    ? [interpolatedPoints[(-1 - key) * 2], interpolatedPoints[(-1 - key) * 2 + 1]]
    : vertices.positionOf(key));

  const addEdge = (bandIndex, from, to) => {
    if (from === to) {
      return;
    }
    let edges = edgesByBand.get(bandIndex);
    if (edges === undefined) {
      edges = new Map();
      edgesByBand.set(bandIndex, edges);
    }
    const reverseKey = `${to}|${from}`;
    if (edges.has(reverseKey)) {
      edges.delete(reverseKey);
      return;
    }
    edges.set(`${from}|${to}`, [from, to]);
  };

  const bandIndexOf = (seconds) => {
    let low = 0;
    let high = thresholds.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (thresholds[mid] <= seconds) low = mid + 1; else high = mid;
    }
    return low;
  };

  // The clipped pieces themselves, kept as triangles per band. Merging them
  // into rings is what a stroked outline and an SVG fill need; a GPU wants the
  // area, and the pieces already are the area - each is convex, so a fan off
  // its first vertex triangulates it exactly with no tessellation step.
  const wantsTriangles = options.collectTriangles === true;
  const trianglesByBand = new Map();
  let clippedPieces = 0;
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

    const lowestBand = bandIndexOf(Math.min(ta, tb, tc));
    const highestBand = bandIndexOf(Math.max(ta, tb, tc));
    if (lowestBand >= thresholds.length) {
      continue;
    }

    const corners = [
      { key: vertices.cornerKey(a), pointIndex: a, seconds: ta },
      { key: vertices.cornerKey(b), pointIndex: b, seconds: tb },
      { key: vertices.cornerKey(c), pointIndex: c, seconds: tc },
    ];

    for (
      let bandIndex = lowestBand;
      bandIndex <= Math.min(highestBand, thresholds.length - 1);
      bandIndex += 1
    ) {
      let polygon = corners;
      if (bandIndex > 0) {
        polygon = clipToValue(polygon, thresholds[bandIndex - 1], bandIndex - 1, false, vertices);
        if (polygon.length < 3) continue;
      }
      polygon = clipToValue(polygon, thresholds[bandIndex], bandIndex, true, vertices);
      if (polygon.length < 3) continue;

      clippedPieces += 1;
      const keys = polygon.map(resolveKey);
      for (let index = 0; index < keys.length; index += 1) {
        addEdge(bandIndex, keys[index], keys[(index + 1) % keys.length]);
      }
      if (wantsTriangles) {
        let fan = trianglesByBand.get(bandIndex);
        if (fan === undefined) {
          fan = [];
          trianglesByBand.set(bandIndex, fan);
        }
        const [originX, originY] = positionOf(keys[0]);
        for (let index = 1; index + 1 < keys.length; index += 1) {
          const [x1, y1] = positionOf(keys[index]);
          const [x2, y2] = positionOf(keys[index + 1]);
          fan.push(originX, originY, x1, y1, x2, y2);
        }
      }
    }
  }

  const bands = [];
  for (const [bandIndex, edges] of [...edgesByBand.entries()].sort((x, y) => x[0] - y[0])) {
    const rings = stitchRings(edges, positionOf, minimumRingArea);
    if (rings.length > 0) {
      const band = { bandIndex, rings };
      if (wantsTriangles) {
        band.triangles = Float32Array.from(trianglesByBand.get(bandIndex) ?? []);
      }
      bands.push(band);
    }
  }
  return { bands, clippedPieces, spannedTriangles, maxTriangleSpanM: maxSpanM };
}

function stitchRings(edges, positionOf, minimumRingArea) {
  const outgoing = new Map();
  for (const [from, to] of edges.values()) {
    const list = outgoing.get(from);
    if (list === undefined) outgoing.set(from, [to]); else list.push(to);
  }

  const rings = [];
  for (const startKey of outgoing.keys()) {
    for (;;) {
      const first = outgoing.get(startKey);
      if (first === undefined || first.length === 0) break;
      const points = [];
      let current = startKey;
      for (;;) {
        const list = outgoing.get(current);
        if (list === undefined || list.length === 0) break;
        const next = list.pop();
        const [x, y] = positionOf(current);
        points.push(x, y);
        current = next;
        if (current === startKey) break;
      }
      if (points.length >= 6) {
        const ringPoints = Float64Array.from(points);
        const signedArea = ringSignedArea(ringPoints);
        if (Math.abs(signedArea) < minimumRingArea) {
          continue;
        }
        // The triangulation winds clockwise in these coordinates, so a band's
        // outer boundary comes out negative and a hole positive. Each band is
        // therefore a finished annulus and fills correctly under either fill
        // rule with nothing added to it.
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
