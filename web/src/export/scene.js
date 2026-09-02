import { MAP_STYLE_MONOCHROME } from '../config/constants.js';
import { buildMonochromeScreenSvg } from '../render/monochrome-screen.js';
import { getMapStyleFromShell } from '../ui/orchestration.js';
import { DEFAULT_LOCATION_NAME, TRANSIT_ONLY_ALLOWED_MODE_MASK } from '../config/constants.js';
import { computeExportDistanceScaleBar } from '../ui/legend-scale.js';
import { getShellLocaleMessages } from '../ui/status.js';
import { resolveIsochroneTheme } from '../ui/theme.js';
import { getColourCycleMinutesFromShell } from '../ui/orchestration.js';
import { formatIsochroneExportTitle } from './svg.js';

// One description of "what is currently on the isochrone canvas", in the terms
// buildRenderedIsochroneSvgDocument speaks. Every vector output - SVG download,
// print, and PDF later - renders from this rather than re-reading the shell,
// so they cannot drift apart in what they title, credit or measure.

/**
 * Reads the live shell + map state into a plain scene object.
 *
 * `getSnapshotEdgeVertexData` is injected because building the edge buffer
 * needs the routing caches that live in app.js; everything else here is
 * already module-level.
 */
export function collectRenderedIsochroneScene(shell, mapData, options = {}) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }
  const getSnapshotEdgeVertexData = options.getSnapshotEdgeVertexData;
  if (typeof getSnapshotEdgeVertexData !== 'function') {
    throw new Error('options.getSnapshotEdgeVertexData must be a function');
  }
  const modeValues = options.modeValues ?? [];
  if (!Array.isArray(modeValues)) {
    throw new Error('options.modeValues must be an array when provided');
  }
  const locale = options.locale ?? shell.locale ?? 'en';
  const messages = getShellLocaleMessages(shell);

  const graphHeader = mapData?.graph?.header ?? null;
  const scaleBar = graphHeader ? computeExportDistanceScaleBar(graphHeader) : null;

  const snapshot = mapData?.lastRoutingSnapshot ?? null;
  let edgeVertexData = new Float32Array(0);
  let cycleMinutes = getColourCycleMinutesFromShell(shell);
  if (mapData && snapshot) {
    // Transit-only isochrones have no road edges to export; their lines are
    // the transit connections, already in this same (x, y, seconds) layout.
    edgeVertexData =
      snapshot.allowedModeMask === TRANSIT_ONLY_ALLOWED_MODE_MASK
        ? (snapshot.transitEdgeVertexData ?? new Float32Array(0))
        : getSnapshotEdgeVertexData(mapData, snapshot, {
          allowedModeMask: snapshot.allowedModeMask,
        });
    cycleMinutes = snapshot.colourCycleMinutes;
  }

  // What is exported is what is on screen. Monochrome changes the drawing, not
  // just its colours, so an export that quietly reverted to coloured lines
  // would be showing something the reader never asked for - and for a mode
  // whose whole purpose is a black-and-white printer, that is the one output
  // that must not ignore it.
  let monochromeMapMarkup = null;
  if (
    graphHeader
    && snapshot
    && getMapStyleFromShell(shell) === MAP_STYLE_MONOCHROME
  ) {
    monochromeMapMarkup = buildMonochromeScreenSvg(mapData, snapshot, {
      widthPx: graphHeader.gridWidthPx,
      heightPx: graphHeader.gridHeightPx,
      viewport: null,
      fitBoundingBoxPx: mapData?.boundaryFitBoundingBoxPx ?? null,
      allowedModeMask: snapshot.allowedModeMask,
      cycleMinutes,
      projectedBoundary: mapData?.projectedBoundary ?? null,
      // A sheet is read at arm's length, not a browser window's worth of
      // pixels away, so the type and the hatch both scale with it.
      labelFontSize: Math.max(12, Math.round(graphHeader.gridWidthPx / 110)),
      patternScale: Math.max(1, graphHeader.gridWidthPx / 1200),
    });
  }

  return {
    graphHeader,
    boundaryPayload: mapData?.boundaryPayload ?? null,
    monochromeMapMarkup,
    edgeVertexData,
    cycleMinutes,
    theme: options.theme ?? resolveIsochroneTheme(),
    ...formatIsochroneExportTitle(mapData?.locationName ?? DEFAULT_LOCATION_NAME, modeValues, {
      messages,
      locale,
    }),
    messages,
    scaleBarLabel: scaleBar?.label ?? shell.distanceScaleLabel?.textContent?.trim() ?? '',
    scaleBarWidthPx: scaleBar?.lineWidthPx ?? 96,
    scaleBarSegmentWidthPx: scaleBar?.segmentWidthPx,
    copyrightNotice: collectShellCopyrightNotice(shell),
  };
}

/**
 * The on-screen attribution, flattened to one line. Transit credit only joins
 * in when the region actually loaded transit data, which is exactly when the
 * shell shows its disclaimer.
 */
export function collectShellCopyrightNotice(shell) {
  const transitText =
    shell?.routingDisclaimerTransit && !shell.routingDisclaimerTransit.hidden
      ? (shell.routingDisclaimerTransit.textContent ?? '')
      : '';
  const osmText =
    shell?.routingDisclaimerOsm?.textContent ?? shell?.routingDisclaimer?.textContent ?? '';
  return `${osmText} ${transitText}`.replace(/\s+/g, ' ').trim();
}
