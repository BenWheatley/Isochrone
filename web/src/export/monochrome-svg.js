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
export function buildMonochromeIsochroneSvg(scene) {
  const { widthPx, heightPx } = scene;
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) {
    throw new Error('scene must carry finite widthPx and heightPx');
  }
  const ribbons = scene.ribbons ?? null;
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
  const bandPatterns = ribbons
    ? [...new Map(ribbons.patterns.map((pattern) => [pattern.id, pattern])).values()]
    : [];
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
      );
    }
  }  // Clipped to the land. A zone is a claim about ground someone can stand on,
  // and the sea is not that - but a river or a lake is different, having ways
  // along both banks whose zones legitimately meet over the water, so only the
  // coastline clips anything. Even-odd against a rectangle of the whole sheet
  // makes the clip the land: everything but the sea, islands included.
  const coastline = basemap.coastlineFeatures ?? [];
  const coastlineRings = coastline
    .flatMap((feature) => feature.paths)
    .map((path) => ringToPathData(Float64Array.from(path.flat()), transform))
    .filter((data) => data.length > 0)
    .join('');
  const landClipId = 'mono-land';
  if (coastlineRings.length > 0) {
    parts.push(
      `<clipPath id="${landClipId}" clipPathUnits="userSpaceOnUse">`
      + `<path clip-rule="evenodd" d="M0 0H${formatSvgNumber(widthPx)}`
      + `V${formatSvgNumber(heightPx)}H0Z${coastlineRings}" /></clipPath>`,
    );
  }

  const labels = [];
  if (ribbons && ribbons.ordered.data.length >= 6) {
    if (coastlineRings.length > 0) {
      parts.push(`<g clip-path="url(#${landClipId})">`);
    }
    const { ordered, patterns, widthPx: ribbonPx, outlinePx } = ribbons;

    const pathForRange = (first, count) => {
      const commands = [];
      for (let piece = 0; piece < count; piece += 1) {
        const offset = (first + piece) * 6;
        const [x0, y0] = transform(ordered.data[offset], ordered.data[offset + 1]);
        const [x1, y1] = transform(ordered.data[offset + 3], ordered.data[offset + 4]);
        commands.push(
          `M${formatSvgNumber(x0)} ${formatSvgNumber(y0)}L${formatSvgNumber(x1)} ${formatSvgNumber(y1)}`,
        );
      }
      return commands.join('');
    };
    const strokeAttributes = (width) => ` stroke-width="${formatSvgNumber(width)}"`
      + ' stroke-linecap="round" stroke-linejoin="round" />';

    // The limit of travel first, heavier, outside them all.
    const allData = pathForRange(0, Math.floor(ordered.data.length / 6));
    if (allData.length > 0) {
      parts.push(
        `<path d="${allData}" fill="none" stroke="${ink}"`
        + strokeAttributes(ribbonPx + contourWidth * 4.4),
      );
    }

    // Then band by band, farthest first, so the nearer time covers any ground
    // two bands both reach - which makes the edge between two fills the
    // isoline itself, with no separate line needed to mark it.
    for (const range of ordered.ranges) {
      if (range.count === 0) {
        continue;
      }
      const data = pathForRange(range.first, range.count);
      if (data.length === 0) {
        continue;
      }
      // Outlined before it is filled: a nearer band covers the outline of the
      // farther one everywhere but along their shared edge, so what survives
      // is a line exactly on each band boundary.
      parts.push(`<path d="${data}" fill="none" stroke="${ink}"`
        + strokeAttributes(ribbonPx + outlinePx * 2));
      parts.push(`<path d="${data}" fill="none" stroke="${paper}"` + strokeAttributes(ribbonPx));
      const pattern = patterns[((range.band % patterns.length) + patterns.length) % patterns.length];
      if (pattern.lines.length > 0) {
        parts.push(
          `<path d="${data}" fill="none" stroke="url(#${pattern.id})"` + strokeAttributes(ribbonPx),
        );
      }
    }
    if (coastlineRings.length > 0) {
      parts.push('</g>');
    }
  }

  // The linework goes over the zones, not under them. A zone is opaque paper
  // where its hatch is not inked, so anything drawn first is covered - and a
  // reader needs the coast and the streets to place the isochrone against.
  if (basemap.waterFeatures?.length) {
    const coastData = basemap.waterFeatures
      .flatMap((feature) => feature.paths)
      .map((path) => ringToPathData(Float64Array.from(path.flat()), transform))
      .filter((data) => data.length > 0)
      .join('');
    if (coastData.length > 0) {
      parts.push(
        `<path d="${coastData}" fill="none" stroke="${ink}"`
        + ` stroke-width="${contourWidth}" />`,
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
      `<path d="${commands.join('')}" fill="none" stroke="${scene.roadInk ?? ink}"`
      + ` stroke-width="${scene.roadStrokeWidth ?? 0.35}" stroke-linecap="round" />`,
    );
  }

  // The same zone around the same ways the screen draws, in the same order:
  // the outline wider than the zone, the paper that covers its inside, then
  // one stroke per pattern over the pieces whose band that pattern fills.
  //
  // A stroke carries one fill for its whole length, so a way has to be cut
  // where its band changes - which the screen has no need to do, deciding it
  // per fragment instead. Both cut at the same interpolated point.

  const plan = { labels: scene.labels ?? [] };
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
  if (scene.legend !== false && ribbons) {
    parts.push(buildLegendMarkup(ribbons, { widthPx, heightPx, ink, paper, fontSize, scene }));
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
function buildLegendMarkup(ribbons, { widthPx, heightPx, ink, paper, fontSize, scene }) {
  const cycle = [];
  ribbons.patterns.forEach((pattern, index) => {
    if (!cycle.some((entry) => entry.pattern.id === pattern.id)) {
      cycle.push({ pattern, label: ribbons.patternLabels?.[index] ?? '' });
    }
  });
  if (cycle.length === 0) {
    return '';
  }
  const swatch = Math.max(18, fontSize * 2);
  const rowHeight = swatch + 6;
  const boxWidth = swatch + 8 + fontSize * 8;
  const boxHeight = rowHeight * cycle.length + 10;
  const left = 12;
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
  const rows = cycle.map((entry, index) => {
    const y = boxTop + captionHeight + 5 + index * rowHeight;
    const fill = entry.pattern.lines.length === 0 ? paper : `url(#${entry.pattern.id})`;
    return `<rect x="${left + 5}" y="${formatSvgNumber(y)}" width="${swatch}"`
      + ` height="${swatch}" fill="${fill}" stroke="${ink}" stroke-width="0.7" />`
      + `<text x="${left + 5 + swatch + 8}" y="${formatSvgNumber(y + swatch / 2)}"`
      + ` font-family="${LABEL_FONT_FAMILY}" font-size="${fontSize}" fill="${ink}"`
      + ' dominant-baseline="central">'
      + `${escapeXmlText(entry.label)}</text>`;
  }).join('');
  const captionWidth = scene.legendCaption
    ? scene.legendCaption.length * fontSize * LABEL_WIDTH_PER_CHARACTER + 16
    : 0;
  void widthPx;
  return `<g><rect x="${left}" y="${formatSvgNumber(boxTop)}"`
    + ` width="${formatSvgNumber(Math.max(boxWidth, captionWidth))}"`
    + ` height="${formatSvgNumber(totalHeight)}" fill="${paper}" stroke="${ink}"`
    + ' stroke-width="0.7" />' + caption + rows + '</g>';
}

/** Legend rows showing the actual hatch, not a grey approximation of it. */
export function buildMonochromeLegendRows(bands) {
  return bands.map((band) => ({
    label: band.label,
    patternId: band.pattern.id,
    coverageRatio: patternCoverageRatio(band.pattern, 80),
  }));
}
