import {
  DEFAULT_COLOUR_CYCLE_MINUTES,
  ISOCHRONE_THEME_DARK,
  normalizeIsochroneTheme,
  timeToColour,
} from '../render/colour.js';
import { formatLegendRange, formatLegendRepeatNote } from '../ui/legend-format.js';
import {
  getBoundaryStrokeStyle,
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
  const words = normalizedText.split(' ');
  const lines = [];
  let currentLine = '';
  let truncated = false;
  let wordIndex = 0;
  for (; wordIndex < words.length; wordIndex += 1) {
    const word = words[wordIndex];
    const candidate = currentLine.length === 0 ? word : `${currentLine} ${word}`;
    if (candidate.length <= maxCharsPerLine || currentLine.length === 0) {
      currentLine = candidate;
      continue;
    }
    lines.push(currentLine);
    currentLine = word;
    if (lines.length >= maxLines - 1) {
      break;
    }
  }
  if (wordIndex < words.length - 1) {
    truncated = true;
  }
  if (currentLine.length > 0 && lines.length < maxLines) {
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

function resolveSvgBackgroundColour(shell, options = {}) {
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

function resolveSvgTheme(shell, options = {}) {
  if (typeof options.theme === 'string' && options.theme.trim().length > 0) {
    return normalizeIsochroneTheme(options.theme.trim(), ISOCHRONE_THEME_DARK);
  }

  const ownerDocument = shell?.isochroneCanvas?.ownerDocument ?? globalThis.document ?? null;
  const datasetTheme = ownerDocument?.documentElement?.dataset?.theme ?? null;
  return normalizeIsochroneTheme(datasetTheme, ISOCHRONE_THEME_DARK);
}

function resolveSvgOverlayColours(shell, options = {}) {
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
    theme,
  };
}

function buildSvgTitleOverlayMarkup(widthPx, title, overlayColours) {
  const boxHeight = 32;
  const titleWidthPx = Math.min(Math.max(220, title.length * 7.2 + 22), Math.max(220, widthPx - 24));
  return [
    '  <g id="isochrone-title">',
    `    <rect x="12" y="12" width="${formatSvgNumber(titleWidthPx)}" height="${boxHeight}" rx="6" fill="${escapeXml(overlayColours.overlayBackground)}" stroke="${escapeXml(overlayColours.overlayBorder)}" />`,
    `    <text x="22" y="33" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="15" fill="${escapeXml(overlayColours.overlayText)}">${escapeXml(title)}</text>`,
    '  </g>',
  ].join('\n');
}

function buildSvgLegendOverlayMarkup(widthPx, cycleMinutes, overlayColours, options = {}) {
  const entries = buildLegendEntries(cycleMinutes, {
    messages: options.messages ?? null,
    theme: options.theme,
  });
  const rowHeight = 17;
  const boxWidth = 220;
  const boxHeight = 16 + entries.length * rowHeight + 20;
  const boxX = Math.max(12, widthPx - boxWidth - 12);
  const boxY = 12;

  const lines = [
    '  <g id="isochrone-legend">',
    `    <rect x="${formatSvgNumber(boxX)}" y="${boxY}" width="${boxWidth}" height="${boxHeight}" rx="6" fill="${escapeXml(overlayColours.overlayBackground)}" stroke="${escapeXml(overlayColours.overlayBorder)}" />`,
  ];

  let textY = boxY + 18;
  for (const entry of entries) {
    lines.push(
      `    <rect x="${formatSvgNumber(boxX + 10)}" y="${formatSvgNumber(textY - 10)}" width="11" height="11" rx="2" fill="rgb(${entry.colour[0]}, ${entry.colour[1]}, ${entry.colour[2]})" />`,
    );
    lines.push(
      `    <text x="${formatSvgNumber(boxX + 28)}" y="${formatSvgNumber(textY)}" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="11" fill="${escapeXml(overlayColours.overlayText)}">${escapeXml(entry.label)}</text>`,
    );
    textY += rowHeight;
  }
  lines.push(
    `    <text x="${formatSvgNumber(boxX + 10)}" y="${formatSvgNumber(boxY + boxHeight - 7)}" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="10" fill="${escapeXml(overlayColours.overlayNote)}">${escapeXml(formatLegendRepeatNote(cycleMinutes, { messages: options.messages ?? null }))}</text>`,
  );
  lines.push('  </g>');
  return lines.join('\n');
}

function buildSvgScaleOverlayMarkup(
  heightPx,
  scaleBarLabel,
  scaleBarWidthPx,
  scaleBarSegmentWidthPx,
  overlayColours,
) {
  const clampedScaleWidthPx = Math.max(24, Math.round(scaleBarWidthPx));
  const clampedSegmentWidthPx = Math.max(
    4,
    Math.min(clampedScaleWidthPx, Math.round(scaleBarSegmentWidthPx)),
  );
  const boxWidth = Math.max(120, clampedScaleWidthPx + 24);
  const boxHeight = 40;
  const boxX = 12;
  const boxY = Math.max(12, heightPx - boxHeight - 12);
  const lineX = boxX + 12;
  const lineY = boxY + 14;
  const lineHeight = 5;
  const clipId = 'isochrone-scale-pattern-clip';

  const lines = [
    '  <g id="isochrone-scale">',
    `    <rect x="${boxX}" y="${formatSvgNumber(boxY)}" width="${boxWidth}" height="${boxHeight}" rx="6" fill="${escapeXml(overlayColours.overlayBackground)}" stroke="${escapeXml(overlayColours.overlayBorder)}" />`,
    `    <defs><clipPath id="${clipId}"><rect x="${lineX}" y="${formatSvgNumber(lineY)}" width="${clampedScaleWidthPx}" height="${lineHeight}" rx="3" /></clipPath></defs>`,
    `    <rect x="${lineX}" y="${formatSvgNumber(lineY)}" width="${clampedScaleWidthPx}" height="${lineHeight}" rx="3" fill="${escapeXml(overlayColours.scaleLineBackground)}" stroke="${escapeXml(overlayColours.scaleLineBorder)}" />`,
    `    <g id="isochrone-scale-pattern" clip-path="url(#${clipId})">`,
  ];

  for (
    let segmentX = lineX + clampedSegmentWidthPx;
    segmentX < lineX + clampedScaleWidthPx;
    segmentX += clampedSegmentWidthPx * 2
  ) {
    const segmentWidth = Math.min(clampedSegmentWidthPx, lineX + clampedScaleWidthPx - segmentX);
    lines.push(
      `      <rect x="${formatSvgNumber(segmentX)}" y="${formatSvgNumber(lineY)}" width="${formatSvgNumber(segmentWidth)}" height="${lineHeight}" fill="${escapeXml(overlayColours.scaleLineAlternate)}" />`,
    );
  }

  lines.push('    </g>');
  lines.push(
    `    <text x="${formatSvgNumber(boxX + boxWidth / 2)}" y="${formatSvgNumber(boxY + 33)}" text-anchor="middle" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="11" fill="${escapeXml(overlayColours.overlayText)}">${escapeXml(scaleBarLabel)}</text>`,
  );
  lines.push('  </g>');
  return lines.join('\n');
}

function buildSvgCopyrightOverlayMarkup(widthPx, heightPx, copyrightNotice, overlayColours) {
  const wrappedLines = wrapTextByWords(copyrightNotice, 58, 3);
  if (wrappedLines.length === 0) {
    return '';
  }

  const boxWidth = 388;
  const boxHeight = 14 + wrappedLines.length * 12;
  const boxX = Math.max(12, widthPx - boxWidth - 12);
  const boxY = Math.max(12, heightPx - boxHeight - 12);

  const lines = [
    '  <g id="isochrone-copyright">',
    `    <rect x="${formatSvgNumber(boxX)}" y="${formatSvgNumber(boxY)}" width="${boxWidth}" height="${boxHeight}" rx="6" fill="${escapeXml(overlayColours.overlayBackground)}" stroke="${escapeXml(overlayColours.overlayBorder)}" />`,
  ];
  let textY = boxY + 16;
  for (const line of wrappedLines) {
    lines.push(
      `    <text x="${formatSvgNumber(boxX + 10)}" y="${formatSvgNumber(textY)}" font-family="${escapeXml(SVG_FONT_STACK)}" font-size="10" fill="${escapeXml(overlayColours.overlayNote)}">${escapeXml(line)}</text>`,
    );
    textY += 12;
  }
  lines.push('  </g>');
  return lines.join('\n');
}

function buildSvgBoundaryPathMarkup(boundaryPayload, graphHeader, boundaryStroke) {
  if (!boundaryPayload || !graphHeader) {
    return '';
  }

  const projectedBoundary = projectBoundaryBasemapToGraphPaths(boundaryPayload, graphHeader);
  const pathMarkup = [];
  for (const feature of projectedBoundary.features) {
    for (const path of feature.paths) {
      if (path.length < 2) {
        continue;
      }
      const commands = [];
      for (let index = 0; index < path.length; index += 1) {
        const [graphX, graphY] = path[index];
        commands.push(
          `${index === 0 ? 'M' : 'L'} ${formatSvgNumber(graphX)} ${formatSvgNumber(graphY)}`,
        );
      }
      pathMarkup.push(
        `    <path d="${commands.join(' ')}" fill="none" stroke="${escapeXml(boundaryStroke)}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />`,
      );
    }
  }

  if (pathMarkup.length === 0) {
    return '';
  }

  return ['  <g id="isochrone-boundaries">', ...pathMarkup, '  </g>'].join('\n');
}

export function buildIsochroneEdgeLineMarkup(edgeVertexData, options = {}) {
  assertEdgeVertexData(edgeVertexData);

  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive number');
  }

  const theme = normalizeIsochroneTheme(options.theme, ISOCHRONE_THEME_DARK);
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
      `<line x1="${formatSvgNumber(x0)}" y1="${formatSvgNumber(y0)}" x2="${formatSvgNumber(x1)}" y2="${formatSvgNumber(y1)}" stroke="rgb(${r}, ${g}, ${b})" stroke-width="1" stroke-linecap="round" vector-effect="non-scaling-stroke" />`,
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
  const escapedTitle = escapeXml(title);
  const escapedBackgroundColour = escapeXml(backgroundColour);

  if ((options.graphHeader && !options.boundaryPayload) || (!options.graphHeader && options.boundaryPayload)) {
    throw new Error('graphHeader and boundaryPayload must be provided together');
  }

  const boundaryMarkup = buildSvgBoundaryPathMarkup(
    options.boundaryPayload ?? null,
    options.graphHeader ?? null,
    overlayColours.boundaryStroke,
  );
  const edgeLines = buildIsochroneEdgeLineMarkup(edgeVertexData, {
    cycleMinutes,
    theme,
  });
  const titleOverlayMarkup = buildSvgTitleOverlayMarkup(widthPx, title, overlayColours);
  const legendOverlayMarkup = buildSvgLegendOverlayMarkup(widthPx, cycleMinutes, overlayColours, {
    messages,
    theme,
  });
  const scaleOverlayMarkup = buildSvgScaleOverlayMarkup(
    heightPx,
    scaleBarLabel,
    scaleBarWidthPx,
    scaleBarSegmentWidthPx,
    overlayColours,
  );
  const copyrightOverlayMarkup = buildSvgCopyrightOverlayMarkup(
    widthPx,
    heightPx,
    copyrightNotice,
    overlayColours,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" role="img" aria-label="${escapedTitle}">`,
    `  <title>${escapedTitle}</title>`,
    `  <rect id="isochrone-background" x="0" y="0" width="${widthPx}" height="${heightPx}" fill="${escapedBackgroundColour}" />`,
    boundaryMarkup,
    '  <g id="isochrone-edges">',
    edgeLines,
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

export function formatIsochroneExportTitle(locationName, modeLabels) {
  const normalizedLocation =
    typeof locationName === 'string' && locationName.trim().length > 0
      ? locationName.trim()
      : 'Unknown location';
  const normalizedModeLabels = [];
  if (Array.isArray(modeLabels)) {
    for (const modeLabel of modeLabels) {
      if (typeof modeLabel === 'string' && modeLabel.trim().length > 0) {
        normalizedModeLabels.push(modeLabel.trim());
      }
    }
  }
  const modeList = normalizedModeLabels.length > 0 ? normalizedModeLabels.join(', ') : 'none selected';
  return `Isochrone of ${normalizedLocation}, by ${modeList}`;
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
