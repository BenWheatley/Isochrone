// The isochrone as a zone around the ways, rather than a surface over the nodes.
//
// A travel time is defined on the network, so the ground it describes is the
// ground near the network. Every reachable way is drawn as a zone of fixed
// width on the finished sheet: dense streets overlap into a filled area, a
// single rural road becomes a corridor of that same width running between two
// towns, and two places with no way between them stay apart because there is
// nothing to widen. Nothing is interpolated across ground that carries no way,
// so the map never claims a crossing the network does not have.
//
// The width is a property of the output and not of the world - it is a
// generalisation, the same decision as the weight of a road on a paper map -
// so it is stated in millimetres of finished sheet and converted by whatever
// is drawing it. Screen and print then agree about the map without agreeing
// about pixels.
//
// Time varies along a way, not per node: a rural way whose ends are eight
// minutes apart crosses a band boundary somewhere in the middle of it. So the
// band is a property of position along the way, and a boundary falls at an
// interpolated point - the same interpolation the colour renderer already
// makes, from the same buffer.

/** Width of the zone drawn around a way, on the finished sheet. */
export const RIBBON_WIDTH_MM = 15;

/** Nominal CSS reference resolution, 96 dpi: the one place mm and px meet. */
export const OUTPUT_PIXELS_PER_MM = 96 / 25.4;

/** Six floats per segment: x0, y0, seconds0, x1, y1, seconds1. */
export const RIBBON_SEGMENT_STRIDE = 6;

export function ribbonWidthPx(widthMm = RIBBON_WIDTH_MM, pixelsPerMm = OUTPUT_PIXELS_PER_MM) {
  return widthMm * pixelsPerMm;
}

/**
 * Where the ways cross a band boundary.
 *
 * One crossing per boundary per segment that spans it, carrying the point in
 * graph pixels, the boundary's own time, and the direction of the way there.
 * A contour runs across the way rather than along it, so the direction of the
 * way is the normal of the contour and the label sits square to it.
 *
 * Most segments span no boundary at all - a few seconds of walking against a
 * band of fifteen minutes - so this is far smaller than the segment list.
 */
export function collectBandBoundaryCrossings(segments, bandSeconds) {
  if (!(bandSeconds > 0)) {
    throw new Error('bandSeconds must be positive');
  }
  const crossings = [];
  for (let offset = 0; offset + 5 < segments.length; offset += RIBBON_SEGMENT_STRIDE) {
    const fromSeconds = segments[offset + 2];
    const toSeconds = segments[offset + 5];
    const lowest = Math.floor(Math.min(fromSeconds, toSeconds) / bandSeconds);
    const highest = Math.floor(Math.max(fromSeconds, toSeconds) / bandSeconds);
    if (lowest === highest) {
      continue;
    }
    const fromX = segments[offset];
    const fromY = segments[offset + 1];
    const toX = segments[offset + 3];
    const toY = segments[offset + 4];
    const span = toSeconds - fromSeconds;
    if (span === 0) {
      continue;
    }
    for (let boundary = lowest + 1; boundary <= highest; boundary += 1) {
      const seconds = boundary * bandSeconds;
      // Strictly inside the way. A boundary landing exactly on an end is the
      // start of the next way, not a crossing of this one, and counting it
      // here would place two contours on one point.
      const fraction = (seconds - fromSeconds) / span;
      if (!(fraction > 0) || !(fraction < 1)) {
        continue;
      }
      crossings.push({
        x: fromX + (toX - fromX) * fraction,
        y: fromY + (toY - fromY) * fraction,
        seconds,
        wayX: toX - fromX,
        wayY: toY - fromY,
      });
    }
  }
  return crossings;
}

/**
 * Contour labels, thinned so they do not sit on top of one another.
 *
 * Acceptance is a distance test against what has already been placed rather
 * than a bucket per cell, so which label survives does not depend on where a
 * grid happens to fall - the cells here only narrow the search.
 *
 * A label is set along its own contour, and the contour's direction is taken
 * from the other crossings of the same boundary nearby, not from the way that
 * happens to cross it. The way is only the normal of the contour where it runs
 * straight out from the origin; a ring road meets the same boundary running
 * along it, and reading the angle off that road stood the label at right
 * angles to the line it belongs to.
 */
export function planRibbonContourLabels(crossings, options) {
  const {
    transform,
    widthPx,
    heightPx,
    spacingPx = 220,
    formatLabel,
    marginPx = 0,
  } = options;
  const kept = [];
  const buckets = new Map();
  const columns = Math.ceil(widthPx / spacingPx) + 3;

  // Crossings of one boundary, indexed by where they are, so the direction of
  // a contour can be read off its own neighbours.
  const neighbourhood = buildCrossingIndex(crossings, transform, spacingPx);

  for (const crossing of crossings) {
    const [x, y] = transform(crossing.x, crossing.y);
    if (x < -marginPx || y < -marginPx || x > widthPx + marginPx || y > heightPx + marginPx) {
      continue;
    }
    const column = Math.floor(x / spacingPx) + 1;
    const row = Math.floor(y / spacingPx) + 1;
    let crowded = false;
    for (let dy = -1; dy <= 1 && !crowded; dy += 1) {
      for (let dx = -1; dx <= 1 && !crowded; dx += 1) {
        const neighbours = buckets.get((row + dy) * columns + (column + dx));
        if (neighbours === undefined) {
          continue;
        }
        for (const other of neighbours) {
          if (Math.hypot(other.x - x, other.y - y) < spacingPx) {
            crowded = true;
            break;
          }
        }
      }
    }
    if (crowded) {
      continue;
    }

    const angleDegrees = contourAngleDegrees(neighbourhood, crossing.seconds, x, y, spacingPx)
      ?? acrossTheWayDegrees(crossing);
    const label = {
      x,
      y,
      angleDegrees,
      seconds: crossing.seconds,
      text: formatLabel(crossing.seconds),
    };
    kept.push(label);
    const key = row * columns + column;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [label]);
    } else {
      bucket.push(label);
    }
  }
  return kept;
}

/** Output-space positions of every crossing, bucketed by boundary and cell. */
function buildCrossingIndex(crossings, transform, cellPx) {
  const byBoundary = new Map();
  for (const crossing of crossings) {
    const [x, y] = transform(crossing.x, crossing.y);
    let cells = byBoundary.get(crossing.seconds);
    if (cells === undefined) {
      cells = new Map();
      byBoundary.set(crossing.seconds, cells);
    }
    const key = `${Math.floor(y / cellPx)}|${Math.floor(x / cellPx)}`;
    const cell = cells.get(key);
    if (cell === undefined) {
      cells.set(key, [x, y]);
    } else {
      cell.push(x, y);
    }
  }
  return { byBoundary, cellPx };
}

/**
 * The direction of a contour at a point, from the spread of the boundary's own
 * crossings around it.
 *
 * The principal axis of those points is the line they lie along, which is the
 * contour. Returns null where there are too few of them to say, or where they
 * are scattered rather than strung out - a junction of several contours, where
 * any angle would be a guess.
 */
function contourAngleDegrees(index, seconds, x, y, radiusPx) {
  const cells = index.byBoundary.get(seconds);
  if (cells === undefined) {
    return null;
  }
  const column = Math.floor(x / index.cellPx);
  const row = Math.floor(y / index.cellPx);
  let count = 0;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const cell = cells.get(`${row + dy}|${column + dx}`);
      if (cell === undefined) {
        continue;
      }
      for (let index2 = 0; index2 + 1 < cell.length; index2 += 2) {
        const offsetX = cell[index2] - x;
        const offsetY = cell[index2 + 1] - y;
        if (Math.hypot(offsetX, offsetY) > radiusPx) {
          continue;
        }
        count += 1;
        sumXX += offsetX * offsetX;
        sumXY += offsetX * offsetY;
        sumYY += offsetY * offsetY;
      }
    }
  }
  if (count < 4) {
    return null;
  }

  // Principal axis of the covariance, and how strongly the points prefer it.
  const trace = sumXX + sumYY;
  const difference = Math.hypot(sumXX - sumYY, 2 * sumXY);
  if (trace <= 0 || difference / trace < 0.25) {
    return null;
  }
  const angle = 0.5 * Math.atan2(2 * sumXY, sumXX - sumYY);
  return uprightDegrees((angle * 180) / Math.PI);
}

/** The fallback: square to the way, which is right where it crosses squarely. */
function acrossTheWayDegrees(crossing) {
  return uprightDegrees((Math.atan2(crossing.wayY, crossing.wayX) * 180) / Math.PI + 90);
}

/** Turned to within a quarter turn of level, so a value is never upside down. */
function uprightDegrees(degrees) {
  let upright = degrees;
  while (upright > 90) {
    upright -= 180;
  }
  while (upright < -90) {
    upright += 180;
  }
  return upright;
}

/**
 * The ways cut at every band boundary, gathered per band, farthest band first.
 *
 * Zones overlap: a way in the twenty-minute band and a way in the
 * twenty-five-minute band can be metres apart, and their zones - fifteen
 * millimetres wide on the sheet - cover much the same ground. What should be
 * true of that ground is the earlier of the two times, because that is when
 * you can first be there. Painting in this order makes it so without any test:
 * the nearer band is drawn last, over the farther one, so the edge between two
 * fills is the isoline itself and needs no separate line to mark it.
 *
 * One buffer with a range per band, rather than a buffer per band, so a draw
 * costs one range and the whole set is still uploaded once.
 */
export function buildBandOrderedSegments(segments, bandSeconds) {
  if (!(bandSeconds > 0)) {
    throw new Error('bandSeconds must be positive');
  }

  // Counted first, then written. Berlin yields over half a million pieces, and
  // growing an array per band to hold them was the single most expensive thing
  // the scene did - millions of boxed pushes and the collection they feed, on
  // a path that runs every time the start point moves.
  const countByBand = new Map();
  forEachBandPiece(segments, bandSeconds, (band) => {
    countByBand.set(band, (countByBand.get(band) ?? 0) + 1);
  });

  const bands = [...countByBand.keys()].sort((a, b) => b - a);
  const ranges = [];
  let first = 0;
  const cursorByBand = new Map();
  for (const band of bands) {
    const count = countByBand.get(band);
    ranges.push({ band, first, count });
    cursorByBand.set(band, first * RIBBON_SEGMENT_STRIDE);
    first += count;
  }

  const data = new Float32Array(first * RIBBON_SEGMENT_STRIDE);
  forEachBandPiece(segments, bandSeconds, (band, x0, y0, t0, x1, y1, t1) => {
    const offset = cursorByBand.get(band);
    data[offset] = x0;
    data[offset + 1] = y0;
    data[offset + 2] = t0;
    data[offset + 3] = x1;
    data[offset + 4] = y1;
    data[offset + 5] = t1;
    cursorByBand.set(band, offset + RIBBON_SEGMENT_STRIDE);
  });
  return { data, ranges };
}

/**
 * Every way cut at every band boundary it crosses, one piece at a time.
 *
 * Walked twice by the caller - once to count the pieces, once to place them -
 * because doing the arithmetic twice is far cheaper than growing an array to
 * discover the answer.
 */
function forEachBandPiece(segments, bandSeconds, visit) {
  for (let offset = 0; offset + 5 < segments.length; offset += RIBBON_SEGMENT_STRIDE) {
    const fromX = segments[offset];
    const fromY = segments[offset + 1];
    const fromSeconds = segments[offset + 2];
    const toX = segments[offset + 3];
    const toY = segments[offset + 4];
    const toSeconds = segments[offset + 5];
    if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds)) {
      continue;
    }
    const span = toSeconds - fromSeconds;
    const lowest = Math.floor(Math.min(fromSeconds, toSeconds) / bandSeconds);
    const highest = Math.floor(Math.max(fromSeconds, toSeconds) / bandSeconds);
    if (lowest === highest || span === 0) {
      visit(lowest, fromX, fromY, fromSeconds, toX, toY, toSeconds);
      continue;
    }

    // Walked in order along the way, so the pieces come out contiguous without
    // sorting a list of crossing fractions.
    const ascending = span > 0;
    let previousFraction = 0;
    for (
      let boundary = ascending ? lowest + 1 : highest;
      ascending ? boundary <= highest : boundary >= lowest + 1;
      boundary += ascending ? 1 : -1
    ) {
      const fraction = (boundary * bandSeconds - fromSeconds) / span;
      if (!(fraction > previousFraction) || !(fraction < 1)) {
        continue;
      }
      emitPiece(visit, bandSeconds, previousFraction, fraction,
        fromX, fromY, fromSeconds, toX, toY, span);
      previousFraction = fraction;
    }
    emitPiece(visit, bandSeconds, previousFraction, 1,
      fromX, fromY, fromSeconds, toX, toY, span);
  }
}

function emitPiece(visit, bandSeconds, start, end, fromX, fromY, fromSeconds, toX, toY, span) {
  if (!(end > start)) {
    return;
  }
  const startSeconds = fromSeconds + span * start;
  const endSeconds = fromSeconds + span * end;
  visit(
    Math.floor(((startSeconds + endSeconds) / 2) / bandSeconds),
    fromX + (toX - fromX) * start,
    fromY + (toY - fromY) * start,
    startSeconds,
    fromX + (toX - fromX) * end,
    fromY + (toY - fromY) * end,
    endSeconds,
  );
}
