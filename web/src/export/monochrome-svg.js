// Monochrome isochrone rendering: filled, hatched bands bounded by labelled
// contours, which is what a map without colour would actually do.
//
// Not a re-tint of the colour render. Removing hue from half a million
// overlapping strokes leaves a grey mass however the strokes are patterned -
// density itself becomes the problem - so monochrome changes what is drawn.
// See docs/monochrome-rendering-plan.md.

import { patternCoverageRatio, WATER_HATCH_PATTERN } from '../render/hatch.js';

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
      // No shape-rendering="crispEdges": it snaps a stroke to the pixel grid,
      // and anything under a pixel snaps to nothing. Patterns keep their
      // strokes at a full unit and vary the spacing instead, so a line is
      // always drawn and still survives being thresholded to one bit.
      + `<g stroke="${ink}" stroke-width="${formatSvgNumber(strokeWidth)}">`
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
/**
 * Several placements along one contour, so that a label is always in view
 * rather than having to be hunted for. A long ring gets one roughly every
 * `spacingPx`; a short one gets a single label, or none.
 */
export function placeContourLabels(points, options = {}) {
  const transform = options.transform ?? ((x, y) => [x, y]);
  const spacingPx = options.spacingPx ?? Number.POSITIVE_INFINITY;
  const perimeter = ringPerimeter(points, transform);
  const wanted = Math.max(1, Math.min(6, Math.floor(perimeter / spacingPx)));
  if (wanted === 1) {
    const single = placeContourLabel(points, options);
    return single ? [single] : [];
  }

  const count = points.length / 2;
  const placements = [];
  for (let slice = 0; slice < wanted; slice += 1) {
    const from = Math.floor((slice * count) / wanted);
    const to = Math.floor(((slice + 1) * count) / wanted);
    if (to - from < 8) {
      continue;
    }
    const sliceSpan = points.subarray(from * 2, to * 2);
    const placement = placeContourLabel(sliceSpan, { ...options, requireClosedRing: false });
    if (placement) {
      placements.push(placement);
    }
  }
  return placements.length > 0 ? placements : [];
}

export function placeContourLabel(points, options = {}) {
  const transform = options.transform ?? ((x, y) => [x, y]);
  const text = options.text ?? '';
  const fontSize = options.fontSize ?? 11;
  const labelLength = text.length * fontSize * LABEL_WIDTH_PER_CHARACTER;
  const count = points.length / 2;
  if (count < 8 || labelLength <= 0) {
    return null;
  }
  // A label needs the run to be several times its own length, or the gap
  // swallows the contour it is annotating.
  const minimumLength = options.requireClosedRing === false ? labelLength * 2 : labelLength * 4;
  if (ringPerimeter(points, transform) < minimumLength) {
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
    // Straightness first, but among equally straight runs prefer the flatter
    // one: text set near-vertical is legal, and tiring. The penalty is scaled
    // by the label's own length so it stays comparable with the turning above.
    const steepness = chord === 0
      ? 1
      : Math.abs(projected[endIndex][1] - projected[startIndex][1]) / chord;
    const score = walked - chord + steepness * labelLength * 0.35;
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

/**
 * The value, on clear ground.
 *
 * A contour label on a monochrome map sits on top of a hatch, and black on
 * black cannot be read however carefully it is placed - masking is not a
 * refinement here, it is the whole difference between legible and not. The
 * text is drawn twice, a thick paper-coloured stroke beneath the black fill,
 * rather than with paint-order: the double draw works in every renderer,
 * including whatever eventually turns this into a PDF.
 */
function renderHaloedLabel(placement, text, { fontSize, ink, paper, followContour }) {
  const x = formatSvgNumber(placement.x);
  const y = formatSvgNumber(placement.y);
  // Set horizontally by default rather than along the contour. Paullin's
  // "Rates of Travel" plates do the same, and for good reason: a value set at
  // seventy degrees is legible only to a reader willing to turn the sheet,
  // and the halo and the gap in the line already say which contour a label
  // belongs to. Following the contour stays available for gentle, sweeping
  // isolines where it reads well.
  const rotate = followContour
    ? ` transform="rotate(${formatSvgNumber(placement.angleDegrees)} ${x} ${y})"`
    : '';
  const common = `x="${x}" y="${y}"${rotate}`
    + ` font-family="${LABEL_FONT_FAMILY}" font-size="${fontSize}"`
    + ' text-anchor="middle" dominant-baseline="central"';
  const escaped = escapeXmlText(text);
  return `<text ${common} fill="none" stroke="${paper}"`
    + ` stroke-width="${formatSvgNumber(fontSize * 0.45)}" stroke-linejoin="round">${escaped}</text>`
    + `<text ${common} fill="${ink}">${escaped}</text>`;
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

  const basemap = scene.basemap ?? {};
  const bandPatterns = [...new Map(bands.map((band) => [band.pattern.id, band.pattern])).values()];
  // The sea's ruling keeps its own pitch: scaling it with the bands would put
  // it back in competition with them, which is exactly what it must not do.
  const waterPatterns = basemap.waterFeatures?.length ? [WATER_HATCH_PATTERN] : [];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}"`
    + ` viewBox="0 0 ${widthPx} ${heightPx}">`,
    `<defs>${buildHatchPatternDefs(bandPatterns, { ink, patternScale: scene.patternScale ?? 1 })}`
    + `${buildHatchPatternDefs(waterPatterns, { ink, patternScale: 1 })}</defs>`,
    `<rect width="${widthPx}" height="${heightPx}" fill="${paper}" />`,
  ];

  // The map beneath the isochrone. Drawn first so that the bands read as a
  // tint laid over it, the way a screen tint prints over linework - which is
  // also why the hatches are transparent rather than opaque. Without this
  // there is nothing to tell the reader where they are: an isochrone with no
  // coastline and no roads is a shape, not a map.
  if (basemap.waterFeatures?.length) {
    const waterPaths = basemap.waterFeatures
      .map((feature) => feature.paths
        .filter((path) => path.length >= 3)
        .map((path) => ringToPathData(Float64Array.from(path.flat()), transform))
        .join(''))
      .filter((data) => data.length > 0);
    if (waterPaths.length > 0) {
      const data = waterPaths.join('');
      // even-odd, so an island stays dry: a coastline is the sea with the land
      // taken out of it.
      parts.push(
        `<path d="${data}" fill="url(#${WATER_HATCH_PATTERN.id})" fill-rule="evenodd" stroke="none" />`,
        `<path d="${data}" fill="none" stroke="${ink}" stroke-width="${contourWidth}" />`,
      );
    }
  }
  if (basemap.roadSegments?.length >= 4) {
    const segments = basemap.roadSegments;
    const commands = [];
    for (let index = 0; index + 3 < segments.length; index += 4) {
      const [x0, y0] = transform(segments[index], segments[index + 1]);
      const [x1, y1] = transform(segments[index + 2], segments[index + 3]);
      commands.push(
        `M${formatSvgNumber(x0)} ${formatSvgNumber(y0)}L${formatSvgNumber(x1)} ${formatSvgNumber(y1)}`,
      );
    }
    parts.push(
      `<path d="${commands.join('')}" fill="none" stroke="${ink}"`
      + ` stroke-width="${scene.roadStrokeWidth ?? 0.35}" stroke-linecap="round" />`,
    );
  }

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

  const labelSpacingPx = scene.labelSpacingPx ?? Math.max(320, Math.min(widthPx, heightPx) / 3);
  for (const band of bands) {
    for (const ring of band.rings) {
      const candidates = band.label
        ? placeContourLabels(ring.points, {
          transform,
          text: band.label,
          fontSize,
          spacingPx: labelSpacingPx,
        })
        : [];
      // Rotation is ignored when testing for a clash: an axis-aligned box
      // around the unrotated run is a little generous, which is the side to
      // err on when the alternative is two values printed over each other.
      const placed = candidates.filter((candidate) => claim(candidate, band.label));
      // Only the first placement can break this ring's path; the rest rely on
      // their halo. Breaking a ring in several places would need the path
      // split into runs, and the halo already clears the line under the text.
      const gap = placed[0] ?? null;
      const pathData = gap
        ? ringPathWithGap(ring.points, transform, gap)
        : ringToPathData(ring.points, transform);
      // The outermost contour is not just another band edge, it is the limit
      // of travel - and it needs to look like one. A bare-paper band inside it
      // is otherwise the same white as the ground nobody can reach at all, and
      // only this line says which side of it the reader is on.
      const strokeWidth = band.isLimit ? contourWidth * 2.2 : contourWidth;
      parts.push(
        `<path d="${pathData}" fill="none" stroke="${ink}"`
        + ` stroke-width="${formatSvgNumber(strokeWidth)}" stroke-linejoin="round" />`,
      );
      for (const placement of placed) {
        labels.push(renderHaloedLabel(placement, band.label, {
          fontSize,
          ink,
          paper,
          followContour: scene.labelsFollowContour === true,
        }));
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
  // Inside the box, on its own paper. Floating above it, the caption sat
  // straight on the map and was unreadable over the sea's ruling.
  const captionHeight = scene.legendCaption ? fontSize * 1.8 : 0;
  const totalHeight = boxHeight + captionHeight;
  const boxTop = heightPx - totalHeight - 12;
  const caption = scene.legendCaption
    ? `<text x="${left + 5}" y="${formatSvgNumber(boxTop + fontSize * 1.1)}"`
      + ` font-family="${LABEL_FONT_FAMILY}" font-size="${fontSize}" fill="${ink}">`
      + `${escapeXmlText(scene.legendCaption)}</text>`
    : '';
  const rowsShifted = cycle.map((band, index) => {
    const y = boxTop + captionHeight + 5 + index * rowHeight;
    const fill = band.pattern.lines.length === 0 ? paper : `url(#${band.pattern.id})`;
    return `<rect x="${left + 5}" y="${formatSvgNumber(y)}" width="${swatch}"`
      + ` height="${swatch}" fill="${fill}" stroke="${ink}" stroke-width="0.7" />`
      + `<text x="${left + 5 + swatch + 8}" y="${formatSvgNumber(y + swatch / 2)}"`
      + ` font-family="${LABEL_FONT_FAMILY}" font-size="${fontSize}" fill="${ink}"`
      + ' dominant-baseline="central">'
      + `${escapeXmlText(band.label)}</text>`;
  }).join('');
  void rows;
  const captionWidth = scene.legendCaption
    ? scene.legendCaption.length * fontSize * LABEL_WIDTH_PER_CHARACTER + 16
    : 0;
  return `<g><rect x="${left}" y="${formatSvgNumber(boxTop)}"`
    + ` width="${formatSvgNumber(Math.max(boxWidth, captionWidth))}"`
    + ` height="${formatSvgNumber(totalHeight)}" fill="${paper}" stroke="${ink}"`
    + ' stroke-width="0.7" />' + caption + rowsShifted + '</g>';
}

/** Legend rows showing the actual hatch, not a grey approximation of it. */
export function buildMonochromeLegendRows(bands) {
  return bands.map((band) => ({
    label: band.label,
    patternId: band.pattern.id,
    coverageRatio: patternCoverageRatio(band.pattern, 80),
  }));
}
