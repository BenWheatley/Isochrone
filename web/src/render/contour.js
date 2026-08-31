// Closed contour rings from a travel-time raster, by marching squares.
//
// Monochrome renders filled, hatched bands rather than coloured lines, and a
// band needs a boundary. The isochrone is computed on the road network, so no
// boundary exists in the routing result: the edges are ~100k disjoint
// segments, not a shape. The alternative to contouring is buffering every
// segment and unioning the results, which is a 2D boolean geometry engine over
// 100k shapes per band - see docs/monochrome-rendering-plan.md for why that
// was rejected.
//
// The raster this reads is a transient rendering intermediate sized to the
// output, not a persistent graph-sized buffer. That distinction is load-
// bearing: a graph-sized grid per region is exactly the allocation that was
// removed from initializeMapData.

// A vertex sits on a grid edge, and is keyed by that edge rather than by its
// coordinates. Two cells sharing an edge then agree on the vertex exactly, by
// construction, so rings stitch together on integer identity with no
// floating-point tolerance anywhere.

/**
 * Marching-squares case table, indexed by which corners are inside:
 * top-left 8, top-right 4, bottom-right 2, bottom-left 1.
 *
 * Each entry lists directed segments as pairs of cell sides, so that following
 * "to" into the neighbouring cell always arrives at its "from". Complementary
 * cases run in opposite directions, which is what makes an outer boundary and
 * a hole wind opposite ways - and therefore what makes even-odd fill work
 * without classifying either.
 *
 * Sides: 0 top, 1 right, 2 bottom, 3 left. The two saddles are resolved at
 * runtime from the cell's mean, so they are absent here.
 */
const SIDE_TOP = 0;
const SIDE_RIGHT = 1;
const SIDE_BOTTOM = 2;
const SIDE_LEFT = 3;

const MARCHING_SQUARES_SEGMENTS = [
  [], // 0000
  [[SIDE_LEFT, SIDE_BOTTOM]], // 0001
  [[SIDE_BOTTOM, SIDE_RIGHT]], // 0010
  [[SIDE_LEFT, SIDE_RIGHT]], // 0011
  [[SIDE_RIGHT, SIDE_TOP]], // 0100
  null, // 0101 saddle
  [[SIDE_BOTTOM, SIDE_TOP]], // 0110
  [[SIDE_LEFT, SIDE_TOP]], // 0111
  [[SIDE_TOP, SIDE_LEFT]], // 1000
  [[SIDE_TOP, SIDE_BOTTOM]], // 1001
  null, // 1010 saddle
  [[SIDE_TOP, SIDE_RIGHT]], // 1011
  [[SIDE_RIGHT, SIDE_LEFT]], // 1100
  [[SIDE_RIGHT, SIDE_BOTTOM]], // 1101
  [[SIDE_BOTTOM, SIDE_LEFT]], // 1110
  [], // 1111
];

// 0101: top-right and bottom-left inside. A mean inside the threshold means
// those two connect through the middle and it is the *outside* corners that
// are isolated pockets; a mean outside means the reverse.
const SADDLE_0101_JOINED = [
  [SIDE_TOP, SIDE_LEFT],
  [SIDE_BOTTOM, SIDE_RIGHT],
];
const SADDLE_0101_SPLIT = [
  [SIDE_LEFT, SIDE_BOTTOM],
  [SIDE_RIGHT, SIDE_TOP],
];
// 1010: top-left and bottom-right inside.
const SADDLE_1010_JOINED = [
  [SIDE_TOP, SIDE_RIGHT],
  [SIDE_BOTTOM, SIDE_LEFT],
];
const SADDLE_1010_SPLIT = [
  [SIDE_TOP, SIDE_LEFT],
  [SIDE_BOTTOM, SIDE_RIGHT],
];

function validateField(field, width, height) {
  if (!field || typeof field.length !== 'number') {
    throw new Error('field must be an array-like of sample values');
  }
  if (!Number.isInteger(width) || width < 2) {
    throw new Error('width must be an integer of at least 2');
  }
  if (!Number.isInteger(height) || height < 2) {
    throw new Error('height must be an integer of at least 2');
  }
  if (field.length < width * height) {
    throw new Error(
      `field holds ${field.length} samples, too few for ${width}x${height}`,
    );
  }
}

function normalizeThresholds(options) {
  const raw = Array.isArray(options.thresholds)
    ? options.thresholds
    : [options.threshold];
  const thresholds = raw.map(Number);
  if (thresholds.length === 0 || thresholds.some((value) => !Number.isFinite(value))) {
    throw new Error('thresholds must be a non-empty list of finite numbers');
  }
  for (let index = 1; index < thresholds.length; index += 1) {
    if (thresholds[index] <= thresholds[index - 1]) {
      throw new Error('thresholds must be strictly ascending');
    }
  }
  return thresholds;
}

/**
 * Closed rings of the regions where the field is at or below each threshold.
 *
 * Coordinates are in field sample units: (0, 0) is the first sample, and a
 * vertex at x = 2.5 lies midway between samples 2 and 3. A caller scales those
 * into output pixels.
 *
 * The field is treated as though surrounded by unreachable samples, so a
 * region running off the raster still closes rather than producing an open
 * polyline the fill rule cannot use.
 */
export function extractContourRings(field, options = {}) {
  const width = options.width;
  const height = options.height;
  validateField(field, width, height);
  const thresholds = normalizeThresholds(options);

  // Padded sample space: one ring of unreachable samples around the field.
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  const horizontalEdgeCount = (paddedWidth - 1) * paddedHeight;

  const sampleAt = (paddedX, paddedY) => {
    const x = paddedX - 1;
    const y = paddedY - 1;
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return Number.POSITIVE_INFINITY;
    }
    const value = field[y * width + x];
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };

  // One traversal map and vertex store per threshold.
  const nextEdgeByThreshold = thresholds.map(() => new Map());
  const vertexByThreshold = thresholds.map(() => new Map());

  const edgeIdForSide = (cellX, cellY, side) => {
    if (side === SIDE_TOP) {
      return cellY * (paddedWidth - 1) + cellX;
    }
    if (side === SIDE_BOTTOM) {
      return (cellY + 1) * (paddedWidth - 1) + cellX;
    }
    if (side === SIDE_LEFT) {
      return horizontalEdgeCount + cellY * paddedWidth + cellX;
    }
    return horizontalEdgeCount + cellY * paddedWidth + cellX + 1;
  };

  // Where along the edge the contour crosses. Both endpoints unreachable
  // cannot happen (the edge would carry no crossing); one endpoint
  // unreachable gives no meaningful fraction, so the crossing is put at the
  // midpoint - the raster is finer than the features it is drawing.
  const crossingFraction = (nearValue, farValue, threshold) => {
    if (!Number.isFinite(nearValue) || !Number.isFinite(farValue)) {
      return 0.5;
    }
    const span = farValue - nearValue;
    if (span === 0) {
      return 0.5;
    }
    const fraction = (threshold - nearValue) / span;
    if (!Number.isFinite(fraction)) {
      return 0.5;
    }
    return Math.min(1, Math.max(0, fraction));
  };

  const vertexForSide = (cellX, cellY, side, corners, threshold) => {
    const [topLeft, topRight, bottomRight, bottomLeft] = corners;
    if (side === SIDE_TOP) {
      return [cellX + crossingFraction(topLeft, topRight, threshold), cellY];
    }
    if (side === SIDE_BOTTOM) {
      return [cellX + crossingFraction(bottomLeft, bottomRight, threshold), cellY + 1];
    }
    if (side === SIDE_LEFT) {
      return [cellX, cellY + crossingFraction(topLeft, bottomLeft, threshold)];
    }
    return [cellX + 1, cellY + crossingFraction(topRight, bottomRight, threshold)];
  };

  for (let cellY = 0; cellY < paddedHeight - 1; cellY += 1) {
    for (let cellX = 0; cellX < paddedWidth - 1; cellX += 1) {
      const topLeft = sampleAt(cellX, cellY);
      const topRight = sampleAt(cellX + 1, cellY);
      const bottomRight = sampleAt(cellX + 1, cellY + 1);
      const bottomLeft = sampleAt(cellX, cellY + 1);

      // A cell only contributes to thresholds that fall between its own
      // extremes, which for a smooth field is nearly none of them. This is
      // what keeps one pass over the raster serving every band.
      let minimum = topLeft;
      let maximum = topLeft;
      for (const value of [topRight, bottomRight, bottomLeft]) {
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
      }
      if (!(minimum <= maximum)) {
        continue;
      }

      const corners = [topLeft, topRight, bottomRight, bottomLeft];
      for (let index = 0; index < thresholds.length; index += 1) {
        const threshold = thresholds[index];
        if (threshold < minimum || threshold >= maximum) {
          continue;
        }

        const caseIndex =
          (topLeft <= threshold ? 8 : 0)
          | (topRight <= threshold ? 4 : 0)
          | (bottomRight <= threshold ? 2 : 0)
          | (bottomLeft <= threshold ? 1 : 0);

        let segments = MARCHING_SQUARES_SEGMENTS[caseIndex];
        if (segments === null) {
          const mean = (topLeft + topRight + bottomRight + bottomLeft) / 4;
          const joined = mean <= threshold;
          if (caseIndex === 5) {
            segments = joined ? SADDLE_0101_JOINED : SADDLE_0101_SPLIT;
          } else {
            segments = joined ? SADDLE_1010_JOINED : SADDLE_1010_SPLIT;
          }
        }
        if (segments.length === 0) {
          continue;
        }

        const nextEdge = nextEdgeByThreshold[index];
        const vertices = vertexByThreshold[index];
        for (const [fromSide, toSide] of segments) {
          const fromEdge = edgeIdForSide(cellX, cellY, fromSide);
          const toEdge = edgeIdForSide(cellX, cellY, toSide);
          nextEdge.set(fromEdge, toEdge);
          if (!vertices.has(fromEdge)) {
            vertices.set(fromEdge, vertexForSide(cellX, cellY, fromSide, corners, threshold));
          }
          if (!vertices.has(toEdge)) {
            vertices.set(toEdge, vertexForSide(cellX, cellY, toSide, corners, threshold));
          }
        }
      }
    }
  }

  return thresholds.map((threshold, index) => ({
    threshold,
    rings: stitchRings(nextEdgeByThreshold[index], vertexByThreshold[index]),
  }));
}

function stitchRings(nextEdge, vertices) {
  const rings = [];
  const visited = new Set();
  for (const startEdge of nextEdge.keys()) {
    if (visited.has(startEdge)) {
      continue;
    }
    const points = [];
    let edge = startEdge;
    // Every edge has exactly one successor, so following them can only
    // terminate by returning to the start: the walk is a permutation cycle.
    while (!visited.has(edge)) {
      visited.add(edge);
      const vertex = vertices.get(edge);
      // Back out of padded space, so callers see plain sample coordinates.
      points.push(vertex[0] - 1, vertex[1] - 1);
      const successor = nextEdge.get(edge);
      if (successor === undefined) {
        break;
      }
      edge = successor;
    }
    if (points.length >= 6) {
      const ringPoints = Float64Array.from(points);
      const signedArea = ringSignedArea(ringPoints);
      // Raster coordinates run y-downwards, which flips the usual convention:
      // an outer boundary comes out positive here and a hole negative.
      rings.push({ points: ringPoints, signedArea, isHole: signedArea < 0 });
    }
  }
  return rings;
}

/**
 * Twice-signed area by the shoelace formula. The sign is the ring's winding,
 * which is what separates an outer boundary from a hole.
 */
export function ringSignedArea(points) {
  let total = 0;
  const count = points.length / 2;
  for (let index = 0; index < count; index += 1) {
    const nextIndex = (index + 1) % count;
    total +=
      points[index * 2] * points[nextIndex * 2 + 1]
      - points[nextIndex * 2] * points[index * 2 + 1];
  }
  return total / 2;
}

/** Even-odd crossing test, used to nest holes inside their parents. */
export function ringContainsPoint(points, x, y) {
  let inside = false;
  const count = points.length / 2;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    const xi = points[index * 2];
    const yi = points[index * 2 + 1];
    const xj = points[previous * 2];
    const yj = points[previous * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
