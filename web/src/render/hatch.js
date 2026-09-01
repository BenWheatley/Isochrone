// Fill patterns for monochrome rendering: the analogue of timeToColour, at
// the same seam, returning a hatch specification per band instead of an RGB
// triple.
//
// A pattern's perceived tone is its ink coverage ratio, and unlike a hue that
// is directly measurable - see patternCoverageRatio below, and the test that
// asserts adjacent bands separate. That test is stronger than the colour one
// it replaces, because it also catches a pattern so dense it stops reading as
// texture and becomes flat grey.

import { DEFAULT_COLOUR_CYCLE_MINUTES } from '../config/constants.js';

/**
 * A ladder of hatches in increasing ink coverage, from bare paper to a dense
 * cross-hatch. Nothing here is solid black: a solid band would bury the
 * basemap beneath it and leave any contour label crossing it unreadable.
 *
 * Each tile is described in user units and repeats seamlessly - the lines
 * that leave one edge are repeated entering the opposite one, so the hatch
 * does not break at tile boundaries.
 */
function diagonalHatchLines(tileSize, { cross = false } = {}) {
  const lines = [];
  for (const offset of [-tileSize, 0, tileSize]) {
    lines.push({ x1: offset, y1: 0, x2: offset + tileSize, y2: tileSize });
    if (cross) {
      lines.push({ x1: offset, y1: tileSize, x2: offset + tileSize, y2: 0 });
    }
  }
  return lines;
}

// Tile sizes chosen by measuring, not by picking round numbers: they put the
// five rungs at roughly 0, 0.16, 0.32, 0.45 and 0.59 coverage, which is about
// as evenly as this ladder spaces. The first pair to collide as rungs are
// added is what limits the count, so evenness here is what buys the headroom.
//
// The two middle rungs also differ in *direction* as well as in coverage - a
// single-direction hatch against a cross-hatch - which separates them by more
// than their coverage difference alone would.
export const HATCH_PATTERN_LADDER = [
  { id: 'mono-blank', tileSize: 8, strokeWidth: 0, lines: [] },
  { id: 'mono-hatch-wide', tileSize: 9, strokeWidth: 1, lines: diagonalHatchLines(9) },
  { id: 'mono-hatch-narrow', tileSize: 4.5, strokeWidth: 1, lines: diagonalHatchLines(4.5) },
  {
    id: 'mono-cross-wide',
    tileSize: 5.5,
    strokeWidth: 1,
    lines: diagonalHatchLines(5.5, { cross: true }),
  },
  {
    id: 'mono-cross-narrow',
    tileSize: 4,
    strokeWidth: 1,
    lines: diagonalHatchLines(4, { cross: true }),
  },
];

/**
 * Water. Ruled horizontally, which no time band ever is - every hatch on the
 * ladder runs at 45 degrees - so the sea cannot be misread as a band, and in
 * particular cannot be confused with the bare-paper rung.
 */
export const WATER_HATCH_PATTERN = {
  id: 'mono-water',
  tileSize: 7,
  strokeWidth: 0.6,
  lines: [{ x1: -7, y1: 3.5, x2: 14, y2: 3.5 }],
};

export const MIN_HATCH_PATTERN_COUNT = 2;
export const MAX_HATCH_PATTERN_COUNT = HATCH_PATTERN_LADDER.length;
/**
 * How many patterns a cycle uses. Deliberately not settled from first
 * principles: how many hatches actually separate depends on the output device,
 * and the honest answer at 1 bit may be two - literally bare paper and
 * something. See docs/monochrome-rendering-plan.md.
 */
export const DEFAULT_HATCH_PATTERN_COUNT = 5;

/**
 * `count` patterns drawn from the ladder, spaced as far apart on it as they
 * can be. Asking for two gets bare paper and the densest cross-hatch, not the
 * two lightest - whatever the count, the separation is the most the ladder
 * can offer.
 */
export function selectHatchPatterns(count = DEFAULT_HATCH_PATTERN_COUNT) {
  if (!Number.isInteger(count) || count < MIN_HATCH_PATTERN_COUNT) {
    throw new Error(`pattern count must be an integer of at least ${MIN_HATCH_PATTERN_COUNT}`);
  }
  if (count > MAX_HATCH_PATTERN_COUNT) {
    throw new Error(`pattern count must be at most ${MAX_HATCH_PATTERN_COUNT}`);
  }
  const lastLadderIndex = HATCH_PATTERN_LADDER.length - 1;
  return Array.from({ length: count }, (_unused, index) =>
    HATCH_PATTERN_LADDER[Math.round((index * lastLadderIndex) / (count - 1))]);
}

/**
 * Which hatch a travel time falls in. The monochrome analogue of
 * timeToColour, and cyclic in the same way and for the same reason: the
 * contour labels say which cycle you are in, exactly as the height figures do
 * on an Ordnance Survey sheet.
 */
export function timeToFillPattern(seconds, options = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('seconds must be a non-negative finite number');
  }
  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive finite number');
  }
  const patterns = options.patterns ?? selectHatchPatterns(
    options.patternCount ?? DEFAULT_HATCH_PATTERN_COUNT,
  );
  const cyclePositionMinutes = (seconds / 60) % cycleMinutes;
  const bandIndex = Math.min(
    patterns.length - 1,
    Math.floor((cyclePositionMinutes / cycleMinutes) * patterns.length),
  );
  return patterns[bandIndex];
}

function distanceToSegmentSquared(px, py, line) {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return (px - line.x1) ** 2 + (py - line.y1) ** 2;
  }
  let t = ((px - line.x1) * dx + (py - line.y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const nearestX = line.x1 + t * dx;
  const nearestY = line.y1 + t * dy;
  return (px - nearestX) ** 2 + (py - nearestY) ** 2;
}

/**
 * Fraction of the tile covered in ink, measured rather than declared: the tile
 * is sampled on a fine lattice and each sample tested against the strokes.
 *
 * This is the number that decides whether two bands are distinguishable once
 * the colour is gone, so it is worth measuring the thing itself rather than
 * trusting a nominal spacing.
 */
export function patternCoverageRatio(pattern, samplesPerAxis = 240) {
  if (!pattern || !Array.isArray(pattern.lines)) {
    throw new Error('pattern must carry a lines array');
  }
  if (pattern.lines.length === 0 || pattern.strokeWidth <= 0) {
    return 0;
  }
  const halfWidthSquared = (pattern.strokeWidth / 2) ** 2;
  let covered = 0;
  for (let row = 0; row < samplesPerAxis; row += 1) {
    const y = ((row + 0.5) / samplesPerAxis) * pattern.tileSize;
    for (let column = 0; column < samplesPerAxis; column += 1) {
      const x = ((column + 0.5) / samplesPerAxis) * pattern.tileSize;
      for (const line of pattern.lines) {
        if (distanceToSegmentSquared(x, y, line) <= halfWidthSquared) {
          covered += 1;
          break;
        }
      }
    }
  }
  return covered / (samplesPerAxis * samplesPerAxis);
}
