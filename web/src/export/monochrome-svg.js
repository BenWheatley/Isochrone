// Monochrome isochrone rendering: filled, hatched bands bounded by labelled
// contours, which is what a map without colour would actually do.
//
// Not a re-tint of the colour render. Removing hue from half a million
// overlapping strokes leaves a grey mass however the strokes are patterned -
// density itself becomes the problem - so monochrome changes what is drawn.
// See docs/monochrome-rendering-plan.md.

import { patternCoverageRatio } from '../render/hatch.js';

const LABEL_FONT_FAMILY = "'Helvetica Neue', Helvetica, Arial, sans-serif";
// Rough advance width per character as a fraction of font size. Only needs to
// be close: it sizes the gap a label sits in, and a little slack either side
// is wanted anyway.
const LABEL_WIDTH_PER_CHARACTER = 0.55;

function formatSvgNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * `<pattern>` definitions for the hatches in use.
 *
 * patternUnits="userSpaceOnUse" so that a hatch does not rescale with the
 * shape it fills - otherwise a large band and a small band, filled from the
 * same pattern, acquire visibly different textures.
 */
export function buildHatchPatternDefs(patterns, options = {}) {
  const ink = options.ink ?? '#000000';
  const scale = options.patternScale ?? 1;
  const definitions = [];
  for (const pattern of patterns) {
    if (pattern.lines.length === 0) {
      continue;
    }
    const tile = pattern.tileSize * scale;
    const strokeWidth = pattern.strokeWidth * scale;
    const strokes = pattern.lines
      .map((line) =>
        `<line x1="${formatSvgNumber(line.x1 * scale)}" y1="${formatSvgNumber(line.y1 * scale)}"`
        + ` x2="${formatSvgNumber(line.x2 * scale)}" y2="${formatSvgNumber(line.y2 * scale)}" />`)
      .join('');
    definitions.push(
      `<pattern id="${pattern.id}" patternUnits="userSpaceOnUse"`
      + ` width="${formatSvgNumber(tile)}" height="${formatSvgNumber(tile)}">`
      + `<g stroke="${ink}" stroke-width="${formatSvgNumber(strokeWidth)}"`
      + ' shape-rendering="crispEdges">'
      + strokes
      + '</g></pattern>',
    );
  }
  return definitions.join('');
}

function ringToPathData(points, transform) {
  const count = points.length / 2;
  const parts = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const [x, y] = transform(points[index * 2], points[index * 2 + 1]);
    parts[index] = `${index === 0 ? 'M' : 'L'}${formatSvgNumber(x)} ${formatSvgNumber(y)}`;
  }
  return `${parts.join('')}Z`;
}

function ringPerimeter(points, transform) {
  const count = points.length / 2;
  let total = 0;
  let [previousX, previousY] = transform(points[0], points[1]);
  for (let index = 1; index <= count; index += 1) {
    const wrapped = index % count;
    const [x, y] = transform(points[wrapped * 2], points[wrapped * 2 + 1]);
    total += Math.hypot(x - previousX, y - previousY);
    previousX = x;
    previousY = y;
  }
  return total;
}

/**
 * Where to write a contour's value, and how much of the contour to leave out
 * so the text has clear paper under it.
 *
 * The label goes on the straightest stretch the ring offers: text set along a
 * tight bend is unreadable, and a bend is also where the eye most wants the
 * line itself to be unbroken. Straightness is scored as the total turning
 * across a window the length of the label.
 */
export function placeContourLabel(points, options = {}) {
  const transform = options.transform ?? ((x, y) => [x, y]);
  const text = options.text ?? '';
  const fontSize = options.fontSize ?? 11;
  const labelLength = text.length * fontSize * LABEL_WIDTH_PER_CHARACTER;
  const count = points.length / 2;
  if (count < 8 || labelLength <= 0) {
    return null;
  }
  // A label needs the ring to be several times its own length, or the gap
  // swallows the contour it is annotating.
  if (ringPerimeter(points, transform) < labelLength * 4) {
    return null;
  }

  const projected = new Array(count);
  for (let index = 0; index < count; index += 1) {
    projected[index] = transform(points[index * 2], points[index * 2 + 1]);
  }

  const windowEndFor = (startIndex) => {
    let travelled = 0;
    let index = startIndex;
    while (travelled < labelLength) {
      const nextIndex = (index + 1) % count;
      travelled += Math.hypot(
        projected[nextIndex][0] - projected[index][0],
        projected[nextIndex][1] - projected[index][1],
      );
      index = nextIndex;
      if (index === startIndex) {
        break;
      }
    }
    return index;
  };

  let bestScore = Number.POSITIVE_INFINITY;
  let bestStart = -1;
  let bestEnd = -1;
  for (let startIndex = 0; startIndex < count; startIndex += 1) {
    const endIndex = windowEndFor(startIndex);
    if (endIndex === startIndex) {
      continue;
    }
    // Turning across the window: the straighter the stretch, the smaller the
    // gap between its chord and the path walked along it.
    let walked = 0;
    let index = startIndex;
    while (index !== endIndex) {
      const nextIndex = (index + 1) % count;
      walked += Math.hypot(
        projected[nextIndex][0] - projected[index][0],
        projected[nextIndex][1] - projected[index][1],
      );
      index = nextIndex;
    }
    const chord = Math.hypot(
      projected[endIndex][0] - projected[startIndex][0],
      projected[endIndex][1] - projected[startIndex][1],
    );
    const score = walked - chord;
    if (score < bestScore) {
      bestScore = score;
      bestStart = startIndex;
      bestEnd = endIndex;
    }
  }
  if (bestStart < 0) {
    return null;
  }

  const [startX, startY] = projected[bestStart];
  const [endX, endY] = projected[bestEnd];
  let angleDegrees = (Math.atan2(endY - startY, endX - startX) * 180) / Math.PI;
  // Never set upside down: flip the run rather than let the reader tilt their
  // head, and keep the result in (-180, 180] so the emitted transform reads as
  // the angle it is.
  if (angleDegrees > 90 || angleDegrees < -90) {
    angleDegrees += 180;
  }
  if (angleDegrees > 180) {
    angleDegrees -= 360;
  }
  return {
    x: (startX + endX) / 2,
    y: (startY + endY) / 2,
    angleDegrees,
    gapStartIndex: bestStart,
    gapEndIndex: bestEnd,
  };
}

/** The ring as an open path that stops short of the label and resumes after
 *  it, so the text sits in clear paper rather than on top of the line. */
function ringPathWithGap(points, transform, gap) {
  const count = points.length / 2;
  const parts = [];
  let index = gap.gapEndIndex;
  while (true) {
    const [x, y] = transform(points[index * 2], points[index * 2 + 1]);
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${formatSvgNumber(x)} ${formatSvgNumber(y)}`);
    if (index === gap.gapStartIndex) {
      break;
    }
    index = (index + 1) % count;
  }
  return parts.join('');
}

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * A complete monochrome isochrone.
 *
 * `bands` run innermost first, each carrying the rings of its own contour and
 * the label to write on it. A band is filled as its own rings *plus* the next
 * band inwards, under the even-odd rule: a point in the annulus crosses one
 * ring and fills, a point further in crosses two and does not. That yields
 * true annuli with transparent hatches, so the bands do not have to be
 * overpainted opaquely and whatever is drawn beneath still shows through.
 */
export function buildMonochromeIsochroneSvg(scene) {
  const { widthPx, heightPx, bands } = scene;
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) {
    throw new Error('scene must carry finite widthPx and heightPx');
  }
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new Error('scene must carry at least one band');
  }
  const transform = scene.transform ?? ((x, y) => [x, y]);
  const ink = scene.ink ?? '#000000';
  const paper = scene.paper ?? '#ffffff';
  const fontSize = scene.labelFontSize ?? 11;
  const contourWidth = scene.contourStrokeWidth ?? 0.8;

  const patterns = [...new Map(bands.map((band) => [band.pattern.id, band.pattern])).values()];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}"`
    + ` viewBox="0 0 ${widthPx} ${heightPx}">`,
    `<defs>${buildHatchPatternDefs(patterns, { ink, patternScale: scene.patternScale ?? 1 })}</defs>`,
    `<rect width="${widthPx}" height="${heightPx}" fill="${paper}" />`,
  ];

  // Fills first, then every contour, then every label: a label must never be
  // crossed by a line belonging to a band drawn after it.
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    if (band.pattern.lines.length === 0) {
      continue;
    }
    const inner = index > 0 ? bands[index - 1].rings : [];
    const pathData = [...band.rings, ...inner]
      .map((ring) => ringToPathData(ring.points, transform))
      .join('');
    if (pathData.length === 0) {
      continue;
    }
    parts.push(
      `<path d="${pathData}" fill="url(#${band.pattern.id})" fill-rule="evenodd" stroke="none" />`,
    );
  }

  // A solid hairline between bands. At one bit, adjacent hatches moire into
  // one another without a separating line, and the line is also what a label
  // sits on.
  const labels = [];
  // Where a label has already been written, so a later one does not land on
  // top of it. Contours crowd together wherever the gradient is steep, which
  // is exactly where several rings would otherwise all want to be labelled in
  // the same few square centimetres.
  const claimedBoxes = [];
  const claim = (label, text) => {
    const halfWidth = (text.length * fontSize * LABEL_WIDTH_PER_CHARACTER) / 2 + fontSize * 0.4;
    const halfHeight = fontSize * 0.9;
    const box = {
      left: label.x - halfWidth,
      right: label.x + halfWidth,
      top: label.y - halfHeight,
      bottom: label.y + halfHeight,
    };
    const collides = claimedBoxes.some((other) =>
      box.left < other.right
      && box.right > other.left
      && box.top < other.bottom
      && box.bottom > other.top);
    if (collides) {
      return false;
    }
    claimedBoxes.push(box);
    return true;
  };

  for (const band of bands) {
    for (const ring of band.rings) {
      const candidate = band.label
        ? placeContourLabel(ring.points, { transform, text: band.label, fontSize })
        : null;
      // Rotation is ignored when testing for a clash: an axis-aligned box
      // around the unrotated run is a little generous, which is the side to
      // err on when the alternative is two values printed over each other.
      const gap = candidate && claim(candidate, band.label) ? candidate : null;
      const pathData = gap
        ? ringPathWithGap(ring.points, transform, gap)
        : ringToPathData(ring.points, transform);
      parts.push(
        `<path d="${pathData}" fill="none" stroke="${ink}"`
        + ` stroke-width="${contourWidth}" stroke-linejoin="round" />`,
      );
      if (gap) {
        labels.push(
          `<text x="${formatSvgNumber(gap.x)}" y="${formatSvgNumber(gap.y)}"`
          + ` transform="rotate(${formatSvgNumber(gap.angleDegrees)} ${formatSvgNumber(gap.x)}`
          + ` ${formatSvgNumber(gap.y)})" font-family="${LABEL_FONT_FAMILY}"`
          + ` font-size="${fontSize}" fill="${ink}" text-anchor="middle"`
          + ' dominant-baseline="central">'
          + `${escapeXmlText(band.label)}</text>`,
        );
      }
    }
  }
  parts.push(...labels);
  if (scene.legend !== false) {
    parts.push(buildLegendMarkup(bands, { widthPx, heightPx, ink, paper, fontSize, scene }));
  }
  parts.push('</svg>');
  return parts.join('');
}

/**
 * The legend shows each band as a swatch of its own hatch, drawn from the same
 * <pattern> the map uses. A grey approximation would defeat the point: what
 * the reader has to match is the texture, not a tone standing in for it.
 *
 * One entry per distinct pattern rather than per band, because the patterns
 * repeat - which is what the contour labels are there to resolve.
 */
function buildLegendMarkup(bands, { widthPx, heightPx, ink, paper, fontSize, scene }) {
  const cycle = [];
  for (const band of bands) {
    if (cycle.some((entry) => entry.pattern.id === band.pattern.id)) {
      break;
    }
    cycle.push(band);
  }
  if (cycle.length === 0) {
    return '';
  }
  const swatch = Math.max(18, fontSize * 2);
  const rowHeight = swatch + 6;
  const boxWidth = swatch + 8 + fontSize * 8;
  const boxHeight = rowHeight * cycle.length + 10;
  const left = 12;
  const top = heightPx - boxHeight - 12;
  const rows = cycle.map((band, index) => {
    const y = top + 5 + index * rowHeight;
    const fill = band.pattern.lines.length === 0
      ? paper
      : `url(#${band.pattern.id})`;
    return `<rect x="${left + 5}" y="${formatSvgNumber(y)}" width="${swatch}"`
      + ` height="${swatch}" fill="${fill}" stroke="${ink}" stroke-width="0.7" />`
      + `<text x="${left + 5 + swatch + 8}" y="${formatSvgNumber(y + swatch / 2)}"`
      + ` font-family="${LABEL_FONT_FAMILY}" font-size="${fontSize}" fill="${ink}"`
      + ' dominant-baseline="central">'
      + `${escapeXmlText(band.label)}</text>`;
  }).join('');
  const caption = scene.legendCaption
    ? `<text x="${left + 5}" y="${formatSvgNumber(top - 6)}" font-family="${LABEL_FONT_FAMILY}"`
      + ` font-size="${fontSize}" fill="${ink}">${escapeXmlText(scene.legendCaption)}</text>`
    : '';
  return `<g><rect x="${left}" y="${formatSvgNumber(top)}" width="${formatSvgNumber(boxWidth)}"`
    + ` height="${formatSvgNumber(boxHeight)}" fill="${paper}" stroke="${ink}"`
    + ' stroke-width="0.7" />' + rows + '</g>' + caption;
}

/** Legend rows showing the actual hatch, not a grey approximation of it. */
export function buildMonochromeLegendRows(bands) {
  return bands.map((band) => ({
    label: band.label,
    patternId: band.pattern.id,
    coverageRatio: patternCoverageRatio(band.pattern, 80),
  }));
}
