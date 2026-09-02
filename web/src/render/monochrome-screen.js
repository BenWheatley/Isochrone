// Monochrome on screen, not only in an export.
//
// e-ink and total colourblindness are live-viewing cases, so a monochrome mode
// that only reached the PDF would miss two of the three readers it exists for.
// The isochrone is drawn as filled hatched bands with labelled contours, into
// an SVG overlay above the map canvas, from a raster built for this frame and
// thrown away again.

import {
  DEFAULT_COLOUR_CYCLE_MINUTES,
  EDGE_MODE_WATER_BIT,
  FINAL_EDGE_INTERPOLATION_STEP_STRIDE,
} from '../config/constants.js';
import { resolveViewportFrame } from '../core/viewport.js';
import { buildMonochromeIsochroneSvg } from '../export/monochrome-svg.js';
import { extractContourRings } from './contour.js';
import { selectHatchPatterns, timeToFillPattern } from './hatch.js';
import { paintAllReachableEdgeInterpolationsToTravelTimeGrid } from './edge-painting.js';
import { clearTravelTimeGrid, createTravelTimeGrid } from './pixel-grid.js';

// The painted edges are one cell wide, so contouring the raster untouched
// traces every individual street rather than the region they enclose. Widening
// the reachable set by a few cells first is what turns a road network into an
// area - and it is the one number here still chosen by eye.
const DEFAULT_DILATE_PASSES = 5;
// Roads are for orientation, so they have to stay legible as roads. Past
// roughly one segment per 250 square pixels they stop being a street network
// and become a grey wash - Portsmouth's whole network inside a 250px island is
// solid black - so the layer is thinned to fit the space it has. Zooming in
// reduces how many are visible, so more of them survive, which is the right
// way round.
const CANVAS_PIXELS_PER_ROAD_SEGMENT = 250;
const MIN_DRAWN_ROAD_SEGMENTS = 1500;

function buildTransientField(grid) {
  // The grid marks "not reached" as -1, which would contour as a very low
  // travel time rather than as unreachable ground.
  const field = new Float32Array(grid.seconds.length);
  for (let index = 0; index < field.length; index += 1) {
    const seconds = grid.seconds[index];
    field[index] = seconds < 0 ? Number.POSITIVE_INFINITY : seconds;
  }
  return field;
}

function dilateReachability(field, width, height, passes) {
  if (passes <= 0) {
    return field;
  }
  let current = field;
  for (let pass = 0; pass < passes; pass += 1) {
    const source = Float32Array.from(current);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        let best = source[index];
        const left = source[index - 1];
        const right = source[index + 1];
        const up = source[index - width];
        const down = source[index + width];
        if (left < best) best = left;
        if (right < best) best = right;
        if (up < best) best = up;
        if (down < best) best = down;
        current[index] = best;
      }
    }
  }
  return current;
}

function formatBandLabel(minutes, formatMinutes) {
  if (typeof formatMinutes === 'function') {
    return formatMinutes(minutes);
  }
  if (minutes < 60) {
    return `${Math.round(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder}`;
}

/**
 * Visible roads, in grid coordinates.
 *
 * Grid rather than canvas coordinates because everything handed to the scene
 * goes through one and the same transform - that is what keeps the coastline,
 * the roads and the bands registered with each other. Visibility is still
 * judged in canvas pixels, since that is what "on screen" means.
 */
function collectVisibleRoadSegments(graph, nodePixels, frame, widthPx, heightPx, origin) {
  const segments = [];
  const nodeCount = graph.header.nNodes;
  const toCanvasX = (graphPx) => (graphPx - frame.offsetXPx) * frame.effectiveScale;
  const toCanvasY = (graphPx) => (graphPx - frame.offsetYPx) * frame.effectiveScale;
  const seen = new Set();
  for (let sourceIndex = 0; sourceIndex < nodeCount; sourceIndex += 1) {
    const firstEdge = graph.nodeU32[sourceIndex * 4 + 2];
    const edgeCount = graph.nodeU16[sourceIndex * 8 + 6];
    const x0 = toCanvasX(nodePixels.nodePixelX[sourceIndex]);
    const y0 = toCanvasY(nodePixels.nodePixelY[sourceIndex]);
    for (let edgeIndex = firstEdge; edgeIndex < firstEdge + edgeCount; edgeIndex += 1) {
      // A ferry is not a road. Drawn as one it is a long straight line
      // striking out to sea and off the map, which is worse than useless as
      // a way of telling a reader where they are.
      if ((graph.edgeModeMask[edgeIndex] & EDGE_MODE_WATER_BIT) !== 0) {
        continue;
      }
      const targetIndex = graph.edgeU32[edgeIndex * 3];
      if (targetIndex >= nodeCount) {
        continue;
      }
      const key = sourceIndex < targetIndex
        ? sourceIndex * 4294967296 + targetIndex
        : targetIndex * 4294967296 + sourceIndex;
      if (seen.has(key)) {
        continue;
      }
      const x1 = toCanvasX(nodePixels.nodePixelX[targetIndex]);
      const y1 = toCanvasY(nodePixels.nodePixelY[targetIndex]);
      const offScreen =
        (x0 < 0 && x1 < 0)
        || (y0 < 0 && y1 < 0)
        || (x0 > widthPx && x1 > widthPx)
        || (y0 > heightPx && y1 > heightPx);
      if (offScreen) {
        continue;
      }
      seen.add(key);
      segments.push(
        (nodePixels.nodePixelX[sourceIndex] - origin.x) / origin.step,
        (nodePixels.nodePixelY[sourceIndex] - origin.y) / origin.step,
        (nodePixels.nodePixelX[targetIndex] - origin.x) / origin.step,
        (nodePixels.nodePixelY[targetIndex] - origin.y) / origin.step,
      );
    }
  }
  const budget = Math.max(
    MIN_DRAWN_ROAD_SEGMENTS,
    Math.floor((widthPx * heightPx) / CANVAS_PIXELS_PER_ROAD_SEGMENT),
  );
  if (segments.length / 4 <= budget) {
    return Float64Array.from(segments);
  }
  const stride = Math.ceil(segments.length / 4 / budget);
  const thinned = [];
  for (let index = 0; index < segments.length; index += 4 * stride) {
    thinned.push(segments[index], segments[index + 1], segments[index + 2], segments[index + 3]);
  }
  return Float64Array.from(thinned);
}

/**
 * The monochrome isochrone for the current view, as SVG markup.
 *
 * Returns null when there is nothing reachable to draw, so the caller can
 * leave the overlay empty rather than showing an empty frame.
 */
export function buildMonochromeScreenSvg(mapData, snapshot, options = {}) {
  const graph = mapData.graph;
  const widthPx = options.widthPx;
  const heightPx = options.heightPx;
  if (!(widthPx > 0) || !(heightPx > 0)) {
    return null;
  }

  const frame = resolveViewportFrame(graph.header, options.viewport ?? null, {
    frameWidthPx: widthPx,
    frameHeightPx: heightPx,
    fitBoundingBoxPx: options.fitBoundingBoxPx ?? null,
  });

  // A raster for this frame only, sized to what is on screen and discarded
  // when the function returns - never a persistent, graph-sized buffer.
  const originXPx = Math.max(0, Math.floor(frame.offsetXPx));
  const originYPx = Math.max(0, Math.floor(frame.offsetYPx));
  const gridWidthPx = Math.min(
    graph.header.gridWidthPx - originXPx,
    Math.ceil(widthPx / frame.effectiveScale) + 2,
  );
  const gridHeightPx = Math.min(
    graph.header.gridHeightPx - originYPx,
    Math.ceil(heightPx / frame.effectiveScale) + 2,
  );
  if (!(gridWidthPx > 2) || !(gridHeightPx > 2)) {
    return null;
  }

  const grid = createTravelTimeGrid(gridWidthPx, gridHeightPx, { originXPx, originYPx });
  clearTravelTimeGrid(grid);
  paintAllReachableEdgeInterpolationsToTravelTimeGrid(
    grid,
    graph,
    mapData.nodePixels,
    snapshot.distSeconds,
    options.allowedModeMask,
    {
      stepStride: FINAL_EDGE_INTERPOLATION_STEP_STRIDE,
      edgeTraversalCostSeconds: options.edgeTraversalCostSeconds ?? undefined,
    },
  );

  // Down to the resolution actually being displayed. Zoomed out, the graph
  // grid is several times finer than the canvas - Portsmouth is 1388 cells
  // across shown in about 340 pixels - and contouring at that fineness traces
  // noise the reader can never see, while a few passes of dilation cover a
  // fraction of a displayed pixel. Reducing by minimum keeps reachability
  // exact: a block is reachable as early as its earliest cell.
  const sampleStep = Math.max(1, Math.round(1 / frame.effectiveScale));
  const fieldWidth = Math.max(2, Math.ceil(gridWidthPx / sampleStep));
  const fieldHeight = Math.max(2, Math.ceil(gridHeightPx / sampleStep));
  const rawField = buildTransientField(grid);
  let sampledField = rawField;
  if (sampleStep > 1) {
    sampledField = new Float32Array(fieldWidth * fieldHeight).fill(Number.POSITIVE_INFINITY);
    for (let y = 0; y < gridHeightPx; y += 1) {
      const targetRow = Math.floor(y / sampleStep) * fieldWidth;
      const sourceRow = y * gridWidthPx;
      for (let x = 0; x < gridWidthPx; x += 1) {
        const seconds = rawField[sourceRow + x];
        const targetIndex = targetRow + Math.floor(x / sampleStep);
        if (seconds < sampledField[targetIndex]) {
          sampledField[targetIndex] = seconds;
        }
      }
    }
  }

  const field = dilateReachability(
    sampledField,
    fieldWidth,
    fieldHeight,
    options.dilatePasses ?? DEFAULT_DILATE_PASSES,
  );

  let longestReachableSeconds = 0;
  for (let index = 0; index < field.length; index += 1) {
    const seconds = field[index];
    if (Number.isFinite(seconds) && seconds > longestReachableSeconds) {
      longestReachableSeconds = seconds;
    }
  }
  if (longestReachableSeconds <= 0) {
    return null;
  }

  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const patterns = options.patterns ?? selectHatchPatterns(options.patternCount ?? 2);
  const bandMinutes = cycleMinutes / patterns.length;
  const thresholds = [];
  for (
    let minutes = bandMinutes;
    minutes <= longestReachableSeconds / 60 + bandMinutes;
    minutes += bandMinutes
  ) {
    thresholds.push(minutes * 60);
    if (thresholds.length >= 40) {
      break;
    }
  }
  if (thresholds.length === 0) {
    return null;
  }

  const contours = extractContourRings(field, {
    width: fieldWidth,
    height: fieldHeight,
    thresholds,
  });

  // One transform for everything in the scene: grid cell -> graph pixel ->
  // canvas pixel. The basemap goes through the same one, which is what keeps
  // the coastline registered with the roads it describes.
  const transform = (fieldX, fieldY) => [
    (originXPx + fieldX * sampleStep - frame.offsetXPx) * frame.effectiveScale,
    (originYPx + fieldY * sampleStep - frame.offsetYPx) * frame.effectiveScale,
  ];

  const bands = contours.map((contour, index) => ({
    threshold: contour.threshold,
    rings: contour.rings,
    label: formatBandLabel(contour.threshold / 60, options.formatMinutes),
    pattern: timeToFillPattern(Math.max(0, contour.threshold - 1), { cycleMinutes, patterns }),
    isLimit: index === contours.length - 1,
  }));

  const waterFeatures = (options.projectedBoundary?.waterFeatures ?? [])
    .concat(options.projectedBoundary?.inlandWaterFeatures ?? [])
    .map((feature) => ({
      paths: feature.paths.map((path) =>
        path.map(([graphX, graphY]) => [
          (graphX - originXPx) / sampleStep,
          (graphY - originYPx) / sampleStep,
        ])),
    }));

  return buildMonochromeIsochroneSvg({
    widthPx,
    heightPx,
    bands,
    transform,
    ink: options.ink ?? '#000000',
    paper: options.paper ?? '#ffffff',
    labelFontSize: options.labelFontSize ?? 12,
    contourStrokeWidth: 0.9,
    roadStrokeWidth: 0.3,
    patternScale: options.patternScale ?? 1,
    legend: false,
    basemap: {
      waterFeatures,
      roadSegments: collectVisibleRoadSegments(
        graph,
        mapData.nodePixels,
        frame,
        widthPx,
        heightPx,
        { x: originXPx, y: originYPx, step: sampleStep },
      ),
    },
  });
}
