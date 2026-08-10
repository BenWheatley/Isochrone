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
  const modeLabels = options.modeLabels ?? [];
  if (!Array.isArray(modeLabels)) {
    throw new Error('options.modeLabels must be an array when provided');
  }

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

  return {
    graphHeader,
    boundaryPayload: mapData?.boundaryPayload ?? null,
    edgeVertexData,
    cycleMinutes,
    theme: options.theme ?? resolveIsochroneTheme(),
    title: formatIsochroneExportTitle(
      mapData?.locationName ?? DEFAULT_LOCATION_NAME,
      modeLabels,
    ),
    messages: getShellLocaleMessages(shell),
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
