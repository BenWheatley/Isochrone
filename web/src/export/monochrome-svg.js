// Monochrome isochrone rendering: filled, hatched bands bounded by labelled
// contours, which is what a map without colour would actually do.
//
// Not a re-tint of the colour render. Removing hue from half a million
// overlapping strokes leaves a grey mass however the strokes are patterned -
// density itself becomes the problem - so monochrome changes what is drawn.
// See docs/monochrome-rendering-plan.md.

import { patternCoverageRatio, WATER_HATCH_PATTERN, WATER_INK } from '../render/hatch.js';

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

function ringToPathData(points, transform, { reversed = false } = {}) {
  const count = points.length / 2;
  const parts = new Array(count);
  for (let step = 0; step < count; step += 1) {
    const index = reversed ? count - 1 - step : step;
    const [x, y] = transform(points[index * 2], points[index * 2 + 1]);
    parts[step] = `${step === 0 ? 'M' : 'L'}${formatSvgNumber(x)} ${formatSvgNumber(y)}`;
  }
  return `${parts.join('')}Z`;
}

function ringPerimeter(points, transform, closed = true) {
  const count = points.length / 2;
  let total = 0;
  let [previousX, previousY] = transform(points[0], points[1]);
  const last = closed ? count : count - 1;
  for (let index = 1; index <= last; index += 1) {
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

  // Cut the ring into equal *lengths*, not equal numbers of points. A ring
  // from a triangulation has points bunched wherever the network is dense, so
  // slicing by index puts several labels in one crowded corner and none along
  // a long smooth run - which is exactly what made their positions look
  // arbitrary.
  const count = points.length / 2;
  const cumulative = new Float64Array(count + 1);
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const [x0, y0] = transform(points[index * 2], points[index * 2 + 1]);
    const [x1, y1] = transform(points[next * 2], points[next * 2 + 1]);
    cumulative[index + 1] = cumulative[index] + Math.hypot(x1 - x0, y1 - y0);
  }
  const indexAtLength = (target) => {
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < target) low = mid + 1; else high = mid;
    }
    return Math.min(count - 1, low);
  };

  const placements = [];
  for (let slice = 0; slice < wanted; slice += 1) {
    const from = indexAtLength((slice * perimeter) / wanted);
    const to = indexAtLength(((slice + 1) * perimeter) / wanted);
    if (to - from < 8) {
      continue;
    }
    const sliceSpan = points.subarray(from * 2, to * 2);
    const placement = placeContourLabel(sliceSpan, { ...options, closed: false });
    if (placement) {
      // The gap indices come back relative to the slice. Left unshifted they
      // cut the contour somewhere unrelated to the label, which is how lines
      // came to break where no value was written and values came to sit on
      // unbroken lines.
      placements.push({
        ...placement,
        gapStartIndex: placement.gapStartIndex + from,
        gapEndIndex: placement.gapEndIndex + from,
      });
    }
  }
  return placements;
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
  // A slice of a ring is an open chain, not a ring of its own. Letting the
  // window wrap from its end back to its start makes the label's gap span
  // almost the whole contour once the indices are read back against the ring -
  // which is how long stretches of isoline came to be missing entirely.
  const closed = options.closed !== false;
  const minimumLength = closed ? labelLength * 4 : labelLength * 2;
  if (ringPerimeter(points, transform, closed) < minimumLength) {
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
      const nextIndex = closed ? (index + 1) % count : index + 1;
      if (nextIndex >= count) {
        return -1;
      }
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
    if (endIndex === startIndex || endIndex < 0) {
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
  // Set along the contour, which is what an isoline label does and what makes
  // it obvious which line a value belongs to. It is never set upside down, and
  // placement prefers the straightest, flattest run available, so it does not
  // come out at an angle a reader has to turn the sheet for.
  const rotate = followContour === false
    ? ''
    : ` transform="rotate(${formatSvgNumber(placement.angleDegrees)} ${x} ${y})"`;
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

/**
 * Where every contour's value goes, and which stretch of contour to leave out
 * for it.
 *
 * Planned once, on the scene, rather than inside a renderer: the screen and the
 * exported sheet are the same map, and labels that moved between them would be
 * two maps with one name.
 */
export function planContourLabels(bands, options = {}) {
  const transform = options.transform ?? ((x, y) => [x, y]);
  const fontSize = options.fontSize ?? 12;
  const spacingPx = options.spacingPx
    ?? Math.max(320, Math.min(options.widthPx ?? 1000, options.heightPx ?? 1000) / 3);

  // Contours crowd wherever the gradient is steep, which is exactly where
  // several rings would all want labelling in the same few centimetres.
  const claimedBoxes = [];
  const claim = (placement, text) => {
    const halfWidth = (text.length * fontSize * LABEL_WIDTH_PER_CHARACTER) / 2 + fontSize * 0.4;
    const halfHeight = fontSize * 0.9;
    const box = {
      left: placement.x - halfWidth,
      right: placement.x + halfWidth,
      top: placement.y - halfHeight,
      bottom: placement.y + halfHeight,
    };
    const collides = claimedBoxes.some((other) =>
      box.left < other.right && box.right > other.left
      && box.top < other.bottom && box.bottom > other.top);
    if (collides) {
      return false;
    }
    claimedBoxes.push(box);
    return true;
  };

  const labels = [];
  const gaps = new Map();
  for (const band of bands) {
    if (!band.label) {
      continue;
    }
    for (const ring of band.rings) {
      // A hole is the boundary with the faster band inside it, and carries
      // that band's value, not this one's. Labelling it here would print two
      // different times along one line.
      if (ring.isHole) {
        continue;
      }
      const candidates = placeContourLabels(ring.points, {
        transform,
        text: band.label,
        fontSize,
        spacingPx,
      });
      const placed = candidates.filter((candidate) => claim(candidate, band.label));
      if (placed.length === 0) {
        continue;
      }
      // Only the first placement breaks this ring's path; the rest rely on
      // their halo. Breaking a ring in several places would need the path
      // split into runs, and the halo already clears the line under the text.
      gaps.set(ring, placed[0]);
      for (const placement of placed) {
        labels.push({ ...placement, text: band.label });
      }
    }
  }
  return { labels, gaps };
}

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
  // The sea covers more of the sheet than anything else and has the least to
  // say, so where grey is available it is the first thing that should use it.
  // One bit is what this mode is built to survive, not a rule it must obey.
  const waterInk = scene.waterInk ?? WATER_INK;
  const bandPatterns = [...new Map(bands.map((band) => [band.pattern.id, band.pattern])).values()];
  // The sea's ruling keeps its own pitch: scaling it with the bands would put
  // it back in competition with them, which is exactly what it must not do.
  const waterPatterns = basemap.waterFeatures?.length ? [WATER_HATCH_PATTERN] : [];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}"`
    + ` viewBox="0 0 ${widthPx} ${heightPx}">`,
    `<defs>${buildHatchPatternDefs(bandPatterns, { ink, patternScale: scene.patternScale ?? 1 })}`
    + `${buildHatchPatternDefs(waterPatterns, { ink: waterInk, patternScale: 1 })}</defs>`,
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
        `<path d="${data}" fill="none" stroke="${waterInk}" stroke-width="${contourWidth}" />`,
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
    // Rings built from a triangulation already carry their own holes, wound
    // oppositely, so a band is a finished annulus and needs nothing added.
    // Rings from contouring do not: each outlines everything within a
    // threshold, so the band inwards has to be subtracted, wound the other way
    // - under even-odd the direction would not matter, but under non-zero a
    // same-wound inner ring adds instead, and every band paints as a full disc
    // over its neighbour. Reversing makes it correct under either rule.
    const inner = scene.bandsIncludeHoles === true || index === 0
      ? []
      : bands[index - 1].rings;
    const pathData = band.rings
      .map((ring) => ringToPathData(ring.points, transform))
      .concat(inner.map((ring) => ringToPathData(ring.points, transform, { reversed: true })))
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

  const plan = scene.labels
    ? { labels: scene.labels, gaps: scene.labelGaps ?? new Map() }
    : planContourLabels(bands, {
      transform,
      fontSize,
      widthPx,
      heightPx,
      spacingPx: scene.labelSpacingPx,
    });

  for (const band of bands) {
    for (const ring of band.rings) {
      const gap = plan.gaps.get(ring) ?? null;
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
    }
  }
  for (const label of plan.labels) {
    labels.push(renderHaloedLabel(label, label.text, {
      fontSize,
      ink,
      paper,
      // Along the contour unless a caller says otherwise: that is what an
      // isoline label does, on a weather chart or an Ordnance Survey sheet.
      followContour: scene.labelsFollowContour !== false,
    }));
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
