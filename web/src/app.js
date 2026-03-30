import {
  BYTES_PER_MEBIBYTE,
  DEFAULT_BOUNDARY_BASEMAP_URL,
  DEFAULT_GRAPH_BINARY_URL,
  DEFAULT_LOCATION_NAME,
  EDGE_INTERPOLATION_SLACK_SECONDS,
  EDGE_MODE_BIKE_BIT,
  EDGE_MODE_CAR_BIT,
  EDGE_MODE_WALK_BIT,
  EDGE_RECORD_SIZE,
  FINAL_EDGE_INTERPOLATION_STEP_STRIDE,
  GRAPH_MAGIC,
  HEADER_SIZE,
  INTERACTIVE_EDGE_INTERPOLATION_STEP_STRIDE,
  LOADING_FADE_MS,
  NODE_RECORD_SIZE,
  SUPPORTED_GRAPH_VERSIONS,
} from './config/constants.js';
import {
  getEdgeTraversalCostSeconds,
  getOrCreateEdgeTraversalCostSecondsCache,
  nodeHasAllowedModeOutgoingEdge,
  precomputeEdgeTraversalCostSecondsCache,
} from './core/routing.js';
import {
  mapCanvasPixelToGraphMeters,
  mapClientPointToCanvasPixel,
  parseNodeIndexFromLocationSearch,
  persistNodeIndexToLocation,
} from './core/coords.js';
import {
  createDefaultMapViewport,
  resolveViewportFrame,
} from './core/viewport.js';
import {
  bindHeaderMenuControl as bindHeaderMenuControlInternal,
  bindPointerButtonInversionControl as bindPointerButtonInversionControlInternal,
  bindThemeControl as bindThemeControlInternal,
  getAllowedModeMaskFromShell,
  getColourCycleMinutesFromShell,
  initializeAppShell,
  bindModeSelectControl as bindModeSelectControlInternal,
} from './ui/orchestration.js';
import {
  formatCommonMessage,
  getCommonMessage,
  loadCommonLocaleBundle,
} from './ui/localization.js';
import { bindCanvasClickRouting as bindCanvasClickRoutingInternal } from './interaction/canvas-routing.js';
import {
  bindSvgExportControl,
  exportCurrentRenderedIsochroneSvg,
  formatIsochroneExportTitle,
} from './export/svg.js';
import {
  CYCLE_COLOUR_MAP_GLSL,
  DEFAULT_COLOUR_CYCLE_MINUTES,
  getIsochronePalette,
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
  parseColourCycleMinutesFromLocationSearch,
  parseModeValuesFromLocationSearch,
  parseNodeIndexFromLocationSearch,
  persistColourCycleMinutesToLocation,
  persistModeValuesToLocation,
  persistNodeIndexToLocation,
} from './core/coords.js';
export {
  initializeAppShell,
  getAllowedModeMaskFromShell,
  getColourCycleMinutesFromShell,
} from './ui/orchestration.js';
export {
  bindSvgExportControl,
  buildRenderedIsochroneSvgDocument,
  buildSvgExportFilename,
  exportCurrentRenderedIsochroneSvg,
  formatIsochroneExportTitle,
} from './export/svg.js';
export { timeToColour } from './render/colour.js';

export const WASM_REQUIRED_MESSAGE =
  'Your browser does not support WASM, this app requires WASM for performance reasons';
const WASM_EDGE_COST_TICK_SCALE = 1_000;
const EDGE_TRAVERSAL_COST_TICK_CACHE_PROPERTY = '__edgeTraversalCostTicksByModeMask';
const MODE_SPECIFIC_KERNEL_GRAPH_VIEWS_CACHE_PROPERTY = '__modeSpecificKernelGraphViewsByModeMask';
const ROUTING_DIST_SCRATCH_BUFFERS_PROPERTY = '__routingDistScratchBuffers';
const ROUTING_DIST_SCRATCH_NEXT_INDEX_PROPERTY = '__routingDistScratchNextIndex';
export function precomputeNodeModeMask(graph) {
  validateGraphForRouting(graph);

  const nodeModeMask = new Uint8Array(graph.header.nNodes);
  const supportedModeMask = EDGE_MODE_WALK_BIT | EDGE_MODE_BIKE_BIT | EDGE_MODE_CAR_BIT;

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

  const edgeTraversalCostSeconds = precomputeEdgeTraversalCostSecondsCache(
    mapData.graph,
    allowedModeMask,
    null,
    {
      edgeCostPrecomputeKernel,
      onKernelError: options.onKernelError ?? null,
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
    mapData.lastRoutingSnapshot = {
      sourceNodeIndex,
      distSeconds: searchState.distSeconds,
      allowedModeMask,
      edgeTraversalCostSeconds,
      colourCycleMinutes: options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES,
      edgeVertexData: runSummary.edgeVertexData ?? null,
      edgeVertexDataModeMask:
        runSummary.edgeVertexData instanceof Float32Array ? allowedModeMask : null,
    };
    runPostMvpTransitStub(mapData.graph, searchState);
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
    blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, { viewport });
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

export function runPostMvpTransitStub(graph, walkingSearchState) {
  validateGraphForRouting(graph);

  if (!walkingSearchState || typeof walkingSearchState !== 'object') {
    throw new Error('walkingSearchState must be an object');
  }
  if (typeof walkingSearchState.isDone !== 'function' || !walkingSearchState.isDone()) {
    throw new Error('walkingSearchState must be complete before transit integration');
  }

  const nStops = graph.header.nStops;
  if (!Number.isInteger(nStops) || nStops < 0) {
    throw new Error('graph.header.nStops must be a non-negative integer');
  }
  if (nStops === 0) {
    return {
      nStops,
      ranCsa: false,
      reranWalkingDijkstra: false,
    };
  }

  // POST-MVP: run CSA here, then re-run Dijkstra from transit-reached stops
  return {
    nStops,
    ranCsa: false,
    reranWalkingDijkstra: false,
  };
}

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

  let edgeTraversalCostTicks = cacheByModeMask[allowedModeMask];
  if (
    !(edgeTraversalCostTicks instanceof Uint32Array)
    || edgeTraversalCostTicks.length < graph.header.nEdges
  ) {
    edgeTraversalCostTicks = new Uint32Array(graph.header.nEdges);
    for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
      const costSeconds = edgeTraversalCostSeconds[edgeIndex];
      if (!Number.isFinite(costSeconds) || costSeconds <= 0) {
        edgeTraversalCostTicks[edgeIndex] = 0;
        continue;
      }
      const ticks = Math.ceil(costSeconds * WASM_EDGE_COST_TICK_SCALE);
      edgeTraversalCostTicks[edgeIndex] = ticks >= 0xffff_ffff ? 0xffff_ffff : ticks;
    }
    cacheByModeMask[allowedModeMask] = edgeTraversalCostTicks;
  }

  return edgeTraversalCostTicks;
}

export function parseBoundaryBasemapPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('boundary payload must be an object');
  }

  const coordinateSpace = payload.coordinate_space;
  if (!coordinateSpace || typeof coordinateSpace !== 'object') {
    throw new Error('boundary payload is missing coordinate_space');
  }

  const width = asFiniteNumber(coordinateSpace.width, 'coordinate_space.width');
  const height = asFiniteNumber(coordinateSpace.height, 'coordinate_space.height');
  const xOrigin = asFiniteNumber(coordinateSpace.x_origin, 'coordinate_space.x_origin');
  const yOrigin = asFiniteNumber(coordinateSpace.y_origin, 'coordinate_space.y_origin');
  const axis =
    typeof coordinateSpace.axis === 'string' ? coordinateSpace.axis : 'x-right-y-down';

  if (width <= 0 || height <= 0) {
    throw new Error('coordinate_space width/height must be positive');
  }
  if (axis !== 'x-right-y-down') {
    throw new Error(`unsupported boundary coordinate_space.axis: ${axis}`);
  }

  const rawFeatures = payload.features;
  if (!Array.isArray(rawFeatures)) {
    throw new Error('boundary payload is missing features[]');
  }

  const features = rawFeatures
    .map((feature, featureIndex) => {
      if (!feature || typeof feature !== 'object') {
        throw new Error(`features[${featureIndex}] must be an object`);
      }

      const name = typeof feature.name === 'string' ? feature.name : `feature_${featureIndex}`;
      const relationId = Number.isFinite(feature.relation_id) ? feature.relation_id : null;

      if (!Array.isArray(feature.paths)) {
        throw new Error(`features[${featureIndex}].paths must be an array`);
      }

      const paths = feature.paths
        .map((path, pathIndex) => {
          if (!Array.isArray(path)) {
            throw new Error(`features[${featureIndex}].paths[${pathIndex}] must be an array`);
          }

          const points = path.map((point, pointIndex) =>
            parseCoordinatePair(
              point,
              `features[${featureIndex}].paths[${pathIndex}][${pointIndex}]`,
            ),
          );

          return points;
        })
        .filter((path) => path.length >= 2);

      return {
        name,
        relationId,
        paths,
      };
    })
    .filter((feature) => feature.paths.length > 0);

  if (features.length === 0) {
    throw new Error('boundary payload has no drawable paths');
  }

  return {
    coordinateSpace: {
      xOrigin,
      yOrigin,
      width,
      height,
      axis,
    },
    features,
  };
}

function getBoundaryStrokeStyle(colourTheme) {
  return normalizeIsochroneTheme(colourTheme, 'dark') === 'light'
    ? 'rgba(58, 94, 126, 0.62)'
    : 'rgba(125, 175, 220, 0.55)';
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

  const parsedBoundary = parseBoundaryBasemapPayload(payload);
  const context = boundaryCanvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to get 2D context for boundary canvas');
  }

  syncCanvasToDisplaySize(boundaryCanvas);
  const viewportFrame = resolveViewportFrame(graphHeader, options.viewport, {
    frameWidthPx: boundaryCanvas.width,
    frameHeightPx: boundaryCanvas.height,
  });

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, boundaryCanvas.width, boundaryCanvas.height);
  context.fillStyle = 'rgba(0, 0, 0, 0)';
  context.strokeStyle = getBoundaryStrokeStyle(options.colourTheme);
  context.lineWidth = 1.2 / viewportFrame.effectiveScale;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.setTransform(
    viewportFrame.effectiveScale,
    0,
    0,
    viewportFrame.effectiveScale,
    -viewportFrame.offsetXPx * viewportFrame.effectiveScale,
    -viewportFrame.offsetYPx * viewportFrame.effectiveScale,
  );

  const maxY = graphHeader.gridHeightPx - 1;
  let renderedPathCount = 0;

  for (const feature of parsedBoundary.features) {
    for (const path of feature.paths) {
      if (path.length < 2) {
        continue;
      }

      context.beginPath();
      for (let i = 0; i < path.length; i += 1) {
        const point = path[i];
        const easting = parsedBoundary.coordinateSpace.xOrigin + point[0];
        const northing = parsedBoundary.coordinateSpace.yOrigin - point[1];
        const xPx = (easting - graphHeader.originEasting) / graphHeader.pixelSizeM;
        const yPx = maxY - (northing - graphHeader.originNorthing) / graphHeader.pixelSizeM;

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
    featureCount: parsedBoundary.features.length,
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

export async function fetchBinaryWithProgress(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const onProgress = options.onProgress ?? (() => {});

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available');
  }
  if (typeof onProgress !== 'function') {
    throw new Error('onProgress must be a function');
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch graph binary: HTTP ${response.status}`);
  }

  const totalBytes = parseContentLength(response.headers?.get('Content-Length'));

  if (!response.body || typeof response.body.getReader !== 'function') {
    const fallbackBuffer = await response.arrayBuffer();
    onProgress(fallbackBuffer.byteLength, totalBytes);
    return fallbackBuffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;

  onProgress(0, totalBytes);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }

    chunks.push(value);
    receivedBytes += value.byteLength;
    onProgress(receivedBytes, totalBytes);
  }

  const merged = new Uint8Array(receivedBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }

  onProgress(receivedBytes, totalBytes);
  return merged.buffer;
}

export async function maybeDecompressGzipBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('maybeDecompressGzipBuffer expects an ArrayBuffer');
  }

  const bytes = new Uint8Array(buffer);
  const isGzipMagic = bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
  if (!isGzipMagic) {
    return buffer;
  }

  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      'Browser does not support DecompressionStream for gzip graph payloads. ' +
        'Use an uncompressed graph binary or a browser with gzip stream support.',
    );
  }

  const compressedBlob = new Blob([buffer], { type: 'application/gzip' });
  const decompressedStream = compressedBlob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(decompressedStream).arrayBuffer();
}

export function parseGraphBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('graph binary parser expects an ArrayBuffer');
  }
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(`graph binary is too small for header: ${buffer.byteLength} bytes`);
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== GRAPH_MAGIC) {
    throw new Error(
      `Invalid graph magic 0x${magic.toString(16).padStart(8, '0')}; expected 0x${GRAPH_MAGIC.toString(16)}`,
    );
  }
  const version = view.getUint8(4);
  if (!SUPPORTED_GRAPH_VERSIONS.has(version)) {
    throw new Error(
      `unsupported graph binary version ${version}; supported graph binary versions: ${[
        ...SUPPORTED_GRAPH_VERSIONS,
      ].join(', ')}`,
    );
  }

  const nNodes = view.getUint32(8, true);
  const nEdges = view.getUint32(12, true);
  const nodeTableOffset = view.getUint32(52, true);
  const edgeTableOffset = view.getUint32(56, true);
  const stopTableOffset = view.getUint32(60, true);

  const nodeTableEnd = nodeTableOffset + nNodes * NODE_RECORD_SIZE;
  const edgeTableEnd = edgeTableOffset + nEdges * EDGE_RECORD_SIZE;

  if (nodeTableOffset < HEADER_SIZE) {
    throw new Error('graph binary node table offset points inside header');
  }
  if (edgeTableOffset < nodeTableEnd) {
    throw new Error('graph binary edge table overlaps node table');
  }
  if (stopTableOffset < edgeTableEnd) {
    throw new Error('graph binary stop table overlaps edge table');
  }
  if (nodeTableEnd > buffer.byteLength) {
    throw new Error('graph binary node table exceeds file size');
  }
  if (edgeTableEnd > buffer.byteLength) {
    throw new Error('graph binary edge table exceeds file size');
  }
  if (stopTableOffset > buffer.byteLength) {
    throw new Error('graph binary stop table offset exceeds file size');
  }
  if (nodeTableOffset % 4 !== 0 || edgeTableOffset % 4 !== 0) {
    throw new Error('graph binary table offsets must be 4-byte aligned');
  }

  const header = {
    magic,
    version,
    flags: view.getUint8(5),
    nNodes,
    nEdges,
    nStops: view.getUint32(16, true),
    nTedges: view.getUint32(20, true),
    originEasting: view.getFloat64(24, true),
    originNorthing: view.getFloat64(32, true),
    epsgCode: view.getUint16(40, true),
    gridWidthPx: view.getUint16(42, true),
    gridHeightPx: view.getUint16(44, true),
    pixelSizeM: view.getFloat32(48, true),
    nodeTableOffset,
    edgeTableOffset,
    stopTableOffset,
  };

  const nodeI32 = new Int32Array(buffer, nodeTableOffset, nNodes * 4);
  const nodeU32 = new Uint32Array(buffer, nodeTableOffset, nNodes * 4);
  const nodeU16 = new Uint16Array(buffer, nodeTableOffset, nNodes * 8);
  const edgeU32 = new Uint32Array(buffer, edgeTableOffset, nEdges * 3);
  const edgeU16 = new Uint16Array(buffer, edgeTableOffset, nEdges * 6);
  const edgeModeMask = new Uint8Array(nEdges);
  const edgeRoadClassId = new Uint8Array(nEdges);
  const edgeMaxspeedKph = new Uint16Array(nEdges);

  for (let edgeIndex = 0; edgeIndex < nEdges; edgeIndex += 1) {
    const packedMetadata = edgeU32[edgeIndex * 3 + 2];
    edgeModeMask[edgeIndex] = packedMetadata & 0xff;
    edgeRoadClassId[edgeIndex] = (packedMetadata >>> 8) & 0xff;
    edgeMaxspeedKph[edgeIndex] = (packedMetadata >>> 16) & 0xffff;
  }

  return {
    header,
    nodeI32,
    nodeU32,
    nodeU16,
    edgeU32,
    edgeU16,
    edgeModeMask,
    edgeRoadClassId,
    edgeMaxspeedKph,
  };
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
    const edgeCostPrecomputeKernel = await edgeCostPrecomputeKernelPromise;
    const renderer = getOrCreateIsochroneRenderer(shell.isochroneCanvas);
    updateRenderBackendBadge(shell, renderer);
    layoutMapViewportToContainGraph(shell, graph.header);
    syncCanvasToDisplaySize(shell.isochroneCanvas);
    const alignedBoundarySummary = drawBoundaryBasemapAlignedToGraphGrid(
      shell.boundaryCanvas,
      boundaryLoad.boundaryPayload,
      graph.header,
      {
        colourTheme: resolveIsochroneTheme(),
        viewport: createDefaultMapViewport(),
      },
    );
    renderIsochroneLegendIfNeeded(shell, getColourCycleMinutesFromShell(shell));
    updateDistanceScaleBar(shell, graph.header, { viewport: createDefaultMapViewport() });
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
      graph,
      nodePixels,
      nodeModeMask,
      nodeSpatialIndex,
      pixelGrid,
      travelTimeGrid,
      viewport: createDefaultMapViewport(),
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

function formatLegendDuration(totalMinutes) {
  const roundedMinutes = Math.max(0, Math.round(totalMinutes));
  if (roundedMinutes < 60) {
    return `${roundedMinutes}m`;
  }

  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function resolveIsochroneTheme(rootElement = globalThis.document?.documentElement ?? null) {
  const datasetTheme = rootElement?.dataset?.theme ?? null;
  return normalizeIsochroneTheme(datasetTheme, 'dark');
}

function getIsochroneThemeVariant(theme) {
  return normalizeIsochroneTheme(theme, 'dark') === 'light' ? 1 : 0;
}

function formatDistanceLabel(distanceMetres) {
  if (distanceMetres >= 1000) {
    const km = distanceMetres / 1000;
    if (km >= 10) {
      return `${Math.round(km)} km`;
    }
    return `${km.toFixed(1)} km`;
  }
  return `${Math.round(distanceMetres)} m`;
}

function pickScaleDistanceMetres(targetDistanceMetres) {
  const safeTarget = Math.max(1, targetDistanceMetres);
  const exponent = Math.floor(Math.log10(safeTarget));
  const base = 10 ** exponent;
  const multipliers = [1, 2, 5];

  let chosen = base;
  for (const multiplier of multipliers) {
    const candidate = multiplier * base;
    if (candidate <= safeTarget) {
      chosen = candidate;
    }
  }

  if (chosen > safeTarget) {
    return chosen / 10;
  }
  return chosen;
}

function pickScaleBucketDistanceMetres(totalDistanceMetres) {
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
  const colours = getIsochronePalette(theme);

  const legendRows = [];
  for (let index = 0; index < colours.length; index += 1) {
    const colour = colours[index];
    const rangeStartMinutes = boundaries[index] * cycleMinutes;
    const rangeEndMinutes = boundaries[index + 1] * cycleMinutes;
    const rangeLabel = `${formatLegendDuration(rangeStartMinutes)}-${formatLegendDuration(rangeEndMinutes)}`;
    const colourCss = `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`;

    legendRows.push(
      `<div class="legend-row"><span class="legend-swatch" aria-hidden="true"><svg class="legend-swatch-svg" viewBox="0 0 16 16" focusable="false" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="2" fill="${colourCss}" stroke="${colourCss}" stroke-width="1.5"></rect></svg></span><span>${rangeLabel}</span></div>`,
    );
  }
  legendRows.push(
    `<div class="legend-note">Colours repeat every ${formatLegendDuration(cycleMinutes)}.</div>`,
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

  if (
    shell.lastRenderedLegendCycleMinutes === cycleMinutes
    && shell.lastRenderedLegendTheme === theme
  ) {
    return false;
  }

  renderIsochroneLegend(shell, cycleMinutes, { theme });
  shell.lastRenderedLegendCycleMinutes = cycleMinutes;
  shell.lastRenderedLegendTheme = theme;
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
  });

  const metresPerCssPixel = graphHeader.pixelSizeM / viewportFrame.effectiveScale;
  const preferredWidthPx = 120;
  const preferredDistanceMetres = preferredWidthPx * metresPerCssPixel;
  const chosenDistanceMetres = pickScaleDistanceMetres(preferredDistanceMetres);
  const lineWidthPx = Math.max(24, Math.round(chosenDistanceMetres / metresPerCssPixel));
  const bucketDistanceMetres = pickScaleBucketDistanceMetres(chosenDistanceMetres);
  const segmentWidthPx = Math.max(4, Math.round(bucketDistanceMetres / metresPerCssPixel));

  shell.distanceScaleLine.style.width = `${lineWidthPx}px`;
  if (typeof shell.distanceScaleLine.style.setProperty === 'function') {
    shell.distanceScaleLine.style.setProperty('--scale-segment-width-px', `${segmentWidthPx}px`);
  } else {
    shell.distanceScaleLine.style['--scale-segment-width-px'] = `${segmentWidthPx}px`;
  }
  shell.distanceScaleLabel.textContent = formatDistanceLabel(chosenDistanceMetres);
}

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

function createCanvas2dIsochroneRenderer(canvas) {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to get 2D context for isochrone canvas');
  }
  const scratchCanvas =
    globalThis.document && typeof globalThis.document.createElement === 'function'
      ? globalThis.document.createElement('canvas')
      : null;
  const scratchContext = scratchCanvas?.getContext?.('2d') ?? null;

  return {
    mode: '2d',
    draw(pixelGrid, options = {}) {
      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        canvas.width = pixelGrid.widthPx;
        canvas.height = pixelGrid.heightPx;
      }

      const imageData = new ImageData(pixelGrid.rgba, pixelGrid.widthPx, pixelGrid.heightPx);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const viewportFrame = resolveViewportFrame(
        { gridWidthPx: pixelGrid.widthPx, gridHeightPx: pixelGrid.heightPx },
        options.viewport,
        {
          frameWidthPx: canvas.width,
          frameHeightPx: canvas.height,
        },
      );
      if (
        scratchCanvas
        && scratchContext
        && (
          viewportFrame.effectiveScale !== 1
          || viewportFrame.offsetXPx !== 0
          || viewportFrame.offsetYPx !== 0
          || canvas.width !== pixelGrid.widthPx
          || canvas.height !== pixelGrid.heightPx
        )
      ) {
        scratchCanvas.width = pixelGrid.widthPx;
        scratchCanvas.height = pixelGrid.heightPx;
        scratchContext.putImageData(imageData, 0, 0);
        context.imageSmoothingEnabled = false;
        context.drawImage(
          scratchCanvas,
          viewportFrame.offsetXPx,
          viewportFrame.offsetYPx,
          viewportFrame.visibleWidthPx,
          viewportFrame.visibleHeightPx,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      } else {
        context.putImageData(imageData, 0, 0);
      }
      return imageData;
    },
  };
}

export function shouldUploadEdgeGeometry(
  previousEdgeVertexDataRef,
  previousEdgeVertexDataLength,
  edgeVertexData,
  options = {},
) {
  if (!(edgeVertexData instanceof Float32Array)) {
    throw new Error('edgeVertexData must be a Float32Array');
  }
  const append = options.append === true;
  const reuseUploadedGeometry = options.reuseUploadedGeometry === true;
  if (append || !reuseUploadedGeometry) {
    return true;
  }
  if (previousEdgeVertexDataRef !== edgeVertexData) {
    return true;
  }
  return previousEdgeVertexDataLength !== edgeVertexData.length;
}

function computeNodeTimeTextureDimensions(nodeCount, maxTextureSize) {
  if (!Number.isInteger(nodeCount) || nodeCount <= 0) {
    throw new Error('nodeCount must be a positive integer');
  }
  if (!Number.isInteger(maxTextureSize) || maxTextureSize <= 0) {
    throw new Error('maxTextureSize must be a positive integer');
  }
  const width = Math.min(maxTextureSize, nodeCount);
  const height = Math.ceil(nodeCount / width);
  if (height > maxTextureSize) {
    throw new Error('nodeCount exceeds representable node-time texture capacity');
  }
  return { width, height, size: width * height };
}

function createWebGlShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('failed to allocate WebGL shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const infoLog = gl.getShaderInfoLog(shader) ?? 'unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${infoLog}`);
  }
  return shader;
}

function createWebGlProgram(gl, vertexShaderSource, fragmentShaderSource) {
  const vertexShader = createWebGlShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createWebGlShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error('failed to allocate WebGL program');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const infoLog = gl.getProgramInfoLog(program) ?? 'unknown program link error';
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${infoLog}`);
  }

  return program;
}

export function createWebGlIsochroneRenderer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('canvas must provide getContext("webgl")');
  }

  const contextAttributes = {
    alpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    ...options.contextAttributes,
  };
  const contextWebGl2 = canvas.getContext('webgl2', contextAttributes);
  const contextWebGl = canvas.getContext('webgl', contextAttributes);
  const gl = contextWebGl2 ?? contextWebGl;
  if (!gl) {
    return null;
  }

  const isWebGl2 =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const vertexShaderSource = isWebGl2
    ? `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main(void) {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`
    : `attribute vec2 a_position;
varying vec2 v_uv;
void main(void) {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;
  const fragmentShaderSource = isWebGl2
    ? `#version 300 es
precision mediump float;
uniform sampler2D u_texture;
uniform vec2 u_texture_size_px;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
in vec2 v_uv;
out vec4 outColor;
void main(void) {
  vec2 screenPx = vec2(v_uv.x * u_viewport_px.x, (1.0 - v_uv.y) * u_viewport_px.y);
  vec2 samplePx = u_view_offset_px + screenPx / max(u_view_scale, 1.0);
  vec2 sampleUv = samplePx / u_texture_size_px;
  if (sampleUv.x < 0.0 || sampleUv.y < 0.0 || sampleUv.x > 1.0 || sampleUv.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  outColor = texture(u_texture, sampleUv);
}`
    : `precision mediump float;
uniform sampler2D u_texture;
uniform vec2 u_texture_size_px;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
varying vec2 v_uv;
void main(void) {
  vec2 screenPx = vec2(v_uv.x * u_viewport_px.x, (1.0 - v_uv.y) * u_viewport_px.y);
  vec2 samplePx = u_view_offset_px + screenPx / max(u_view_scale, 1.0);
  vec2 sampleUv = samplePx / u_texture_size_px;
  if (sampleUv.x < 0.0 || sampleUv.y < 0.0 || sampleUv.x > 1.0 || sampleUv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  gl_FragColor = texture2D(u_texture, sampleUv);
}`;

  const program = createWebGlProgram(gl, vertexShaderSource, fragmentShaderSource);
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  if (positionLocation < 0) {
    gl.deleteProgram(program);
    throw new Error('WebGL program is missing a_position attribute');
  }

  const quadBuffer = gl.createBuffer();
  if (!quadBuffer) {
    gl.deleteProgram(program);
    throw new Error('failed to allocate WebGL quad buffer');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const texture = gl.createTexture();
  if (!texture) {
    gl.deleteBuffer(quadBuffer);
    gl.deleteProgram(program);
    throw new Error('failed to allocate WebGL texture');
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const textureLocation = gl.getUniformLocation(program, 'u_texture');
  const textureSizeLocation = gl.getUniformLocation(program, 'u_texture_size_px');
  const viewportSizeLocation = gl.getUniformLocation(program, 'u_viewport_px');
  const textureViewOffsetLocation = gl.getUniformLocation(program, 'u_view_offset_px');
  const textureViewScaleLocation = gl.getUniformLocation(program, 'u_view_scale');
  const bindQuadToProgram = (programToBind, positionLocationToBind) => {
    gl.useProgram(programToBind);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(positionLocationToBind);
    gl.vertexAttribPointer(positionLocationToBind, 2, gl.FLOAT, false, 0, 0);
  };

  let travelTimeProgram = null;
  let travelTimePositionLocation = -1;
  let travelTimeTexture = null;
  let travelTimeTextureLocation = null;
  let travelTimeCycleMinutesLocation = null;
  let travelTimeThemeVariantLocation = null;
  let travelTimeTextureSizeLocation = null;
  let travelTimeViewportSizeLocation = null;
  let travelTimeViewOffsetLocation = null;
  let travelTimeViewScaleLocation = null;

  if (isWebGl2) {
    const travelTimeFragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_time_texture;
uniform float u_cycle_minutes;
uniform float u_theme_variant;
uniform vec2 u_texture_size_px;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
in vec2 v_uv;
out vec4 outColor;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  vec2 screenPx = vec2(v_uv.x * u_viewport_px.x, (1.0 - v_uv.y) * u_viewport_px.y);
  vec2 samplePx = u_view_offset_px + screenPx / max(u_view_scale, 1.0);
  vec2 sampleUv = samplePx / u_texture_size_px;
  if (sampleUv.x < 0.0 || sampleUv.y < 0.0 || sampleUv.x > 1.0 || sampleUv.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float seconds = texture(u_time_texture, sampleUv).r;
  if (seconds < 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio, u_theme_variant) / 255.0;
  outColor = vec4(rgb, 1.0);
}`;

    travelTimeProgram = createWebGlProgram(gl, vertexShaderSource, travelTimeFragmentSource);
    travelTimePositionLocation = gl.getAttribLocation(travelTimeProgram, 'a_position');
    if (travelTimePositionLocation < 0) {
      gl.deleteProgram(travelTimeProgram);
      travelTimeProgram = null;
    } else {
      travelTimeTexture = gl.createTexture();
      if (!travelTimeTexture) {
        gl.deleteProgram(travelTimeProgram);
        travelTimeProgram = null;
      } else {
        gl.bindTexture(gl.TEXTURE_2D, travelTimeTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        travelTimeTextureLocation = gl.getUniformLocation(travelTimeProgram, 'u_time_texture');
        travelTimeCycleMinutesLocation = gl.getUniformLocation(travelTimeProgram, 'u_cycle_minutes');
        travelTimeThemeVariantLocation = gl.getUniformLocation(travelTimeProgram, 'u_theme_variant');
        travelTimeTextureSizeLocation = gl.getUniformLocation(travelTimeProgram, 'u_texture_size_px');
        travelTimeViewportSizeLocation = gl.getUniformLocation(travelTimeProgram, 'u_viewport_px');
        travelTimeViewOffsetLocation = gl.getUniformLocation(travelTimeProgram, 'u_view_offset_px');
        travelTimeViewScaleLocation = gl.getUniformLocation(travelTimeProgram, 'u_view_scale');
      }
    }
  }

  const edgeVertexShaderSource = isWebGl2
    ? `#version 300 es
in vec2 a_position_px;
in float a_seconds;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
out float v_seconds;
void main(void) {
  vec2 viewPositionPx = (a_position_px - u_view_offset_px) * u_view_scale;
  vec2 clip = vec2(
    (viewPositionPx.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (viewPositionPx.y / u_viewport_px.y) * 2.0
  );
  v_seconds = a_seconds;
  gl_Position = vec4(clip, 0.0, 1.0);
}`
    : `attribute vec2 a_position_px;
attribute float a_seconds;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
varying float v_seconds;
void main(void) {
  vec2 viewPositionPx = (a_position_px - u_view_offset_px) * u_view_scale;
  vec2 clip = vec2(
    (viewPositionPx.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (viewPositionPx.y / u_viewport_px.y) * 2.0
  );
  v_seconds = a_seconds;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;
  const edgeFragmentShaderSource = isWebGl2
    ? `#version 300 es
precision highp float;
uniform float u_cycle_minutes;
uniform float u_alpha;
uniform float u_theme_variant;
in float v_seconds;
out vec4 outColor;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  if (v_seconds < 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(v_seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio, u_theme_variant) / 255.0;
  outColor = vec4(rgb, u_alpha);
}`
    : `precision highp float;
uniform float u_cycle_minutes;
uniform float u_alpha;
uniform float u_theme_variant;
varying float v_seconds;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  if (v_seconds < 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(v_seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio, u_theme_variant) / 255.0;
  gl_FragColor = vec4(rgb, u_alpha);
}`;
  const edgeProgram = createWebGlProgram(gl, edgeVertexShaderSource, edgeFragmentShaderSource);
  const edgePositionLocation = gl.getAttribLocation(edgeProgram, 'a_position_px');
  const edgeSecondsLocation = gl.getAttribLocation(edgeProgram, 'a_seconds');
  if (edgePositionLocation < 0 || edgeSecondsLocation < 0) {
    gl.deleteProgram(edgeProgram);
    throw new Error('WebGL edge program is missing required attributes');
  }
  const edgeViewportLocation = gl.getUniformLocation(edgeProgram, 'u_viewport_px');
  const edgeViewOffsetLocation = gl.getUniformLocation(edgeProgram, 'u_view_offset_px');
  const edgeViewScaleLocation = gl.getUniformLocation(edgeProgram, 'u_view_scale');
  const edgeCycleMinutesLocation = gl.getUniformLocation(edgeProgram, 'u_cycle_minutes');
  const edgeAlphaLocation = gl.getUniformLocation(edgeProgram, 'u_alpha');
  const edgeThemeVariantLocation = gl.getUniformLocation(edgeProgram, 'u_theme_variant');
  const edgeVertexBuffer = gl.createBuffer();
  if (!edgeVertexBuffer) {
    gl.deleteProgram(edgeProgram);
    throw new Error('failed to allocate WebGL edge vertex buffer');
  }
  let edgeVertexBufferCapacityFloats = 0;
  let lastUploadedEdgeVertexDataRef = null;
  let lastUploadedEdgeVertexDataLength = 0;
  const ensureEdgeVertexBufferCapacity = (requiredFloats) => {
    if (!Number.isInteger(requiredFloats) || requiredFloats <= 0) {
      throw new Error('requiredFloats must be a positive integer');
    }
    if (edgeVertexBufferCapacityFloats >= requiredFloats) {
      return;
    }
    let nextCapacityFloats = Math.max(1024, edgeVertexBufferCapacityFloats || 1024);
    while (nextCapacityFloats < requiredFloats) {
      nextCapacityFloats *= 2;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeVertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      nextCapacityFloats * Float32Array.BYTES_PER_ELEMENT,
      gl.DYNAMIC_DRAW,
    );
    edgeVertexBufferCapacityFloats = nextCapacityFloats;
  };

  let indexedEdgeProgram = null;
  let indexedEdgePositionLocation = -1;
  let indexedEdgeSourceNodeLocation = -1;
  let indexedEdgeTargetNodeLocation = -1;
  let indexedEdgeCostLocation = -1;
  let indexedEdgeEndpointLocation = -1;
  let indexedEdgeViewportLocation = null;
  let indexedEdgeViewOffsetLocation = null;
  let indexedEdgeViewScaleLocation = null;
  let indexedEdgeCycleMinutesLocation = null;
  let indexedEdgeAlphaLocation = null;
  let indexedEdgeThemeVariantLocation = null;
  let indexedEdgeSlackSecondsLocation = null;
  let indexedEdgeNodeTimeTextureLocation = null;
  let indexedEdgeNodeTimeTextureSizeLocation = null;
  let indexedEdgeNodeTimeTexture = null;
  let indexedEdgeNodeTimeTextureWidth = 0;
  let indexedEdgeNodeTimeTextureHeight = 0;
  let indexedEdgeNodeTimeTextureUploadBuffer = null;
  let indexedEdgeNodeTimeTextureFloat64Bridge = null;
  let indexedEdgeMaxTextureSize = 0;
  let lastUploadedIndexedEdgeVertexDataRef = null;
  let lastUploadedIndexedEdgeVertexDataLength = 0;

  if (isWebGl2) {
    const indexedEdgeVertexShaderSource = `#version 300 es
precision highp float;
in vec2 a_position_px;
in float a_source_node_index;
in float a_target_node_index;
in float a_edge_cost_seconds;
in float a_endpoint_t;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
uniform sampler2D u_node_time_texture;
uniform ivec2 u_node_time_texture_size;
uniform float u_edge_slack_seconds;
out float v_seconds;
out float v_visible;

float readNodeSeconds(float nodeIndexFloat) {
  int nodeIndex = int(nodeIndexFloat + 0.5);
  int textureWidth = u_node_time_texture_size.x;
  int x = nodeIndex % textureWidth;
  int y = nodeIndex / textureWidth;
  return texelFetch(u_node_time_texture, ivec2(x, y), 0).r;
}

bool isFiniteSeconds(float value) {
  return !(isnan(value) || isinf(value));
}

void main(void) {
  vec2 viewPositionPx = (a_position_px - u_view_offset_px) * u_view_scale;
  vec2 clip = vec2(
    (viewPositionPx.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (viewPositionPx.y / u_viewport_px.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);

  float startSeconds = readNodeSeconds(a_source_node_index);
  float targetSeconds = readNodeSeconds(a_target_node_index);
  float expectedTargetSeconds = startSeconds + a_edge_cost_seconds;
  bool visible = isFiniteSeconds(startSeconds)
    && isFiniteSeconds(targetSeconds)
    && isFiniteSeconds(a_edge_cost_seconds)
    && a_edge_cost_seconds > 0.0
    && expectedTargetSeconds <= targetSeconds + u_edge_slack_seconds;
  v_visible = visible ? 1.0 : 0.0;
  if (!visible) {
    v_seconds = -1.0;
    return;
  }
  v_seconds = mix(startSeconds, expectedTargetSeconds, a_endpoint_t);
}`;
    const indexedEdgeFragmentShaderSource = `#version 300 es
precision highp float;
uniform float u_cycle_minutes;
uniform float u_alpha;
uniform float u_theme_variant;
in float v_seconds;
in float v_visible;
out vec4 outColor;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  if (v_visible < 0.5 || v_seconds < 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(v_seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio, u_theme_variant) / 255.0;
  outColor = vec4(rgb, u_alpha);
}`;
    try {
      indexedEdgeProgram = createWebGlProgram(
        gl,
        indexedEdgeVertexShaderSource,
        indexedEdgeFragmentShaderSource,
      );
      indexedEdgePositionLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_position_px');
      indexedEdgeSourceNodeLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_source_node_index');
      indexedEdgeTargetNodeLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_target_node_index');
      indexedEdgeCostLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_edge_cost_seconds');
      indexedEdgeEndpointLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_endpoint_t');
      if (
        indexedEdgePositionLocation < 0
        || indexedEdgeSourceNodeLocation < 0
        || indexedEdgeTargetNodeLocation < 0
        || indexedEdgeCostLocation < 0
        || indexedEdgeEndpointLocation < 0
      ) {
        gl.deleteProgram(indexedEdgeProgram);
        indexedEdgeProgram = null;
      } else {
        indexedEdgeViewportLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_viewport_px');
        indexedEdgeViewOffsetLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_view_offset_px');
        indexedEdgeViewScaleLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_view_scale');
        indexedEdgeCycleMinutesLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_cycle_minutes');
        indexedEdgeAlphaLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_alpha');
        indexedEdgeThemeVariantLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_theme_variant');
        indexedEdgeSlackSecondsLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_edge_slack_seconds');
        indexedEdgeNodeTimeTextureLocation = gl.getUniformLocation(
          indexedEdgeProgram,
          'u_node_time_texture',
        );
        indexedEdgeNodeTimeTextureSizeLocation = gl.getUniformLocation(
          indexedEdgeProgram,
          'u_node_time_texture_size',
        );
        indexedEdgeNodeTimeTexture = gl.createTexture();
        if (!indexedEdgeNodeTimeTexture) {
          gl.deleteProgram(indexedEdgeProgram);
          indexedEdgeProgram = null;
        } else {
          gl.bindTexture(gl.TEXTURE_2D, indexedEdgeNodeTimeTexture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          indexedEdgeMaxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        }
      }
    } catch (error) {
      console.warn(
        'Indexed WebGL edge renderer initialization failed; falling back to packed edge-time buffers.',
        error,
      );
      if (indexedEdgeProgram) {
        gl.deleteProgram(indexedEdgeProgram);
      }
      indexedEdgeProgram = null;
      indexedEdgeNodeTimeTexture = null;
    }
  }

  const uploadIndexedEdgeNodeTimesTexture = (distSeconds) => {
    if (!(distSeconds instanceof Float32Array) && !(distSeconds instanceof Float64Array)) {
      throw new Error('distSeconds must be a Float32Array or Float64Array');
    }
    if (!indexedEdgeNodeTimeTexture || indexedEdgeMaxTextureSize <= 0) {
      throw new Error('indexed edge node-time texture is unavailable');
    }
    const { width, height, size } = computeNodeTimeTextureDimensions(
      distSeconds.length,
      indexedEdgeMaxTextureSize,
    );
    if (width !== indexedEdgeNodeTimeTextureWidth || height !== indexedEdgeNodeTimeTextureHeight) {
      indexedEdgeNodeTimeTextureWidth = width;
      indexedEdgeNodeTimeTextureHeight = height;
      gl.bindTexture(gl.TEXTURE_2D, indexedEdgeNodeTimeTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        width,
        height,
        0,
        gl.RED,
        gl.FLOAT,
        null,
      );
    }

    let uploadData = distSeconds;
    if (distSeconds instanceof Float64Array) {
      if (
        !(indexedEdgeNodeTimeTextureFloat64Bridge instanceof Float32Array)
        || indexedEdgeNodeTimeTextureFloat64Bridge.length !== distSeconds.length
      ) {
        indexedEdgeNodeTimeTextureFloat64Bridge = new Float32Array(distSeconds.length);
      }
      indexedEdgeNodeTimeTextureFloat64Bridge.set(distSeconds);
      uploadData = indexedEdgeNodeTimeTextureFloat64Bridge;
    }
    if (size !== uploadData.length) {
      if (
        !(indexedEdgeNodeTimeTextureUploadBuffer instanceof Float32Array)
        || indexedEdgeNodeTimeTextureUploadBuffer.length !== size
      ) {
        indexedEdgeNodeTimeTextureUploadBuffer = new Float32Array(size);
      }
      indexedEdgeNodeTimeTextureUploadBuffer.fill(Number.POSITIVE_INFINITY);
      indexedEdgeNodeTimeTextureUploadBuffer.set(uploadData);
      uploadData = indexedEdgeNodeTimeTextureUploadBuffer;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, indexedEdgeNodeTimeTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      gl.RED,
      gl.FLOAT,
      uploadData,
    );
    return { width, height };
  };

  const resolveRendererViewport = (graphWidthPx, graphHeightPx, viewport) =>
    resolveViewportFrame(
      {
        gridWidthPx: graphWidthPx,
        gridHeightPx: graphHeightPx,
      },
      viewport,
      {
        frameWidthPx: canvas.width,
        frameHeightPx: canvas.height,
      },
    );

  const renderer = {
    mode: 'webgl',
    clear(options = {}) {
      syncCanvasToDisplaySize(canvas);
      const targetWidthPx = options.widthPx ?? canvas.width;
      const targetHeightPx = options.heightPx ?? canvas.height;
      if (!Number.isFinite(targetWidthPx) || targetWidthPx <= 0) {
        throw new Error('options.widthPx (or canvas.width) must be positive');
      }
      if (!Number.isFinite(targetHeightPx) || targetHeightPx <= 0) {
        throw new Error('options.heightPx (or canvas.height) must be positive');
      }

      const widthPx = Math.floor(targetWidthPx);
      const heightPx = Math.floor(targetHeightPx);
      if (canvas.width !== widthPx) {
        canvas.width = widthPx;
      }
      if (canvas.height !== heightPx) {
        canvas.height = heightPx;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    draw(pixelGrid, options = {}) {
      validatePixelGrid(pixelGrid);
      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        canvas.width = pixelGrid.widthPx;
        canvas.height = pixelGrid.heightPx;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      const viewport = resolveRendererViewport(pixelGrid.widthPx, pixelGrid.heightPx, options.viewport);
      bindQuadToProgram(program, positionLocation);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        pixelGrid.widthPx,
        pixelGrid.heightPx,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixelGrid.rgba,
      );
      if (textureLocation !== null) {
        gl.uniform1i(textureLocation, 0);
      }
      if (textureSizeLocation !== null) {
        gl.uniform2f(textureSizeLocation, pixelGrid.widthPx, pixelGrid.heightPx);
      }
      if (viewportSizeLocation !== null) {
        gl.uniform2f(viewportSizeLocation, canvas.width, canvas.height);
      }
      if (textureViewOffsetLocation !== null) {
        gl.uniform2f(textureViewOffsetLocation, viewport.offsetXPx, viewport.offsetYPx);
      }
      if (textureViewScaleLocation !== null) {
        gl.uniform1f(textureViewScaleLocation, viewport.effectiveScale);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return null;
    },
    drawTravelTimeEdges(edgeVertexData, options = {}) {
      if (!(edgeVertexData instanceof Float32Array)) {
        throw new Error('edgeVertexData must be a Float32Array');
      }
      if (edgeVertexData.length % 6 !== 0) {
        throw new Error('edgeVertexData length must be a multiple of 6 (x0,y0,t0,x1,y1,t1)');
      }
      const append = options.append ?? false;
      if (edgeVertexData.length === 0) {
        if (!append) {
          lastUploadedEdgeVertexDataRef = null;
          lastUploadedEdgeVertexDataLength = 0;
        }
        return 0;
      }

      const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
      const themeVariant = getIsochroneThemeVariant(options.colourTheme ?? 'dark');
      const alpha = Number.isFinite(options.alpha) ? options.alpha : 1;
      const clampedAlpha = Math.max(0, Math.min(1, alpha));
      const reuseUploadedGeometry = options.reuseUploadedGeometry === true;
      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        const fallbackWidthPx = options.graphWidthPx ?? canvas.width;
        const fallbackHeightPx = options.graphHeightPx ?? canvas.height;
        canvas.width = Math.max(1, Math.floor(fallbackWidthPx));
        canvas.height = Math.max(1, Math.floor(fallbackHeightPx));
      }
      const graphWidthPx = options.graphWidthPx ?? canvas.width;
      const graphHeightPx = options.graphHeightPx ?? canvas.height;
      const viewport = resolveRendererViewport(graphWidthPx, graphHeightPx, options.viewport);

      gl.viewport(0, 0, canvas.width, canvas.height);
      if (!append) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(edgeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, edgeVertexBuffer);
      ensureEdgeVertexBufferCapacity(edgeVertexData.length);
      const shouldUploadGeometry = shouldUploadEdgeGeometry(
        lastUploadedEdgeVertexDataRef,
        lastUploadedEdgeVertexDataLength,
        edgeVertexData,
        {
          append,
          reuseUploadedGeometry,
        },
      );
      if (shouldUploadGeometry) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeVertexData);
      }
      gl.enableVertexAttribArray(edgePositionLocation);
      gl.vertexAttribPointer(edgePositionLocation, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(edgeSecondsLocation);
      gl.vertexAttribPointer(edgeSecondsLocation, 1, gl.FLOAT, false, 12, 8);
      if (edgeViewportLocation !== null) {
        gl.uniform2f(edgeViewportLocation, canvas.width, canvas.height);
      }
      if (edgeViewOffsetLocation !== null) {
        gl.uniform2f(edgeViewOffsetLocation, viewport.offsetXPx, viewport.offsetYPx);
      }
      if (edgeViewScaleLocation !== null) {
        gl.uniform1f(edgeViewScaleLocation, viewport.effectiveScale);
      }
      if (edgeCycleMinutesLocation !== null) {
        gl.uniform1f(edgeCycleMinutesLocation, cycleMinutes);
      }
      if (edgeAlphaLocation !== null) {
        gl.uniform1f(edgeAlphaLocation, clampedAlpha);
      }
      if (edgeThemeVariantLocation !== null) {
        gl.uniform1f(edgeThemeVariantLocation, themeVariant);
      }
      gl.drawArrays(gl.LINES, 0, edgeVertexData.length / 3);
      if (!append) {
        lastUploadedEdgeVertexDataRef = edgeVertexData;
        lastUploadedEdgeVertexDataLength = edgeVertexData.length;
      } else {
        lastUploadedEdgeVertexDataRef = null;
        lastUploadedEdgeVertexDataLength = 0;
      }
      return edgeVertexData.length / 6;
    },
    drawTravelTimeEdgesFromNodeTimes(edgeVertexData, distSeconds, options = {}) {
      if (!indexedEdgeProgram || !indexedEdgeNodeTimeTexture) {
        throw new Error('indexed WebGL edge renderer is unavailable');
      }
      if (!(edgeVertexData instanceof Float32Array)) {
        throw new Error('edgeVertexData must be a Float32Array');
      }
      if (edgeVertexData.length % 12 !== 0) {
        throw new Error(
          'edgeVertexData length must be a multiple of 12 (two vertices of six floats per edge)',
        );
      }
      if (!(distSeconds instanceof Float32Array) && !(distSeconds instanceof Float64Array)) {
        throw new Error('distSeconds must be a Float32Array or Float64Array');
      }
      const append = options.append ?? false;
      if (edgeVertexData.length === 0 || distSeconds.length === 0) {
        if (!append) {
          lastUploadedIndexedEdgeVertexDataRef = null;
          lastUploadedIndexedEdgeVertexDataLength = 0;
        }
        return 0;
      }

      const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
      const themeVariant = getIsochroneThemeVariant(options.colourTheme ?? 'dark');
      const alpha = Number.isFinite(options.alpha) ? options.alpha : 1;
      const clampedAlpha = Math.max(0, Math.min(1, alpha));
      const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
      if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
        throw new Error('options.edgeSlackSeconds must be a non-negative finite number');
      }
      const reuseUploadedGeometry = options.reuseUploadedGeometry === true;
      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        const fallbackWidthPx = options.graphWidthPx ?? canvas.width;
        const fallbackHeightPx = options.graphHeightPx ?? canvas.height;
        canvas.width = Math.max(1, Math.floor(fallbackWidthPx));
        canvas.height = Math.max(1, Math.floor(fallbackHeightPx));
      }
      const graphWidthPx = options.graphWidthPx ?? canvas.width;
      const graphHeightPx = options.graphHeightPx ?? canvas.height;
      const viewport = resolveRendererViewport(graphWidthPx, graphHeightPx, options.viewport);

      gl.viewport(0, 0, canvas.width, canvas.height);
      if (!append) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(indexedEdgeProgram);

      const textureDimensions = uploadIndexedEdgeNodeTimesTexture(distSeconds);
      if (indexedEdgeNodeTimeTextureLocation !== null) {
        gl.uniform1i(indexedEdgeNodeTimeTextureLocation, 0);
      }
      if (indexedEdgeNodeTimeTextureSizeLocation !== null) {
        gl.uniform2i(
          indexedEdgeNodeTimeTextureSizeLocation,
          textureDimensions.width,
          textureDimensions.height,
        );
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, edgeVertexBuffer);
      ensureEdgeVertexBufferCapacity(edgeVertexData.length);
      const shouldUploadGeometry = shouldUploadEdgeGeometry(
        lastUploadedIndexedEdgeVertexDataRef,
        lastUploadedIndexedEdgeVertexDataLength,
        edgeVertexData,
        {
          append,
          reuseUploadedGeometry,
        },
      );
      if (shouldUploadGeometry) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeVertexData);
      }
      gl.enableVertexAttribArray(indexedEdgePositionLocation);
      gl.vertexAttribPointer(indexedEdgePositionLocation, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(indexedEdgeSourceNodeLocation);
      gl.vertexAttribPointer(indexedEdgeSourceNodeLocation, 1, gl.FLOAT, false, 24, 8);
      gl.enableVertexAttribArray(indexedEdgeTargetNodeLocation);
      gl.vertexAttribPointer(indexedEdgeTargetNodeLocation, 1, gl.FLOAT, false, 24, 12);
      gl.enableVertexAttribArray(indexedEdgeCostLocation);
      gl.vertexAttribPointer(indexedEdgeCostLocation, 1, gl.FLOAT, false, 24, 16);
      gl.enableVertexAttribArray(indexedEdgeEndpointLocation);
      gl.vertexAttribPointer(indexedEdgeEndpointLocation, 1, gl.FLOAT, false, 24, 20);
      if (indexedEdgeViewportLocation !== null) {
        gl.uniform2f(indexedEdgeViewportLocation, canvas.width, canvas.height);
      }
      if (indexedEdgeViewOffsetLocation !== null) {
        gl.uniform2f(indexedEdgeViewOffsetLocation, viewport.offsetXPx, viewport.offsetYPx);
      }
      if (indexedEdgeViewScaleLocation !== null) {
        gl.uniform1f(indexedEdgeViewScaleLocation, viewport.effectiveScale);
      }
      if (indexedEdgeCycleMinutesLocation !== null) {
        gl.uniform1f(indexedEdgeCycleMinutesLocation, cycleMinutes);
      }
      if (indexedEdgeAlphaLocation !== null) {
        gl.uniform1f(indexedEdgeAlphaLocation, clampedAlpha);
      }
      if (indexedEdgeThemeVariantLocation !== null) {
        gl.uniform1f(indexedEdgeThemeVariantLocation, themeVariant);
      }
      if (indexedEdgeSlackSecondsLocation !== null) {
        gl.uniform1f(indexedEdgeSlackSecondsLocation, edgeSlackSeconds);
      }
      gl.drawArrays(gl.LINES, 0, edgeVertexData.length / 6);
      if (!append) {
        lastUploadedIndexedEdgeVertexDataRef = edgeVertexData;
        lastUploadedIndexedEdgeVertexDataLength = edgeVertexData.length;
      } else {
        lastUploadedIndexedEdgeVertexDataRef = null;
        lastUploadedIndexedEdgeVertexDataLength = 0;
      }
      return edgeVertexData.length / 12;
    },
    readPixelsRgba(samplePixels) {
      if (!Array.isArray(samplePixels)) {
        throw new Error('samplePixels must be an array of [x, y] pairs');
      }

      const sampledRgba = new Uint8Array(samplePixels.length * 4);
      const onePixel = new Uint8Array(4);
      for (let sampleIndex = 0; sampleIndex < samplePixels.length; sampleIndex += 1) {
        const sample = samplePixels[sampleIndex];
        if (!Array.isArray(sample) || sample.length < 2) {
          throw new Error('samplePixels must contain [x, y] pairs');
        }
        const xPx = clampInt(Math.round(sample[0]), 0, canvas.width - 1);
        const yPx = clampInt(Math.round(sample[1]), 0, canvas.height - 1);
        const yReadPx = canvas.height - 1 - yPx;
        gl.readPixels(xPx, yReadPx, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePixel);
        sampledRgba[sampleIndex * 4] = onePixel[0];
        sampledRgba[sampleIndex * 4 + 1] = onePixel[1];
        sampledRgba[sampleIndex * 4 + 2] = onePixel[2];
        sampledRgba[sampleIndex * 4 + 3] = onePixel[3];
      }

      return sampledRgba;
    },
  };

  if (!indexedEdgeProgram || !indexedEdgeNodeTimeTexture) {
    delete renderer.drawTravelTimeEdgesFromNodeTimes;
  }

  if (travelTimeProgram && travelTimeTexture && isWebGl2) {
    renderer.drawTravelTimeGrid = function drawTravelTimeGrid(travelTimeGrid, options = {}) {
      validateTravelTimeGrid(travelTimeGrid);

      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        canvas.width = travelTimeGrid.widthPx;
        canvas.height = travelTimeGrid.heightPx;
      }

      const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
      const themeVariant = getIsochroneThemeVariant(options.colourTheme ?? 'dark');
      const viewport = resolveRendererViewport(
        travelTimeGrid.widthPx,
        travelTimeGrid.heightPx,
        options.viewport,
      );
      gl.viewport(0, 0, canvas.width, canvas.height);
      bindQuadToProgram(travelTimeProgram, travelTimePositionLocation);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, travelTimeTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        travelTimeGrid.widthPx,
        travelTimeGrid.heightPx,
        0,
        gl.RED,
        gl.FLOAT,
        travelTimeGrid.seconds,
      );
      if (travelTimeTextureLocation !== null) {
        gl.uniform1i(travelTimeTextureLocation, 0);
      }
      if (travelTimeTextureSizeLocation !== null) {
        gl.uniform2f(travelTimeTextureSizeLocation, travelTimeGrid.widthPx, travelTimeGrid.heightPx);
      }
      if (travelTimeViewportSizeLocation !== null) {
        gl.uniform2f(travelTimeViewportSizeLocation, canvas.width, canvas.height);
      }
      if (travelTimeViewOffsetLocation !== null) {
        gl.uniform2f(travelTimeViewOffsetLocation, viewport.offsetXPx, viewport.offsetYPx);
      }
      if (travelTimeViewScaleLocation !== null) {
        gl.uniform1f(travelTimeViewScaleLocation, viewport.effectiveScale);
      }
      if (travelTimeCycleMinutesLocation !== null) {
        gl.uniform1f(travelTimeCycleMinutesLocation, cycleMinutes);
      }
      if (travelTimeThemeVariantLocation !== null) {
        gl.uniform1f(travelTimeThemeVariantLocation, themeVariant);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return null;
    };
  }

  return renderer;
}

export function createIsochroneRenderer(canvas, options = {}) {
  try {
    const webglRenderer = createWebGlIsochroneRenderer(canvas, options);
    return webglRenderer ?? createCanvas2dIsochroneRenderer(canvas);
  } catch (error) {
    console.warn('WebGL renderer initialization failed; falling back to 2D canvas renderer.', error);
    return createCanvas2dIsochroneRenderer(canvas);
  }
}

function getShellLocaleMessages(shell) {
  return shell?.localeMessages && typeof shell.localeMessages === 'object' ? shell.localeMessages : null;
}

function getLocalizedShellText(shell, key, fallbackValue, values = {}) {
  return formatCommonMessage(getShellLocaleMessages(shell), key, values, fallbackValue);
}

function getWasmRequiredMessage(shell) {
  return getCommonMessage(
    getShellLocaleMessages(shell),
    'error.wasm.required',
    WASM_REQUIRED_MESSAGE,
  );
}

function formatInitialGraphLoadingText(shell) {
  return getLocalizedShellText(shell, 'loading.graph.initial', 'Loading graph: 0.00 MB');
}

export function getRoutingFailedStatusText(shell) {
  return getLocalizedShellText(shell, 'error.routing.failed', 'Routing failed.');
}

export function formatRenderBackendBadgeText(rendererMode, options = {}) {
  const messages = options.messages ?? null;
  if (rendererMode === 'webgl') {
    return formatCommonMessage(messages, 'status.renderer.webgl', {}, 'Renderer: WebGL');
  }
  return formatCommonMessage(messages, 'status.renderer.cpu', {}, 'Renderer: CPU');
}

function updateRenderBackendBadge(shell, renderer) {
  if (!shell || typeof shell !== 'object' || !shell.renderBackendBadge) {
    return;
  }

  const rendererMode = renderer?.mode === 'webgl' ? 'webgl' : 'cpu';
  const nextText = formatRenderBackendBadgeText(rendererMode, {
    messages: getShellLocaleMessages(shell),
  });
  if (shell.renderBackendBadge.textContent !== nextText) {
    shell.renderBackendBadge.textContent = nextText;
  }
  shell.renderBackendBadge.dataset.backend = rendererMode;
}

function getOrCreateIsochroneRenderer(canvas) {
  const cached = canvas.__isochroneRenderer;
  if (cached && typeof cached.draw === 'function') {
    return cached;
  }

  const renderer = createIsochroneRenderer(canvas);
  canvas.__isochroneRenderer = renderer;
  return renderer;
}

export function blitPixelGridToCanvas(canvas, pixelGrid, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('canvas must provide getContext("2d")');
  }
  validatePixelGrid(pixelGrid);
  const renderer = getOrCreateIsochroneRenderer(canvas);
  return renderer.draw(pixelGrid, { viewport: options.viewport });
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
    });
  } else {
    clearGrid(mapData.pixelGrid);
    blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, { viewport });
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
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, { viewport }),
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
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid, { viewport }),
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
  const allowedModeMask = searchState.allowedModeMask ?? EDGE_MODE_CAR_BIT;
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

export function formatRoutingStatusCalculating(settledCount, options = {}) {
  const safeCount = Math.max(0, Math.floor(settledCount));
  return formatCommonMessage(
    options.messages ?? null,
    'routing.calculating',
    { settledCount: safeCount },
    `Calculating... (${safeCount} nodes settled)`,
  );
}

function formatRoutingDurationSuffix(durationMs, options = {}) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  const roundedDurationMs = Math.max(0, Math.round(durationMs));
  return formatCommonMessage(
    options.messages ?? null,
    'routing.durationSuffix',
    { durationMs: roundedDurationMs },
    ` (${roundedDurationMs} ms)`,
  );
}

export function formatRoutingStatusDone(durationMs = null, options = {}) {
  return formatCommonMessage(
    options.messages ?? null,
    'routing.done',
    { durationSuffix: formatRoutingDurationSuffix(durationMs, options) },
    `Done - full travel-time field ready${formatRoutingDurationSuffix(durationMs, options)}`,
  );
}

export function formatRoutingStatusPreview(durationMs = null, options = {}) {
  return formatCommonMessage(
    options.messages ?? null,
    'routing.preview',
    { durationSuffix: formatRoutingDurationSuffix(durationMs, options) },
    `Done - preview updated${formatRoutingDurationSuffix(durationMs, options)}`,
  );
}

export function formatRoutingStatusNoReachable(durationMs = null, options = {}) {
  return formatCommonMessage(
    options.messages ?? null,
    'routing.none',
    { durationSuffix: formatRoutingDurationSuffix(durationMs, options) },
    `Done - no reachable network for selected mode at this start point${formatRoutingDurationSuffix(durationMs, options)}`,
  );
}

function getSelectedTransportModeLabels(shell) {
  if (!shell || typeof shell !== 'object' || !shell.modeSelect) {
    return [];
  }
  const labels = [];
  for (const option of shell.modeSelect.selectedOptions ?? []) {
    const label =
      typeof option?.label === 'string' && option.label.trim().length > 0
        ? option.label.trim()
        : typeof option?.textContent === 'string' && option.textContent.trim().length > 0
          ? option.textContent.trim()
          : null;
    if (label) {
      labels.push(label);
    }
  }
  return labels;
}

function setRoutingStatus(shell, text) {
  shell.routingStatus.textContent = text;
}

export function ensureWasmSupportOrShowError(shell, options = {}) {
  if (!shell || typeof shell !== 'object' || !shell.isochroneCanvas) {
    throw new Error('shell.isochroneCanvas is required');
  }
  const runtimeGlobal = options.runtimeGlobal ?? globalThis;
  if (hasWebAssemblySupport(runtimeGlobal)) {
    return true;
  }

  shell.isochroneCanvas.style.pointerEvents = 'none';
  shell.isochroneCanvas.dataset.graphLoaded = 'false';
  const wasmRequiredMessage = getWasmRequiredMessage(shell);
  showLoadingOverlay(shell, wasmRequiredMessage, 0);
  setRoutingStatus(shell, wasmRequiredMessage);
  return false;
}

function updateGraphLoadingText(shell, receivedBytes, totalBytes) {
  const receivedText = formatMebibytes(receivedBytes);
  if (totalBytes === null || totalBytes <= 0) {
    shell.loadingText.textContent = getLocalizedShellText(
      shell,
      'loading.graph.received',
      `Loading graph: ${receivedText}`,
      { received: receivedText },
    );
    return;
  }

  const totalText = formatMebibytes(totalBytes);
  const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
  shell.loadingText.textContent = getLocalizedShellText(
    shell,
    'loading.graph.progress',
    `Loading graph: ${receivedText} / ${totalText} (${percent}%)`,
    { received: receivedText, total: totalText, percent },
  );
  setLoadingProgressBar(shell.loadingProgressBar, percent);
}

function showLoadingOverlay(shell, text, progressPercent) {
  if (shell.loadingFadeTimeoutId !== null) {
    clearTimeout(shell.loadingFadeTimeoutId);
    shell.loadingFadeTimeoutId = null;
  }

  shell.loadingOverlay.hidden = false;
  shell.loadingOverlay.classList.remove('is-fading');
  shell.loadingText.textContent = text;
  setLoadingProgressBar(shell.loadingProgressBar, progressPercent);
}

function fadeOutLoadingOverlay(shell) {
  if (shell.loadingFadeTimeoutId !== null) {
    clearTimeout(shell.loadingFadeTimeoutId);
  }

  shell.loadingOverlay.classList.add('is-fading');
  shell.loadingFadeTimeoutId = setTimeout(() => {
    shell.loadingOverlay.hidden = true;
    shell.loadingOverlay.classList.remove('is-fading');
    shell.loadingFadeTimeoutId = null;
  }, LOADING_FADE_MS);
}

function setLoadingProgressBar(progressBar, progressPercent) {
  const clamped = clampInt(Math.round(progressPercent), 0, 100);
  progressBar.style.width = `${clamped}%`;
}

function parseContentLength(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function formatMebibytes(bytes) {
  const safeBytes = Math.max(0, bytes);
  return `${(safeBytes / BYTES_PER_MEBIBYTE).toFixed(2)} MB`;
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

function validateEdgeTraversalCostSecondsLookup(edgeTraversalCostSeconds, expectedLength) {
  if (edgeTraversalCostSeconds === null || edgeTraversalCostSeconds === undefined) {
    return null;
  }
  if (!(edgeTraversalCostSeconds instanceof Float32Array)) {
    throw new Error('edgeTraversalCostSeconds must be a Float32Array when provided');
  }
  if (edgeTraversalCostSeconds.length < expectedLength) {
    throw new Error('edgeTraversalCostSeconds is too short for edge records');
  }
  return edgeTraversalCostSeconds;
}

function validateNodePixels(nodePixels) {
  if (!nodePixels || typeof nodePixels !== 'object') {
    throw new Error('nodePixels must be an object');
  }
  if (!(nodePixels.nodePixelX instanceof Uint16Array)) {
    throw new Error('nodePixels.nodePixelX must be a Uint16Array');
  }
  if (!(nodePixels.nodePixelY instanceof Uint16Array)) {
    throw new Error('nodePixels.nodePixelY must be a Uint16Array');
  }
  if (nodePixels.nodePixelX.length !== nodePixels.nodePixelY.length) {
    throw new Error('node pixel arrays must have equal lengths');
  }
}

function validateDistSeconds(distSeconds, expectedLength) {
  if (!distSeconds || typeof distSeconds.length !== 'number') {
    throw new Error('distSeconds must be an array-like sequence');
  }
  if (distSeconds.length < expectedLength) {
    throw new Error('distSeconds is shorter than node pixel arrays');
  }
}

function validateSettledBatch(settledBatch) {
  if (!settledBatch || typeof settledBatch[Symbol.iterator] !== 'function') {
    throw new Error('settledBatch must be iterable');
  }
}

function validateSearchState(searchState) {
  if (!searchState || typeof searchState !== 'object') {
    throw new Error('searchState must be an object');
  }
  if (typeof searchState.expandOne !== 'function') {
    throw new Error('searchState.expandOne must be a function');
  }
  if (typeof searchState.isDone !== 'function' && typeof searchState.done !== 'boolean') {
    throw new Error('searchState must expose isDone() or done boolean');
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


function clampInt(value, minValue, maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

function parseCoordinatePair(value, context) {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${context} must be [x, y]`);
  }

  const x = asFiniteNumber(value[0], `${context}[0]`);
  const y = asFiniteNumber(value[1], `${context}[1]`);
  return [x, y];
}

function asFiniteNumber(value, context) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}

function isClosedPath(path) {
  if (path.length < 3) {
    return false;
  }

  const first = path[0];
  const last = path[path.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

if (typeof window !== 'undefined' && typeof globalThis.document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', async () => {
    const localeBundle = await loadCommonLocaleBundle();
    const shell = initializeAppShell(globalThis.document, { localeBundle });
    bindHeaderMenuControl(shell);
    bindPointerButtonInversionControl(shell);
    if (!ensureWasmSupportOrShowError(shell)) {
      return;
    }
    let initializedMapData = null;
    let routingBinding = null;
    const themeBinding = bindThemeControl(shell, {
      onThemeChange(themeValue) {
        if (initializedMapData?.boundaryPayload && initializedMapData?.graph?.header) {
          drawBoundaryBasemapAlignedToGraphGrid(
            shell.boundaryCanvas,
            initializedMapData.boundaryPayload,
            initializedMapData.graph.header,
            {
              colourTheme: themeValue,
              viewport: initializedMapData.viewport,
            },
          );
        }
        const cycleMinutes = getColourCycleMinutesFromShell(shell);
        renderIsochroneLegendIfNeeded(shell, cycleMinutes, { theme: themeValue });
        const rerendered = rerenderIsochroneFromSnapshotWithStatus(shell, initializedMapData, {
          colourTheme: themeValue,
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
        const scaleBarLabel = shell.distanceScaleLabel?.textContent?.trim() ?? '';
        const parsedScaleBarWidthPx = Number.parseFloat(shell.distanceScaleLine?.style?.width ?? '');
        const scaleBarWidthPx =
          Number.isFinite(parsedScaleBarWidthPx) && parsedScaleBarWidthPx > 0
            ? parsedScaleBarWidthPx
            : 96;
        const copyrightNotice =
          shell.routingDisclaimer?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

        let edgeVertexData = new Float32Array(0);
        let cycleMinutes = getColourCycleMinutesFromShell(shell);
        const routingSnapshot = initializedMapData?.lastRoutingSnapshot ?? null;
        if (initializedMapData && routingSnapshot) {
          edgeVertexData = getOrBuildSnapshotEdgeVertexData(initializedMapData, routingSnapshot, {
            allowedModeMask: routingSnapshot.allowedModeMask,
          });
          cycleMinutes = routingSnapshot.colourCycleMinutes;
        }

        return exportCurrentRenderedIsochroneSvg(shell, {
          edgeVertexData,
          cycleMinutes,
          title,
          scaleBarLabel,
          scaleBarWidthPx,
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
    void initializeMapData(shell)
      .then((mapData) => {
        initializedMapData = mapData;
        window.addEventListener('resize', () => {
          if (mapData.boundaryPayload) {
            drawBoundaryBasemapAlignedToGraphGrid(
              shell.boundaryCanvas,
              mapData.boundaryPayload,
              mapData.graph.header,
              {
                colourTheme: resolveIsochroneTheme(),
                viewport: mapData.viewport,
              },
            );
          }
          rerenderIsochroneFromSnapshot(shell, mapData, {
            colourTheme: resolveIsochroneTheme(),
            colourCycleMinutes: getColourCycleMinutesFromShell(shell),
            viewport: mapData.viewport,
          });
          updateDistanceScaleBar(shell, mapData.graph.header, { viewport: mapData.viewport });
        });
        routingBinding = bindCanvasClickRouting(shell, mapData);
      })
      .catch((error) => {
        initializedMapData = null;
        console.error(error);
      });
  });
}
