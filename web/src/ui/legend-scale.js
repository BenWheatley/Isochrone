import { getIsochronePalette, normalizeIsochroneTheme } from '../render/colour.js';
import { formatLegendRange, formatLegendRepeatNote } from './legend-format.js';
import { validateGraphHeaderForBoundaryAlignment } from '../core/graph-validation.js';
import { resolveViewportFrame } from '../core/viewport.js';
import { getShellLocaleMessages } from './status.js';
import { resolveIsochroneTheme } from './theme.js';
import {
  formatDistanceLabel,
  pickNiceDistanceMetres,
  resolveUnitSystem,
} from './units.js';

// The two map overlays that explain the isochrone: the colour-band legend
// and the distance scale bar (which also backs the SVG export's scale bar).

export function pickScaleBucketDistanceMetres(totalDistanceMetres) {
  const safeTotal = Math.max(1, totalDistanceMetres);
  const targetSegments = 5;
  const minSegments = 3;
  const maxSegments = 10;
  const candidateRoots = [1, 2, 5];
  const baseExponent = Math.floor(Math.log10(safeTotal / targetSegments));
  const candidates = [];

  for (let exponentOffset = -1; exponentOffset <= 2; exponentOffset += 1) {
    const exponent = baseExponent + exponentOffset;
    const scale = 10 ** exponent;
    for (const root of candidateRoots) {
      const candidate = root * scale;
      if (!(candidate > 0) || candidate > safeTotal) {
        continue;
      }
      const segmentCount = safeTotal / candidate;
      if (segmentCount < minSegments || segmentCount > maxSegments) {
        continue;
      }
      const integerPenalty = Math.abs(segmentCount - Math.round(segmentCount));
      const segmentPenalty = Math.abs(segmentCount - targetSegments);
      const score = integerPenalty * 3 + segmentPenalty;
      candidates.push({
        candidate,
        score,
      });
    }
  }

  if (candidates.length === 0) {
    return safeTotal / targetSegments;
  }

  candidates.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    return a.candidate - b.candidate;
  });

  return candidates[0].candidate;
}

export function computeDistanceScaleBarGeometry(metresPerPixel) {
  const preferredWidthPx = 120;
  const preferredDistanceMetres = preferredWidthPx * metresPerPixel;
  const unitSystem = resolveUnitSystem();
  const chosenDistanceMetres = pickNiceDistanceMetres(preferredDistanceMetres, unitSystem);
  const lineWidthPx = Math.max(24, Math.round(chosenDistanceMetres / metresPerPixel));
  const bucketDistanceMetres = pickScaleBucketDistanceMetres(chosenDistanceMetres);
  const segmentWidthPx = Math.max(4, Math.round(bucketDistanceMetres / metresPerPixel));
  return {
    chosenDistanceMetres,
    lineWidthPx,
    bucketDistanceMetres,
    segmentWidthPx,
    label: formatDistanceLabel(chosenDistanceMetres, unitSystem),
  };
}

export function computeExportDistanceScaleBar(graphHeader) {
  if (!graphHeader || !(graphHeader.pixelSizeM > 0)) {
    throw new Error('graphHeader.pixelSizeM must be positive');
  }
  return computeDistanceScaleBarGeometry(graphHeader.pixelSizeM);
}

export function renderIsochroneLegend(shell, cycleMinutes, options = {}) {
  if (!shell || typeof shell !== 'object' || !shell.isochroneLegend) {
    throw new Error('shell.isochroneLegend is required');
  }
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive finite number');
  }

  const boundaries = [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1];
  const theme = normalizeIsochroneTheme(
    options.theme ?? resolveIsochroneTheme(options.rootElement),
    'dark',
  );
  const messages = options.messages ?? getShellLocaleMessages(shell);
  const colours = getIsochronePalette(theme);

  const legendRows = [];
  for (let index = 0; index < colours.length; index += 1) {
    const colour = colours[index];
    const rangeStartMinutes = boundaries[index] * cycleMinutes;
    const rangeEndMinutes = boundaries[index + 1] * cycleMinutes;
    const rangeLabel = formatLegendRange(rangeStartMinutes, rangeEndMinutes, { messages });
    const colourCss = `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`;

    legendRows.push(
      `<div class="legend-row"><span class="legend-swatch" aria-hidden="true"><svg class="legend-swatch-svg" viewBox="0 0 16 16" focusable="false" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="2" fill="${colourCss}" stroke="${colourCss}" stroke-width="1.5"></rect></svg></span><span>${rangeLabel}</span></div>`,
    );
  }
  legendRows.push(
    `<div class="legend-note">${formatLegendRepeatNote(cycleMinutes, { messages })}</div>`,
  );

  shell.isochroneLegend.innerHTML = legendRows.join('');
}

export function renderIsochroneLegendIfNeeded(shell, cycleMinutes, options = {}) {
  if (!shell || typeof shell !== 'object' || !shell.isochroneLegend) {
    throw new Error('shell.isochroneLegend is required');
  }
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive finite number');
  }
  const theme = normalizeIsochroneTheme(
    options.theme ?? resolveIsochroneTheme(options.rootElement),
    'dark',
  );
  const locale = typeof options.locale === 'string' && options.locale.trim().length > 0
    ? options.locale.trim()
    : shell?.locale ?? 'en';

  if (
    shell.lastRenderedLegendCycleMinutes === cycleMinutes
    && shell.lastRenderedLegendTheme === theme
    && shell.lastRenderedLegendLocale === locale
  ) {
    return false;
  }

  renderIsochroneLegend(shell, cycleMinutes, {
    theme,
    messages: options.messages ?? getShellLocaleMessages(shell),
  });
  shell.lastRenderedLegendCycleMinutes = cycleMinutes;
  shell.lastRenderedLegendTheme = theme;
  shell.lastRenderedLegendLocale = locale;
  return true;
}

export function updateDistanceScaleBar(shell, graphHeader, options = {}) {
  if (
    !shell ||
    typeof shell !== 'object' ||
    !shell.distanceScale ||
    !shell.distanceScaleLine ||
    !shell.distanceScaleLabel ||
    !shell.isochroneCanvas
  ) {
    throw new Error('distance scale shell elements are required');
  }

  validateGraphHeaderForBoundaryAlignment(graphHeader);
  const canvasRect = shell.isochroneCanvas.getBoundingClientRect();
  if (!(canvasRect.width > 0)) {
    return;
  }
  if (!(canvasRect.height > 0)) {
    return;
  }
  const viewportFrame = resolveViewportFrame(graphHeader, options.viewport, {
    frameWidthPx: canvasRect.width,
    frameHeightPx: canvasRect.height,
    fitBoundingBoxPx: options.fitBoundingBoxPx,
  });

  const metresPerCssPixel = graphHeader.pixelSizeM / viewportFrame.effectiveScale;
  const { lineWidthPx, segmentWidthPx, label } = computeDistanceScaleBarGeometry(metresPerCssPixel);

  shell.distanceScaleLine.style.width = `${lineWidthPx}px`;
  if (typeof shell.distanceScaleLine.style.setProperty === 'function') {
    shell.distanceScaleLine.style.setProperty('--scale-segment-width-px', `${segmentWidthPx}px`);
  } else {
    shell.distanceScaleLine.style['--scale-segment-width-px'] = `${segmentWidthPx}px`;
  }
  shell.distanceScaleLabel.textContent = label;
}
