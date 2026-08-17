import {
  DEFAULT_COLOUR_CYCLE_MINUTES,
  ISOCHRONE_THEME_DARK,
  normalizeIsochroneTheme,
  timeToColour,
} from '../render/colour.js';
import { formatLegendRange, formatLegendRepeatNote } from '../ui/legend-format.js';
import { formatCommonMessage } from '../ui/localization.js';
import {
  getAirportFillStyle,
  getBoundaryStrokeStyle,
  getBoundaryWaterFillStyle,
  getForestFillStyle,
  getInlandWaterFillStyle,
  getWaterwayStrokeStyle,
  projectBoundaryBasemapToGraphPaths,
} from '../core/boundary-basemap.js';

const SVG_FONT_STACK = 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif';

const DEFAULT_OVERLAY_COLOURS = {
  dark: {
    overlayBackground: 'rgba(4, 12, 18, 0.88)',
    overlayBorder: 'rgba(130, 170, 210, 0.55)',
    overlayText: '#dceaf8',
    overlayNote: '#c0d4e8',
    scaleLineBackground: '#f6fbff',
    scaleLineAlternate: '#31577a',
    scaleLineBorder: '#c1d6e9',
    boundaryStroke: getBoundaryStrokeStyle('dark'),
    boundaryWaterFill: getBoundaryWaterFillStyle('dark'),
    forestFill: getForestFillStyle('dark'),
    inlandWaterFill: getInlandWaterFillStyle('dark'),
    waterwayNavigableStroke: getWaterwayStrokeStyle('dark', true),
    waterwayNonNavigableStroke: getWaterwayStrokeStyle('dark', false),
    airportFill: getAirportFillStyle('dark'),
  },
  light: {
    overlayBackground: 'rgba(251, 253, 255, 0.92)',
    overlayBorder: 'rgba(97, 130, 159, 0.62)',
    overlayText: '#173750',
    overlayNote: '#365772',
    scaleLineBackground: '#21435d',
    scaleLineAlternate: '#eef5fb',
    scaleLineBorder: '#21435d',
    boundaryStroke: getBoundaryStrokeStyle('light'),
    boundaryWaterFill: getBoundaryWaterFillStyle('light'),
    forestFill: getForestFillStyle('light'),
    inlandWaterFill: getInlandWaterFillStyle('light'),
    waterwayNavigableStroke: getWaterwayStrokeStyle('light', true),
    waterwayNonNavigableStroke: getWaterwayStrokeStyle('light', false),
    airportFill: getAirportFillStyle('light'),
  },
};

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertCssColourString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty CSS colour string`);
  }
}

function assertEdgeVertexData(edgeVertexData) {
  if (!(edgeVertexData instanceof Float32Array)) {
    throw new Error('edgeVertexData must be a Float32Array');
  }
  if (edgeVertexData.length % 6 !== 0) {
    throw new Error('edgeVertexData length must be a multiple of 6');
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatSvgNumber(value) {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function buildLegendEntries(cycleMinutes, options = {}) {
  const boundaries = [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1];
  const entries = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const rangeStartMinutes = boundaries[index] * cycleMinutes;
    const rangeEndMinutes = boundaries[index + 1] * cycleMinutes;
    const representativeSeconds = ((rangeStartMinutes + rangeEndMinutes) * 60) / 2;
    entries.push({
      colour: timeToColour(representativeSeconds, {
        cycleMinutes,
        theme: options.theme,
      }),
      label: formatLegendRange(rangeStartMinutes, rangeEndMinutes, {
        messages: options.messages,
      }),
    });
  }

  return entries;
}

function wrapTextByWords(text, maxCharsPerLine, maxLines) {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  if (normalizedText.length === 0) {
    return [];
  }
  const words = [];
  for (const rawWord of normalizedText.split(' ')) {
    if (rawWord.length <= maxCharsPerLine) {
      words.push(rawWord);
      continue;
    }
    for (let index = 0; index < rawWord.length; index += maxCharsPerLine) {
      words.push(rawWord.slice(index, index + maxCharsPerLine));
    }
  }
  const lines = [];
  let currentLine = '';
  let truncated = false;
  let wordIndex = 0;
  const boundedLineCount = Number.isFinite(maxLines);
  for (; wordIndex < words.length; wordIndex += 1) {
    const word = words[wordIndex];
    const candidate = currentLine.length === 0 ? word : `${currentLine} ${word}`;
    if (candidate.length <= maxCharsPerLine || currentLine.length === 0) {
      currentLine = candidate;
      continue;
    }
    lines.push(currentLine);
    currentLine = word;
    if (boundedLineCount && lines.length >= maxLines - 1) {
      break;
    }
  }
  if (boundedLineCount && wordIndex < words.length - 1) {
    truncated = true;
  }
  if (currentLine.length > 0 && (!boundedLineCount || lines.length < maxLines)) {
    lines.push(currentLine);
  }
  if (truncated && lines.length > 0) {
    const lastLineIndex = lines.length - 1;
    if (!lines[lastLineIndex].endsWith('...')) {
      lines[lastLineIndex] = `${lines[lastLineIndex]}...`;
    }
  }
  return lines;
}

function isTransparentCssColour(colourValue) {
  if (typeof colourValue !== 'string') {
    return true;
  }
  const normalized = colourValue.trim().toLowerCase();
  if (normalized.length === 0 || normalized === 'transparent') {
    return true;
  }
  if (normalized === 'rgba(0, 0, 0, 0)' || normalized === 'rgba(0,0,0,0)') {
    return true;
  }
  const rgbaMatch = normalized.match(/^rgba\((.+)\)$/);
  if (!rgbaMatch) {
    return false;
  }
  const channels = rgbaMatch[1].split(',').map((channel) => channel.trim());
  if (channels.length !== 4) {
    return false;
  }
  const alpha = Number.parseFloat(channels[3]);
  return Number.isFinite(alpha) && alpha <= 0;
}

function pickComputedBackgroundColour(computedStyle) {
  if (!computedStyle || typeof computedStyle.backgroundColor !== 'string') {
    return null;
  }
  const candidate = computedStyle.backgroundColor.trim();
  if (candidate.length === 0 || isTransparentCssColour(candidate)) {
    return null;
  }
  return candidate;
}

function readComputedCssCustomProperty(computedStyle, propertyName) {
  if (!computedStyle || typeof computedStyle.getPropertyValue !== 'function') {
    return null;
  }
  const value = computedStyle.getPropertyValue(propertyName)?.trim() ?? '';
  return value.length > 0 ? value : null;
}

export function resolveSvgBackgroundColour(shell, options = {}) {
  const explicitColour = options.backgroundColour ?? options.backgroundColor;
  if (typeof explicitColour === 'string' && explicitColour.trim().length > 0) {
    return explicitColour.trim();
  }

  const getComputedStyleImpl = options.getComputedStyleImpl ?? globalThis.getComputedStyle ?? null;
  if (typeof getComputedStyleImpl !== 'function') {
    return '#ffffff';
  }

  const ownerDocument = shell?.isochroneCanvas?.ownerDocument ?? globalThis.document ?? null;
  const candidateElements = [
    shell?.isochroneCanvas ?? null,
    shell?.boundaryCanvas ?? null,
    shell?.canvasStack ?? null,
    shell?.mapRegion ?? null,
    ownerDocument?.documentElement ?? null,
    ownerDocument?.body ?? null,
  ];

  for (const candidate of candidateElements) {
    if (!candidate) {
      continue;
    }
    const computedBackground = pickComputedBackgroundColour(getComputedStyleImpl(candidate));
    if (computedBackground !== null) {
      return computedBackground;
    }
  }

  return '#ffffff';
}

export function resolveSvgTheme(shell, options = {}) {
  if (typeof options.theme === 'string' && options.theme.trim().length > 0) {
    return normalizeIsochroneTheme(options.theme.trim(), ISOCHRONE_THEME_DARK);
  }

  const ownerDocument = shell?.isochroneCanvas?.ownerDocument ?? globalThis.document ?? null;
  const datasetTheme = ownerDocument?.documentElement?.dataset?.theme ?? null;
  return normalizeIsochroneTheme(datasetTheme, ISOCHRONE_THEME_DARK);
}

export function resolveSvgOverlayColours(shell, options = {}) {
  const theme = resolveSvgTheme(shell, options);
  const defaults = DEFAULT_OVERLAY_COLOURS[theme];
  const explicit = options.overlayColours && typeof options.overlayColours === 'object'
    ? options.overlayColours
    : {};
  const getComputedStyleImpl = options.getComputedStyleImpl ?? globalThis.getComputedStyle ?? null;
  const ownerDocument = shell?.isochroneCanvas?.ownerDocument ?? globalThis.document ?? null;
  const rootElement = ownerDocument?.documentElement ?? null;
  const rootComputedStyle =
    typeof getComputedStyleImpl === 'function' && rootElement ? getComputedStyleImpl(rootElement) : null;

  return {
    overlayBackground:
      explicit.overlayBackground
      ?? readComputedCssCustomProperty(rootComputedStyle, '--map-overlay-bg')
      ?? defaults.overlayBackground,
    overlayBorder:
      explicit.overlayBorder
      ?? readComputedCssCustomProperty(rootComputedStyle, '--map-overlay-border')
      ?? defaults.overlayBorder,
    overlayText:
      explicit.overlayText
      ?? readComputedCssCustomProperty(rootComputedStyle, '--map-overlay-text')
      ?? defaults.overlayText,
    overlayNote:
      explicit.overlayNote
      ?? readComputedCssCustomProperty(rootComputedStyle, '--map-overlay-note')
      ?? defaults.overlayNote,
    scaleLineBackground:
      explicit.scaleLineBackground
      ?? readComputedCssCustomProperty(rootComputedStyle, '--map-scale-line-bg')
      ?? defaults.scaleLineBackground,
    scaleLineAlternate:
      explicit.scaleLineAlternate
      ?? readComputedCssCustomProperty(rootComputedStyle, '--map-scale-line-alt')
      ?? defaults.scaleLineAlternate,
    scaleLineBorder:
      explicit.scaleLineBorder
      ?? readComputedCssCustomProperty(rootComputedStyle, '--map-scale-line-border')
      ?? defaults.scaleLineBorder,
    boundaryStroke: explicit.boundaryStroke ?? defaults.boundaryStroke,
    boundaryWaterFill: explicit.boundaryWaterFill ?? defaults.boundaryWaterFill,
    forestFill: explicit.forestFill ?? defaults.forestFill,
    inlandWaterFill: explicit.inlandWaterFill ?? defaults.inlandWaterFill,
    waterwayNavigableStroke: explicit.waterwayNavigableStroke ?? defaults.waterwayNavigableStroke,
    waterwayNonNavigableStroke:
      explicit.waterwayNonNavigableStroke ?? defaults.waterwayNonNavigableStroke,
    airportFill: explicit.airportFill ?? defaults.airportFill,
    theme,
  };
}

// Rough advance width of the sans-serif stack, as a fraction of font size.
// Only used to decide where to wrap, so it errs narrow: over-wrapping costs a
// line, under-wrapping would run text off the page.
const APPROX_GLYPH_WIDTH_RATIO = 0.55;

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * APPROX_GLYPH_WIDTH_RATIO;
}

/**
 * Geometry for the exported sheet, laid out as a poster: a title band, the map
 * in a frame, then a footer carrying the scale bar and the data credits.
 *
 * Every measurement derives from the map's own pixel size, so the proportions
 * hold for any region and at any print size - the SVG scales as one unit, and
 * the type scales with it instead of staying at screen sizes and shrinking to
 * nothing on paper.
 */
export function computeIsochronePosterLayout(mapWidthPx, mapHeightPx, options = {}) {
  assertPositiveInteger(mapWidthPx, 'mapWidthPx');
  assertPositiveInteger(mapHeightPx, 'mapHeightPx');
  const creditLineCount = Number.isInteger(options.creditLineCount) && options.creditLineCount > 0
    ? options.creditLineCount
    : 0;
  const legendRowCount = Number.isInteger(options.legendRowCount) && options.legendRowCount > 0
    ? options.legendRowCount
    : 1;

  // One typographic unit, ~1.1% of the sheet's long edge.
  const unit = Math.max(4, Math.max(mapWidthPx, mapHeightPx) / 90);
  const margin = unit * 2;
  const titleFontSize = unit * 2.6;
  const legendFontSize = unit * 1.5;
  const legendNoteFontSize = unit * 1.2;
  const scaleFontSize = unit * 1.35;
  const creditFontSize = unit * 0.95;

  const subtitleFontSize = unit * 1.5;
  const hasSubtitle = options.hasSubtitle === true;
  const titleBandHeight = hasSubtitle
    ? titleFontSize * 1.5 + subtitleFontSize * 1.9
    : titleFontSize * 1.8;
  const mapX = margin;
  const mapY = margin + titleBandHeight;

  const scaleBarHeight = unit * 0.9;
  const scaleRowHeight = Math.max(scaleBarHeight, scaleFontSize) * 1.6;
  // Row pitch comes from the font, so substituting a different sans-serif at
  // print time cannot collapse rows into each other.
  const legendRowHeight = legendFontSize * 1.7;
  const creditLineHeight = creditFontSize * 1.4;

  // Footer stack, each band on its own line so nothing can collide: the key,
  // then the scale bar, then the data credits.
  const legendY = mapY + mapHeightPx + unit * 1.8;
  const legendNoteBaselineY = legendY + legendRowCount * legendRowHeight + legendNoteFontSize;
  const scaleY = legendNoteBaselineY + unit * 1.2;
  const creditFirstBaselineY = scaleY + scaleRowHeight + creditFontSize;

  return {
    unit,
    margin,
    titleFontSize,
    legendFontSize,
    legendNoteFontSize,
    scaleFontSize,
    creditFontSize,
    subtitleFontSize,
    titleBandHeight,
    titleBaselineY: margin + titleFontSize,
    subtitleBaselineY: margin + titleFontSize * 1.5 + subtitleFontSize,
    mapX,
    mapY,
    mapWidthPx,
    mapHeightPx,
    legendY,
    legendRowHeight,
    legendNoteBaselineY,
    scaleBarHeight,
    scaleRowHeight,
    scaleY,
    creditLineHeight,
    creditFirstBaselineY,
    posterWidthPx: Math.ceil(mapWidthPx + margin * 2),
    posterHeightPx: Math.ceil(
      creditLineCount > 0
        ? creditFirstBaselineY + (creditLineCount - 1) * creditLineHeight + margin
        : scaleY + scaleRowHeight + margin,
    ),
  };
}

function buildSvgTitleOverlayMarkup(layout, title, subtitle, overlayColours) {
  const lines = [
    '  <g id="isochrone-title">',
    `    <text x="${formatSvgNumber(layout.margin)}" y="${formatSvgNumber(layout.titleBaselineY)}" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="${formatSvgNumber(layout.titleFontSize)}" font-weight="600" fill="${escapeXml(overlayColours.overlayText)}">${escapeXml(title)}</text>`,
  ];
  if (typeof subtitle === 'string' && subtitle.length > 0) {
    lines.push(
      `    <text x="${formatSvgNumber(layout.margin)}" y="${formatSvgNumber(layout.subtitleBaselineY)}" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="${formatSvgNumber(layout.subtitleFontSize)}" fill="${escapeXml(overlayColours.overlayNote)}">${escapeXml(subtitle)}</text>`,
    );
  }
  lines.push('  </g>');
  return lines.join('\n');
}

/**
 * Packs the colour key into rows of swatch+label pairs that fit the poster's
 * content width. Laying it out along the footer rather than as a panel floating
 * over the map keeps the export free of the translucent on-screen chrome, and
 * means the key can never sit on top of the isochrone it explains.
 */
function layOutLegendRows(entries, layout) {
  const swatchSize = layout.legendFontSize;
  const swatchGap = layout.unit * 0.7;
  const itemGap = layout.unit * 2.4;

  const items = entries.map((entry) => ({
    entry,
    width: swatchSize + swatchGap + estimateTextWidth(entry.label, layout.legendFontSize),
  }));

  const rows = [];
  let currentRow = [];
  let currentWidth = 0;
  for (const item of items) {
    const advance = currentRow.length === 0 ? item.width : itemGap + item.width;
    if (currentRow.length > 0 && currentWidth + advance > layout.mapWidthPx) {
      rows.push(currentRow);
      currentRow = [item];
      currentWidth = item.width;
      continue;
    }
    currentRow.push(item);
    currentWidth += advance;
  }
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }
  return { rows, swatchSize, swatchGap, itemGap };
}

function buildSvgLegendOverlayMarkup(layout, legendRows, overlayColours, options = {}) {
  const { rows, swatchSize, swatchGap, itemGap } = legendRows;
  const noteText = options.noteText ?? '';

  const lines = ['  <g id="isochrone-legend">'];
  let rowTop = layout.legendY;
  for (const row of rows) {
    let itemX = layout.mapX;
    const centreY = rowTop + layout.legendRowHeight / 2;
    for (const item of row) {
      lines.push(
        `    <rect x="${formatSvgNumber(itemX)}" y="${formatSvgNumber(centreY - swatchSize / 2)}" width="${formatSvgNumber(swatchSize)}" height="${formatSvgNumber(swatchSize)}" rx="${formatSvgNumber(swatchSize * 0.18)}" fill="rgb(${item.entry.colour[0]}, ${item.entry.colour[1]}, ${item.entry.colour[2]})" />`,
      );
      lines.push(
        `    <text x="${formatSvgNumber(itemX + swatchSize + swatchGap)}" y="${formatSvgNumber(centreY)}" dominant-baseline="central" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="${formatSvgNumber(layout.legendFontSize)}" fill="${escapeXml(overlayColours.overlayText)}">${escapeXml(item.entry.label)}</text>`,
      );
      itemX += item.width + itemGap;
    }
    rowTop += layout.legendRowHeight;
  }
  if (noteText.length > 0) {
    lines.push(
      `    <text x="${formatSvgNumber(layout.mapX)}" y="${formatSvgNumber(layout.legendNoteBaselineY)}" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="${formatSvgNumber(layout.legendNoteFontSize)}" fill="${escapeXml(overlayColours.overlayNote)}">${escapeXml(noteText)}</text>`,
    );
  }
  lines.push('  </g>');
  return lines.join('\n');
}

function buildSvgScaleOverlayMarkup(
  layout,
  scaleBarLabel,
  scaleBarWidthPx,
  scaleBarSegmentWidthPx,
  overlayColours,
) {
  // The scale bar arrives measured in map pixels, which is exactly the unit the
  // map group is drawn in, so it needs no rescaling - only repositioning into
  // the footer band.
  const clampedScaleWidthPx = Math.max(layout.unit * 2, scaleBarWidthPx);
  const clampedSegmentWidthPx = Math.max(
    layout.unit * 0.4,
    Math.min(clampedScaleWidthPx, scaleBarSegmentWidthPx),
  );
  const lineX = layout.mapX;
  const barHeight = layout.scaleBarHeight;
  const lineY = layout.scaleY + (layout.scaleRowHeight - barHeight) / 2;
  const clipId = 'isochrone-scale-pattern-clip';
  const cornerRadius = barHeight / 2;

  const lines = [
    '  <g id="isochrone-scale">',
    `    <defs><clipPath id="${clipId}"><rect x="${formatSvgNumber(lineX)}" y="${formatSvgNumber(lineY)}" width="${formatSvgNumber(clampedScaleWidthPx)}" height="${formatSvgNumber(barHeight)}" rx="${formatSvgNumber(cornerRadius)}" /></clipPath></defs>`,
    `    <rect x="${formatSvgNumber(lineX)}" y="${formatSvgNumber(lineY)}" width="${formatSvgNumber(clampedScaleWidthPx)}" height="${formatSvgNumber(barHeight)}" rx="${formatSvgNumber(cornerRadius)}" fill="${escapeXml(overlayColours.scaleLineBackground)}" stroke="${escapeXml(overlayColours.scaleLineBorder)}" stroke-width="${formatSvgNumber(Math.max(0.5, layout.unit * 0.08))}" />`,
    `    <g id="isochrone-scale-pattern" clip-path="url(#${clipId})">`,
  ];

  for (
    let segmentX = lineX + clampedSegmentWidthPx;
    segmentX < lineX + clampedScaleWidthPx;
    segmentX += clampedSegmentWidthPx * 2
  ) {
    const segmentWidth = Math.min(clampedSegmentWidthPx, lineX + clampedScaleWidthPx - segmentX);
    lines.push(
      `      <rect x="${formatSvgNumber(segmentX)}" y="${formatSvgNumber(lineY)}" width="${formatSvgNumber(segmentWidth)}" height="${formatSvgNumber(barHeight)}" fill="${escapeXml(overlayColours.scaleLineAlternate)}" />`,
    );
  }

  lines.push('    </g>');
  // Label sits beside the bar, not under it: the credits occupy the line below.
  lines.push(
    `    <text x="${formatSvgNumber(lineX + clampedScaleWidthPx + layout.unit)}" y="${formatSvgNumber(lineY + barHeight / 2)}" dominant-baseline="central" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="${formatSvgNumber(layout.scaleFontSize)}" fill="${escapeXml(overlayColours.overlayText)}">${escapeXml(scaleBarLabel)}</text>`,
  );
  lines.push('  </g>');
  return lines.join('\n');
}

function wrapCopyrightNotice(copyrightNotice, layout) {
  const maxCharsPerLine = Math.max(
    16,
    Math.floor(layout.mapWidthPx / (layout.creditFontSize * APPROX_GLYPH_WIDTH_RATIO)),
  );
  return wrapTextByWords(copyrightNotice, maxCharsPerLine, Number.POSITIVE_INFINITY);
}

function buildSvgCopyrightOverlayMarkup(layout, wrappedLines, overlayColours) {
  if (wrappedLines.length === 0) {
    return '';
  }

  const lines = ['  <g id="isochrone-copyright">'];
  let textY = layout.creditFirstBaselineY;
  for (const line of wrappedLines) {
    lines.push(
      `    <text x="${formatSvgNumber(layout.mapX)}" y="${formatSvgNumber(textY)}" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="${formatSvgNumber(layout.creditFontSize)}" fill="${escapeXml(overlayColours.overlayNote)}">${escapeXml(line)}</text>`,
    );
    textY += layout.creditLineHeight;
  }
  lines.push('  </g>');
  return lines.join('\n');
}

function buildSvgPathCommands(path) {
  const commands = [];
  for (let index = 0; index < path.length; index += 1) {
    const [graphX, graphY] = path[index];
    commands.push(`${index === 0 ? 'M' : 'L'} ${formatSvgNumber(graphX)} ${formatSvgNumber(graphY)}`);
  }
  return commands.join(' ');
}

function buildSvgFilledPolygonMarkup(features, fillColour, groupId) {
  const pathMarkup = [];
  for (const feature of features) {
    for (const path of feature.paths) {
      if (path.length < 3) {
        continue;
      }
      pathMarkup.push(
        `    <path d="${buildSvgPathCommands(path)} Z" fill="${escapeXml(fillColour)}" stroke="none" />`,
      );
    }
  }

  if (pathMarkup.length === 0) {
    return '';
  }

  return [`  <g id="${groupId}">`, ...pathMarkup, '  </g>'].join('\n');
}

function buildSvgStrokedLineMarkup(features, resolveStrokeColour, groupId, strokeWidth = 1.2) {
  const pathMarkup = [];
  for (const feature of features) {
    const strokeColour = resolveStrokeColour(feature);
    for (const path of feature.paths) {
      if (path.length < 2) {
        continue;
      }
      pathMarkup.push(
        `    <path d="${buildSvgPathCommands(path)}" fill="none" stroke="${escapeXml(strokeColour)}" stroke-width="${formatSvgNumber(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" />`,
      );
    }
  }

  if (pathMarkup.length === 0) {
    return '';
  }

  return [`  <g id="${groupId}">`, ...pathMarkup, '  </g>'].join('\n');
}

function buildSvgBoundaryLineMarkup(features, boundaryStroke, strokeWidth) {
  return buildSvgStrokedLineMarkup(
    features,
    () => boundaryStroke,
    'isochrone-boundaries',
    strokeWidth,
  );
}

export function buildIsochroneEdgeLineMarkup(edgeVertexData, options = {}) {
  assertEdgeVertexData(edgeVertexData);

  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive number');
  }

  const theme = normalizeIsochroneTheme(options.theme, ISOCHRONE_THEME_DARK);
  // Stroke width is in map units and scales with the artwork. A non-scaling
  // stroke would hold at one device pixel while the map shrank to fit a page,
  // which is what made printed lines look far too heavy.
  const strokeWidth = formatSvgNumber(
    Number.isFinite(options.strokeWidth) && options.strokeWidth > 0 ? options.strokeWidth : 1,
  );
  // Endpoints are rounded to whole grid pixels - the resolution the graph is
  // stored at anyway, and far finer than print can resolve. On a region with
  // half a million edges the dropped decimals are several MB of file.
  const edgeLines = [];
  for (let i = 0; i < edgeVertexData.length; i += 6) {
    const x0 = edgeVertexData[i];
    const y0 = edgeVertexData[i + 1];
    const t0 = edgeVertexData[i + 2];
    const x1 = edgeVertexData[i + 3];
    const y1 = edgeVertexData[i + 4];
    const t1 = edgeVertexData[i + 5];

    if (
      !Number.isFinite(x0)
      || !Number.isFinite(y0)
      || !Number.isFinite(x1)
      || !Number.isFinite(y1)
      || !Number.isFinite(t0)
      || !Number.isFinite(t1)
      || t0 < 0
      || t1 < 0
    ) {
      continue;
    }

    const representativeSeconds = Math.max(0, (t0 + t1) * 0.5);
    const [r, g, b] = timeToColour(representativeSeconds, { cycleMinutes, theme });

    edgeLines.push(
      `<line x1="${Math.round(x0)}" y1="${Math.round(y0)}" x2="${Math.round(x1)}" y2="${Math.round(y1)}" stroke="rgb(${r}, ${g}, ${b})" stroke-width="${strokeWidth}" stroke-linecap="round" />`,
    );
  }

  return edgeLines.join('\n');
}

export function buildRenderedIsochroneSvgDocument(options = {}) {
  const widthPx = Math.floor(options.widthPx);
  const heightPx = Math.floor(options.heightPx);
  assertPositiveInteger(widthPx, 'widthPx');
  assertPositiveInteger(heightPx, 'heightPx');

  const backgroundColour = options.backgroundColour ?? options.backgroundColor ?? '#ffffff';
  assertCssColourString(backgroundColour, 'backgroundColour');
  const edgeVertexData = options.edgeVertexData ?? new Float32Array(0);
  assertEdgeVertexData(edgeVertexData);
  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive number');
  }

  const theme = normalizeIsochroneTheme(options.theme, ISOCHRONE_THEME_DARK);
  const overlayColours = resolveSvgOverlayColours(null, {
    overlayColours: options.overlayColours,
    theme,
  });
  const title = typeof options.title === 'string' ? options.title : 'Isochrone export';
  const subtitle = typeof options.subtitle === 'string' ? options.subtitle : '';
  const scaleBarLabel =
    typeof options.scaleBarLabel === 'string' && options.scaleBarLabel.trim().length > 0
      ? options.scaleBarLabel.trim()
      : '1 km';
  const scaleBarWidthPx =
    Number.isFinite(options.scaleBarWidthPx) && options.scaleBarWidthPx > 0
      ? options.scaleBarWidthPx
      : 96;
  const scaleBarSegmentWidthPx =
    Number.isFinite(options.scaleBarSegmentWidthPx) && options.scaleBarSegmentWidthPx > 0
      ? options.scaleBarSegmentWidthPx
      : Math.max(4, scaleBarWidthPx / 4);
  const copyrightNotice =
    typeof options.copyrightNotice === 'string' && options.copyrightNotice.trim().length > 0
      ? options.copyrightNotice.trim()
      : 'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL): https://www.openstreetmap.org/copyright';
  const messages = options.messages ?? null;
  // The accessible name carries both lines, since the subtitle is what says
  // which modes the isochrone is for.
  const escapedTitle = escapeXml(subtitle.length > 0 ? `${title}. ${subtitle}` : title);
  const escapedBackgroundColour = escapeXml(backgroundColour);

  if ((options.graphHeader && !options.boundaryPayload) || (!options.graphHeader && options.boundaryPayload)) {
    throw new Error('graphHeader and boundaryPayload must be provided together');
  }

  const projectedBoundary =
    options.boundaryPayload && options.graphHeader
      ? projectBoundaryBasemapToGraphPaths(options.boundaryPayload, options.graphHeader)
      : null;

  // Bottom-to-top, matching the canvas draw order: forest, airports, inland
  // water, sea, waterways, then admin boundary lines.
  const forestMarkup = projectedBoundary
    ? buildSvgFilledPolygonMarkup(
        projectedBoundary.forestFeatures,
        overlayColours.forestFill,
        'isochrone-forest',
      )
    : '';
  const airportMarkup = projectedBoundary
    ? buildSvgFilledPolygonMarkup(
        projectedBoundary.airportFeatures,
        overlayColours.airportFill,
        'isochrone-airports',
      )
    : '';
  const inlandWaterMarkup = projectedBoundary
    ? buildSvgFilledPolygonMarkup(
        projectedBoundary.inlandWaterFeatures,
        overlayColours.inlandWaterFill,
        'isochrone-inland-water',
      )
    : '';
  const seaMarkup = projectedBoundary
    ? buildSvgFilledPolygonMarkup(
        projectedBoundary.waterFeatures,
        overlayColours.boundaryWaterFill,
        'isochrone-sea',
      )
    : '';
  const waterwayMarkup = projectedBoundary
    ? buildSvgStrokedLineMarkup(
        projectedBoundary.waterwayFeatures,
        (feature) =>
          feature.navigable
            ? overlayColours.waterwayNavigableStroke
            : overlayColours.waterwayNonNavigableStroke,
        'isochrone-waterways',
      )
    : '';
  // Two passes: the sheet's height depends on how many lines the key and the
  // credits wrap to, which in turn depends on the type sizes the first pass
  // establishes. The type sizes never change between passes, only the offsets.
  const provisionalLayout = computeIsochronePosterLayout(widthPx, heightPx, {
    hasSubtitle: subtitle.length > 0,
  });
  const creditLines = wrapCopyrightNotice(copyrightNotice, provisionalLayout);
  const legendEntries = buildLegendEntries(cycleMinutes, { messages, theme });
  const legendRows = layOutLegendRows(legendEntries, provisionalLayout);
  const layout = computeIsochronePosterLayout(widthPx, heightPx, {
    creditLineCount: creditLines.length,
    legendRowCount: legendRows.rows.length,
    hasSubtitle: subtitle.length > 0,
  });

  const boundaryMarkup = projectedBoundary
    ? buildSvgBoundaryLineMarkup(
        projectedBoundary.features,
        overlayColours.boundaryStroke,
        layout.unit * 0.09,
      )
    : '';
  const edgeLines = buildIsochroneEdgeLineMarkup(edgeVertexData, {
    cycleMinutes,
    theme,
    strokeWidth: layout.unit * 0.045,
  });
  const titleOverlayMarkup = buildSvgTitleOverlayMarkup(layout, title, subtitle, overlayColours);
  const legendOverlayMarkup = buildSvgLegendOverlayMarkup(layout, legendRows, overlayColours, {
    noteText: formatLegendRepeatNote(cycleMinutes, { messages }),
  });
  const scaleOverlayMarkup = buildSvgScaleOverlayMarkup(
    layout,
    scaleBarLabel,
    scaleBarWidthPx,
    scaleBarSegmentWidthPx,
    overlayColours,
  );
  const copyrightOverlayMarkup = buildSvgCopyrightOverlayMarkup(
    layout,
    creditLines,
    overlayColours,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.posterWidthPx}" height="${layout.posterHeightPx}" viewBox="0 0 ${layout.posterWidthPx} ${layout.posterHeightPx}" role="img" aria-label="${escapedTitle}">`,
    `  <title>${escapedTitle}</title>`,
    `  <rect id="isochrone-background" x="0" y="0" width="${layout.posterWidthPx}" height="${layout.posterHeightPx}" fill="${escapedBackgroundColour}" />`,
    // Coastline and water polygons are projected from the region boundary and
    // run past the routing grid they are drawn against, so the map is clipped
    // to its own extent - otherwise that overspill bleeds into the poster's
    // margins and off the edge of the sheet.
    `  <defs><clipPath id="isochrone-map-clip"><rect x="0" y="0" width="${widthPx}" height="${heightPx}" /></clipPath></defs>`,
    // The map keeps its own pixel coordinate system; the poster frame is built
    // around it by translation, so projected geometry never has to be rescaled.
    `  <g id="isochrone-map" clip-path="url(#isochrone-map-clip)" transform="translate(${formatSvgNumber(layout.mapX)}, ${formatSvgNumber(layout.mapY)})">`,
    forestMarkup,
    airportMarkup,
    inlandWaterMarkup,
    seaMarkup,
    waterwayMarkup,
    boundaryMarkup,
    '  <g id="isochrone-edges">',
    edgeLines,
    '  </g>',
    '  </g>',
    titleOverlayMarkup,
    legendOverlayMarkup,
    scaleOverlayMarkup,
    copyrightOverlayMarkup,
    '</svg>',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

// Mode names as they read inside the export's subtitle, which is not always how
// they read on a toggle button - so they get their own locale keys.
const EXPORT_MODE_NAME_FALLBACKS = {
  walk: 'walking',
  bike: 'cycling',
  car: 'driving',
  water: 'ferry',
  transit: 'public transport',
};

/**
 * Joins names the way the reader's language does it ("a, b and c" / "a, b und
 * c" / "a, b et c"), falling back to comma separation where Intl.ListFormat is
 * unavailable.
 */
function formatModeNameList(names, locale) {
  if (names.length === 0) {
    return '';
  }
  if (typeof Intl?.ListFormat === 'function') {
    try {
      return new Intl.ListFormat(locale || 'en', {
        style: 'long',
        type: 'conjunction',
      }).format(names);
    } catch {
      // Unknown locale tag - fall through to the plain join.
    }
  }
  return names.join(', ');
}

/**
 * Builds the export's heading as a title plus a labelled subtitle, e.g.
 * "Isochrone of Berlin" / "Travel modes: walking and public transport".
 *
 * Naming the list ("Travel modes: ...") rather than running it into the title
 * ("...by walking, public transit") is what keeps this grammatical across every
 * language and every combination of modes: the alternative needs a preposition
 * that agrees with each mode noun, and those differ by mode and by language.
 */
export function formatIsochroneExportTitle(locationName, modeValues, options = {}) {
  const messages = options.messages ?? null;
  const locale = typeof options.locale === 'string' && options.locale.trim().length > 0
    ? options.locale.trim()
    : 'en';
  const normalizedLocation =
    typeof locationName === 'string' && locationName.trim().length > 0
      ? locationName.trim()
      : formatCommonMessage(messages, 'export.unknownLocation', {}, 'an unknown location');

  const names = [];
  if (Array.isArray(modeValues)) {
    for (const modeValue of modeValues) {
      if (typeof modeValue !== 'string') {
        continue;
      }
      const fallback = EXPORT_MODE_NAME_FALLBACKS[modeValue];
      if (fallback === undefined) {
        continue;
      }
      names.push(formatCommonMessage(messages, `export.mode.${modeValue}`, {}, fallback));
    }
  }

  const title = formatCommonMessage(
    messages,
    'export.title',
    { location: normalizedLocation },
    `Isochrone of ${normalizedLocation}`,
  );
  const subtitle = names.length > 0
    ? formatCommonMessage(
      messages,
      'export.modes',
      { modes: formatModeNameList(names, locale) },
      `Travel modes: ${formatModeNameList(names, locale)}`,
    )
    : '';

  return { title, subtitle };
}

export function buildSvgExportFilename(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('now must be a valid Date');
  }

  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hours = pad2(now.getHours());
  const minutes = pad2(now.getMinutes());
  const seconds = pad2(now.getSeconds());
  return `isochrone-${year}${month}${day}-${hours}${minutes}${seconds}.svg`;
}

export function exportCurrentRenderedIsochroneSvg(shell, options = {}) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }
  if (!shell.isochroneCanvas || !Number.isInteger(shell.isochroneCanvas.width)) {
    throw new Error('shell.isochroneCanvas with width/height is required');
  }

  const widthPx = Number.isInteger(options.graphHeader?.gridWidthPx)
    ? options.graphHeader.gridWidthPx
    : shell.isochroneCanvas.width;
  const heightPx = Number.isInteger(options.graphHeader?.gridHeightPx)
    ? options.graphHeader.gridHeightPx
    : shell.isochroneCanvas.height;
  assertPositiveInteger(widthPx, 'shell.isochroneCanvas.width');
  assertPositiveInteger(heightPx, 'shell.isochroneCanvas.height');

  const theme = resolveSvgTheme(shell, options);
  const overlayColours = resolveSvgOverlayColours(shell, {
    ...options,
    theme,
  });
  const backgroundColour = resolveSvgBackgroundColour(shell, options);
  const scaleBarSegmentWidthPx = resolveScaleBarSegmentWidthPx(shell, options);
  const svgDocument = buildRenderedIsochroneSvgDocument({
    widthPx,
    heightPx,
    backgroundColour,
    graphHeader: options.graphHeader ?? null,
    boundaryPayload: options.boundaryPayload ?? null,
    edgeVertexData: options.edgeVertexData ?? new Float32Array(0),
    cycleMinutes: options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES,
    theme,
    overlayColours,
    title: options.title ?? 'Isochrone export',
    subtitle: options.subtitle,
    messages: options.messages ?? null,
    scaleBarLabel: options.scaleBarLabel,
    scaleBarWidthPx: options.scaleBarWidthPx,
    scaleBarSegmentWidthPx,
    copyrightNotice: options.copyrightNotice,
  });
  const filename = options.filename ?? buildSvgExportFilename(options.now ?? new Date());

  const documentObject = options.documentObject ?? globalThis.document;
  const urlObject = options.urlObject ?? globalThis.URL;
  const scheduleRevoke = options.scheduleRevoke ?? ((callback) => setTimeout(callback, 0));
  if (!documentObject || typeof documentObject.createElement !== 'function' || !documentObject.body) {
    throw new Error('A DOM document with body is required for SVG download');
  }
  if (
    !urlObject
    || typeof urlObject.createObjectURL !== 'function'
    || typeof urlObject.revokeObjectURL !== 'function'
  ) {
    throw new Error('URL.createObjectURL/revokeObjectURL are required for SVG download');
  }
  if (typeof scheduleRevoke !== 'function') {
    throw new Error('options.scheduleRevoke must be a function when provided');
  }

  const blob = new Blob([svgDocument], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = urlObject.createObjectURL(blob);
  const anchor = documentObject.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  documentObject.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  scheduleRevoke(() => {
    urlObject.revokeObjectURL(objectUrl);
  });

  return { filename, svgDocument };
}

function resolveScaleBarSegmentWidthPx(shell, options = {}) {
  if (Number.isFinite(options.scaleBarSegmentWidthPx) && options.scaleBarSegmentWidthPx > 0) {
    return options.scaleBarSegmentWidthPx;
  }

  const fromStyleProperty = Number.parseFloat(
    shell?.distanceScaleLine?.style?.getPropertyValue?.('--scale-segment-width-px')
      ?? shell?.distanceScaleLine?.style?.['--scale-segment-width-px']
      ?? '',
  );
  if (Number.isFinite(fromStyleProperty) && fromStyleProperty > 0) {
    return fromStyleProperty;
  }

  const widthPx = Number.parseFloat(shell?.distanceScaleLine?.style?.width ?? '');
  if (Number.isFinite(widthPx) && widthPx > 0) {
    return Math.max(4, widthPx / 4);
  }

  return 24;
}

export function bindSvgExportControl(shell, dependencies = {}) {
  if (!shell || typeof shell !== 'object' || !shell.exportSvgButton) {
    throw new Error('shell.exportSvgButton is required');
  }

  const exportSvg = dependencies.exportCurrentRenderedIsochroneSvg;
  if (typeof exportSvg !== 'function') {
    throw new Error('dependencies.exportCurrentRenderedIsochroneSvg must be a function');
  }
  const onExportSuccess = dependencies.onExportSuccess;
  if (onExportSuccess !== undefined && typeof onExportSuccess !== 'function') {
    throw new Error('dependencies.onExportSuccess must be a function when provided');
  }
  const onExportError = dependencies.onExportError;
  if (onExportError !== undefined && typeof onExportError !== 'function') {
    throw new Error('dependencies.onExportError must be a function when provided');
  }

  const handleClick = () => {
    let exportResult;
    try {
      exportResult = exportSvg(shell);
    } catch (error) {
      if (typeof onExportError === 'function') {
        onExportError(error);
      }
      return;
    }

    Promise.resolve(exportResult)
      .then((resolvedResult) => {
        if (typeof onExportSuccess === 'function') {
          onExportSuccess(resolvedResult);
        }
      })
      .catch((error) => {
        if (typeof onExportError === 'function') {
          onExportError(error);
        }
      });
  };

  shell.exportSvgButton.addEventListener('click', handleClick);
  return {
    dispose() {
      shell.exportSvgButton.removeEventListener('click', handleClick);
    },
  };
}
