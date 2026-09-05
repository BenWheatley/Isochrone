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

    // The way runs across the contour, so the contour runs across the way.
    let angleDegrees = (Math.atan2(crossing.wayY, crossing.wayX) * 180) / Math.PI + 90;
    if (angleDegrees > 90) {
      angleDegrees -= 180;
    }
    if (angleDegrees < -90) {
      angleDegrees += 180;
    }
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
  const byBand = new Map();
  const pushPiece = (band, x0, y0, t0, x1, y1, t1) => {
    let pieces = byBand.get(band);
    if (pieces === undefined) {
      pieces = [];
      byBand.set(band, pieces);
    }
    pieces.push(x0, y0, t0, x1, y1, t1);
  };

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
      pushPiece(lowest, fromX, fromY, fromSeconds, toX, toY, toSeconds);
      continue;
    }

    const fractions = [0];
    for (let boundary = lowest + 1; boundary <= highest; boundary += 1) {
      const fraction = (boundary * bandSeconds - fromSeconds) / span;
      if (fraction > 0 && fraction < 1) {
        fractions.push(fraction);
      }
    }
    fractions.push(1);
    fractions.sort((a, b) => a - b);
    for (let index = 0; index + 1 < fractions.length; index += 1) {
      const start = fractions[index];
      const end = fractions[index + 1];
      if (end - start <= 0) {
        continue;
      }
      const startSeconds = fromSeconds + span * start;
      const endSeconds = fromSeconds + span * end;
      pushPiece(
        Math.floor(((startSeconds + endSeconds) / 2) / bandSeconds),
        fromX + (toX - fromX) * start, fromY + (toY - fromY) * start, startSeconds,
        fromX + (toX - fromX) * end, fromY + (toY - fromY) * end, endSeconds,
      );
    }
  }

  const bands = [...byBand.keys()].sort((a, b) => b - a);
  let total = 0;
  for (const pieces of byBand.values()) {
    total += pieces.length;
  }
  const data = new Float32Array(total);
  const ranges = [];
  let written = 0;
  for (const band of bands) {
    const pieces = byBand.get(band);
    data.set(pieces, written);
    ranges.push({ band, first: written / RIBBON_SEGMENT_STRIDE, count: pieces.length / RIBBON_SEGMENT_STRIDE });
    written += pieces.length;
  }
  return { data, ranges };
}
