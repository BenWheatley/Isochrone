// Monochrome on screen, not only in an export.
//
// e-ink and total colourblindness are live-viewing cases, so a monochrome mode
// that only reached the PDF would miss two of the three readers it exists for.
// The isochrone is drawn as filled hatched bands with labelled contours, into
// an SVG layer above the map canvas.
//
// Vector throughout. The bands are polygons built from a triangulation of the
// nodes, not traced out of a raster, so they are the same shapes at any zoom
// and at any output size. The triangulation is a static property of the region
// and is kept, so a routing run only reclassifies triangles and panning is a
// pure transform.

import { DEFAULT_COLOUR_CYCLE_MINUTES, EDGE_MODE_WATER_BIT } from '../config/constants.js';
import { resolveViewportFrame } from '../core/viewport.js';
import { buildMonochromeIsochroneSvg, planContourLabels } from '../export/monochrome-svg.js';
import { buildBandRegions, DEFAULT_MAX_TRIANGLE_SPAN_M } from './band-regions.js';
import { triangulate } from './delaunay.js';
import {
  HATCH_PATTERN_LADDER,
  selectHatchPatterns,
  WATER_HATCH_PATTERN,
  WATER_INK,
} from './hatch.js';

/**
 * The pair a map uses for hatched-and-clear.
 *
 * Not selectHatchPatterns(2), which returns the ladder's two ends because
 * separation is what it optimises. With two states separation is not the
 * binding constraint - bare paper against anything is already maximal - and
 * the darkest rung buries the street network underneath it. Judged against
 * Portsmouth at 1:1: the second rung keeps the roads legible through the
 * hatch while still reading unmistakably as hatched.
 */
const MAP_HATCH_PAIR = [HATCH_PATTERN_LADDER[0], HATCH_PATTERN_LADDER[1]];

const TRIANGULATION_PROPERTY = '__nodeTriangulation';
// Roads are for orientation, so they have to stay legible as roads. Portsmouth's
// whole network inside a 250px island is a grey wash, not a street map, so at
// low zoom only the more important roads are drawn.
//
// Which roads, chosen by class rather than by thinning the visible set. Class
// is a property of the road itself, so the same roads are drawn from one frame
// to the next and zooming only ever adds more; anything derived from how many
// segments happen to be on screen changes under panning, and the network
// shimmers.
//
// Ids come from adjacency.py: motorway 15, trunk 14, primary 13, secondary 12,
// tertiary 11, unclassified 10, track 9, cycleway 8, service 7, residential 6,
// and footways below that.
const ROAD_CLASS_BY_SCALE = [
  { minimumScale: 0, minimumRoadClass: 12 },
  { minimumScale: 0.35, minimumRoadClass: 11 },
  { minimumScale: 0.7, minimumRoadClass: 10 },
  { minimumScale: 1.2, minimumRoadClass: 6 },
  { minimumScale: 2.5, minimumRoadClass: 0 },
];

function minimumRoadClassForScale(effectiveScale) {
  let minimumRoadClass = ROAD_CLASS_BY_SCALE[0].minimumRoadClass;
  for (const step of ROAD_CLASS_BY_SCALE) {
    if (effectiveScale >= step.minimumScale) {
      minimumRoadClass = step.minimumRoadClass;
    }
  }
  return minimumRoadClass;
}

/**
 * The region's triangulation, built once and kept on the map data.
 *
 * It depends only on where the nodes are, which does not change, so rebuilding
 * it per frame - or worse, per pan - would be pure waste. Berlin's 578,000
 * nodes take about 390 ms and yield 1.15 million triangles; every routing run
 * after that only has to decide which band each of them falls in.
 *
 * Built in graph pixels rather than metres, so it shares the space the
 * viewport and the basemap already use and cannot drift out of register.
 */
function getOrBuildNodeTriangulation(mapData) {
  const cached = mapData[TRIANGULATION_PROPERTY];
  if (cached) {
    return cached;
  }
  const nodePixels = mapData.nodePixels;
  const nodeCount = nodePixels.nodePixelX.length;
  const coords = new Float64Array(nodeCount * 2);
  for (let index = 0; index < nodeCount; index += 1) {
    coords[index * 2] = nodePixels.nodePixelX[index];
    coords[index * 2 + 1] = nodePixels.nodePixelY[index];
  }
  const triangulation = triangulate(coords);
  mapData[TRIANGULATION_PROPERTY] = triangulation;
  return triangulation;
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
 * Visible roads, in graph pixels.
 *
 * Graph pixels rather than canvas pixels because everything handed to the scene
 * goes through one and the same transform - that is what keeps the coastline,
 * the roads and the bands registered with each other. Visibility is still
 * judged in canvas pixels, since that is what "on screen" means.
 */
function collectVisibleRoadSegments(graph, nodePixels, frame, widthPx, heightPx) {
  const minimumRoadClass = minimumRoadClassForScale(frame.effectiveScale);
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
      if (graph.edgeRoadClassId[edgeIndex] < minimumRoadClass) {
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
        nodePixels.nodePixelX[sourceIndex],
        nodePixels.nodePixelY[sourceIndex],
        nodePixels.nodePixelX[targetIndex],
        nodePixels.nodePixelY[targetIndex],
      );
    }
  }
  return Float64Array.from(segments);
}

/**
 * The monochrome isochrone for the current view, as SVG markup.
 *
 * Returns null when there is nothing reachable to draw, so the caller can
 * leave the overlay empty rather than showing an empty frame.
 */
/**
 * Everything the monochrome map is made of, in one description: the bands and
 * their rings, the basemap under them, and the transform that puts them on the
 * output.
 *
 * Separated from any way of drawing it, because there are two - a canvas on
 * screen and SVG for export - and they must not be allowed to become two
 * different maps. Whatever is wrong here is wrong in both, which is the point.
 */
export function buildMonochromeScene(mapData, snapshot, options = {}) {
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

  // Vector, not raster. The triangulation of the node positions is a static
  // property of the region, so it is built once and kept: a routing run only
  // reclassifies triangles, and panning or zooming is then a pure transform
  // with nothing to recompute. A raster had to be rebuilt and re-contoured
  // every frame at whatever resolution happened to be on screen, which is what
  // made the bands mottle when zoomed and cost megabytes of markup per pan.
  const triangulation = getOrBuildNodeTriangulation(mapData);
  if (triangulation.triangles.length === 0) {
    return null;
  }

  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const patternCount = options.patternCount ?? 2;
  const patterns = options.patterns
    ?? (patternCount === 2 ? MAP_HATCH_PAIR : selectHatchPatterns(patternCount));
  const bandSeconds = (cycleMinutes * 60) / patterns.length;
  const maxBands = options.maxBands ?? 40;

  let longestReachableSeconds = 0;
  for (let index = 0; index < snapshot.distSeconds.length; index += 1) {
    const seconds = snapshot.distSeconds[index];
    if (Number.isFinite(seconds) && seconds > longestReachableSeconds) {
      longestReachableSeconds = seconds;
    }
  }
  const thresholds = [];
  for (
    let seconds = bandSeconds;
    seconds < longestReachableSeconds + bandSeconds && thresholds.length < maxBands;
    seconds += bandSeconds
  ) {
    thresholds.push(seconds);
  }
  if (thresholds.length === 0) {
    return null;
  }

  // Below about this many square pixels on the finished map, a pocket is a
  // speck rather than a feature. Expressed in output pixels and converted, so
  // it means the same thing on screen and on a poster.
  const minimumOutputArea = options.minimumRingOutputArea ?? 90;
  const regions = buildBandRegions(triangulation, snapshot.distSeconds, {
    thresholds,
    collectTriangles: options.collectTriangles === true,
    minimumRingArea: minimumOutputArea / (frame.effectiveScale * frame.effectiveScale),
    // The limit is a real distance, but the triangulation lives in graph
    // pixels - the space the viewport already works in - so it converts here.
    maxTriangleSpanM: (options.maxTriangleSpanM ?? DEFAULT_MAX_TRIANGLE_SPAN_M)
      / graph.header.pixelSizeM,
  });
  if (regions.bands.length === 0) {
    return null;
  }

  // Graph pixels straight to canvas pixels: the same frame the basemap and the
  // edge renderer use, so everything registers without a second thought.
  const transform = (graphX, graphY) => [
    (graphX - frame.offsetXPx) * frame.effectiveScale,
    (graphY - frame.offsetYPx) * frame.effectiveScale,
  ];

  const bands = regions.bands.map((region, index) => ({
    rings: region.rings,
    triangles: region.triangles,
    label: formatBandLabel(thresholds[region.bandIndex] / 60, options.formatMinutes),
    pattern: patterns[region.bandIndex % patterns.length],
    isLimit: index === regions.bands.length - 1,
  }));

  const waterFeatures = (options.projectedBoundary?.waterFeatures ?? [])
    .concat(options.projectedBoundary?.inlandWaterFeatures ?? [])
    .map((feature) => ({
      paths: feature.paths.map((path) => path.map(([graphX, graphY]) => [graphX, graphY])),
    }));

  const labelFontSize = options.labelFontSize ?? 12;
  // Planned on the scene rather than inside a renderer, so the screen and the
  // exported sheet put every value in the same place. Labels that moved
  // between them would be two maps with one name.
  const { labels, gaps } = planContourLabels(bands, {
    transform,
    fontSize: labelFontSize,
    widthPx,
    heightPx,
    spacingPx: options.labelSpacingPx,
  });

  return {
    widthPx,
    heightPx,
    bands,
    transform,
    labels,
    labelGaps: gaps,
    waterPattern: WATER_HATCH_PATTERN,
    waterInk: WATER_INK,
    bandsIncludeHoles: true,
    ink: options.ink ?? '#000000',
    paper: options.paper ?? '#ffffff',
    labelFontSize,
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
      ),
    },
  };
}

/** The same scene, serialised as SVG. Used by the export and print paths. */
export function buildMonochromeScreenSvg(mapData, snapshot, options = {}) {
  const scene = buildMonochromeScene(mapData, snapshot, options);
  return scene === null ? null : buildMonochromeIsochroneSvg(scene);
}
