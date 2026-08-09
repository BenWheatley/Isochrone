import {
  DEFAULT_BOUNDARY_BASEMAP_URL,
  DEFAULT_GRAPH_BINARY_URL,
  DEFAULT_LOCATION_ID,
  DEFAULT_LOCATION_NAME,
  EDGE_INTERPOLATION_SLACK_SECONDS,
  EDGE_MODE_BIKE_BIT,
  EDGE_MODE_CAR_BIT,
  EDGE_MODE_WALK_BIT,
  EDGE_MODE_WATER_BIT,
  FINAL_EDGE_INTERPOLATION_STEP_STRIDE,
  INTERACTIVE_EDGE_INTERPOLATION_STEP_STRIDE,
  TRANSIT_ONLY_ALLOWED_MODE_MASK,
} from './config/constants.js';
import {
  getEdgeTraversalCostSeconds,
  getOrCreateEdgeTraversalCostSecondsCache,
  nodeHasAllowedModeOutgoingEdge,
  precomputeEdgeTraversalCostSecondsCache,
} from './core/routing.js';
import {
  parseLanguageFromLocationSearch,
  mapCanvasPixelToGraphMeters,
  mapClientPointToCanvasPixel,
  parseLocationIdFromLocationSearch,
  parseNodeIndexFromLocationSearch,
  persistLocationIdToLocation,
  persistNodeIndexToLocation,
} from './core/coords.js';
import {
  createDefaultMapViewport,
  resolveViewportFrame,
} from './core/viewport.js';
import {
  computeProjectedFeatureListBoundingBoxPx,
  getAirportFillStyle,
  getBoundaryStrokeStyle,
  getBoundaryWaterFillStyle,
  getForestFillStyle,
  getInlandWaterFillStyle,
  getWaterwayStrokeStyle,
  isClosedPath,
  parseBoundaryBasemapPayload,
  projectBoundaryBasemapToGraphPaths,
} from './core/boundary-basemap.js';
import {
  buildLocationAssetUrls,
  localizeLocationRegistry,
  loadLocationRegistry,
  resolveLocationEntry,
} from './core/location-registry.js';
import {
  bindLocationSelectControl,
  bindHeaderMenuControl as bindHeaderMenuControlInternal,
  bindPointerButtonInversionControl as bindPointerButtonInversionControlInternal,
  bindThemeControl as bindThemeControlInternal,
  getAllowedModeMaskFromShell,
  getColourCycleMinutesFromShell,
  getSpeedOptionsFromShell,
  getTransitOptionsFromShell,
  initializeAppShell,
  bindModeSelectControl as bindModeSelectControlInternal,
  populateLocationSelect,
  updateTransitControlAvailability,
} from './ui/orchestration.js';
import {
  loadCommonLocaleBundle,
} from './ui/localization.js';
import {
} from './ui/legend-format.js';
import { bindCanvasClickRouting as bindCanvasClickRoutingInternal } from './interaction/canvas-routing.js';
import {
  bindSvgExportControl,
  exportCurrentRenderedIsochroneSvg,
  formatIsochroneExportTitle,
} from './export/svg.js';
import {
  DEFAULT_COLOUR_CYCLE_MINUTES,
  normalizeIsochroneTheme,
  timeToColour,
} from './render/colour.js';
import {
  validateGraphForNodePixels,
  validateGraphForRouting,
  validateGraphHeaderForBoundaryAlignment,
} from './core/graph-validation.js';
import {
  createWasmRoutingKernelFacade,
  hasWebAssemblySupport,
  instantiateRoutingKernelWasm,
} from './wasm/routing-kernel.js';

import {
  blitPixelGridToCanvas,
  getOrCreateIsochroneRenderer,
} from './render/isochrone-renderer.js';
import {
} from './core/graph-binary.js';
import {
  buildTransitConnectionEdgeVertexData,
  runConnectionScanFromWalkingReachableStops,
} from './core/transit-csa.js';
import {
  validateDistSeconds,
  validateEdgeTraversalCostSecondsLookup,
  validateNodePixels,
  validateSearchState,
  validateSettledBatch,
} from './core/routing-validation.js';
export {
  buildTransitConnectionEdgeVertexData,
  runConnectionScanFromWalkingReachableStops,
} from './core/transit-csa.js';
import {
  fetchBinaryWithProgress,
  maybeDecompressGzipBuffer,
  parseGraphBinary,
} from './core/graph-binary.js';
import {
  clampInt,
} from './core/math.js';
import {
  resolveIsochroneTheme,
} from './ui/theme.js';
import {
  WASM_REQUIRED_MESSAGE,
  ensureWasmSupportOrShowError,
  fadeOutLoadingOverlay,
  formatInitialGraphLoadingText,
  formatRoutingStatusCalculating,
  formatRoutingStatusDone,
  formatRoutingStatusNoReachable,
  formatRoutingStatusPreview,
  getLocalizedShellText,
  getRoutingFailedStatusText,
  getShellLocaleMessages,
  setRoutingStatus,
  showLoadingOverlay,
  updateGraphLoadingText,
  updateRenderBackendBadge,
} from './ui/status.js';
import {
  computeExportDistanceScaleBar,
  renderIsochroneLegendIfNeeded,
  updateDistanceScaleBar,
} from './ui/legend-scale.js';
export {
  computeExportDistanceScaleBar,
  renderIsochroneLegend,
  renderIsochroneLegendIfNeeded,
  updateDistanceScaleBar,
} from './ui/legend-scale.js';
export {
  WASM_REQUIRED_MESSAGE,
  ensureWasmSupportOrShowError,
  formatRenderBackendBadgeText,
  formatRoutingStatusCalculating,
  formatRoutingStatusDone,
  formatRoutingStatusNoReachable,
  formatRoutingStatusPreview,
  getRoutingFailedStatusText,
} from './ui/status.js';
export {
  fetchBinaryWithProgress,
  maybeDecompressGzipBuffer,
  parseGraphBinary,
} from './core/graph-binary.js';
export {
  blitPixelGridToCanvas,
  createIsochroneRenderer,
  createWebGlIsochroneRenderer,
  shouldUploadEdgeGeometry,
} from './render/isochrone-renderer.js';
export {
  DEFAULT_BOUNDARY_BASEMAP_URL,
  DEFAULT_GRAPH_BINARY_URL,
  DEFAULT_LOCATION_NAME,
  GRAPH_MAGIC,
} from './config/constants.js';
export { MinHeap, runMinHeapSelfTest } from './core/heap.js';
export { createWalkingSearchState, computeEdgeTraversalCostSeconds } from './core/routing.js';
export {
  mapCanvasPixelToGraphMeters,
  mapClientPointToCanvasPixel,
  parseBikeSpeedKphFromLocationSearch,
  parseColourCycleMinutesFromLocationSearch,
  parseDepartureDatetimeFromLocationSearch,
  parseLocationIdFromLocationSearch,
  parseModeValuesFromLocationSearch,
  parseNodeIndexFromLocationSearch,
  parseWalkSpeedKphFromLocationSearch,
  persistBikeSpeedKphToLocation,
  persistColourCycleMinutesToLocation,
  persistDepartureDatetimeToLocation,
  persistLocationIdToLocation,
  persistModeValuesToLocation,
  persistNodeIndexToLocation,
  persistWalkSpeedKphToLocation,
} from './core/coords.js';
export {
  initializeAppShell,
  bindLocationSelectControl,
  getAllowedModeMaskFromShell,
  getColourCycleMinutesFromShell,
  getSpeedOptionsFromShell,
  getTransitOptionsFromShell,
  populateLocationSelect,
  updateTransitControlAvailability,
} from './ui/orchestration.js';
export {
  bindSvgExportControl,
  buildRenderedIsochroneSvgDocument,
  buildSvgExportFilename,
  exportCurrentRenderedIsochroneSvg,
  formatIsochroneExportTitle,
} from './export/svg.js';
export { timeToColour } from './render/colour.js';

const WASM_EDGE_COST_TICK_SCALE = 1_000;
const EDGE_TRAVERSAL_COST_TICK_CACHE_PROPERTY = '__edgeTraversalCostTicksByModeMask';
const MODE_SPECIFIC_KERNEL_GRAPH_VIEWS_CACHE_PROPERTY = '__modeSpecificKernelGraphViewsByModeMask';
const ROUTING_DIST_SCRATCH_BUFFERS_PROPERTY = '__routingDistScratchBuffers';
const ROUTING_DIST_SCRATCH_NEXT_INDEX_PROPERTY = '__routingDistScratchNextIndex';
export function precomputeNodeModeMask(graph) {
  validateGraphForRouting(graph);

  const nodeModeMask = new Uint8Array(graph.header.nNodes);
  const supportedModeMask =
    EDGE_MODE_WALK_BIT | EDGE_MODE_BIKE_BIT | EDGE_MODE_CAR_BIT | EDGE_MODE_WATER_BIT;

  for (let nodeIndex = 0; nodeIndex < graph.header.nNodes; nodeIndex += 1) {
    const firstEdgeIndex = graph.nodeU32[nodeIndex * 4 + 2];
    const edgeCount = graph.nodeU16[nodeIndex * 8 + 6];
    const endEdgeIndex = firstEdgeIndex + edgeCount;
    let mask = 0;

    for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
      mask |= graph.edgeModeMask[edgeIndex] & supportedModeMask;
      if (mask === supportedModeMask) {
        break;
      }
    }

    nodeModeMask[nodeIndex] = mask;
  }

  return nodeModeMask;
}

export function precomputeKernelGraphViews(graph) {
  validateGraphForRouting(graph);

  const nodeFirstEdgeIndex = new Uint32Array(graph.header.nNodes);
  const nodeEdgeCount = new Uint16Array(graph.header.nNodes);
  const edgeTargetNodeIndex = new Uint32Array(graph.header.nEdges);
  const edgeWalkCostSeconds = new Uint16Array(graph.header.nEdges);

  for (let nodeIndex = 0; nodeIndex < graph.header.nNodes; nodeIndex += 1) {
    nodeFirstEdgeIndex[nodeIndex] = graph.nodeU32[nodeIndex * 4 + 2];
    nodeEdgeCount[nodeIndex] = graph.nodeU16[nodeIndex * 8 + 6];
  }
  for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
    edgeTargetNodeIndex[edgeIndex] = graph.edgeU32[edgeIndex * 3];
    edgeWalkCostSeconds[edgeIndex] = graph.edgeU16[edgeIndex * 6 + 2];
  }

  return {
    nodeFirstEdgeIndex,
    nodeEdgeCount,
    edgeTargetNodeIndex,
    edgeWalkCostSeconds,
  };
}

export function buildModeSpecificKernelGraphViews(graph, allowedModeMask, edgeCostTicks) {
  validateGraphForRouting(graph);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  if (!(edgeCostTicks instanceof Uint32Array)) {
    throw new Error('edgeCostTicks must be a Uint32Array');
  }
  if (edgeCostTicks.length < graph.header.nEdges) {
    throw new Error('edgeCostTicks must cover graph.header.nEdges');
  }

  const nodeCount = graph.header.nNodes;
  const nodeFirstEdgeIndex = new Uint32Array(nodeCount);
  const nodeEdgeCount = new Uint16Array(nodeCount);

  let compactEdgeCount = 0;
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    nodeFirstEdgeIndex[nodeIndex] = compactEdgeCount;
    const firstEdgeIndex = graph.nodeU32[nodeIndex * 4 + 2];
    const outgoingEdgeCount = graph.nodeU16[nodeIndex * 8 + 6];
    const endEdgeIndex = firstEdgeIndex + outgoingEdgeCount;
    let eligibleEdgeCount = 0;

    for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
      if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
        continue;
      }
      if (edgeCostTicks[edgeIndex] === 0) {
        continue;
      }
      eligibleEdgeCount += 1;
    }

    if (eligibleEdgeCount > 0xffff) {
      throw new Error(`node ${nodeIndex} has too many eligible outgoing edges for Uint16 count`);
    }
    nodeEdgeCount[nodeIndex] = eligibleEdgeCount;
    compactEdgeCount += eligibleEdgeCount;
  }

  const edgeTargetNodeIndex = new Uint32Array(compactEdgeCount);
  const compactEdgeCostTicks = new Uint32Array(compactEdgeCount);
  let writeEdgeIndex = 0;
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const firstEdgeIndex = graph.nodeU32[nodeIndex * 4 + 2];
    const outgoingEdgeCount = graph.nodeU16[nodeIndex * 8 + 6];
    const endEdgeIndex = firstEdgeIndex + outgoingEdgeCount;

    for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
      if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
        continue;
      }
      const edgeTickCost = edgeCostTicks[edgeIndex];
      if (edgeTickCost === 0) {
        continue;
      }
      edgeTargetNodeIndex[writeEdgeIndex] = graph.edgeU32[edgeIndex * 3];
      compactEdgeCostTicks[writeEdgeIndex] = edgeTickCost;
      writeEdgeIndex += 1;
    }
  }

  return {
    allowedModeMask,
    nodeFirstEdgeIndex,
    nodeEdgeCount,
    edgeTargetNodeIndex,
    edgeCostTicks: compactEdgeCostTicks,
    edgeCostTicksRef: edgeCostTicks,
  };
}

function getOrBuildModeSpecificKernelGraphViews(mapData, allowedModeMask, edgeCostTicks) {
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  if (!(edgeCostTicks instanceof Uint32Array)) {
    throw new Error('edgeCostTicks must be a Uint32Array');
  }

  let cacheByModeMask = mapData[MODE_SPECIFIC_KERNEL_GRAPH_VIEWS_CACHE_PROPERTY];
  if (!cacheByModeMask || typeof cacheByModeMask !== 'object') {
    cacheByModeMask = Object.create(null);
    mapData[MODE_SPECIFIC_KERNEL_GRAPH_VIEWS_CACHE_PROPERTY] = cacheByModeMask;
  }

  const cached = cacheByModeMask[allowedModeMask];
  if (
    cached
    && typeof cached === 'object'
    && cached.edgeCostTicksRef === edgeCostTicks
    && cached.nodeFirstEdgeIndex instanceof Uint32Array
    && cached.nodeEdgeCount instanceof Uint16Array
    && cached.edgeTargetNodeIndex instanceof Uint32Array
    && cached.edgeCostTicks instanceof Uint32Array
  ) {
    return cached;
  }

  const built = buildModeSpecificKernelGraphViews(mapData.graph, allowedModeMask, edgeCostTicks);
  cacheByModeMask[allowedModeMask] = built;
  return built;
}

export function createNodeSpatialIndex(graph, nodePixels) {
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  if (nodePixels.nodePixelX.length < graph.header.nNodes || nodePixels.nodePixelY.length < graph.header.nNodes) {
    throw new Error('node pixel arrays are too short for graph.header.nNodes');
  }

  const widthPx = graph.header.gridWidthPx;
  const heightPx = graph.header.gridHeightPx;
  const cellCount = widthPx * heightPx;
  const cellNodeHead = new Int32Array(cellCount);
  cellNodeHead.fill(-1);
  const nextNodeInCell = new Int32Array(graph.header.nNodes);
  nextNodeInCell.fill(-1);

  for (let nodeIndex = 0; nodeIndex < graph.header.nNodes; nodeIndex += 1) {
    const xPx = nodePixels.nodePixelX[nodeIndex];
    const yPx = nodePixels.nodePixelY[nodeIndex];
    const cellIndex = yPx * widthPx + xPx;
    nextNodeInCell[nodeIndex] = cellNodeHead[cellIndex];
    cellNodeHead[cellIndex] = nodeIndex;
  }

  return {
    widthPx,
    heightPx,
    cellNodeHead,
    nextNodeInCell,
  };
}

function validateNodeSpatialIndex(spatialIndex, nodeCount, widthPx, heightPx) {
  if (!spatialIndex || typeof spatialIndex !== 'object') {
    throw new Error('spatialIndex must be an object');
  }
  if (!(spatialIndex.cellNodeHead instanceof Int32Array)) {
    throw new Error('spatialIndex.cellNodeHead must be an Int32Array');
  }
  if (!(spatialIndex.nextNodeInCell instanceof Int32Array)) {
    throw new Error('spatialIndex.nextNodeInCell must be an Int32Array');
  }
  const expectedCellCount = widthPx * heightPx;
  if (spatialIndex.cellNodeHead.length < expectedCellCount) {
    throw new Error('spatialIndex.cellNodeHead is too short');
  }
  if (spatialIndex.nextNodeInCell.length < nodeCount) {
    throw new Error('spatialIndex.nextNodeInCell is too short');
  }
}

export function findNearestNodeIndexForMode(
  graph,
  xM,
  yM,
  allowedModeMask = EDGE_MODE_CAR_BIT,
) {
  validateGraphForRouting(graph);

  if (!Number.isFinite(xM) || !Number.isFinite(yM)) {
    throw new Error('xM and yM must be finite numbers');
  }
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  let nearestAnyNodeIndex = -1;
  let nearestAnyDistanceSquared = Infinity;
  let nearestModeNodeIndex = -1;
  let nearestModeDistanceSquared = Infinity;
  const edgeTraversalCostSeconds = getOrCreateEdgeTraversalCostSecondsCache(graph, allowedModeMask);

  for (let nodeIndex = 0; nodeIndex < graph.header.nNodes; nodeIndex += 1) {
    const nodeXM = graph.nodeI32[nodeIndex * 4];
    const nodeYM = graph.nodeI32[nodeIndex * 4 + 1];
    const dx = nodeXM - xM;
    const dy = nodeYM - yM;
    const distanceSquared = dx * dx + dy * dy;

    if (distanceSquared < nearestAnyDistanceSquared) {
      nearestAnyDistanceSquared = distanceSquared;
      nearestAnyNodeIndex = nodeIndex;
    }

    if (
      !nodeHasAllowedModeOutgoingEdge(
        graph,
        nodeIndex,
        allowedModeMask,
        edgeTraversalCostSeconds,
      )
    ) {
      continue;
    }
    if (distanceSquared < nearestModeDistanceSquared) {
      nearestModeDistanceSquared = distanceSquared;
      nearestModeNodeIndex = nodeIndex;
    }
  }

  if (nearestModeNodeIndex >= 0) {
    return nearestModeNodeIndex;
  }
  if (nearestAnyNodeIndex >= 0) {
    return nearestAnyNodeIndex;
  }
  throw new Error('graph contains no nodes');
}

export function findNearestNodeIndexForModeFromSpatialIndex(
  spatialIndex,
  nodePixels,
  nodeModeMask,
  xPx,
  yPx,
  allowedModeMask = EDGE_MODE_CAR_BIT,
) {
  validateNodePixels(nodePixels);
  if (!(nodeModeMask instanceof Uint8Array)) {
    throw new Error('nodeModeMask must be a Uint8Array');
  }
  if (nodeModeMask.length < nodePixels.nodePixelX.length) {
    throw new Error('nodeModeMask is too short for nodePixels');
  }
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const widthPx = Math.max(1, Number(spatialIndex?.widthPx ?? 0));
  const heightPx = Math.max(1, Number(spatialIndex?.heightPx ?? 0));
  validateNodeSpatialIndex(spatialIndex, nodePixels.nodePixelX.length, widthPx, heightPx);

  const clampedXPx = clampInt(Math.round(xPx), 0, widthPx - 1);
  const clampedYPx = clampInt(Math.round(yPx), 0, heightPx - 1);

  let nearestAnyNodeIndex = -1;
  let nearestAnyDistanceSquared = Infinity;
  let nearestModeNodeIndex = -1;
  let nearestModeDistanceSquared = Infinity;

  const visitCell = (cellXPx, cellYPx) => {
    const cellIndex = cellYPx * widthPx + cellXPx;
    let nodeIndex = spatialIndex.cellNodeHead[cellIndex];

    while (nodeIndex >= 0) {
      const dx = nodePixels.nodePixelX[nodeIndex] - clampedXPx;
      const dy = nodePixels.nodePixelY[nodeIndex] - clampedYPx;
      const distanceSquared = dx * dx + dy * dy;

      if (distanceSquared < nearestAnyDistanceSquared) {
        nearestAnyDistanceSquared = distanceSquared;
        nearestAnyNodeIndex = nodeIndex;
      }
      if (nodeModeMask[nodeIndex] & allowedModeMask) {
        if (distanceSquared < nearestModeDistanceSquared) {
          nearestModeDistanceSquared = distanceSquared;
          nearestModeNodeIndex = nodeIndex;
        }
      }

      nodeIndex = spatialIndex.nextNodeInCell[nodeIndex];
    }
  };

  const maxRadius = Math.max(widthPx, heightPx);
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    const minX = Math.max(0, clampedXPx - radius);
    const maxX = Math.min(widthPx - 1, clampedXPx + radius);
    const minY = Math.max(0, clampedYPx - radius);
    const maxY = Math.min(heightPx - 1, clampedYPx + radius);

    if (radius === 0) {
      visitCell(clampedXPx, clampedYPx);
    } else {
      for (let scanX = minX; scanX <= maxX; scanX += 1) {
        visitCell(scanX, minY);
        if (maxY !== minY) {
          visitCell(scanX, maxY);
        }
      }
      for (let scanY = minY + 1; scanY < maxY; scanY += 1) {
        visitCell(minX, scanY);
        if (maxX !== minX) {
          visitCell(maxX, scanY);
        }
      }
    }

    const radiusSquared = radius * radius;
    if (nearestModeNodeIndex >= 0 && nearestModeDistanceSquared <= radiusSquared) {
      break;
    }
  }

  if (nearestModeNodeIndex >= 0) {
    return nearestModeNodeIndex;
  }
  if (nearestAnyNodeIndex >= 0) {
    return nearestAnyNodeIndex;
  }
  throw new Error('graph contains no nodes');
}


export function findNearestNodeForCanvasPixel(mapData, xPx, yPx, options = {}) {
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }

  const { easting, northing } = mapCanvasPixelToGraphMeters(mapData.graph, xPx, yPx);
  const xM = easting - mapData.graph.header.originEasting;
  const yM = northing - mapData.graph.header.originNorthing;
  const allowedModeMask = options.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  const nodeModeMask = mapData.nodeModeMask ?? null;
  const nodeSpatialIndex = mapData.nodeSpatialIndex ?? null;
  let nodeIndex;
  if (nodeModeMask && nodeSpatialIndex) {
    const nodeIndexPx = findNearestNodeIndexForModeFromSpatialIndex(
      nodeSpatialIndex,
      mapData.nodePixels,
      nodeModeMask,
      xPx,
      yPx,
      allowedModeMask,
    );
    nodeIndex = nodeIndexPx;
  } else {
    nodeIndex = findNearestNodeIndexForMode(mapData.graph, xM, yM, allowedModeMask);
  }

  return {
    nodeIndex,
    easting,
    northing,
    xM,
    yM,
  };
}

export function bindCanvasClickRouting(shell, mapData, options = {}) {
  return bindCanvasClickRoutingInternal(shell, mapData, options, {
    findNearestNodeForCanvasPixel,
    getAllowedModeMaskFromShell,
    getColourCycleMinutesFromShell,
    getRoutingFailedStatusText,
    getSpeedOptionsFromShell,
    getTransitOptionsFromShell,
    mapClientPointToCanvasPixel,
    parseNodeIndexFromLocationSearch,
    persistNodeIndexToLocation,
    renderIsochroneLegendIfNeeded,
    runWalkingIsochroneFromSourceNode,
    setRoutingStatus,
    updateDistanceScaleBar,
    redrawViewport(currentShell, currentMapData) {
      if (currentMapData?.boundaryPayload && currentMapData?.graph?.header) {
        drawBoundaryBasemapAlignedToGraphGrid(
          currentShell.boundaryCanvas,
          currentMapData.boundaryPayload,
          currentMapData.graph.header,
          {
            colourTheme: resolveIsochroneTheme(),
            viewport: currentMapData.viewport,
            fitBoundingBoxPx: currentMapData.boundaryFitBoundingBoxPx,
          },
        );
      }
      rerenderIsochroneFromSnapshot(currentShell, currentMapData, {
        colourTheme: resolveIsochroneTheme(),
        colourCycleMinutes: getColourCycleMinutesFromShell(currentShell),
        viewport: currentMapData?.viewport,
      });
    },
  });
}

export async function runWalkingIsochroneFromSourceNode(
  shell,
  mapData,
  sourceNodeIndex,
  timeLimitSeconds = Number.POSITIVE_INFINITY,
  options = {},
) {
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }
  if (
    !Number.isInteger(sourceNodeIndex)
    || sourceNodeIndex < 0
    || sourceNodeIndex >= mapData.graph.header.nNodes
  ) {
    throw new Error(`sourceNodeIndex out of range: ${sourceNodeIndex}`);
  }

  const allowedModeMask = options.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  const edgeCostPrecomputeKernel = options.edgeCostPrecomputeKernel
    ?? mapData.edgeCostPrecomputeKernel
    ?? null;
  if (
    edgeCostPrecomputeKernel === null
    || typeof edgeCostPrecomputeKernel !== 'object'
    || typeof edgeCostPrecomputeKernel.precomputeEdgeCostsForGraph !== 'function'
    || typeof edgeCostPrecomputeKernel.computeTravelTimeFieldForGraph !== 'function'
  ) {
    throw new Error('WASM routing kernel is required and must expose precompute/search methods');
  }

  const walkingSpeedMps = options.walkingSpeedMps;
  const bikeCruiseSpeedKph = options.bikeCruiseSpeedKph;
  const edgeTraversalCostSeconds = precomputeEdgeTraversalCostSecondsCache(
    mapData.graph,
    allowedModeMask,
    null,
    {
      edgeCostPrecomputeKernel,
      onKernelError: options.onKernelError ?? null,
      walkingSpeedMps,
      bikeCruiseSpeedKph,
    },
  );
  const edgeTraversalCostTicks = getOrBuildEdgeTraversalCostTicksForMode(
    mapData.graph,
    allowedModeMask,
    edgeTraversalCostSeconds,
  );
  const kernelGraphViews = getOrBuildModeSpecificKernelGraphViews(
    mapData,
    allowedModeMask,
    edgeTraversalCostTicks,
  );
  const distSeconds = getOrRotateRoutingDistScratchBuffer(
    mapData,
    mapData.graph.header.nNodes,
  );

  let done = false;
  let settledCount = 0;
  const searchState = {
    graph: mapData.graph,
    sourceNodeIndex,
    timeLimitSeconds,
    allowedModeMask,
    heapStrategy: 'wasm-kernel',
    edgeTraversalCostSeconds,
    distSeconds,
    get done() {
      return done;
    },
    get settledCount() {
      return settledCount;
    },
    isDone() {
      return done;
    },
    expandOne() {
      if (done) {
        return -1;
      }
      const kernelResult = edgeCostPrecomputeKernel.computeTravelTimeFieldForGraph({
        nodeFirstEdgeIndex: kernelGraphViews.nodeFirstEdgeIndex,
        nodeEdgeCount: kernelGraphViews.nodeEdgeCount,
        edgeTargetNodeIndex: kernelGraphViews.edgeTargetNodeIndex,
        edgeCostTicks: kernelGraphViews.edgeCostTicks,
        outDistSeconds: distSeconds,
        sourceNodeIndex,
        returnSharedOutputView: true,
        timeLimitSeconds,
      });
      if (
        kernelResult
        && typeof kernelResult === 'object'
        && kernelResult.outDistSecondsView instanceof Float32Array
        && kernelResult.outDistSecondsView.length === distSeconds.length
      ) {
        searchState.distSeconds = kernelResult.outDistSecondsView;
      } else {
        searchState.distSeconds = distSeconds;
      }
      if (
        kernelResult
        && typeof kernelResult === 'object'
        && Number.isInteger(kernelResult.settledNodeCount)
        && kernelResult.settledNodeCount >= 0
      ) {
        settledCount = kernelResult.settledNodeCount;
      } else {
        settledCount = countFiniteTravelTimes(searchState.distSeconds);
      }
      done = true;
      return sourceNodeIndex;
    },
  };

  const runSummary = await runSearchTimeSlicedWithRendering(shell, mapData, searchState, options);
  if (!runSummary.cancelled) {
    let finalDistSeconds = searchState.distSeconds;
    let finalEdgeVertexData = runSummary.edgeVertexData ?? null;
    let transitAugmented = false;
    let transitEdgeVertexData = null;

    const nStops = mapData.graph.header.nStops;
    if (
      Number.isInteger(nStops)
      && nStops > 0
      && options.transitEnabled
      && Number.isFinite(options.departureSecondsOfDay)
      && Number.isInteger(options.departureWeekdayIndex)
    ) {
      const isTransitOnlyRouting = allowedModeMask === TRANSIT_ONLY_ALLOWED_MODE_MASK;
      const csaResult = runConnectionScanFromWalkingReachableStops(
        mapData.graph,
        finalDistSeconds,
        {
          departureSecondsOfDay: options.departureSecondsOfDay,
          departureWeekdayIndex: options.departureWeekdayIndex,
          timeLimitSeconds,
          walkingSpeedMps,
          // Pass 1 cannot move at all under the transit-only sentinel mask, so
          // give the CSA scan the origin's own coordinates to attach directly
          // to nearby stops (see runConnectionScanFromWalkingReachableStops).
          originXM: isTransitOnlyRouting ? mapData.graph.nodeI32[sourceNodeIndex * 4] : undefined,
          originYM: isTransitOnlyRouting ? mapData.graph.nodeI32[sourceNodeIndex * 4 + 1] : undefined,
        },
      );
      if (csaResult.renderableTedgeIndices.length > 0) {
        transitEdgeVertexData = buildTransitConnectionEdgeVertexData(
          mapData.graph,
          mapData.nodePixels,
          csaResult.renderableTedgeIndices,
          csaResult.stopElapsedSeconds,
        );
        transitAugmented = transitEdgeVertexData.length > 0;
      }
      if (csaResult.seedNodeIndices.length > 0) {
        const seedNodeIndices = new Uint32Array(csaResult.seedNodeIndices.length + 1);
        const seedStartDistSeconds = new Float32Array(csaResult.seedStartDistSeconds.length + 1);
        seedNodeIndices[0] = sourceNodeIndex;
        seedStartDistSeconds[0] = 0;
        seedNodeIndices.set(csaResult.seedNodeIndices, 1);
        seedStartDistSeconds.set(csaResult.seedStartDistSeconds, 1);

        const transitDistSeconds = getOrRotateRoutingDistScratchBuffer(
          mapData,
          mapData.graph.header.nNodes,
        );
        const multiSourceResult = edgeCostPrecomputeKernel.computeTravelTimeFieldMultiSourceForGraph({
          nodeFirstEdgeIndex: kernelGraphViews.nodeFirstEdgeIndex,
          nodeEdgeCount: kernelGraphViews.nodeEdgeCount,
          edgeTargetNodeIndex: kernelGraphViews.edgeTargetNodeIndex,
          edgeCostTicks: kernelGraphViews.edgeCostTicks,
          outDistSeconds: transitDistSeconds,
          seedNodeIndices,
          seedStartDistSeconds,
          returnSharedOutputView: true,
          timeLimitSeconds,
        });
        finalDistSeconds =
          multiSourceResult
          && multiSourceResult.outDistSecondsView instanceof Float32Array
          && multiSourceResult.outDistSecondsView.length === transitDistSeconds.length
            ? multiSourceResult.outDistSecondsView
            : transitDistSeconds;
        // Edge-interpolation vertex buffers were built from the walk-only
        // pass; invalidate so the next render lazily rebuilds them from
        // the transit-augmented distances (getOrBuildSnapshotEdgeVertexData
        // is a generic function of snapshot.distSeconds, no special-casing
        // needed here beyond clearing the stale cache).
        finalEdgeVertexData = null;
        transitAugmented = true;
      }
    }

    mapData.lastRoutingSnapshot = {
      sourceNodeIndex,
      distSeconds: finalDistSeconds,
      allowedModeMask,
      walkingSpeedMps,
      bikeCruiseSpeedKph,
      edgeTraversalCostSeconds,
      colourCycleMinutes: options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES,
      edgeVertexData: finalEdgeVertexData,
      edgeVertexDataModeMask: finalEdgeVertexData instanceof Float32Array ? allowedModeMask : null,
      transitEdgeVertexData,
    };

    // runSearchTimeSlicedWithRendering already painted the canvas from the
    // walk-only pass-1 distances (searchState.distSeconds) before this
    // function ever runs CSA/pass-2 above — that paint call has no way to
    // know a transit augmentation is coming. Without this, the canvas would
    // silently keep showing the walk-only isochrone even though
    // mapData.lastRoutingSnapshot (and any subsequent SVG export) reflects
    // the correct transit-augmented times.
    if (transitAugmented) {
      rerenderIsochroneFromSnapshot(shell, mapData, {
        allowedModeMask,
        colourCycleMinutes: options.colourCycleMinutes,
        colourTheme: options.colourTheme,
      });
      // The status text above was already set by
      // runSearchTimeSlicedWithRendering from the walk-only pass-1 result
      // (including a possible "no reachable network" verdict) before this
      // function's CSA/pass-2 step ever ran - correct it now that
      // finalDistSeconds reflects the transit-augmented reality.
      if (shell.routingStatus) {
        const transitReachedCount = countFiniteTravelTimes(finalDistSeconds);
        setRoutingStatus(
          shell,
          transitReachedCount > 1
            ? formatRoutingStatusDone(null, { messages: getShellLocaleMessages(shell) })
            : formatRoutingStatusNoReachable(null, { messages: getShellLocaleMessages(shell) }),
        );
      }
    }
  }
  return runSummary;
}

async function loadEdgeCostPrecomputeKernel(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new Error('options must be an object');
  }

  const enabled = options.enabled ?? true;
  if (!enabled) {
    throw new Error('WASM routing kernel cannot be disabled');
  }
  const webAssemblyObject = options.webAssemblyObject ?? globalThis.WebAssembly;
  if (!hasWebAssemblySupport({ WebAssembly: webAssemblyObject })) {
    throw new Error(WASM_REQUIRED_MESSAGE);
  }

  try {
    const loadedWasmKernel = await instantiateRoutingKernelWasm({
      wasmUrl: options.url,
      fetchImpl: options.fetchImpl,
      webAssemblyObject,
    });
    return createWasmRoutingKernelFacade(loadedWasmKernel.exports);
  } catch (error) {
    if (typeof options.onLoadError === 'function') {
      options.onLoadError(error);
    }
    throw error;
  }
}

export function getOrBuildSnapshotEdgeVertexData(mapData, snapshot, options = {}) {
  if (!mapData || typeof mapData !== 'object' || !mapData.graph || !mapData.nodePixels) {
    throw new Error('mapData.graph and mapData.nodePixels are required');
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('snapshot must be an object');
  }
  const distSeconds = snapshot.distSeconds;
  if (!(distSeconds instanceof Float32Array) && !(distSeconds instanceof Float64Array)) {
    throw new Error('snapshot.distSeconds must be a Float32Array or Float64Array');
  }

  const allowedModeMask = options.allowedModeMask ?? snapshot.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  if (
    snapshot.edgeVertexData instanceof Float32Array
    && snapshot.edgeVertexDataModeMask === allowedModeMask
  ) {
    return snapshot.edgeVertexData;
  }

  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    snapshot.edgeTraversalCostSeconds,
    mapData.graph.header.nEdges,
  ) ?? precomputeEdgeTraversalCostSecondsCache(
    mapData.graph,
    allowedModeMask,
    null,
    {
      edgeCostPrecomputeKernel: mapData.edgeCostPrecomputeKernel,
    },
  );
  const collectEdgeVerticesImpl = options.collectEdgeVerticesImpl ?? null;
  if (collectEdgeVerticesImpl !== null) {
    if (typeof collectEdgeVerticesImpl !== 'function') {
      throw new Error('collectEdgeVerticesImpl must be a function');
    }
    const edgeVertexData = collectEdgeVerticesImpl(
      mapData.graph,
      mapData.nodePixels,
      distSeconds,
      allowedModeMask,
      { edgeTraversalCostSeconds },
    );
    if (!(edgeVertexData instanceof Float32Array)) {
      throw new Error('collectEdgeVerticesImpl must return a Float32Array');
    }
    snapshot.edgeVertexData = edgeVertexData;
    snapshot.edgeVertexDataModeMask = allowedModeMask;
    return edgeVertexData;
  }

  const edgeTemplate = getOrBuildStaticEdgeVertexTemplateForModeFromMapData(
    mapData,
    allowedModeMask,
    edgeTraversalCostSeconds,
  );
  updateTravelTimesInStaticEdgeVertexTemplate(
    edgeTemplate,
    distSeconds,
    edgeTraversalCostSeconds,
    {
      edgeSlackSeconds: options.edgeSlackSeconds,
    },
  );
  snapshot.edgeVertexData = edgeTemplate.edgeVertexData;
  snapshot.edgeVertexDataModeMask = allowedModeMask;
  return edgeTemplate.edgeVertexData;
}

export function buildStaticEdgeVertexTemplateForMode(
  graph,
  nodePixels,
  allowedModeMask,
  options = {},
) {
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    options.edgeTraversalCostSeconds,
    graph.header.nEdges,
  );
  const edgeCostLookup = edgeTraversalCostSeconds
    ?? getOrCreateEdgeTraversalCostSecondsCache(graph, allowedModeMask);

  let edgeCount = 0;
  for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
    if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
      continue;
    }
    const edgeCostSeconds = edgeCostLookup[edgeIndex];
    if (!Number.isFinite(edgeCostSeconds) || edgeCostSeconds <= 0) {
      continue;
    }
    edgeCount += 1;
  }

  const edgeVertexData = new Float32Array(edgeCount * 6);
  const sourceNodeIndices = new Uint32Array(edgeCount);
  const targetNodeIndices = new Uint32Array(edgeCount);
  const edgeIndices = new Uint32Array(edgeCount);
  let writeEdgeIndex = 0;

  for (let sourceNodeIndex = 0; sourceNodeIndex < graph.header.nNodes; sourceNodeIndex += 1) {
    const x0 = nodePixels.nodePixelX[sourceNodeIndex];
    const y0 = nodePixels.nodePixelY[sourceNodeIndex];
    const firstEdgeIndex = graph.nodeU32[sourceNodeIndex * 4 + 2];
    const nodeEdgeCount = graph.nodeU16[sourceNodeIndex * 8 + 6];
    const endEdgeIndex = firstEdgeIndex + nodeEdgeCount;

    for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
      if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
        continue;
      }
      const edgeCostSeconds = edgeCostLookup[edgeIndex];
      if (!Number.isFinite(edgeCostSeconds) || edgeCostSeconds <= 0) {
        continue;
      }

      const targetNodeIndex = graph.edgeU32[edgeIndex * 3];
      if (targetNodeIndex < 0 || targetNodeIndex >= graph.header.nNodes) {
        continue;
      }
      const x1 = nodePixels.nodePixelX[targetNodeIndex];
      const y1 = nodePixels.nodePixelY[targetNodeIndex];
      const base = writeEdgeIndex * 6;
      edgeVertexData[base] = x0;
      edgeVertexData[base + 1] = y0;
      edgeVertexData[base + 2] = -1;
      edgeVertexData[base + 3] = x1;
      edgeVertexData[base + 4] = y1;
      edgeVertexData[base + 5] = -1;
      sourceNodeIndices[writeEdgeIndex] = sourceNodeIndex;
      targetNodeIndices[writeEdgeIndex] = targetNodeIndex;
      edgeIndices[writeEdgeIndex] = edgeIndex;
      writeEdgeIndex += 1;
    }
  }

  return {
    allowedModeMask,
    maxNodeIndexExclusive: graph.header.nNodes,
    edgeCount: writeEdgeIndex,
    edgeVertexData,
    sourceNodeIndices,
    targetNodeIndices,
    edgeIndices,
  };
}

export function buildStaticEdgeNodeIndexedVertexData(template, edgeTraversalCostSeconds) {
  if (!template || typeof template !== 'object') {
    throw new Error('template must be an object');
  }
  if (!(template.edgeVertexData instanceof Float32Array)) {
    throw new Error('template.edgeVertexData must be a Float32Array');
  }
  if (!(template.sourceNodeIndices instanceof Uint32Array)) {
    throw new Error('template.sourceNodeIndices must be a Uint32Array');
  }
  if (!(template.targetNodeIndices instanceof Uint32Array)) {
    throw new Error('template.targetNodeIndices must be a Uint32Array');
  }
  if (!(template.edgeIndices instanceof Uint32Array)) {
    throw new Error('template.edgeIndices must be a Uint32Array');
  }
  if (
    !Number.isInteger(template.edgeCount)
    || template.edgeCount < 0
    || template.edgeCount > template.sourceNodeIndices.length
  ) {
    throw new Error('template.edgeCount must be a valid edge count');
  }

  const edgeCosts = validateEdgeTraversalCostSecondsLookup(
    edgeTraversalCostSeconds,
    template.edgeIndices.length,
  );
  if (!edgeCosts) {
    throw new Error('edgeTraversalCostSeconds is required');
  }

  const edgeCount = template.edgeCount;
  const edgeVertexData = template.edgeVertexData;
  const sourceNodeIndices = template.sourceNodeIndices;
  const targetNodeIndices = template.targetNodeIndices;
  const edgeIndices = template.edgeIndices;
  const packedVertexData = new Float32Array(edgeCount * 12);

  for (let templateEdgeIndex = 0; templateEdgeIndex < edgeCount; templateEdgeIndex += 1) {
    const edgeBase = templateEdgeIndex * 6;
    const packedBase = templateEdgeIndex * 12;
    const sourceNodeIndex = sourceNodeIndices[templateEdgeIndex];
    const targetNodeIndex = targetNodeIndices[templateEdgeIndex];
    const edgeIndex = edgeIndices[templateEdgeIndex];
    const edgeCostSeconds = edgeCosts[edgeIndex];

    // Start vertex.
    packedVertexData[packedBase] = edgeVertexData[edgeBase];
    packedVertexData[packedBase + 1] = edgeVertexData[edgeBase + 1];
    packedVertexData[packedBase + 2] = sourceNodeIndex;
    packedVertexData[packedBase + 3] = targetNodeIndex;
    packedVertexData[packedBase + 4] = edgeCostSeconds;
    packedVertexData[packedBase + 5] = 0;

    // End vertex.
    packedVertexData[packedBase + 6] = edgeVertexData[edgeBase + 3];
    packedVertexData[packedBase + 7] = edgeVertexData[edgeBase + 4];
    packedVertexData[packedBase + 8] = sourceNodeIndex;
    packedVertexData[packedBase + 9] = targetNodeIndex;
    packedVertexData[packedBase + 10] = edgeCostSeconds;
    packedVertexData[packedBase + 11] = 1;
  }

  return packedVertexData;
}

export function updateTravelTimesInStaticEdgeVertexTemplate(
  template,
  distSeconds,
  edgeTraversalCostSeconds,
  options = {},
) {
  if (!template || typeof template !== 'object') {
    throw new Error('template must be an object');
  }
  if (!(template.edgeVertexData instanceof Float32Array)) {
    throw new Error('template.edgeVertexData must be a Float32Array');
  }
  if (!(template.sourceNodeIndices instanceof Uint32Array)) {
    throw new Error('template.sourceNodeIndices must be a Uint32Array');
  }
  if (!(template.targetNodeIndices instanceof Uint32Array)) {
    throw new Error('template.targetNodeIndices must be a Uint32Array');
  }
  if (!(template.edgeIndices instanceof Uint32Array)) {
    throw new Error('template.edgeIndices must be a Uint32Array');
  }
  if (template.sourceNodeIndices.length !== template.targetNodeIndices.length) {
    throw new Error('template source/target index arrays must have equal lengths');
  }
  if (template.sourceNodeIndices.length !== template.edgeIndices.length) {
    throw new Error('template edge index arrays must have equal lengths');
  }
  if (
    !Number.isInteger(template.edgeCount)
    || template.edgeCount < 0
    || template.edgeCount > template.sourceNodeIndices.length
  ) {
    throw new Error('template.edgeCount must be a valid edge count');
  }
  const maxNodeIndexExclusive = template.maxNodeIndexExclusive ?? 0;
  if (!Number.isInteger(maxNodeIndexExclusive) || maxNodeIndexExclusive < 0) {
    throw new Error('template.maxNodeIndexExclusive must be a non-negative integer');
  }
  validateDistSeconds(distSeconds, maxNodeIndexExclusive);

  const edgeCosts = validateEdgeTraversalCostSecondsLookup(
    edgeTraversalCostSeconds,
    template.edgeIndices.length,
  );
  if (!edgeCosts) {
    throw new Error('edgeTraversalCostSeconds is required');
  }
  const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }

  const edgeCount = template.edgeCount;
  const sourceNodeIndices = template.sourceNodeIndices;
  const targetNodeIndices = template.targetNodeIndices;
  const edgeIndices = template.edgeIndices;
  const edgeVertexData = template.edgeVertexData;
  let visibleEdgeCount = 0;

  for (let templateEdgeIndex = 0; templateEdgeIndex < edgeCount; templateEdgeIndex += 1) {
    const base = templateEdgeIndex * 6;
    const sourceNodeIndex = sourceNodeIndices[templateEdgeIndex];
    const targetNodeIndex = targetNodeIndices[templateEdgeIndex];
    const edgeIndex = edgeIndices[templateEdgeIndex];

    const startSeconds = distSeconds[sourceNodeIndex];
    if (!Number.isFinite(startSeconds)) {
      edgeVertexData[base + 2] = -1;
      edgeVertexData[base + 5] = -1;
      continue;
    }

    const targetSeconds = distSeconds[targetNodeIndex];
    if (!Number.isFinite(targetSeconds)) {
      edgeVertexData[base + 2] = -1;
      edgeVertexData[base + 5] = -1;
      continue;
    }

    const edgeCostSeconds = edgeCosts[edgeIndex];
    if (!Number.isFinite(edgeCostSeconds) || edgeCostSeconds <= 0) {
      edgeVertexData[base + 2] = -1;
      edgeVertexData[base + 5] = -1;
      continue;
    }

    const expectedTargetSeconds = startSeconds + edgeCostSeconds;
    if (expectedTargetSeconds > targetSeconds + edgeSlackSeconds) {
      edgeVertexData[base + 2] = -1;
      edgeVertexData[base + 5] = -1;
      continue;
    }

    edgeVertexData[base + 2] = startSeconds;
    edgeVertexData[base + 5] = expectedTargetSeconds;
    visibleEdgeCount += 1;
  }

  return visibleEdgeCount;
}

function getOrBuildStaticEdgeVertexTemplateForModeFromMapData(
  mapData,
  allowedModeMask,
  edgeTraversalCostSeconds,
) {
  if (!mapData || typeof mapData !== 'object' || !mapData.graph || !mapData.nodePixels) {
    throw new Error('mapData.graph and mapData.nodePixels are required');
  }
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  const edgeCosts = validateEdgeTraversalCostSecondsLookup(
    edgeTraversalCostSeconds,
    mapData.graph.header.nEdges,
  );
  if (!edgeCosts) {
    throw new Error('edgeTraversalCostSeconds is required');
  }

  let templateByModeMask = mapData.edgeVertexTemplateByModeMask;
  if (!templateByModeMask || typeof templateByModeMask !== 'object') {
    templateByModeMask = Object.create(null);
    mapData.edgeVertexTemplateByModeMask = templateByModeMask;
  }

  let template = templateByModeMask[allowedModeMask] ?? null;
  if (!template || typeof template !== 'object' || !(template.edgeVertexData instanceof Float32Array)) {
    template = buildStaticEdgeVertexTemplateForMode(
      mapData.graph,
      mapData.nodePixels,
      allowedModeMask,
      { edgeTraversalCostSeconds: edgeCosts },
    );
    templateByModeMask[allowedModeMask] = template;
  }

  return template;
}

function getOrBuildStaticEdgeNodeIndexedVertexDataForModeFromMapData(
  mapData,
  allowedModeMask,
  edgeTraversalCostSeconds,
) {
  const template = getOrBuildStaticEdgeVertexTemplateForModeFromMapData(
    mapData,
    allowedModeMask,
    edgeTraversalCostSeconds,
  );
  if (
    template.edgeNodeIndexedVertexData instanceof Float32Array
    && template.edgeNodeIndexedVertexDataEdgeCostsRef === edgeTraversalCostSeconds
  ) {
    return template.edgeNodeIndexedVertexData;
  }

  const edgeNodeIndexedVertexData = buildStaticEdgeNodeIndexedVertexData(
    template,
    edgeTraversalCostSeconds,
  );
  template.edgeNodeIndexedVertexData = edgeNodeIndexedVertexData;
  template.edgeNodeIndexedVertexDataEdgeCostsRef = edgeTraversalCostSeconds;
  return edgeNodeIndexedVertexData;
}

function rerenderIsochroneFromSnapshot(shell, mapData, options = {}) {
  if (!shell || typeof shell !== 'object' || !shell.isochroneCanvas) {
    return false;
  }
  if (!mapData || typeof mapData !== 'object' || !mapData.graph || !mapData.nodePixels) {
    return false;
  }

  const snapshot = options.snapshot ?? mapData.lastRoutingSnapshot ?? null;
  const distSeconds = snapshot?.distSeconds ?? null;
  if (
    !snapshot
    || (
      !(distSeconds instanceof Float32Array)
      && !(distSeconds instanceof Float64Array)
    )
  ) {
    return false;
  }
  if (distSeconds.length < mapData.graph.header.nNodes) {
    return false;
  }

  const colourCycleMinutes = options.colourCycleMinutes
    ?? snapshot.colourCycleMinutes
    ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(
    options.colourTheme ?? resolveIsochroneTheme(),
    'dark',
  );
  const allowedModeMask = options.allowedModeMask ?? snapshot.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  const viewport = options.viewport ?? mapData.viewport;

  const renderer = getOrCreateIsochroneRenderer(shell.isochroneCanvas);
  updateRenderBackendBadge(shell, renderer);
  const supportsGpuEdgeInterpolation = typeof renderer.drawTravelTimeEdges === 'function';
  const supportsGpuIndexedEdgeInterpolation =
    typeof renderer.drawTravelTimeEdgesFromNodeTimes === 'function';
  const supportsGpuTravelTimeRendering = typeof renderer.drawTravelTimeGrid === 'function';
  // Under the transit-only sentinel mask no real road/ferry edge ever
  // matches allowedModeMask, so the isochrone is carried entirely by the
  // transit connections the CSA scan found. Those come with their own
  // per-endpoint times and must go through the plain edge renderer, not the
  // node-indexed one - see buildTransitConnectionEdgeVertexData for why.
  const isTransitOnlyAllowedModeMask = allowedModeMask === TRANSIT_ONLY_ALLOWED_MODE_MASK;

  if (supportsGpuEdgeInterpolation && isTransitOnlyAllowedModeMask) {
    renderer.drawTravelTimeEdges(snapshot.transitEdgeVertexData ?? new Float32Array(0), {
      cycleMinutes: colourCycleMinutes,
      colourTheme,
      append: false,
      graphWidthPx: mapData.graph.header.gridWidthPx,
      graphHeightPx: mapData.graph.header.gridHeightPx,
      viewport,
      fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
    });
    return true;
  }

  if (supportsGpuEdgeInterpolation) {
    const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
      snapshot.edgeTraversalCostSeconds,
      mapData.graph.header.nEdges,
    ) ?? precomputeEdgeTraversalCostSecondsCache(
      mapData.graph,
      allowedModeMask,
      null,
      {
        edgeCostPrecomputeKernel: mapData.edgeCostPrecomputeKernel,
      },
    );
    if (supportsGpuIndexedEdgeInterpolation) {
      const edgeNodeIndexedVertexData =
        getOrBuildStaticEdgeNodeIndexedVertexDataForModeFromMapData(
          mapData,
          allowedModeMask,
          edgeTraversalCostSeconds,
        );
      renderer.drawTravelTimeEdgesFromNodeTimes(
        edgeNodeIndexedVertexData,
        distSeconds,
        {
          cycleMinutes: colourCycleMinutes,
          colourTheme,
          append: false,
          reuseUploadedGeometry: true,
          graphWidthPx: mapData.graph.header.gridWidthPx,
          graphHeightPx: mapData.graph.header.gridHeightPx,
          edgeSlackSeconds: EDGE_INTERPOLATION_SLACK_SECONDS,
          viewport,
          fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
        },
      );
      return true;
    }

    const allEdgeVertices = getOrBuildSnapshotEdgeVertexData(mapData, snapshot, {
      allowedModeMask,
    });
    renderer.drawTravelTimeEdges(allEdgeVertices, {
      cycleMinutes: colourCycleMinutes,
      colourTheme,
      append: false,
      reuseUploadedGeometry: true,
      graphWidthPx: mapData.graph.header.gridWidthPx,
      graphHeightPx: mapData.graph.header.gridHeightPx,
      viewport,
      fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
    });
    return true;
  }

  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    snapshot.edgeTraversalCostSeconds,
    mapData.graph.header.nEdges,
  );

  if (supportsGpuTravelTimeRendering && mapData.travelTimeGrid) {
    clearTravelTimeGrid(mapData.travelTimeGrid);
    paintAllReachableEdgeInterpolationsToTravelTimeGrid(
      mapData.travelTimeGrid,
      mapData.graph,
      mapData.nodePixels,
      distSeconds,
      allowedModeMask,
      {
        stepStride: FINAL_EDGE_INTERPOLATION_STEP_STRIDE,
        edgeTraversalCostSeconds,
      },
    );
    paintReachableNodesTravelTimesToGrid(
      mapData.travelTimeGrid,
      mapData.nodePixels,
      distSeconds,
    );
    renderer.drawTravelTimeGrid(mapData.travelTimeGrid, {
      cycleMinutes: colourCycleMinutes,
      colourTheme,
      viewport,
      fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
    });
    return true;
  }

  if (mapData.pixelGrid) {
    clearGrid(mapData.pixelGrid);
    paintAllReachableEdgeInterpolationsToGrid(
      mapData.pixelGrid,
      mapData.graph,
      mapData.nodePixels,
      distSeconds,
      allowedModeMask,
      {
        alpha: 255,
        colourCycleMinutes,
        colourTheme,
        stepStride: FINAL_EDGE_INTERPOLATION_STEP_STRIDE,
        edgeTraversalCostSeconds,
      },
    );
    paintReachableNodesToGrid(
      mapData.pixelGrid,
      mapData.nodePixels,
      distSeconds,
      {
        alpha: 255,
        colourCycleMinutes,
        colourTheme,
      },
    );
    blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, {
      viewport,
      fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
    });
    return true;
  }

  return false;
}

export function rerenderIsochroneFromSnapshotWithStatus(shell, mapData, options = {}) {
  const nowImpl = options.nowImpl ?? defaultNowMs;
  if (typeof nowImpl !== 'function') {
    throw new Error('nowImpl must be a function');
  }
  const rerenderImpl = options.rerenderImpl ?? rerenderIsochroneFromSnapshot;
  if (typeof rerenderImpl !== 'function') {
    throw new Error('rerenderImpl must be a function');
  }

  const startMs = nowImpl();
  const rerendered = rerenderImpl(shell, mapData, options);
  if (!rerendered) {
    return false;
  }

  const elapsedMs = Math.max(0, Math.round(nowImpl() - startMs));
  setRoutingStatus(
    shell,
    formatRoutingStatusDone(elapsedMs, { messages: getShellLocaleMessages(shell) }),
  );
  return true;
}

/**
 * Connection Scan Algorithm pass: given a completed walking search's
 * distSeconds and a departure date/time, finds the earliest transit arrival
 * at every stop reachable from the walking-reachable set, and returns seed
 * arrays for a second multi-source Dijkstra pass (see
 * runWalkingIsochroneFromSourceNode). The build-time pipeline
 * (data_pipeline/gtfs_transit.py) now includes every weekday-recurring
 * service across the feed's whole calendar window, not just one reference
 * day, so this scan filters each connection against
 * graph.tedgeServiceDayMask using the departure date's ISO weekday bit
 * (0=Monday..6=Sunday) before accepting it. Connections are stored sorted
 * by time-of-day departure regardless of which weekday(s) they run on, so
 * the scan can still break out early once departures exceed the time
 * budget. Besides the seed arrays, the returned usedTedgeIndices lists
 * every connection whose boarding stop was reachable in time - not just
 * the one that won each stop's earliest-arrival race - so rendering can
 * draw the whole boardable transit network (see
 * buildTransitConnectionEdgeVertexData) rather than a sparse spanning
 * tree.
 */

/**
 * Builds edge vertex data for transit connections in the plain
 * (x, y, seconds) x 2 layout that drawTravelTimeEdges and the SVG exporter
 * both consume, colouring each end by the CSA's earliest arrival at that
 * stop.
 *
 * Deliberately NOT the node-indexed layout used for road/ferry edges. That
 * path looks each endpoint's time up from a per-node texture and keeps an
 * edge only when `startSeconds + edgeCost <= targetSeconds + slack` - a
 * shortest-path-tree test that is right for roads and wrong for transit
 * three times over: per-node times can't represent stops that share an
 * attachment node; a connection's in-vehicle time excludes the wait for the
 * vehicle, so the inequality rejects every non-optimal connection; and
 * under the transit-only mask most stop nodes have no finite time at all.
 * Together those silently dropped most connections, which is what made
 * consecutive hops of one route (A->B->C->D) render as disconnected
 * fragments. Explicit per-endpoint times avoid all three.
 */

export function bindModeSelectControl(shell, options = {}) {
  return bindModeSelectControlInternal(shell, {
    renderIsochroneLegendIfNeeded,
    requestIsochroneRepaint: options.requestIsochroneRepaint,
    requestIsochroneRedraw: options.requestIsochroneRedraw,
  });
}

export function bindHeaderMenuControl(shell, options = {}) {
  return bindHeaderMenuControlInternal(shell, options);
}

export function bindThemeControl(shell, options = {}) {
  return bindThemeControlInternal(shell, options);
}

export function bindPointerButtonInversionControl(shell, options = {}) {
  return bindPointerButtonInversionControlInternal(shell, options);
}

export function getOrRotateRoutingDistScratchBuffer(mapData, nodeCount) {
  if (!mapData || typeof mapData !== 'object') {
    throw new Error('mapData must be an object');
  }
  if (!Number.isInteger(nodeCount) || nodeCount <= 0) {
    throw new Error('nodeCount must be a positive integer');
  }

  let scratchBuffers = mapData[ROUTING_DIST_SCRATCH_BUFFERS_PROPERTY];
  if (
    !Array.isArray(scratchBuffers)
    || scratchBuffers.length !== 2
    || !(scratchBuffers[0] instanceof Float32Array)
    || !(scratchBuffers[1] instanceof Float32Array)
    || scratchBuffers[0].length !== nodeCount
    || scratchBuffers[1].length !== nodeCount
  ) {
    scratchBuffers = [
      new Float32Array(nodeCount),
      new Float32Array(nodeCount),
    ];
    mapData[ROUTING_DIST_SCRATCH_BUFFERS_PROPERTY] = scratchBuffers;
    mapData[ROUTING_DIST_SCRATCH_NEXT_INDEX_PROPERTY] = 0;
  }

  let nextIndex = mapData[ROUTING_DIST_SCRATCH_NEXT_INDEX_PROPERTY];
  if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= scratchBuffers.length) {
    nextIndex = 0;
  }
  const selectedBuffer = scratchBuffers[nextIndex];
  mapData[ROUTING_DIST_SCRATCH_NEXT_INDEX_PROPERTY] = (nextIndex + 1) % scratchBuffers.length;
  return selectedBuffer;
}

export function getOrBuildEdgeTraversalCostTicksForMode(
  graph,
  allowedModeMask,
  edgeTraversalCostSeconds,
) {
  validateGraphForRouting(graph);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  if (
    !(edgeTraversalCostSeconds instanceof Float32Array)
    && !(edgeTraversalCostSeconds instanceof Float64Array)
  ) {
    throw new Error('edgeTraversalCostSeconds must be a Float32Array or Float64Array');
  }
  if (edgeTraversalCostSeconds.length < graph.header.nEdges) {
    throw new Error('edgeTraversalCostSeconds must cover graph.header.nEdges');
  }

  let cacheByModeMask = graph[EDGE_TRAVERSAL_COST_TICK_CACHE_PROPERTY];
  if (!cacheByModeMask || typeof cacheByModeMask !== 'object') {
    cacheByModeMask = Object.create(null);
    graph[EDGE_TRAVERSAL_COST_TICK_CACHE_PROPERTY] = cacheByModeMask;
  }

  // Keyed on reference identity of edgeTraversalCostSeconds (not just
  // allowedModeMask) — precomputeEdgeTraversalCostSecondsCache hands back a
  // freshly-keyed array whenever the effective walk/bike speed changes for
  // the same mode mask, so a stale ticks array from a previous speed must
  // not be reused just because the mask matches.
  const cached = cacheByModeMask[allowedModeMask];
  if (
    cached
    && typeof cached === 'object'
    && cached.sourceCostSecondsRef === edgeTraversalCostSeconds
    && cached.ticks instanceof Uint32Array
    && cached.ticks.length >= graph.header.nEdges
  ) {
    return cached.ticks;
  }

  const edgeTraversalCostTicks = new Uint32Array(graph.header.nEdges);
  for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
    const costSeconds = edgeTraversalCostSeconds[edgeIndex];
    if (!Number.isFinite(costSeconds) || costSeconds <= 0) {
      edgeTraversalCostTicks[edgeIndex] = 0;
      continue;
    }
    const ticks = Math.ceil(costSeconds * WASM_EDGE_COST_TICK_SCALE);
    edgeTraversalCostTicks[edgeIndex] = ticks >= 0xffff_ffff ? 0xffff_ffff : ticks;
  }
  cacheByModeMask[allowedModeMask] = {
    ticks: edgeTraversalCostTicks,
    sourceCostSecondsRef: edgeTraversalCostSeconds,
  };

  return edgeTraversalCostTicks;
}

function syncCanvasToDisplaySize(canvas) {
  if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
    return false;
  }

  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return false;
  }

  const nextWidth = Math.max(1, Math.round(rect.width));
  const nextHeight = Math.max(1, Math.round(rect.height));
  const sizeChanged = canvas.width !== nextWidth || canvas.height !== nextHeight;
  if (sizeChanged) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
  }
  return sizeChanged;
}

function fillDrawableBoundaryFeatures(context, features) {
  for (const feature of features) {
    let hasDrawablePath = false;
    context.beginPath();
    for (const path of feature.paths) {
      if (path.length < 3) {
        continue;
      }
      hasDrawablePath = true;
      for (let i = 0; i < path.length; i += 1) {
        const point = path[i];
        const xPx = point[0];
        const yPx = point[1];
        if (i === 0) {
          context.moveTo(xPx, yPx);
        } else {
          context.lineTo(xPx, yPx);
        }
      }
      if (isClosedPath(path)) {
        context.closePath();
      }
    }
    if (hasDrawablePath) {
      context.fill();
    }
  }
}

export function drawBoundaryBasemapAlignedToGraphGrid(
  boundaryCanvas,
  payload,
  graphHeader,
  options = {},
) {
  if (!boundaryCanvas || typeof boundaryCanvas.getContext !== 'function') {
    throw new Error('boundaryCanvas must provide getContext("2d")');
  }
  validateGraphHeaderForBoundaryAlignment(graphHeader);

  const projectedBoundary = projectBoundaryBasemapToGraphPaths(payload, graphHeader);
  const context = boundaryCanvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to get 2D context for boundary canvas');
  }

  syncCanvasToDisplaySize(boundaryCanvas);
  const viewportFrame = resolveViewportFrame(graphHeader, options.viewport, {
    frameWidthPx: boundaryCanvas.width,
    frameHeightPx: boundaryCanvas.height,
    fitBoundingBoxPx: options.fitBoundingBoxPx,
  });

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, boundaryCanvas.width, boundaryCanvas.height);
  context.setTransform(
    viewportFrame.effectiveScale,
    0,
    0,
    viewportFrame.effectiveScale,
    -viewportFrame.offsetXPx * viewportFrame.effectiveScale,
    -viewportFrame.offsetYPx * viewportFrame.effectiveScale,
  );

  // Bottom-to-top: forest -> airports -> inland water -> coastal sea -> waterways -> admin boundary lines.
  context.fillStyle = getForestFillStyle(options.colourTheme);
  fillDrawableBoundaryFeatures(context, projectedBoundary.forestFeatures);

  context.fillStyle = getAirportFillStyle(options.colourTheme);
  fillDrawableBoundaryFeatures(context, projectedBoundary.airportFeatures);

  context.fillStyle = getInlandWaterFillStyle(options.colourTheme);
  fillDrawableBoundaryFeatures(context, projectedBoundary.inlandWaterFeatures);

  context.fillStyle = getBoundaryWaterFillStyle(options.colourTheme);
  fillDrawableBoundaryFeatures(context, projectedBoundary.waterFeatures);

  context.lineJoin = 'round';
  context.lineCap = 'round';
  for (const feature of projectedBoundary.waterwayFeatures) {
    const navigable = feature.navigable === true;
    context.strokeStyle = getWaterwayStrokeStyle(options.colourTheme, navigable);
    context.lineWidth = (navigable ? 1.6 : 1.0) / viewportFrame.effectiveScale;
    for (const path of feature.paths) {
      if (path.length < 2) {
        continue;
      }
      context.beginPath();
      for (let i = 0; i < path.length; i += 1) {
        const point = path[i];
        if (i === 0) {
          context.moveTo(point[0], point[1]);
        } else {
          context.lineTo(point[0], point[1]);
        }
      }
      context.stroke();
    }
  }

  context.fillStyle = 'rgba(0, 0, 0, 0)';
  context.strokeStyle = getBoundaryStrokeStyle(options.colourTheme);
  context.lineWidth = 1.2 / viewportFrame.effectiveScale;
  context.lineJoin = 'round';
  context.lineCap = 'round';

  let renderedPathCount = 0;

  for (const feature of projectedBoundary.features) {
    for (const path of feature.paths) {
      if (path.length < 2) {
        continue;
      }

      context.beginPath();
      for (let i = 0; i < path.length; i += 1) {
        const point = path[i];
        const xPx = point[0];
        const yPx = point[1];

        if (i === 0) {
          context.moveTo(xPx, yPx);
        } else {
          context.lineTo(xPx, yPx);
        }
      }

      if (isClosedPath(path)) {
        context.closePath();
        context.fill();
      }

      context.stroke();
      renderedPathCount += 1;
    }
  }

  context.setTransform(1, 0, 0, 1, 0, 0);

  return {
    featureCount: projectedBoundary.features.length,
    pathCount: renderedPathCount,
  };
}

export async function loadAndRenderBoundaryBasemap(shell, options = {}) {
  const url = options.url ?? DEFAULT_BOUNDARY_BASEMAP_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available');
  }

  showLoadingOverlay(
    shell,
    getLocalizedShellText(shell, 'body.loading.boundaries', 'Loading district boundaries...'),
    0,
  );

  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`failed to fetch district boundaries: HTTP ${response.status}`);
    }

    const payload = await response.json();
    const parsed = parseBoundaryBasemapPayload(payload);
    let pathCount = 0;
    for (const feature of parsed.features) {
      pathCount += feature.paths.length;
    }

    showLoadingOverlay(shell, formatInitialGraphLoadingText(shell), 0);
    return {
      boundaryPayload: payload,
      boundarySummary: {
        featureCount: parsed.features.length,
        pathCount,
      },
    };
  } catch (error) {
    showLoadingOverlay(
      shell,
      getLocalizedShellText(shell, 'error.boundaries.load', 'Failed to load district boundaries.'),
      0,
    );
    throw error;
  }
}





export async function initializeMapData(shell, options = {}) {
  const boundaryOptions = options.boundaries ?? {};
  const graphOptions = options.graph ?? {};
  const wasmKernelOptions = options.wasmKernel ?? {};
  const locationName =
    typeof options.locationName === 'string' && options.locationName.trim().length > 0
      ? options.locationName.trim()
      : DEFAULT_LOCATION_NAME;

  try {
    const edgeCostPrecomputeKernelPromise = loadEdgeCostPrecomputeKernel(wasmKernelOptions);
    const boundaryLoad = await loadAndRenderBoundaryBasemap(shell, boundaryOptions);
    const graph = await loadGraphBinary(shell, graphOptions);
    updateTransitControlAvailability(shell, graph.header.nStops > 0, {
      transitDateRange: options.transitDateRange,
    });
    const edgeCostPrecomputeKernel = await edgeCostPrecomputeKernelPromise;
    const renderer = getOrCreateIsochroneRenderer(shell.isochroneCanvas);
    updateRenderBackendBadge(shell, renderer);
    layoutMapViewportToContainGraph(shell, graph.header);
    syncCanvasToDisplaySize(shell.isochroneCanvas);
    // Default/max-zoom-out framing fits the district boundary (+5%) rather
    // than the full routing grid, which can be dominated by far-flung
    // ferry endpoints (see osm_graph_extract.py's grid-size-budgeted ferry
    // inclusion) — the boundary is what a user actually expects to see on
    // load. Panning still reaches the wider grid at that same zoom level.
    const boundaryFitBoundingBoxPx = computeProjectedFeatureListBoundingBoxPx(
      projectBoundaryBasemapToGraphPaths(boundaryLoad.boundaryPayload, graph.header).features,
    );
    const alignedBoundarySummary = drawBoundaryBasemapAlignedToGraphGrid(
      shell.boundaryCanvas,
      boundaryLoad.boundaryPayload,
      graph.header,
      {
        colourTheme: resolveIsochroneTheme(),
        viewport: createDefaultMapViewport({ fitBoundingBoxPx: boundaryFitBoundingBoxPx }),
        fitBoundingBoxPx: boundaryFitBoundingBoxPx,
      },
    );
    renderIsochroneLegendIfNeeded(shell, getColourCycleMinutesFromShell(shell));
    updateDistanceScaleBar(shell, graph.header, {
      viewport: createDefaultMapViewport({ fitBoundingBoxPx: boundaryFitBoundingBoxPx }),
      fitBoundingBoxPx: boundaryFitBoundingBoxPx,
    });
    if (shell.exportSvgButton) {
      shell.exportSvgButton.disabled = false;
    }
    fadeOutLoadingOverlay(shell);

    const nodePixels = precomputeNodePixelCoordinates(graph);
    const nodeModeMask = precomputeNodeModeMask(graph);
    const nodeSpatialIndex = createNodeSpatialIndex(graph, nodePixels);
    const pixelGrid = createPixelGrid(graph.header.gridWidthPx, graph.header.gridHeightPx);
    const travelTimeGrid = createTravelTimeGrid(graph.header.gridWidthPx, graph.header.gridHeightPx);
    clearGrid(pixelGrid);
    clearTravelTimeGrid(travelTimeGrid);

    return {
      boundarySummary: boundaryLoad.boundarySummary,
      alignedBoundarySummary,
      boundaryPayload: boundaryLoad.boundaryPayload,
      boundaryFitBoundingBoxPx,
      graph,
      nodePixels,
      nodeModeMask,
      nodeSpatialIndex,
      pixelGrid,
      travelTimeGrid,
      viewport: createDefaultMapViewport({ fitBoundingBoxPx: boundaryFitBoundingBoxPx }),
      edgeCostPrecomputeKernel,
      lastRoutingSnapshot: null,
      locationName,
    };
  } catch (error) {
    if (shell.exportSvgButton) {
      shell.exportSvgButton.disabled = true;
    }
    const failureMessage =
      error && typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : 'Initialization failed.';
    showLoadingOverlay(shell, failureMessage, 0);
    setRoutingStatus(shell, failureMessage);
    throw error;
  }
}

export function layoutMapViewportToContainGraph(shell, graphHeader) {
  if (!shell || !shell.canvasStack) {
    throw new Error('shell.canvasStack is required');
  }

  validateGraphHeaderForBoundaryAlignment(graphHeader);
  const graphAspect = graphHeader.gridWidthPx / graphHeader.gridHeightPx;
  shell.canvasStack.style.setProperty('--map-aspect-ratio', '');
  shell.canvasStack.style.setProperty('--map-aspect-ratio-num', '');
  shell.canvasStack.style.width = '';
  shell.canvasStack.style.height = '';
  shell.canvasStack.style.aspectRatio = '';
  shell.canvasStack.style.transform = '';
  shell.canvasStack.style.transformOrigin = '';

  return {
    aspectRatio: graphAspect,
  };
}







// The SVG export renders content in the unzoomed full-region graph pixel grid
// (1 px = graphHeader.pixelSizeM metres), not the live zoomed screen viewport,
// so the exported scale bar must be sized from that same fixed scale rather
// than copied from the on-screen bar's CSS pixel width.




export function precomputeNodePixelCoordinates(graph) {
  validateGraphForNodePixels(graph);

  if (graph.header.gridWidthPx > 0xffff || graph.header.gridHeightPx > 0xffff) {
    throw new Error('grid dimensions exceed Uint16 capacity for node pixel index arrays');
  }

  const pixelSizeM = graph.header.pixelSizeM;
  if (!(pixelSizeM > 0)) {
    throw new Error('graph header pixelSizeM must be positive');
  }

  const maxX = graph.header.gridWidthPx - 1;
  const maxY = graph.header.gridHeightPx - 1;
  const nodePixelX = new Uint16Array(graph.header.nNodes);
  const nodePixelY = new Uint16Array(graph.header.nNodes);

  for (let nodeIndex = 0; nodeIndex < graph.header.nNodes; nodeIndex += 1) {
    const xM = graph.nodeI32[nodeIndex * 4];
    const yM = graph.nodeI32[nodeIndex * 4 + 1];
    const pxX = Math.floor(xM / pixelSizeM);
    const yCellsFromSouth = Math.floor(yM / pixelSizeM);
    const pxY = maxY - yCellsFromSouth;

    nodePixelX[nodeIndex] = clampInt(pxX, 0, maxX);
    nodePixelY[nodeIndex] = clampInt(pxY, 0, maxY);
  }

  return { nodePixelX, nodePixelY };
}


export function createPixelGrid(widthPx, heightPx) {
  if (!Number.isInteger(widthPx) || widthPx <= 0) {
    throw new Error('pixel grid width must be a positive integer');
  }
  if (!Number.isInteger(heightPx) || heightPx <= 0) {
    throw new Error('pixel grid height must be a positive integer');
  }

  return {
    widthPx,
    heightPx,
    rgba: new Uint8ClampedArray(widthPx * heightPx * 4),
  };
}

export function clearGrid(pixelGrid) {
  validatePixelGrid(pixelGrid);
  for (let i = 3; i < pixelGrid.rgba.length; i += 4) {
    pixelGrid.rgba[i] = 0;
  }
}

export function setPixel(pixelGrid, xPx, yPx, r, g, b, a) {
  validatePixelGrid(pixelGrid);

  if (xPx < 0 || yPx < 0 || xPx >= pixelGrid.widthPx || yPx >= pixelGrid.heightPx) {
    return false;
  }

  const offset = (yPx * pixelGrid.widthPx + xPx) * 4;
  pixelGrid.rgba[offset] = r;
  pixelGrid.rgba[offset + 1] = g;
  pixelGrid.rgba[offset + 2] = b;
  pixelGrid.rgba[offset + 3] = a;
  return true;
}

export function createTravelTimeGrid(widthPx, heightPx) {
  if (!Number.isInteger(widthPx) || widthPx <= 0) {
    throw new Error('travel time grid width must be a positive integer');
  }
  if (!Number.isInteger(heightPx) || heightPx <= 0) {
    throw new Error('travel time grid height must be a positive integer');
  }

  return {
    widthPx,
    heightPx,
    seconds: new Float32Array(widthPx * heightPx),
  };
}

export function clearTravelTimeGrid(travelTimeGrid) {
  validateTravelTimeGrid(travelTimeGrid);
  travelTimeGrid.seconds.fill(-1);
}

export function setTravelTimePixelMin(travelTimeGrid, xPx, yPx, seconds) {
  validateTravelTimeGrid(travelTimeGrid);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return false;
  }
  if (xPx < 0 || yPx < 0 || xPx >= travelTimeGrid.widthPx || yPx >= travelTimeGrid.heightPx) {
    return false;
  }

  const offset = yPx * travelTimeGrid.widthPx + xPx;
  const currentSeconds = travelTimeGrid.seconds[offset];
  if (currentSeconds < 0 || seconds < currentSeconds) {
    travelTimeGrid.seconds[offset] = seconds;
    return true;
  }
  return false;
}

export function rasterizeLinePixels(x0, y0, x1, y1, visitPixel) {
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    throw new Error('line endpoints must be finite numbers');
  }
  if (typeof visitPixel !== 'function') {
    throw new Error('visitPixel must be a function');
  }

  const startX = Math.round(x0);
  const startY = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);

  let x = startX;
  let y = startY;
  const dx = Math.abs(endX - startX);
  const sx = startX < endX ? 1 : -1;
  const dy = -Math.abs(endY - startY);
  const sy = startY < endY ? 1 : -1;
  let err = dx + dy;

  while (true) {
    visitPixel(x, y);
    if (x === endX && y === endY) {
      break;
    }

    const twiceErr = err * 2;
    if (twiceErr >= dy) {
      err += dy;
      x += sx;
    }
    if (twiceErr <= dx) {
      err += dx;
      y += sy;
    }
  }
}

export function interpolateEdgeTravelSeconds(startSeconds, endSeconds, stepIndex, totalSteps) {
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    throw new Error('startSeconds must be a non-negative finite number');
  }
  if (!Number.isFinite(endSeconds) || endSeconds < 0) {
    throw new Error('endSeconds must be a non-negative finite number');
  }
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new Error('stepIndex must be a non-negative integer');
  }
  if (!Number.isInteger(totalSteps) || totalSteps < 0) {
    throw new Error('totalSteps must be a non-negative integer');
  }
  if (stepIndex > totalSteps && totalSteps > 0) {
    throw new Error('stepIndex must be <= totalSteps');
  }

  if (totalSteps === 0) {
    return startSeconds;
  }

  const ratio = stepIndex / totalSteps;
  return startSeconds + (endSeconds - startSeconds) * ratio;
}

export function paintInterpolatedEdgeToGrid(
  pixelGrid,
  x0,
  y0,
  startSeconds,
  x1,
  y1,
  endSeconds,
  options = {},
) {
  validatePixelGrid(pixelGrid);

  const alpha = clampInt(Math.round(options.alpha ?? 255), 0, 255);
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
  const stepStride = options.stepStride ?? 1;
  if (!Number.isInteger(stepStride) || stepStride <= 0) {
    throw new Error('stepStride must be a positive integer');
  }
  const startX = Math.round(x0);
  const startY = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const totalSteps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY));
  let paintedCount = 0;
  let stepIndex = 0;

  rasterizeLinePixels(x0, y0, x1, y1, (xPx, yPx) => {
    if (stepIndex % stepStride !== 0 && stepIndex !== totalSteps) {
      stepIndex += 1;
      return;
    }
    const seconds = interpolateEdgeTravelSeconds(
      startSeconds,
      endSeconds,
      stepIndex,
      totalSteps,
    );
    const [r, g, b] = timeToColour(seconds, {
      cycleMinutes: colourCycleMinutes,
      theme: colourTheme,
    });
    if (setPixel(pixelGrid, xPx, yPx, r, g, b, alpha)) {
      paintedCount += 1;
    }
    stepIndex += 1;
  });

  return paintedCount;
}

export function paintInterpolatedEdgeTravelTimesToGrid(
  travelTimeGrid,
  x0,
  y0,
  startSeconds,
  x1,
  y1,
  endSeconds,
  options = {},
) {
  validateTravelTimeGrid(travelTimeGrid);

  const stepStride = options.stepStride ?? 1;
  if (!Number.isInteger(stepStride) || stepStride <= 0) {
    throw new Error('stepStride must be a positive integer');
  }
  const startX = Math.round(x0);
  const startY = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const totalSteps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY));
  let paintedCount = 0;
  let stepIndex = 0;

  rasterizeLinePixels(x0, y0, x1, y1, (xPx, yPx) => {
    if (stepIndex % stepStride !== 0 && stepIndex !== totalSteps) {
      stepIndex += 1;
      return;
    }
    const seconds = interpolateEdgeTravelSeconds(
      startSeconds,
      endSeconds,
      stepIndex,
      totalSteps,
    );
    if (setTravelTimePixelMin(travelTimeGrid, xPx, yPx, seconds)) {
      paintedCount += 1;
    }
    stepIndex += 1;
  });

  return paintedCount;
}

export function paintReachableNodesToGrid(pixelGrid, nodePixels, distSeconds, options = {}) {
  validatePixelGrid(pixelGrid);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
  let paintedCount = 0;

  for (let nodeIndex = 0; nodeIndex < nodePixels.nodePixelX.length; nodeIndex += 1) {
    if (distSeconds[nodeIndex] < Infinity) {
      const [r, g, b] = timeToColour(distSeconds[nodeIndex], {
        cycleMinutes: colourCycleMinutes,
        theme: colourTheme,
      });
      const xPx = nodePixels.nodePixelX[nodeIndex];
      const yPx = nodePixels.nodePixelY[nodeIndex];
      if (setPixel(pixelGrid, xPx, yPx, r, g, b, alpha)) {
        paintedCount += 1;
      }
    }
  }

  return paintedCount;
}

export function paintReachableNodesTravelTimesToGrid(travelTimeGrid, nodePixels, distSeconds) {
  validateTravelTimeGrid(travelTimeGrid);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);

  let paintedCount = 0;
  for (let nodeIndex = 0; nodeIndex < nodePixels.nodePixelX.length; nodeIndex += 1) {
    if (distSeconds[nodeIndex] < Infinity) {
      const xPx = nodePixels.nodePixelX[nodeIndex];
      const yPx = nodePixels.nodePixelY[nodeIndex];
      if (setTravelTimePixelMin(travelTimeGrid, xPx, yPx, distSeconds[nodeIndex])) {
        paintedCount += 1;
      }
    }
  }

  return paintedCount;
}

















export function clearRenderedIsochrone(shell, mapData = null) {
  if (!shell || typeof shell !== 'object' || !shell.isochroneCanvas) {
    throw new Error('shell.isochroneCanvas is required');
  }

  const renderer = getOrCreateIsochroneRenderer(shell.isochroneCanvas);
  if (typeof renderer.clear === 'function') {
    renderer.clear();
  }

  if (mapData && typeof mapData === 'object') {
    if (mapData.pixelGrid) {
      clearGrid(mapData.pixelGrid);
    }
    if (mapData.travelTimeGrid) {
      clearTravelTimeGrid(mapData.travelTimeGrid);
    }
    mapData.lastRoutingSnapshot = null;
  }
}

export function renderReachableNodes(shell, mapData, distSeconds, options = {}) {
  if (!mapData || typeof mapData !== 'object') {
    throw new Error('mapData must be an object');
  }

  clearGrid(mapData.pixelGrid);
  const paintedNodeCount = paintReachableNodesToGrid(
    mapData.pixelGrid,
    mapData.nodePixels,
    distSeconds,
    options,
  );
  blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, {
    viewport: mapData.viewport,
    fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
  });
  return paintedNodeCount;
}

export function paintSettledBatchToGrid(pixelGrid, nodePixels, distSeconds, settledBatch, options = {}) {
  validatePixelGrid(pixelGrid);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  validateSettledBatch(settledBatch);

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
  let paintedCount = 0;

  for (const nodeIndex of settledBatch) {
    if (nodeIndex < 0 || nodeIndex >= nodePixels.nodePixelX.length) {
      continue;
    }
    if (!(distSeconds[nodeIndex] < Infinity)) {
      continue;
    }

    const [r, g, b] = timeToColour(distSeconds[nodeIndex], {
      cycleMinutes: colourCycleMinutes,
      theme: colourTheme,
    });
    const xPx = nodePixels.nodePixelX[nodeIndex];
    const yPx = nodePixels.nodePixelY[nodeIndex];
    if (setPixel(pixelGrid, xPx, yPx, r, g, b, alpha)) {
      paintedCount += 1;
    }
  }

  return paintedCount;
}

function forEachEligibleOutgoingEdgeFromSourceNode(
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  edgeSlackSeconds,
  edgeTraversalCostSeconds,
  onEligibleEdge,
) {
  if (typeof onEligibleEdge !== 'function') {
    throw new Error('onEligibleEdge must be a function');
  }
  if (sourceNodeIndex < 0 || sourceNodeIndex >= graph.header.nNodes) {
    return 0;
  }

  const startSeconds = distSeconds[sourceNodeIndex];
  if (!Number.isFinite(startSeconds)) {
    return 0;
  }

  let totalContribution = 0;
  const x0 = nodePixels.nodePixelX[sourceNodeIndex];
  const y0 = nodePixels.nodePixelY[sourceNodeIndex];
  const firstEdgeIndex = graph.nodeU32[sourceNodeIndex * 4 + 2];
  const edgeCount = graph.nodeU16[sourceNodeIndex * 8 + 6];
  const endEdgeIndex = firstEdgeIndex + edgeCount;

  for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
    if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
      continue;
    }

    const edgeCostSeconds = getEdgeTraversalCostSeconds(
      graph,
      edgeIndex,
      allowedModeMask,
      edgeTraversalCostSeconds,
    );
    if (!Number.isFinite(edgeCostSeconds) || edgeCostSeconds <= 0) {
      continue;
    }

    const targetNodeIndex = graph.edgeU32[edgeIndex * 3];
    if (targetNodeIndex < 0 || targetNodeIndex >= graph.header.nNodes) {
      continue;
    }

    const targetSeconds = distSeconds[targetNodeIndex];
    if (!Number.isFinite(targetSeconds)) {
      continue;
    }

    const expectedTargetSeconds = startSeconds + edgeCostSeconds;
    if (expectedTargetSeconds > targetSeconds + edgeSlackSeconds) {
      continue;
    }

    const x1 = nodePixels.nodePixelX[targetNodeIndex];
    const y1 = nodePixels.nodePixelY[targetNodeIndex];
    const callbackContribution = onEligibleEdge(
      x0,
      y0,
      startSeconds,
      x1,
      y1,
      expectedTargetSeconds,
      targetNodeIndex,
      edgeIndex,
    );
    if (Number.isFinite(callbackContribution)) {
      totalContribution += callbackContribution;
    }
  }

  return totalContribution;
}

function paintEligibleOutgoingEdgesFromSourceNode(
  pixelGrid,
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  alpha,
  colourCycleMinutes,
  colourTheme,
  edgeSlackSeconds,
  stepStride,
  edgeTraversalCostSeconds,
) {
  return forEachEligibleOutgoingEdgeFromSourceNode(
    graph,
    nodePixels,
    distSeconds,
    sourceNodeIndex,
    allowedModeMask,
    edgeSlackSeconds,
    edgeTraversalCostSeconds,
    (x0, y0, startSeconds, x1, y1, expectedTargetSeconds) =>
      paintInterpolatedEdgeToGrid(
        pixelGrid,
        x0,
        y0,
        startSeconds,
        x1,
        y1,
        expectedTargetSeconds,
        { alpha, colourCycleMinutes, colourTheme, stepStride },
      ),
  );
}

export function paintSettledBatchEdgeInterpolationsToGrid(
  pixelGrid,
  graph,
  nodePixels,
  distSeconds,
  settledBatch,
  allowedModeMask,
  options = {},
) {
  validatePixelGrid(pixelGrid);
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  validateSettledBatch(settledBatch);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
  const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
  const stepStride = options.stepStride ?? 1;
  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    options.edgeTraversalCostSeconds,
    graph.header.nEdges,
  );
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }
  if (!Number.isInteger(stepStride) || stepStride <= 0) {
    throw new Error('stepStride must be a positive integer');
  }

  let paintedCount = 0;

  for (const sourceNodeIndex of settledBatch) {
    paintedCount += paintEligibleOutgoingEdgesFromSourceNode(
      pixelGrid,
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      alpha,
      colourCycleMinutes,
      colourTheme,
      edgeSlackSeconds,
      stepStride,
      edgeTraversalCostSeconds,
    );
  }

  return paintedCount;
}

export function paintAllReachableEdgeInterpolationsToGrid(
  pixelGrid,
  graph,
  nodePixels,
  distSeconds,
  allowedModeMask,
  options = {},
) {
  validatePixelGrid(pixelGrid);
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
  const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
  const stepStride = options.stepStride ?? 1;
  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    options.edgeTraversalCostSeconds,
    graph.header.nEdges,
  );
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }
  if (!Number.isInteger(stepStride) || stepStride <= 0) {
    throw new Error('stepStride must be a positive integer');
  }

  let paintedCount = 0;
  for (let sourceNodeIndex = 0; sourceNodeIndex < graph.header.nNodes; sourceNodeIndex += 1) {
    paintedCount += paintEligibleOutgoingEdgesFromSourceNode(
      pixelGrid,
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      alpha,
      colourCycleMinutes,
      colourTheme,
      edgeSlackSeconds,
      stepStride,
      edgeTraversalCostSeconds,
    );
  }

  return paintedCount;
}

export function paintSettledBatchTravelTimesToGrid(
  travelTimeGrid,
  nodePixels,
  distSeconds,
  settledBatch,
) {
  validateTravelTimeGrid(travelTimeGrid);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  validateSettledBatch(settledBatch);

  let paintedCount = 0;
  for (const nodeIndex of settledBatch) {
    if (nodeIndex < 0 || nodeIndex >= nodePixels.nodePixelX.length) {
      continue;
    }
    if (!(distSeconds[nodeIndex] < Infinity)) {
      continue;
    }
    const xPx = nodePixels.nodePixelX[nodeIndex];
    const yPx = nodePixels.nodePixelY[nodeIndex];
    if (setTravelTimePixelMin(travelTimeGrid, xPx, yPx, distSeconds[nodeIndex])) {
      paintedCount += 1;
    }
  }
  return paintedCount;
}

function paintEligibleOutgoingEdgesFromSourceNodeToTravelTimeGrid(
  travelTimeGrid,
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  edgeSlackSeconds,
  stepStride,
  edgeTraversalCostSeconds,
) {
  return forEachEligibleOutgoingEdgeFromSourceNode(
    graph,
    nodePixels,
    distSeconds,
    sourceNodeIndex,
    allowedModeMask,
    edgeSlackSeconds,
    edgeTraversalCostSeconds,
    (x0, y0, startSeconds, x1, y1, expectedTargetSeconds) =>
      paintInterpolatedEdgeTravelTimesToGrid(
        travelTimeGrid,
        x0,
        y0,
        startSeconds,
        x1,
        y1,
        expectedTargetSeconds,
        { stepStride },
      ),
  );
}

export function paintSettledBatchEdgeInterpolationsToTravelTimeGrid(
  travelTimeGrid,
  graph,
  nodePixels,
  distSeconds,
  settledBatch,
  allowedModeMask,
  options = {},
) {
  validateTravelTimeGrid(travelTimeGrid);
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  validateSettledBatch(settledBatch);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
  const stepStride = options.stepStride ?? 1;
  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    options.edgeTraversalCostSeconds,
    graph.header.nEdges,
  );
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }
  if (!Number.isInteger(stepStride) || stepStride <= 0) {
    throw new Error('stepStride must be a positive integer');
  }

  let paintedCount = 0;
  for (const sourceNodeIndex of settledBatch) {
    paintedCount += paintEligibleOutgoingEdgesFromSourceNodeToTravelTimeGrid(
      travelTimeGrid,
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      edgeSlackSeconds,
      stepStride,
      edgeTraversalCostSeconds,
    );
  }
  return paintedCount;
}

export function paintAllReachableEdgeInterpolationsToTravelTimeGrid(
  travelTimeGrid,
  graph,
  nodePixels,
  distSeconds,
  allowedModeMask,
  options = {},
) {
  validateTravelTimeGrid(travelTimeGrid);
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
  const stepStride = options.stepStride ?? 1;
  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    options.edgeTraversalCostSeconds,
    graph.header.nEdges,
  );
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }
  if (!Number.isInteger(stepStride) || stepStride <= 0) {
    throw new Error('stepStride must be a positive integer');
  }

  let paintedCount = 0;
  for (let sourceNodeIndex = 0; sourceNodeIndex < graph.header.nNodes; sourceNodeIndex += 1) {
    paintedCount += paintEligibleOutgoingEdgesFromSourceNodeToTravelTimeGrid(
      travelTimeGrid,
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      edgeSlackSeconds,
      stepStride,
      edgeTraversalCostSeconds,
    );
  }
  return paintedCount;
}

function createEdgeVertexBufferBuilder(initialCapacityFloats = 32768) {
  if (!Number.isInteger(initialCapacityFloats) || initialCapacityFloats <= 0) {
    throw new Error('initialCapacityFloats must be a positive integer');
  }
  return {
    data: new Float32Array(initialCapacityFloats),
    length: 0,
  };
}

function validateEdgeVertexBufferBuilder(builder) {
  if (!builder || typeof builder !== 'object') {
    throw new Error('builder must be an object');
  }
  if (!(builder.data instanceof Float32Array)) {
    throw new Error('builder.data must be a Float32Array');
  }
  if (!Number.isInteger(builder.length) || builder.length < 0 || builder.length > builder.data.length) {
    throw new Error('builder.length must be a valid index within builder.data');
  }
}

function resetEdgeVertexBufferBuilder(builder) {
  validateEdgeVertexBufferBuilder(builder);
  builder.length = 0;
  return builder;
}

function ensureEdgeVertexBufferBuilderCapacity(builder, requiredLength) {
  validateEdgeVertexBufferBuilder(builder);
  if (builder.data.length >= requiredLength) {
    return;
  }
  let nextLength = builder.data.length;
  while (nextLength < requiredLength) {
    nextLength *= 2;
  }
  const nextData = new Float32Array(nextLength);
  nextData.set(builder.data.subarray(0, builder.length));
  builder.data = nextData;
}

function appendEdgeVertexSegment(builder, x0, y0, t0, x1, y1, t1) {
  ensureEdgeVertexBufferBuilderCapacity(builder, builder.length + 6);
  const offset = builder.length;
  builder.data[offset] = x0;
  builder.data[offset + 1] = y0;
  builder.data[offset + 2] = t0;
  builder.data[offset + 3] = x1;
  builder.data[offset + 4] = y1;
  builder.data[offset + 5] = t1;
  builder.length += 6;
}

function finalizeEdgeVertexBufferBuilder(builder) {
  validateEdgeVertexBufferBuilder(builder);
  return builder.data.subarray(0, builder.length);
}

function collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  edgeSlackSeconds,
  edgeVertexBuilder,
  edgeTraversalCostSeconds,
) {
  return forEachEligibleOutgoingEdgeFromSourceNode(
    graph,
    nodePixels,
    distSeconds,
    sourceNodeIndex,
    allowedModeMask,
    edgeSlackSeconds,
    edgeTraversalCostSeconds,
    (x0, y0, startSeconds, x1, y1, expectedTargetSeconds) => {
      appendEdgeVertexSegment(
        edgeVertexBuilder,
        x0,
        y0,
        startSeconds,
        x1,
        y1,
        expectedTargetSeconds,
      );
      return 1;
    },
  );
}

export function collectSettledBatchTravelTimeEdgeVertices(
  graph,
  nodePixels,
  distSeconds,
  settledBatch,
  allowedModeMask,
  options = {},
) {
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  validateSettledBatch(settledBatch);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    options.edgeTraversalCostSeconds,
    graph.header.nEdges,
  );
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }

  const builder = resetEdgeVertexBufferBuilder(options.builder ?? createEdgeVertexBufferBuilder());
  for (const sourceNodeIndex of settledBatch) {
    collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      edgeSlackSeconds,
      builder,
      edgeTraversalCostSeconds,
    );
  }

  return finalizeEdgeVertexBufferBuilder(builder);
}

export function collectAllReachableTravelTimeEdgeVertices(
  graph,
  nodePixels,
  distSeconds,
  allowedModeMask,
  options = {},
) {
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    options.edgeTraversalCostSeconds,
    graph.header.nEdges,
  );
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }

  const builder = resetEdgeVertexBufferBuilder(options.builder ?? createEdgeVertexBufferBuilder());
  for (let sourceNodeIndex = 0; sourceNodeIndex < graph.header.nNodes; sourceNodeIndex += 1) {
    collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      edgeSlackSeconds,
      builder,
      edgeTraversalCostSeconds,
    );
  }

  return finalizeEdgeVertexBufferBuilder(builder);
}

export async function runSearchTimeSliced(searchState, options = {}) {
  validateSearchState(searchState);

  const sliceBudgetMs = options.sliceBudgetMs ?? 33;
  const frameYieldIntervalSlices = options.frameYieldIntervalSlices ?? 1;
  const onSlice = options.onSlice ?? (() => {});
  const isCancelled = options.isCancelled ?? (() => false);
  const onExpandOneTimingMs = options.onExpandOneTimingMs ?? null;
  const onAnimationFrameWaitTimingMs = options.onAnimationFrameWaitTimingMs ?? null;
  const nowImpl = options.nowImpl ?? defaultNowMs;
  const requestAnimationFrameImpl = options.requestAnimationFrameImpl ?? globalThis.requestAnimationFrame;

  if (!Number.isFinite(sliceBudgetMs) || sliceBudgetMs <= 0) {
    throw new Error('sliceBudgetMs must be a positive finite number');
  }
  if (!Number.isInteger(frameYieldIntervalSlices) || frameYieldIntervalSlices <= 0) {
    throw new Error('frameYieldIntervalSlices must be a positive integer');
  }
  if (typeof onSlice !== 'function') {
    throw new Error('onSlice must be a function');
  }
  if (typeof isCancelled !== 'function') {
    throw new Error('isCancelled must be a function');
  }
  if (onExpandOneTimingMs !== null && typeof onExpandOneTimingMs !== 'function') {
    throw new Error('onExpandOneTimingMs must be a function when provided');
  }
  if (onAnimationFrameWaitTimingMs !== null && typeof onAnimationFrameWaitTimingMs !== 'function') {
    throw new Error('onAnimationFrameWaitTimingMs must be a function when provided');
  }
  if (typeof nowImpl !== 'function') {
    throw new Error('nowImpl must be a function');
  }

  let totalSettledCount = 0;
  let sliceCount = 0;
  let cancelled = false;
  let slicesSinceLastFrameYield = 0;

  while (!isDone(searchState)) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }

    const settledBatch = [];
    const sliceStartMs = nowImpl();
    let elapsedMs = 0;

    while (elapsedMs < sliceBudgetMs && !isDone(searchState)) {
      if (isCancelled()) {
        cancelled = true;
        break;
      }

      const expandStartMs = onExpandOneTimingMs ? nowImpl() : 0;
      const settledNodeIndex = searchState.expandOne();
      if (onExpandOneTimingMs) {
        onExpandOneTimingMs(Math.max(0, nowImpl() - expandStartMs));
      }
      if (Number.isInteger(settledNodeIndex) && settledNodeIndex >= 0) {
        settledBatch.push(settledNodeIndex);
        totalSettledCount += 1;
      }

      elapsedMs = nowImpl() - sliceStartMs;
    }

    if (!cancelled && isCancelled()) {
      cancelled = true;
    }
    if (cancelled) {
      break;
    }

    onSlice(settledBatch);
    sliceCount += 1;

    if (!isDone(searchState)) {
      slicesSinceLastFrameYield += 1;
      if (slicesSinceLastFrameYield >= frameYieldIntervalSlices) {
        const waitStartMs = onAnimationFrameWaitTimingMs ? nowImpl() : 0;
        await waitForAnimationFrame(requestAnimationFrameImpl);
        if (onAnimationFrameWaitTimingMs) {
          onAnimationFrameWaitTimingMs(Math.max(0, nowImpl() - waitStartMs));
        }
        slicesSinceLastFrameYield = 0;
      }
    }
  }

  return {
    totalSettledCount,
    sliceCount,
    cancelled,
  };
}

function renderInitialPassByBackend(renderContext) {
  const {
    incrementalRender,
    supportsGpuEdgeInterpolation,
    supportsGpuTravelTimeRendering,
    renderer,
    shell,
    mapData,
    viewport,
  } = renderContext;
  if (!incrementalRender) {
    return;
  }

  if (supportsGpuEdgeInterpolation) {
    renderer.clear();
  } else if (supportsGpuTravelTimeRendering) {
    clearTravelTimeGrid(mapData.travelTimeGrid);
    renderer.drawTravelTimeGrid(mapData.travelTimeGrid, {
      cycleMinutes: getColourCycleMinutesFromShell(shell),
      colourTheme: renderContext.colourTheme,
      viewport,
      fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
    });
  } else {
    clearGrid(mapData.pixelGrid);
    blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, {
      viewport,
      fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
    });
  }
}

function renderIncrementalSliceByBackend(renderContext, settledBatch, settledNodeCount, paintCounts) {
  const {
    incrementalRender,
    supportsGpuEdgeInterpolation,
    supportsGpuTravelTimeRendering,
    profileMs,
    searchState,
    mapData,
    allowedModeMask,
    edgeVertexBuilder,
    edgeTraversalCostSeconds,
    renderer,
    colourCycleMinutes,
    colourTheme,
    interactiveEdgeStepStride,
    alpha,
    shell,
    viewport,
  } = renderContext;
  let { paintedNodeCount, paintedEdgeCount } = paintCounts;
  if (!incrementalRender) {
    return { paintedNodeCount, paintedEdgeCount };
  }

  if (supportsGpuEdgeInterpolation) {
    const batchEdgeVertices = profileMs('onSliceCollectMs', () =>
      collectSettledBatchTravelTimeEdgeVertices(
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        settledBatch,
        allowedModeMask,
        {
          builder: edgeVertexBuilder,
          edgeTraversalCostSeconds,
        },
      ),
    );
    paintedEdgeCount += profileMs('onSliceDrawMs', () =>
      renderer.drawTravelTimeEdges(batchEdgeVertices, {
        cycleMinutes: colourCycleMinutes,
        colourTheme,
        append: true,
        graphWidthPx: searchState.graph.header.gridWidthPx,
        graphHeightPx: searchState.graph.header.gridHeightPx,
        viewport,
        fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
      }),
    );
    paintedNodeCount = settledNodeCount;
  } else if (supportsGpuTravelTimeRendering) {
    paintedEdgeCount += profileMs('onSlicePaintMs', () =>
      paintSettledBatchEdgeInterpolationsToTravelTimeGrid(
        mapData.travelTimeGrid,
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        settledBatch,
        allowedModeMask,
        {
          stepStride: interactiveEdgeStepStride,
          edgeTraversalCostSeconds,
        },
      ),
    );
    paintedNodeCount += profileMs('onSlicePaintMs', () =>
      paintSettledBatchTravelTimesToGrid(
        mapData.travelTimeGrid,
        mapData.nodePixels,
        searchState.distSeconds,
        settledBatch,
      ),
    );
    profileMs('onSliceDrawMs', () =>
      renderer.drawTravelTimeGrid(mapData.travelTimeGrid, {
        cycleMinutes: colourCycleMinutes,
        colourTheme,
        viewport,
        fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
      }),
    );
  } else {
    paintedEdgeCount += profileMs('onSlicePaintMs', () =>
      paintSettledBatchEdgeInterpolationsToGrid(
        mapData.pixelGrid,
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        settledBatch,
        allowedModeMask,
        {
          alpha,
          colourCycleMinutes,
          colourTheme,
          stepStride: interactiveEdgeStepStride,
          edgeTraversalCostSeconds,
        },
      ),
    );
    paintedNodeCount += profileMs('onSlicePaintMs', () =>
      paintSettledBatchToGrid(
        mapData.pixelGrid,
        mapData.nodePixels,
        searchState.distSeconds,
        settledBatch,
        { alpha, colourCycleMinutes, colourTheme },
      ),
    );
    profileMs('onSliceDrawMs', () =>
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, {
        viewport,
        fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
      }),
    );
  }

  return { paintedNodeCount, paintedEdgeCount };
}

function renderFinalPassByBackend(renderContext, paintCounts) {
  const {
    supportsGpuEdgeInterpolation,
    supportsGpuTravelTimeRendering,
    profileMs,
    searchState,
    mapData,
    allowedModeMask,
    edgeTraversalCostSeconds,
    renderer,
    colourCycleMinutes,
    colourTheme,
    finalEdgeStepStride,
    alpha,
    shell,
    viewport,
  } = renderContext;
  let { paintedNodeCount, paintedEdgeCount } = paintCounts;
  let edgeVertexData = null;

  if (supportsGpuEdgeInterpolation) {
    const supportsGpuIndexedEdgeInterpolation =
      typeof renderer.drawTravelTimeEdgesFromNodeTimes === 'function';
    if (supportsGpuIndexedEdgeInterpolation) {
      const edgeNodeIndexedVertexData = profileMs('finalCollectMs', () =>
        getOrBuildStaticEdgeNodeIndexedVertexDataForModeFromMapData(
          mapData,
          allowedModeMask,
          edgeTraversalCostSeconds,
        ),
      );
      paintedEdgeCount = profileMs('finalDrawMs', () =>
        renderer.drawTravelTimeEdgesFromNodeTimes(
          edgeNodeIndexedVertexData,
          searchState.distSeconds,
          {
            cycleMinutes: colourCycleMinutes,
            colourTheme,
            append: false,
            reuseUploadedGeometry: true,
            graphWidthPx: searchState.graph.header.gridWidthPx,
            graphHeightPx: searchState.graph.header.gridHeightPx,
            edgeSlackSeconds: EDGE_INTERPOLATION_SLACK_SECONDS,
            viewport,
            fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
          },
        ),
      );
      edgeVertexData = null;
    } else {
      const edgeTemplate = profileMs('finalCollectMs', () =>
        getOrBuildStaticEdgeVertexTemplateForModeFromMapData(
          mapData,
          allowedModeMask,
          edgeTraversalCostSeconds,
        ),
      );
      paintedEdgeCount = profileMs('finalCollectMs', () =>
        updateTravelTimesInStaticEdgeVertexTemplate(
          edgeTemplate,
          searchState.distSeconds,
          edgeTraversalCostSeconds,
          {
            edgeSlackSeconds: EDGE_INTERPOLATION_SLACK_SECONDS,
          },
        ),
      );
      edgeVertexData = edgeTemplate.edgeVertexData;
      profileMs('finalDrawMs', () =>
        renderer.drawTravelTimeEdges(edgeVertexData, {
          cycleMinutes: colourCycleMinutes,
          colourTheme,
          append: false,
          graphWidthPx: searchState.graph.header.gridWidthPx,
          graphHeightPx: searchState.graph.header.gridHeightPx,
          viewport,
          fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
        }),
      );
    }
    if (
      Number.isInteger(searchState.settledCount)
      && searchState.settledCount >= 0
    ) {
      paintedNodeCount = searchState.settledCount;
    } else {
      paintedNodeCount = countFiniteTravelTimes(searchState.distSeconds);
    }
  } else if (supportsGpuTravelTimeRendering) {
    profileMs('finalDrawMs', () => {
      clearTravelTimeGrid(mapData.travelTimeGrid);
    });
    paintedEdgeCount = profileMs('finalPaintMs', () =>
      paintAllReachableEdgeInterpolationsToTravelTimeGrid(
        mapData.travelTimeGrid,
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        allowedModeMask,
        {
          stepStride: finalEdgeStepStride,
          edgeTraversalCostSeconds,
        },
      ),
    );
    paintedNodeCount = profileMs('finalPaintMs', () =>
      paintReachableNodesTravelTimesToGrid(
        mapData.travelTimeGrid,
        mapData.nodePixels,
        searchState.distSeconds,
      ),
    );
    profileMs('finalDrawMs', () =>
      renderer.drawTravelTimeGrid(mapData.travelTimeGrid, {
        cycleMinutes: colourCycleMinutes,
        colourTheme,
        viewport,
        fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
      }),
    );
  } else {
    profileMs('finalDrawMs', () => {
      clearGrid(mapData.pixelGrid);
    });
    paintedEdgeCount = profileMs('finalPaintMs', () =>
      paintAllReachableEdgeInterpolationsToGrid(
        mapData.pixelGrid,
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        allowedModeMask,
        {
          alpha,
          colourCycleMinutes,
          colourTheme,
          stepStride: finalEdgeStepStride,
          edgeTraversalCostSeconds,
        },
      ),
    );
    paintedNodeCount = profileMs('finalPaintMs', () =>
      paintReachableNodesToGrid(
        mapData.pixelGrid,
        mapData.nodePixels,
        searchState.distSeconds,
        { alpha, colourCycleMinutes, colourTheme },
      ),
    );
    profileMs('finalDrawMs', () =>
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, {
        viewport,
        fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
      }),
    );
  }

  return { paintedNodeCount, paintedEdgeCount, edgeVertexData };
}

export async function runSearchTimeSlicedWithRendering(shell, mapData, searchState, options = {}) {
  if (!shell || !shell.isochroneCanvas) {
    throw new Error('shell.isochroneCanvas is required');
  }
  if (!shell.routingStatus) {
    throw new Error('shell.routingStatus is required');
  }
  if (!mapData || typeof mapData !== 'object') {
    throw new Error('mapData must be an object');
  }

  const renderer = getOrCreateIsochroneRenderer(shell.isochroneCanvas);
  updateRenderBackendBadge(shell, renderer);
  const allowedModeMask = searchState.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  const supportsGpuEdgeInterpolation = typeof renderer.drawTravelTimeEdges === 'function';
  const supportsGpuTravelTimeRendering = typeof renderer.drawTravelTimeGrid === 'function';
  if (supportsGpuTravelTimeRendering && !mapData.travelTimeGrid) {
    throw new Error('mapData.travelTimeGrid is required for GPU travel-time rendering');
  }

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(
    options.colourTheme ?? resolveIsochroneTheme(),
    'dark',
  );
  const edgeTraversalCostSeconds = searchState.edgeTraversalCostSeconds;
  const nowImpl = options.nowImpl ?? defaultNowMs;
  const statusUpdateIntervalMs = options.statusUpdateIntervalMs ?? 120;
  const skipFinalFullPass = options.skipFinalFullPass ?? false;
  const incrementalRender = options.incrementalRender ?? false;
  const fullPassFrameYieldIntervalSlices = options.fullPassFrameYieldIntervalSlices ?? 2;
  const normalizedFrameYieldIntervalSlices = skipFinalFullPass ? 1 : fullPassFrameYieldIntervalSlices;
  const interactiveEdgeStepStride =
    options.interactiveEdgeStepStride ?? INTERACTIVE_EDGE_INTERPOLATION_STEP_STRIDE;
  const finalEdgeStepStride = options.finalEdgeStepStride ?? FINAL_EDGE_INTERPOLATION_STEP_STRIDE;
  const paritySampleCount = options.gpuParitySampleCount ?? 0;
  const onSliceExternal = options.onSlice;
  const onExpandOneTimingExternal = options.onExpandOneTimingMs ?? null;
  const onAnimationFrameWaitTimingExternal = options.onAnimationFrameWaitTimingMs ?? null;
  const edgeVertexBuilder = createEdgeVertexBufferBuilder();
  let paintedNodeCount = 0;
  let paintedEdgeCount = 0;
  let finalEdgeVertexData = null;
  let settledNodeCount = 0;
  if (typeof nowImpl !== 'function') {
    throw new Error('nowImpl must be a function');
  }
  if (!Number.isFinite(statusUpdateIntervalMs) || statusUpdateIntervalMs < 0) {
    throw new Error('statusUpdateIntervalMs must be a non-negative finite number');
  }
  if (typeof skipFinalFullPass !== 'boolean') {
    throw new Error('skipFinalFullPass must be a boolean');
  }
  if (typeof incrementalRender !== 'boolean') {
    throw new Error('incrementalRender must be a boolean');
  }
  if (
    !Number.isInteger(fullPassFrameYieldIntervalSlices)
    || fullPassFrameYieldIntervalSlices <= 0
  ) {
    throw new Error('fullPassFrameYieldIntervalSlices must be a positive integer');
  }
  if (onExpandOneTimingExternal !== null && typeof onExpandOneTimingExternal !== 'function') {
    throw new Error('options.onExpandOneTimingMs must be a function when provided');
  }
  if (
    onAnimationFrameWaitTimingExternal !== null
    && typeof onAnimationFrameWaitTimingExternal !== 'function'
  ) {
    throw new Error('options.onAnimationFrameWaitTimingMs must be a function when provided');
  }
  const normalizedStatusUpdateIntervalMs = Math.round(statusUpdateIntervalMs);
  const routingProfileEnabled = isRoutingProfilingEnabled(options.profile);
  const routingProfile = routingProfileEnabled
    ? {
        initialPassMs: 0,
        searchExpandMs: 0,
        searchFrameWaitMs: 0,
        onSliceCollectMs: 0,
        onSlicePaintMs: 0,
        onSliceDrawMs: 0,
        finalCollectMs: 0,
        finalPaintMs: 0,
        finalDrawMs: 0,
        parityDiagnosticMs: 0,
      }
    : null;
  const profileMs = (field, callback) => {
    if (!routingProfileEnabled || routingProfile === null) {
      return callback();
    }
    const startedMs = nowImpl();
    try {
      return callback();
    } finally {
      routingProfile[field] += Math.max(0, nowImpl() - startedMs);
    }
  };
  const renderContext = {
    shell,
    mapData,
    searchState,
    renderer,
    supportsGpuEdgeInterpolation,
    supportsGpuTravelTimeRendering,
    incrementalRender,
    profileMs,
    allowedModeMask,
    edgeVertexBuilder,
    edgeTraversalCostSeconds,
    colourCycleMinutes,
    colourTheme,
    interactiveEdgeStepStride,
    finalEdgeStepStride,
    alpha,
    viewport: options.viewport ?? mapData.viewport,
  };

  profileMs('initialPassMs', () => {
    renderInitialPassByBackend(renderContext);
  });
  setRoutingStatus(
    shell,
    formatRoutingStatusCalculating(0, { messages: getShellLocaleMessages(shell) }),
  );

  const routeStartMs = nowImpl();
  let lastStatusUpdateMs = routeStartMs;

  const runSummary = await runSearchTimeSliced(searchState, {
    ...options,
    frameYieldIntervalSlices: normalizedFrameYieldIntervalSlices,
    onExpandOneTimingMs:
      routingProfileEnabled || typeof onExpandOneTimingExternal === 'function'
        ? (elapsedMs) => {
            if (routingProfileEnabled) {
              routingProfile.searchExpandMs += elapsedMs;
            }
            if (typeof onExpandOneTimingExternal === 'function') {
              onExpandOneTimingExternal(elapsedMs);
            }
          }
        : onExpandOneTimingExternal,
    onAnimationFrameWaitTimingMs:
      routingProfileEnabled || typeof onAnimationFrameWaitTimingExternal === 'function'
        ? (elapsedMs) => {
            if (routingProfileEnabled) {
              routingProfile.searchFrameWaitMs += elapsedMs;
            }
            if (typeof onAnimationFrameWaitTimingExternal === 'function') {
              onAnimationFrameWaitTimingExternal(elapsedMs);
            }
          }
        : onAnimationFrameWaitTimingExternal,
    onSlice(settledBatch) {
      settledNodeCount += settledBatch.length;
      const incrementalPaintCounts = renderIncrementalSliceByBackend(
        renderContext,
        settledBatch,
        settledNodeCount,
        {
          paintedNodeCount,
          paintedEdgeCount,
        },
      );
      paintedNodeCount = incrementalPaintCounts.paintedNodeCount;
      paintedEdgeCount = incrementalPaintCounts.paintedEdgeCount;
      if (normalizedStatusUpdateIntervalMs <= 0) {
        setRoutingStatus(
          shell,
          formatRoutingStatusCalculating(settledNodeCount, {
            messages: getShellLocaleMessages(shell),
          }),
        );
        lastStatusUpdateMs = nowImpl();
      } else {
        const nowMs = nowImpl();
        if (nowMs - lastStatusUpdateMs >= statusUpdateIntervalMs) {
          setRoutingStatus(
            shell,
            formatRoutingStatusCalculating(settledNodeCount, {
              messages: getShellLocaleMessages(shell),
            }),
          );
          lastStatusUpdateMs = nowMs;
        }
      }

      if (typeof onSliceExternal === 'function') {
        onSliceExternal(settledBatch);
      }
    },
  });
  if (
    Number.isInteger(searchState.settledCount)
    && searchState.settledCount >= 0
    && searchState.settledCount >= settledNodeCount
  ) {
    settledNodeCount = searchState.settledCount;
  }
  const routeElapsedMs = Math.max(0, Math.round(nowImpl() - routeStartMs));

  if (!runSummary.cancelled) {
    if (!skipFinalFullPass) {
      const finalPaintCounts = renderFinalPassByBackend(renderContext, {
        paintedNodeCount,
        paintedEdgeCount,
      });
      paintedNodeCount = finalPaintCounts.paintedNodeCount;
      paintedEdgeCount = finalPaintCounts.paintedEdgeCount;
      finalEdgeVertexData = finalPaintCounts.edgeVertexData;
    }

    if (!skipFinalFullPass && supportsGpuEdgeInterpolation && paritySampleCount > 0) {
      const parityResult = profileMs('parityDiagnosticMs', () =>
        runGpuCpuParityDiagnostic(
          renderer,
          mapData,
          searchState,
          {
            allowedModeMask,
            cycleMinutes: colourCycleMinutes,
            colourTheme,
            alpha,
            stepStride: finalEdgeStepStride,
            sampleCount: paritySampleCount,
            sampleSeed: options.gpuParitySampleSeed,
            perChannelThreshold: options.gpuParityPerChannelThreshold,
          },
        ),
      );
      console.info('GPU/CPU parity diagnostic', parityResult);
    }

    if (!skipFinalFullPass) {
      if (paintedNodeCount <= 1) {
        setRoutingStatus(
          shell,
          formatRoutingStatusNoReachable(routeElapsedMs, {
            messages: getShellLocaleMessages(shell),
          }),
        );
      } else {
        setRoutingStatus(
          shell,
          formatRoutingStatusDone(routeElapsedMs, { messages: getShellLocaleMessages(shell) }),
        );
      }
    } else {
      setRoutingStatus(
        shell,
        formatRoutingStatusPreview(routeElapsedMs, { messages: getShellLocaleMessages(shell) }),
      );
    }
  }

  if (routingProfileEnabled && routingProfile !== null) {
    console.info('Routing profile', buildRoutingProfileSummary(
      routingProfile,
      {
        rendererMode: renderer.mode,
        heapStrategy: searchState.heapStrategy ?? 'unknown',
        cancelled: runSummary.cancelled,
        skipFinalFullPass,
        elapsedMs: routeElapsedMs,
        sliceCount: runSummary.sliceCount,
        settledNodeCount,
        paintedNodeCount,
        paintedEdgeCount,
      },
    ));
  }

  return {
    ...runSummary,
    elapsedMs: routeElapsedMs,
    paintedEdgeCount,
    paintedNodeCount,
    edgeVertexData: finalEdgeVertexData,
  };
}

function countFiniteTravelTimes(distSeconds) {
  if (!distSeconds || typeof distSeconds.length !== 'number') {
    return 0;
  }
  let count = 0;
  for (let i = 0; i < distSeconds.length; i += 1) {
    if (distSeconds[i] < Infinity) {
      count += 1;
    }
  }
  return count;
}

function createDeterministicSamplePixels(widthPx, heightPx, sampleCount, seed = 0x5f3759df) {
  if (!Number.isInteger(widthPx) || widthPx <= 0) {
    throw new Error('widthPx must be a positive integer');
  }
  if (!Number.isInteger(heightPx) || heightPx <= 0) {
    throw new Error('heightPx must be a positive integer');
  }
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    throw new Error('sampleCount must be a positive integer');
  }

  let randomState = seed >>> 0;
  const nextRandom = () => {
    randomState = (1664525 * randomState + 1013904223) >>> 0;
    return randomState / 4294967296;
  };

  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const xPx = Math.floor(nextRandom() * widthPx);
    const yPx = Math.floor(nextRandom() * heightPx);
    samples.push([xPx, yPx]);
  }

  return samples;
}

function samplePixelGridRgba(pixelGrid, samplePixels) {
  validatePixelGrid(pixelGrid);
  if (!Array.isArray(samplePixels)) {
    throw new Error('samplePixels must be an array of [x, y] pairs');
  }

  const sampledRgba = new Uint8Array(samplePixels.length * 4);
  for (let sampleIndex = 0; sampleIndex < samplePixels.length; sampleIndex += 1) {
    const sample = samplePixels[sampleIndex];
    if (!Array.isArray(sample) || sample.length < 2) {
      throw new Error('samplePixels must contain [x, y] pairs');
    }
    const xPx = clampInt(Math.round(sample[0]), 0, pixelGrid.widthPx - 1);
    const yPx = clampInt(Math.round(sample[1]), 0, pixelGrid.heightPx - 1);
    const offset = (yPx * pixelGrid.widthPx + xPx) * 4;
    sampledRgba[sampleIndex * 4] = pixelGrid.rgba[offset];
    sampledRgba[sampleIndex * 4 + 1] = pixelGrid.rgba[offset + 1];
    sampledRgba[sampleIndex * 4 + 2] = pixelGrid.rgba[offset + 2];
    sampledRgba[sampleIndex * 4 + 3] = pixelGrid.rgba[offset + 3];
  }

  return sampledRgba;
}

export function runGpuCpuParityDiagnostic(renderer, mapData, searchState, options = {}) {
  if (!renderer || typeof renderer.readPixelsRgba !== 'function') {
    throw new Error('renderer.readPixelsRgba(samplePixels) is required');
  }
  if (!mapData || typeof mapData !== 'object') {
    throw new Error('mapData must be an object');
  }
  if (!mapData.graph || !mapData.nodePixels || !mapData.pixelGrid) {
    throw new Error('mapData.graph, mapData.nodePixels, and mapData.pixelGrid are required');
  }
  if (!searchState || typeof searchState !== 'object') {
    throw new Error('searchState must be an object');
  }
  if (!searchState.graph || !searchState.distSeconds) {
    throw new Error('searchState.graph and searchState.distSeconds are required');
  }

  validateGraphForRouting(mapData.graph);
  validateNodePixels(mapData.nodePixels);
  validateDistSeconds(searchState.distSeconds, mapData.nodePixels.nodePixelX.length);
  validatePixelGrid(mapData.pixelGrid);

  const allowedModeMask = options.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
  const alpha = clampInt(Math.round(options.alpha ?? 255), 0, 255);
  const stepStride = options.stepStride ?? FINAL_EDGE_INTERPOLATION_STEP_STRIDE;
  const rawSampleCount = options.sampleCount ?? 256;
  const sampleCount = clampInt(Math.floor(rawSampleCount), 1, 10000);
  const sampleSeed = options.sampleSeed ?? 0x5f3759df;
  const perChannelThreshold = clampInt(Math.round(options.perChannelThreshold ?? 64), 0, 255);

  const referenceGrid = createPixelGrid(mapData.pixelGrid.widthPx, mapData.pixelGrid.heightPx);
  clearGrid(referenceGrid);
  paintAllReachableEdgeInterpolationsToGrid(
    referenceGrid,
    searchState.graph,
    mapData.nodePixels,
    searchState.distSeconds,
    allowedModeMask,
    { alpha, colourCycleMinutes: cycleMinutes, colourTheme, stepStride },
  );
  paintReachableNodesToGrid(
    referenceGrid,
    mapData.nodePixels,
    searchState.distSeconds,
    { alpha, colourCycleMinutes: cycleMinutes, colourTheme },
  );

  const samplePixels = createDeterministicSamplePixels(
    referenceGrid.widthPx,
    referenceGrid.heightPx,
    sampleCount,
    sampleSeed,
  );
  const cpuRgba = samplePixelGridRgba(referenceGrid, samplePixels);
  const gpuRgba = renderer.readPixelsRgba(samplePixels);
  if (!(gpuRgba instanceof Uint8Array) || gpuRgba.length !== cpuRgba.length) {
    throw new Error('renderer.readPixelsRgba(samplePixels) returned unexpected byte length');
  }

  let sumAbsDelta = 0;
  let maxAbsDelta = 0;
  let aboveThresholdChannels = 0;
  for (let i = 0; i < cpuRgba.length; i += 1) {
    const absDelta = Math.abs(cpuRgba[i] - gpuRgba[i]);
    sumAbsDelta += absDelta;
    if (absDelta > maxAbsDelta) {
      maxAbsDelta = absDelta;
    }
    if (absDelta > perChannelThreshold) {
      aboveThresholdChannels += 1;
    }
  }

  return {
    sampleCount,
    meanAbsDelta: sumAbsDelta / cpuRgba.length,
    maxAbsDelta,
    aboveThresholdChannels,
    perChannelThreshold,
  };
}






function getSelectedTransportModeLabels(shell) {
  if (!shell || typeof shell !== 'object' || !Array.isArray(shell.modeCheckboxes)) {
    return [];
  }
  const labels = [];
  for (const checkbox of shell.modeCheckboxes) {
    if (!checkbox?.checked) {
      continue;
    }
    // Skip the transit checkbox (folded into modeCheckboxes alongside
    // Walk/Bike/Car/Ferry) while its row is hidden - no transit data for
    // the loaded region - so a stale checked state from a previous region
    // can't leak into the export title. Mirrors
    // getTransitOptionsFromShell's own transitEnabledRow.hidden check.
    const optionRow = checkbox.closest?.('.mode-checkbox-option') ?? null;
    if (optionRow?.hidden) {
      continue;
    }
    const labelSpan = optionRow?.querySelector?.('span') ?? null;
    const label =
      typeof labelSpan?.textContent === 'string' && labelSpan.textContent.trim().length > 0
        ? labelSpan.textContent.trim()
        : null;
    if (label) {
      labels.push(label);
    }
  }
  return labels;
}









function validatePixelGrid(pixelGrid) {
  if (!pixelGrid || typeof pixelGrid !== 'object') {
    throw new Error('pixelGrid must be an object');
  }
  if (!Number.isInteger(pixelGrid.widthPx) || pixelGrid.widthPx <= 0) {
    throw new Error('pixelGrid.widthPx must be a positive integer');
  }
  if (!Number.isInteger(pixelGrid.heightPx) || pixelGrid.heightPx <= 0) {
    throw new Error('pixelGrid.heightPx must be a positive integer');
  }
  if (!(pixelGrid.rgba instanceof Uint8ClampedArray)) {
    throw new Error('pixelGrid.rgba must be a Uint8ClampedArray');
  }
  const expectedLength = pixelGrid.widthPx * pixelGrid.heightPx * 4;
  if (pixelGrid.rgba.length !== expectedLength) {
    throw new Error(
      `pixelGrid.rgba length mismatch: got ${pixelGrid.rgba.length}, expected ${expectedLength}`,
    );
  }
}

function validateTravelTimeGrid(travelTimeGrid) {
  if (!travelTimeGrid || typeof travelTimeGrid !== 'object') {
    throw new Error('travelTimeGrid must be an object');
  }
  if (!Number.isInteger(travelTimeGrid.widthPx) || travelTimeGrid.widthPx <= 0) {
    throw new Error('travelTimeGrid.widthPx must be a positive integer');
  }
  if (!Number.isInteger(travelTimeGrid.heightPx) || travelTimeGrid.heightPx <= 0) {
    throw new Error('travelTimeGrid.heightPx must be a positive integer');
  }
  if (!(travelTimeGrid.seconds instanceof Float32Array)) {
    throw new Error('travelTimeGrid.seconds must be a Float32Array');
  }
  const expectedLength = travelTimeGrid.widthPx * travelTimeGrid.heightPx;
  if (travelTimeGrid.seconds.length !== expectedLength) {
    throw new Error(
      `travelTimeGrid.seconds length mismatch: got ${travelTimeGrid.seconds.length}, expected ${expectedLength}`,
    );
  }
}






function isDone(searchState) {
  if (typeof searchState.isDone === 'function') {
    return Boolean(searchState.isDone());
  }
  return Boolean(searchState.done);
}

function waitForAnimationFrame(requestAnimationFrameImpl) {
  if (typeof requestAnimationFrameImpl === 'function') {
    return new Promise((resolve) => {
      requestAnimationFrameImpl(() => {
        resolve(undefined);
      });
    });
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(undefined);
    }, 0);
  });
}

function defaultNowMs() {
  if (globalThis.performance && typeof globalThis.performance.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

function isRoutingProfilingEnabled(profileOption) {
  if (profileOption === true || profileOption === false) {
    return profileOption;
  }

  const locationSearch = globalThis.location?.search;
  if (typeof locationSearch !== 'string' || locationSearch.length === 0) {
    return false;
  }
  const params = new URLSearchParams(locationSearch);
  const profileParam = params.get('profile');
  if (profileParam === null) {
    return false;
  }

  const normalizedProfileParam = profileParam.trim().toLowerCase();
  return (
    normalizedProfileParam === '1'
    || normalizedProfileParam === 'true'
    || normalizedProfileParam === 'yes'
    || normalizedProfileParam === 'on'
  );
}

function buildRoutingProfileSummary(profile, metadata = {}) {
  const roundedProfileMs = {};
  for (const [field, value] of Object.entries(profile)) {
    roundedProfileMs[field] = Math.max(0, Math.round(value * 1000) / 1000);
  }
  return {
    ...metadata,
    timingsMs: roundedProfileMs,
  };
}



if (typeof window !== 'undefined' && typeof globalThis.document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', async () => {
    const locationSearch = globalThis.location?.search ?? '';
    const requestedLocale = parseLanguageFromLocationSearch(locationSearch);
    const [localeBundle, locationRegistry] = await Promise.all([
      loadCommonLocaleBundle(
        requestedLocale === null
          ? undefined
          : {
              locale: requestedLocale,
            },
      ),
      loadLocationRegistry(),
    ]);
    const shell = initializeAppShell(globalThis.document, { localeBundle });
    const localizedLocationRegistry = localizeLocationRegistry(locationRegistry, localeBundle.locale);
    const requestedLocationId = parseLocationIdFromLocationSearch(locationSearch) ?? DEFAULT_LOCATION_ID;
    const initialLocation = resolveLocationEntry(
      localizedLocationRegistry,
      requestedLocationId,
      DEFAULT_LOCATION_ID,
    );
    populateLocationSelect(
      shell,
      localizedLocationRegistry.locations,
      initialLocation?.id ?? DEFAULT_LOCATION_ID,
    );
    bindHeaderMenuControl(shell);
    bindPointerButtonInversionControl(shell);
    if (!ensureWasmSupportOrShowError(shell)) {
      return;
    }
    let initializedMapData = null;
    let routingBinding = null;
    let currentLocationId = null;
    let isLocationLoading = false;
    const redrawLoadedMap = (mapData) => {
      if (!mapData?.graph?.header) {
        return;
      }
      if (mapData.boundaryPayload) {
        drawBoundaryBasemapAlignedToGraphGrid(
          shell.boundaryCanvas,
          mapData.boundaryPayload,
          mapData.graph.header,
          {
            colourTheme: resolveIsochroneTheme(),
            viewport: mapData.viewport,
            fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
          },
        );
      }
      rerenderIsochroneFromSnapshot(shell, mapData, {
        colourTheme: resolveIsochroneTheme(),
        colourCycleMinutes: getColourCycleMinutesFromShell(shell),
        viewport: mapData.viewport,
      });
      updateDistanceScaleBar(shell, mapData.graph.header, {
        viewport: mapData.viewport,
        fitBoundingBoxPx: mapData.boundaryFitBoundingBoxPx,
      });
    };
    const handleWindowResize = () => {
      if (!initializedMapData) {
        return;
      }
      redrawLoadedMap(initializedMapData);
    };
    window.addEventListener('resize', handleWindowResize);
    const loadLocationById = async (requestedLocationId) => {
      const nextLocation = resolveLocationEntry(
        localizedLocationRegistry,
        requestedLocationId,
        currentLocationId ?? initialLocation?.id ?? DEFAULT_LOCATION_ID,
      );
      if (!nextLocation) {
        return false;
      }
      if (isLocationLoading) {
        return false;
      }
      if (initializedMapData && currentLocationId === nextLocation.id) {
        shell.locationSelect.value = nextLocation.id;
        return true;
      }

      const previousMapData = initializedMapData;
      const previousLocationId = currentLocationId;
      if (routingBinding?.dispose) {
        routingBinding.dispose();
      }
      routingBinding = null;
      if (previousMapData) {
        clearRenderedIsochrone(shell, previousMapData);
      }
      initializedMapData = null;
      isLocationLoading = true;
      shell.locationSelect.disabled = true;
      shell.isochroneCanvas.style.pointerEvents = 'none';
      shell.isochroneCanvas.dataset.graphLoaded = 'false';
      if (shell.exportSvgButton) {
        shell.exportSvgButton.disabled = true;
      }

      const { boundaryUrl, graphUrl } = buildLocationAssetUrls(nextLocation);
      try {
        const mapData = await initializeMapData(shell, {
          locationName: nextLocation.name,
          boundaries: { url: boundaryUrl },
          graph: { url: graphUrl },
          transitDateRange: nextLocation.transitDateRange,
        });
        initializedMapData = mapData;
        currentLocationId = nextLocation.id;
        shell.locationSelect.value = nextLocation.id;
        persistLocationIdToLocation(nextLocation.id);
        routingBinding = bindCanvasClickRouting(shell, mapData);
        return true;
      } catch (error) {
        initializedMapData = previousMapData;
        currentLocationId = previousLocationId;
        if (previousMapData) {
          redrawLoadedMap(previousMapData);
          routingBinding = bindCanvasClickRouting(shell, previousMapData, {
            autoStartFromLocation: false,
          });
          shell.isochroneCanvas.style.pointerEvents = 'auto';
          shell.isochroneCanvas.dataset.graphLoaded = 'true';
          if (shell.exportSvgButton) {
            shell.exportSvgButton.disabled = false;
          }
        }
        shell.locationSelect.value =
          previousLocationId ?? nextLocation.id;
        console.error(error);
        return false;
      } finally {
        isLocationLoading = false;
        shell.locationSelect.disabled = false;
      }
    };
    bindLocationSelectControl(shell, {
      onLocationChange(locationId) {
        void loadLocationById(locationId);
      },
    });
    const themeBinding = bindThemeControl(shell, {
      // themeValue may be the raw radio selection ('auto' included, not
      // just 'light'/'dark') - resolveIsochroneTheme() re-reads
      // rootElement.dataset.theme (which bindThemeControl already updated)
      // and turns 'auto'/unset into the actual OS-preference-driven colour
      // so canvas/legend rendering always gets a concrete theme.
      onThemeChange() {
        const resolvedTheme = resolveIsochroneTheme();
        if (initializedMapData?.boundaryPayload && initializedMapData?.graph?.header) {
          drawBoundaryBasemapAlignedToGraphGrid(
            shell.boundaryCanvas,
            initializedMapData.boundaryPayload,
            initializedMapData.graph.header,
            {
              colourTheme: resolvedTheme,
              viewport: initializedMapData.viewport,
              fitBoundingBoxPx: initializedMapData.boundaryFitBoundingBoxPx,
            },
          );
        }
        const cycleMinutes = getColourCycleMinutesFromShell(shell);
        renderIsochroneLegendIfNeeded(shell, cycleMinutes, { theme: resolvedTheme });
        const rerendered = rerenderIsochroneFromSnapshotWithStatus(shell, initializedMapData, {
          colourTheme: resolvedTheme,
          colourCycleMinutes: cycleMinutes,
          viewport: initializedMapData?.viewport,
        });
        if (!rerendered) {
          routingBinding?.requestIsochroneRedraw();
        }
      },
    });
    let printRestoreTheme = null;
    let isPrintOverrideActive = false;
    const enterPrintMode = () => {
      if (isPrintOverrideActive) {
        return;
      }
      isPrintOverrideActive = true;
      const currentTheme = resolveIsochroneTheme();
      if (currentTheme === 'light') {
        return;
      }
      if (!printRestoreTheme) {
        printRestoreTheme = currentTheme;
      }
      themeBinding.setTheme('light', { persist: false, notify: true });
    };
    const exitPrintMode = () => {
      if (!isPrintOverrideActive) {
        return;
      }
      isPrintOverrideActive = false;
      if (!printRestoreTheme) {
        return;
      }
      themeBinding.setTheme(printRestoreTheme, { persist: false, notify: true });
      printRestoreTheme = null;
    };
    window.addEventListener('beforeprint', enterPrintMode);
    window.addEventListener('afterprint', exitPrintMode);
    const printMediaQuery = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
    const handlePrintMediaChange = (event) => {
      if (event.matches) {
        enterPrintMode();
      } else {
        exitPrintMode();
      }
    };
    if (printMediaQuery) {
      if (typeof printMediaQuery.addEventListener === 'function') {
        printMediaQuery.addEventListener('change', handlePrintMediaChange);
      } else if (typeof printMediaQuery.addListener === 'function') {
        printMediaQuery.addListener(handlePrintMediaChange);
      }
    }
    bindSvgExportControl(shell, {
      async exportCurrentRenderedIsochroneSvg() {
        if (routingBinding && typeof routingBinding.waitForIdle === 'function') {
          await routingBinding.waitForIdle();
        }

        const locationName = initializedMapData?.locationName ?? DEFAULT_LOCATION_NAME;
        const modeLabels = getSelectedTransportModeLabels(shell);
        const title = formatIsochroneExportTitle(locationName, modeLabels);
        const graphHeaderForExport = initializedMapData?.graph.header ?? null;
        const exportScaleBar = graphHeaderForExport
          ? computeExportDistanceScaleBar(graphHeaderForExport)
          : null;
        const scaleBarLabel =
          exportScaleBar?.label ?? shell.distanceScaleLabel?.textContent?.trim() ?? '';
        const scaleBarWidthPx = exportScaleBar?.lineWidthPx ?? 96;
        const scaleBarSegmentWidthPx = exportScaleBar?.segmentWidthPx;
        const transitDisclaimerText =
          shell.routingDisclaimerTransit && !shell.routingDisclaimerTransit.hidden
            ? (shell.routingDisclaimerTransit.textContent ?? '')
            : '';
        const osmDisclaimerText =
          shell.routingDisclaimerOsm?.textContent ?? shell.routingDisclaimer?.textContent ?? '';
        const copyrightNotice = `${osmDisclaimerText} ${transitDisclaimerText}`
          .replace(/\s+/g, ' ')
          .trim();

        let edgeVertexData = new Float32Array(0);
        let cycleMinutes = getColourCycleMinutesFromShell(shell);
        const routingSnapshot = initializedMapData?.lastRoutingSnapshot ?? null;
        if (initializedMapData && routingSnapshot) {
          // Transit-only isochrones have no road edges to export; their lines
          // are the transit connections, already in this same (x, y, seconds)
          // layout.
          edgeVertexData =
            routingSnapshot.allowedModeMask === TRANSIT_ONLY_ALLOWED_MODE_MASK
              ? (routingSnapshot.transitEdgeVertexData ?? new Float32Array(0))
              : getOrBuildSnapshotEdgeVertexData(initializedMapData, routingSnapshot, {
                allowedModeMask: routingSnapshot.allowedModeMask,
              });
          cycleMinutes = routingSnapshot.colourCycleMinutes;
        }

        const currentTheme = resolveIsochroneTheme();
        return exportCurrentRenderedIsochroneSvg(shell, {
          graphHeader: initializedMapData?.graph.header ?? null,
          boundaryPayload: initializedMapData?.boundaryPayload ?? null,
          edgeVertexData,
          cycleMinutes,
          theme: currentTheme,
          title,
          messages: getShellLocaleMessages(shell),
          scaleBarLabel,
          scaleBarWidthPx,
          scaleBarSegmentWidthPx,
          copyrightNotice,
        });
      },
      onExportSuccess(result) {
        setRoutingStatus(
          shell,
          getLocalizedShellText(shell, 'routing.exportedSvg', `Exported SVG: ${result.filename}`, {
            filename: result.filename,
          }),
        );
      },
      onExportError() {
        setRoutingStatus(
          shell,
          getLocalizedShellText(shell, 'routing.exportFailed', 'SVG export failed.'),
        );
      },
    });
    bindModeSelectControl(shell, {
      requestIsochroneRepaint() {
        const cycleMinutes = getColourCycleMinutesFromShell(shell);
        const rerendered = rerenderIsochroneFromSnapshotWithStatus(shell, initializedMapData, {
          colourTheme: resolveIsochroneTheme(),
          colourCycleMinutes: cycleMinutes,
        });
        if (rerendered && initializedMapData?.lastRoutingSnapshot) {
          initializedMapData.lastRoutingSnapshot.colourCycleMinutes = cycleMinutes;
        }
        return rerendered;
      },
      requestIsochroneRedraw() {
        return routingBinding?.requestIsochroneRedraw() ?? false;
      },
    });
    void loadLocationById(initialLocation?.id ?? DEFAULT_LOCATION_ID);
  });
}

export async function loadGraphBinary(shell, options = {}) {
  const url = options.url ?? DEFAULT_GRAPH_BINARY_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  showLoadingOverlay(shell, formatInitialGraphLoadingText(shell), 0);

  try {
    const buffer = await fetchBinaryWithProgress(url, {
      fetchImpl,
      onProgress(receivedBytes, totalBytes) {
        updateGraphLoadingText(shell, receivedBytes, totalBytes);
      },
    });

    const binaryBuffer = await maybeDecompressGzipBuffer(buffer);
    const graph = parseGraphBinary(binaryBuffer);
    shell.isochroneCanvas.style.pointerEvents = 'auto';
    shell.isochroneCanvas.dataset.graphLoaded = 'true';
    return graph;
  } catch (error) {
    shell.isochroneCanvas.style.pointerEvents = 'none';
    shell.isochroneCanvas.dataset.graphLoaded = 'false';
    showLoadingOverlay(
      shell,
      getLocalizedShellText(shell, 'error.graph.load', 'Failed to load graph binary.'),
      0,
    );
    throw error;
  }
}
