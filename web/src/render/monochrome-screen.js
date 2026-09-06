// Monochrome on screen, not only in an export.
//
// e-ink and total colourblindness are live-viewing cases, so a monochrome mode
// that only reached the PDF would miss two of the three readers it exists for.
// The isochrone is drawn as hatched bands with labelled contours.
//
// Vector throughout, and built around the ways rather than over the nodes: a
// travel time is defined on the network, so the ground it describes is the
// ground near the network. See band-ribbons.js for what that means, and why
// the width of the zone drawn around a way is a length on the finished sheet
// rather than a distance on the ground.

import { DEFAULT_COLOUR_CYCLE_MINUTES, EDGE_MODE_WATER_BIT } from '../config/constants.js';
import { resolveViewportFrame } from '../core/viewport.js';
import { buildMonochromeIsochroneSvg } from '../export/monochrome-svg.js';
import {
  buildBandOrderedSegments,
  collectBandBoundaryCrossings,
  OUTPUT_PIXELS_PER_MM,
  planRibbonContourLabels,
  RIBBON_WIDTH_MM,
  ribbonWidthPx,
} from './band-ribbons.js';
import { collectAllReachableTravelTimeEdgeVertices } from './edge-painting.js';
import {
  HATCH_PATTERN_LADDER,
  selectHatchPatterns,
  WATER_HATCH_PATTERN,
  ROAD_INK,
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

const ROAD_SEGMENT_CACHE_PROPERTY = '__monochromeRoadSegments';
const BAND_GEOMETRY_PROPERTY = '__monochromeBandGeometry';
const WAY_SEGMENT_CACHE_PROPERTY = '__monochromeWaySegments';
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
 * The ways cut into bands, and where they cross a boundary.
 *
 * Neither depends on the viewport: they are the field expressed as geometry,
 * in graph pixels. Rebuilding them per frame put Berlin's whole 200 ms of
 * cutting into every pan and every zoom step, which is the thing the drawing
 * was arranged to avoid.
 */
function getOrBuildBandGeometry(snapshot, segments, bandSeconds) {
  const cached = snapshot[BAND_GEOMETRY_PROPERTY];
  if (cached && cached.segments === segments && cached.bandSeconds === bandSeconds) {
    return cached;
  }
  const geometry = {
    segments,
    bandSeconds,
    ordered: buildBandOrderedSegments(segments, bandSeconds),
    crossings: collectBandBoundaryCrossings(segments, bandSeconds),
  };
  snapshot[BAND_GEOMETRY_PROPERTY] = geometry;
  return geometry;
}

/**
 * The reachable ways, six floats each: both ends in graph pixels with the
 * travel time at each.
 *
 * This is the colour renderer's own edge vertex buffer. Reused when the
 * routing run already built one for the same modes, so the common case costs
 * nothing at all and the two modes cannot come to describe different journeys.
 */
function getReachableWaySegments(mapData, snapshot, options) {
  const allowedModeMask = options.allowedModeMask ?? snapshot.allowedModeMask;
  if (
    snapshot.edgeVertexData instanceof Float32Array
    && snapshot.edgeVertexDataModeMask === allowedModeMask
  ) {
    return snapshot.edgeVertexData;
  }
  // Kept on the snapshot when the routing run did not leave one. The GPU's
  // node-indexed edge renderer has no use for a plain vertex buffer, so on
  // that path there is nothing to reuse and this walks the whole graph -
  // 348 ms on Berlin, which is a price to pay once for a routing result and
  // not once for every pan of it.
  const cached = snapshot[WAY_SEGMENT_CACHE_PROPERTY];
  if (cached && cached.allowedModeMask === allowedModeMask) {
    return cached.segments;
  }
  const distSeconds = snapshot.distSeconds;
  if (!(distSeconds?.length >= mapData.graph.header.nNodes)) {
    return new Float32Array(0);
  }
  // An origin on an isolated node reaches nothing, and Portsmouth alone has
  // 8107 of those. Finding that out costs one pass over the field; walking
  // every edge in the region to build an empty buffer costs rather more.
  let reachesAnything = false;
  for (let node = 0; node < mapData.graph.header.nNodes; node += 1) {
    if (Number.isFinite(distSeconds[node])) {
      reachesAnything = true;
      break;
    }
  }
  if (!reachesAnything) {
    return new Float32Array(0);
  }
  const segments = collectAllReachableTravelTimeEdgeVertices(
    mapData.graph,
    mapData.nodePixels,
    distSeconds,
    allowedModeMask,
    { edgeTraversalCostSeconds: options.edgeTraversalCostSeconds },
  );
  snapshot[WAY_SEGMENT_CACHE_PROPERTY] = { allowedModeMask, segments };
  return segments;
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
/**
 * Every drawable road at or above a class, deduplicated, in graph pixels.
 *
 * The graph stores each road twice, once per direction, so drawing it needs a
 * seen-set over half a million edges - and that set does not depend on the
 * viewport at all. Built once per class and kept, so a pan only has to decide
 * what is on screen.
 */
function getOrBuildRoadSegmentsForClass(mapData, graph, nodePixels, minimumRoadClass) {
  let cache = mapData[ROAD_SEGMENT_CACHE_PROPERTY];
  if (cache === undefined) {
    cache = new Map();
    mapData[ROAD_SEGMENT_CACHE_PROPERTY] = cache;
  }
  const cached = cache.get(minimumRoadClass);
  if (cached !== undefined) {
    return cached;
  }

  const segments = [];
  const nodeCount = graph.header.nNodes;
  const seen = new Set();
  for (let sourceIndex = 0; sourceIndex < nodeCount; sourceIndex += 1) {
    const firstEdge = graph.nodeU32[sourceIndex * 4 + 2];
    const edgeCount = graph.nodeU16[sourceIndex * 8 + 6];
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
      seen.add(key);
      segments.push(
        nodePixels.nodePixelX[sourceIndex],
        nodePixels.nodePixelY[sourceIndex],
        nodePixels.nodePixelX[targetIndex],
        nodePixels.nodePixelY[targetIndex],
      );
    }
  }
  const packed = Float32Array.from(segments);
  cache.set(minimumRoadClass, packed);
  return packed;
}

/** Those of them that fall in the frame, in graph pixels. */
function collectVisibleRoadSegments(mapData, graph, nodePixels, frame, widthPx, heightPx) {
  const all = getOrBuildRoadSegmentsForClass(
    mapData, graph, nodePixels, minimumRoadClassForScale(frame.effectiveScale),
  );
  const toCanvasX = (graphPx) => (graphPx - frame.offsetXPx) * frame.effectiveScale;
  const toCanvasY = (graphPx) => (graphPx - frame.offsetYPx) * frame.effectiveScale;
  const visible = new Float64Array(all.length);
  let written = 0;
  for (let index = 0; index + 3 < all.length; index += 4) {
    const x0 = toCanvasX(all[index]);
    const x1 = toCanvasX(all[index + 2]);
    if ((x0 < 0 && x1 < 0) || (x0 > widthPx && x1 > widthPx)) {
      continue;
    }
    const y0 = toCanvasY(all[index + 1]);
    const y1 = toCanvasY(all[index + 3]);
    if ((y0 < 0 && y1 < 0) || (y0 > heightPx && y1 > heightPx)) {
      continue;
    }
    visible[written] = all[index];
    visible[written + 1] = all[index + 1];
    visible[written + 2] = all[index + 2];
    visible[written + 3] = all[index + 3];
    written += 4;
  }
  return visible.subarray(0, written);
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

  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const patternCount = options.patternCount ?? 2;
  const patterns = options.patterns
    ?? (patternCount === 2 ? MAP_HATCH_PAIR : selectHatchPatterns(patternCount));
  const bandSeconds = (cycleMinutes * 60) / patterns.length;
  // Graph pixels straight to canvas pixels: the same frame the basemap and the
  // edge renderer use, so everything registers without a second thought.
  const transform = (graphX, graphY) => [
    (graphX - frame.offsetXPx) * frame.effectiveScale,
    (graphY - frame.offsetYPx) * frame.effectiveScale,
  ];

  // The ways themselves, with the travel time at each end. Reachability is the
  // whole of what puts a way in here, so nothing is ever drawn across ground
  // that carries no way - which is what a triangulation over the nodes could
  // not help doing.
  //
  // There is no band count anywhere in this: a band is one division of a time,
  // done per fragment on screen and per piece in the export, exactly as the
  // colour renderer evaluates its cycle. Nothing enumerates bands, so nothing
  // has to bound how many there are.
  const segments = getReachableWaySegments(mapData, snapshot, options);
  const hasField = segments.length >= 6;

  const asPaths = (features) => features.map((feature) => ({
    paths: feature.paths.map((path) => path.map(([graphX, graphY]) => [graphX, graphY])),
  }));
  // The coastline and the inland water are ruled the same way, but only the
  // coastline is a limit on where anyone can be: a river or a lake has ways
  // running along both banks and a zone drawn around them legitimately covers
  // the water between, while the sea has no far bank on this sheet.
  const coastlineFeatures = asPaths(options.projectedBoundary?.waterFeatures ?? []);
  const waterFeatures = coastlineFeatures
    .concat(asPaths(options.projectedBoundary?.inlandWaterFeatures ?? []));

  const labelFontSize = options.labelFontSize ?? 12;
  const pixelsPerMm = options.outputPixelsPerMm ?? OUTPUT_PIXELS_PER_MM;
  const ribbonPx = ribbonWidthPx(options.ribbonWidthMm ?? RIBBON_WIDTH_MM, pixelsPerMm);

  // Planned on the scene rather than inside a renderer, so the screen and the
  // exported sheet put every value in the same place. Labels that moved
  // between them would be two maps with one name.
  // Where a way crosses a band boundary: the contour geometry and the anchor
  // for its label, computed once and carried on the scene so the screen and
  // the sheet draw the same lines in the same places.
  const bandGeometry = hasField ? getOrBuildBandGeometry(snapshot, segments, bandSeconds) : null;
  const contourCrossings = bandGeometry?.crossings ?? [];
  const labels = hasField
    ? planRibbonContourLabels(contourCrossings, {
      transform,
      widthPx,
      heightPx,
      spacingPx: options.labelSpacingPx ?? Math.max(ribbonPx * 3, 160),
      formatLabel: (seconds) => formatBandLabel(seconds / 60, options.formatMinutes),
    })
    : [];
  return {
    widthPx,
    heightPx,
    transform,
    frame: {
      offsetXPx: frame.offsetXPx,
      offsetYPx: frame.offsetYPx,
      effectiveScale: frame.effectiveScale,
    },
    ribbons: hasField
      ? {
        segments,
        ordered: bandGeometry.ordered,
        bandSeconds,
        patterns,
        // One legend row per pattern, labelled with the time it first stands
        // for. The cycle repeats after that, which is what the contour values
        // on the map are there to resolve.
        patternLabels: patterns.map(
          (_, index) => formatBandLabel(((index + 1) * bandSeconds) / 60, options.formatMinutes),
        ),
        widthPx: ribbonPx,
        outlinePx: 0.9,
      }
      : null,
    contourCrossings,
    labels,
    waterPattern: WATER_HATCH_PATTERN,
    waterInk: WATER_INK,
    roadInk: ROAD_INK,
    ink: options.ink ?? '#000000',
    paper: options.paper ?? '#ffffff',
    labelFontSize,
    contourStrokeWidth: 0.9,
    roadStrokeWidth: 0.3,
    patternScale: options.patternScale ?? 1,
    legend: false,
    basemap: {
      waterFeatures,
      coastlineFeatures,
      roadSegments: collectVisibleRoadSegments(
        mapData,
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
