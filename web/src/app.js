import {
  BYTES_PER_MEBIBYTE,
  DEFAULT_BOUNDARY_BASEMAP_URL,
  DEFAULT_GRAPH_BINARY_URL,
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
  createWalkingSearchState,
  getEdgeTraversalCostSeconds,
  getOrCreateEdgeTraversalCostSecondsCache,
  nodeHasAllowedModeOutgoingEdge,
} from './core/routing.js';
import {
  mapCanvasPixelToGraphMeters,
  mapClientPointToCanvasPixel,
  parseNodeIndexFromLocationSearch,
  persistNodeIndexToLocation,
} from './core/coords.js';
import {
  getAllowedModeMaskFromShell,
  getColourCycleMinutesFromShell,
  initializeAppShell,
  bindModeSelectControl as bindModeSelectControlInternal,
} from './ui/orchestration.js';
import { bindCanvasClickRouting as bindCanvasClickRoutingInternal } from './interaction/canvas-routing.js';
import {
  bindSvgExportControl,
  exportCurrentRenderedIsochroneSvg,
} from './export/svg.js';
import {
  CYCLE_COLOUR_MAP_GLSL,
  DEFAULT_COLOUR_CYCLE_MINUTES,
  timeToColour,
} from './render/colour.js';
import {
  validateGraphForNodePixels,
  validateGraphForRouting,
  validateGraphHeaderForBoundaryAlignment,
} from './core/graph-validation.js';

export { DEFAULT_BOUNDARY_BASEMAP_URL, DEFAULT_GRAPH_BINARY_URL, GRAPH_MAGIC } from './config/constants.js';
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
} from './export/svg.js';
export { timeToColour } from './render/colour.js';
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
    mapClientPointToCanvasPixel,
    parseNodeIndexFromLocationSearch,
    persistNodeIndexToLocation,
    renderIsochroneLegendIfNeeded,
    runWalkingIsochroneFromSourceNode,
    setRoutingStatus,
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

  const allowedModeMask = options.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  const heapStrategy = options.heapStrategy ?? 'decrease-key';
  const searchState = createWalkingSearchState(
    mapData.graph,
    sourceNodeIndex,
    timeLimitSeconds,
    allowedModeMask,
    { heapStrategy },
  );
  const runSummary = await runSearchTimeSlicedWithRendering(shell, mapData, searchState, options);
  if (!runSummary.cancelled) {
    runPostMvpTransitStub(mapData.graph, searchState);
  }
  return runSummary;
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
    requestIsochroneRedraw: options.requestIsochroneRedraw,
  });
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

export function drawBoundaryBasemapAlignedToGraphGrid(boundaryCanvas, payload, graphHeader) {
  if (!boundaryCanvas || typeof boundaryCanvas.getContext !== 'function') {
    throw new Error('boundaryCanvas must provide getContext("2d")');
  }
  validateGraphHeaderForBoundaryAlignment(graphHeader);

  const parsedBoundary = parseBoundaryBasemapPayload(payload);
  const context = boundaryCanvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to get 2D context for boundary canvas');
  }

  boundaryCanvas.width = graphHeader.gridWidthPx;
  boundaryCanvas.height = graphHeader.gridHeightPx;

  context.clearRect(0, 0, boundaryCanvas.width, boundaryCanvas.height);
  context.fillStyle = 'rgba(0, 0, 0, 0)';
  context.strokeStyle = 'rgba(125, 175, 220, 0.55)';
  context.lineWidth = 1.2;
  context.lineJoin = 'round';
  context.lineCap = 'round';

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

  showLoadingOverlay(shell, 'Loading district boundaries...', 0);

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

    showLoadingOverlay(shell, 'Loading graph: 0.00 MB', 0);
    return {
      boundaryPayload: payload,
      boundarySummary: {
        featureCount: parsed.features.length,
        pathCount,
      },
    };
  } catch (error) {
    showLoadingOverlay(shell, 'Failed to load district boundaries.', 0);
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

  showLoadingOverlay(shell, 'Loading graph: 0.00 MB', 0);

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
    showLoadingOverlay(shell, 'Failed to load graph binary.', 0);
    throw error;
  }
}

export async function initializeMapData(shell, options = {}) {
  const boundaryOptions = options.boundaries ?? {};
  const graphOptions = options.graph ?? {};

  try {
    const boundaryLoad = await loadAndRenderBoundaryBasemap(shell, boundaryOptions);
    const graph = await loadGraphBinary(shell, graphOptions);
    shell.isochroneCanvas.width = graph.header.gridWidthPx;
    shell.isochroneCanvas.height = graph.header.gridHeightPx;
    const renderer = getOrCreateIsochroneRenderer(shell.isochroneCanvas);
    updateRenderBackendBadge(shell, renderer);
    layoutMapViewportToContainGraph(shell, graph.header);
    const alignedBoundarySummary = drawBoundaryBasemapAlignedToGraphGrid(
      shell.boundaryCanvas,
      boundaryLoad.boundaryPayload,
      graph.header,
    );
    renderIsochroneLegendIfNeeded(shell, getColourCycleMinutesFromShell(shell));
    updateDistanceScaleBar(shell, graph.header);
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
      graph,
      nodePixels,
      nodeModeMask,
      nodeSpatialIndex,
      pixelGrid,
      travelTimeGrid,
    };
  } catch (error) {
    if (shell.exportSvgButton) {
      shell.exportSvgButton.disabled = true;
    }
    showLoadingOverlay(shell, 'Initialization failed.', 0);
    throw error;
  }
}

export function layoutMapViewportToContainGraph(shell, graphHeader) {
  if (!shell || !shell.mapRegion || !shell.canvasStack) {
    throw new Error('shell.mapRegion and shell.canvasStack are required');
  }

  validateGraphHeaderForBoundaryAlignment(graphHeader);
  const regionRect = shell.mapRegion.getBoundingClientRect();
  if (!(regionRect.width > 0) || !(regionRect.height > 0)) {
    throw new Error('map region must have positive width and height');
  }

  const graphAspect = graphHeader.gridWidthPx / graphHeader.gridHeightPx;
  const regionAspect = regionRect.width / regionRect.height;

  let layoutWidthPx = regionRect.width;
  let layoutHeightPx = regionRect.height;
  if (regionAspect > graphAspect) {
    layoutWidthPx = regionRect.height * graphAspect;
  } else {
    layoutHeightPx = regionRect.width / graphAspect;
  }

  layoutWidthPx = Math.max(1, Math.floor(layoutWidthPx));
  layoutHeightPx = Math.max(1, Math.floor(layoutHeightPx));

  shell.canvasStack.style.aspectRatio = `${graphHeader.gridWidthPx} / ${graphHeader.gridHeightPx}`;
  shell.canvasStack.style.width = `${layoutWidthPx}px`;
  shell.canvasStack.style.height = `${layoutHeightPx}px`;

  return {
    layoutWidthPx,
    layoutHeightPx,
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

export function renderIsochroneLegend(shell, cycleMinutes) {
  if (!shell || typeof shell !== 'object' || !shell.isochroneLegend) {
    throw new Error('shell.isochroneLegend is required');
  }
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive finite number');
  }

  const boundaries = [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1];
  const colours = [
    [0, 255, 255],
    [64, 255, 64],
    [255, 255, 64],
    [255, 140, 0],
    [255, 64, 160],
  ];

  const legendRows = [];
  for (let index = 0; index < colours.length; index += 1) {
    const colour = colours[index];
    const rangeStartMinutes = boundaries[index] * cycleMinutes;
    const rangeEndMinutes = boundaries[index + 1] * cycleMinutes;
    const rangeLabel = `${formatLegendDuration(rangeStartMinutes)}-${formatLegendDuration(rangeEndMinutes)}`;

    legendRows.push(
      `<div class="legend-row"><span class="legend-swatch" style="background: rgb(${colour[0]}, ${colour[1]}, ${colour[2]});"></span><span>${rangeLabel}</span></div>`,
    );
  }
  legendRows.push(
    `<div class="legend-note">Colours repeat every ${formatLegendDuration(cycleMinutes)}.</div>`,
  );

  shell.isochroneLegend.innerHTML = legendRows.join('');
}

export function renderIsochroneLegendIfNeeded(shell, cycleMinutes) {
  if (!shell || typeof shell !== 'object' || !shell.isochroneLegend) {
    throw new Error('shell.isochroneLegend is required');
  }
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive finite number');
  }

  if (shell.lastRenderedLegendCycleMinutes === cycleMinutes) {
    return false;
  }

  renderIsochroneLegend(shell, cycleMinutes);
  shell.lastRenderedLegendCycleMinutes = cycleMinutes;
  return true;
}

export function updateDistanceScaleBar(shell, graphHeader) {
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

  const metresPerCssPixel =
    (graphHeader.gridWidthPx * graphHeader.pixelSizeM) / canvasRect.width;
  const preferredWidthPx = 120;
  const preferredDistanceMetres = preferredWidthPx * metresPerCssPixel;
  const chosenDistanceMetres = pickScaleDistanceMetres(preferredDistanceMetres);
  const lineWidthPx = Math.max(24, Math.round(chosenDistanceMetres / metresPerCssPixel));

  shell.distanceScaleLine.style.width = `${lineWidthPx}px`;
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
    const [r, g, b] = timeToColour(seconds, { cycleMinutes: colourCycleMinutes });
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
  let paintedCount = 0;

  for (let nodeIndex = 0; nodeIndex < nodePixels.nodePixelX.length; nodeIndex += 1) {
    if (distSeconds[nodeIndex] < Infinity) {
      const [r, g, b] = timeToColour(distSeconds[nodeIndex], { cycleMinutes: colourCycleMinutes });
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

  return {
    mode: '2d',
    draw(pixelGrid) {
      if (canvas.width !== pixelGrid.widthPx) {
        canvas.width = pixelGrid.widthPx;
      }
      if (canvas.height !== pixelGrid.heightPx) {
        canvas.height = pixelGrid.heightPx;
      }

      const imageData = new ImageData(pixelGrid.rgba, pixelGrid.widthPx, pixelGrid.heightPx);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.putImageData(imageData, 0, 0);
      return imageData;
    },
  };
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
    antialias: false,
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
in vec2 v_uv;
out vec4 outColor;
void main(void) {
  outColor = texture(u_texture, vec2(v_uv.x, 1.0 - v_uv.y));
}`
    : `precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_uv;
void main(void) {
  gl_FragColor = texture2D(u_texture, vec2(v_uv.x, 1.0 - v_uv.y));
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

  if (isWebGl2) {
    const travelTimeFragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_time_texture;
uniform float u_cycle_minutes;
in vec2 v_uv;
out vec4 outColor;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  float seconds = texture(u_time_texture, vec2(v_uv.x, 1.0 - v_uv.y)).r;
  if (seconds < 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio) / 255.0;
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
      }
    }
  }

  const edgeVertexShaderSource = isWebGl2
    ? `#version 300 es
in vec2 a_position_px;
in float a_seconds;
uniform vec2 u_viewport_px;
out float v_seconds;
void main(void) {
  vec2 clip = vec2(
    (a_position_px.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (a_position_px.y / u_viewport_px.y) * 2.0
  );
  v_seconds = a_seconds;
  gl_Position = vec4(clip, 0.0, 1.0);
}`
    : `attribute vec2 a_position_px;
attribute float a_seconds;
uniform vec2 u_viewport_px;
varying float v_seconds;
void main(void) {
  vec2 clip = vec2(
    (a_position_px.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (a_position_px.y / u_viewport_px.y) * 2.0
  );
  v_seconds = a_seconds;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;
  const edgeFragmentShaderSource = isWebGl2
    ? `#version 300 es
precision highp float;
uniform float u_cycle_minutes;
uniform float u_alpha;
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
  vec3 rgb = mapCycleColour(cycleRatio) / 255.0;
  outColor = vec4(rgb, u_alpha);
}`
    : `precision highp float;
uniform float u_cycle_minutes;
uniform float u_alpha;
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
  vec3 rgb = mapCycleColour(cycleRatio) / 255.0;
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
  const edgeCycleMinutesLocation = gl.getUniformLocation(edgeProgram, 'u_cycle_minutes');
  const edgeAlphaLocation = gl.getUniformLocation(edgeProgram, 'u_alpha');
  const edgeVertexBuffer = gl.createBuffer();
  if (!edgeVertexBuffer) {
    gl.deleteProgram(edgeProgram);
    throw new Error('failed to allocate WebGL edge vertex buffer');
  }
  let edgeVertexBufferCapacityFloats = 0;
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

  const renderer = {
    mode: 'webgl',
    clear(options = {}) {
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
    draw(pixelGrid) {
      validatePixelGrid(pixelGrid);
      if (canvas.width !== pixelGrid.widthPx) {
        canvas.width = pixelGrid.widthPx;
      }
      if (canvas.height !== pixelGrid.heightPx) {
        canvas.height = pixelGrid.heightPx;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
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
      if (textureLocation) {
        gl.uniform1i(textureLocation, 0);
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
      if (edgeVertexData.length === 0) {
        return 0;
      }

      const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
      const alpha = Number.isFinite(options.alpha) ? options.alpha : 1;
      const clampedAlpha = Math.max(0, Math.min(1, alpha));
      const append = options.append ?? false;
      const targetWidthPx = options.widthPx ?? canvas.width;
      const targetHeightPx = options.heightPx ?? canvas.height;
      if (!Number.isFinite(targetWidthPx) || targetWidthPx <= 0) {
        throw new Error('options.widthPx (or canvas.width) must be positive');
      }
      if (!Number.isFinite(targetHeightPx) || targetHeightPx <= 0) {
        throw new Error('options.heightPx (or canvas.height) must be positive');
      }

      if (canvas.width !== targetWidthPx) {
        canvas.width = Math.floor(targetWidthPx);
      }
      if (canvas.height !== targetHeightPx) {
        canvas.height = Math.floor(targetHeightPx);
      }

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
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeVertexData);
      gl.enableVertexAttribArray(edgePositionLocation);
      gl.vertexAttribPointer(edgePositionLocation, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(edgeSecondsLocation);
      gl.vertexAttribPointer(edgeSecondsLocation, 1, gl.FLOAT, false, 12, 8);
      if (edgeViewportLocation) {
        gl.uniform2f(edgeViewportLocation, canvas.width, canvas.height);
      }
      if (edgeCycleMinutesLocation) {
        gl.uniform1f(edgeCycleMinutesLocation, cycleMinutes);
      }
      if (edgeAlphaLocation) {
        gl.uniform1f(edgeAlphaLocation, clampedAlpha);
      }
      gl.drawArrays(gl.LINES, 0, edgeVertexData.length / 3);
      return edgeVertexData.length / 6;
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

  if (travelTimeProgram && travelTimeTexture && isWebGl2) {
    renderer.drawTravelTimeGrid = function drawTravelTimeGrid(travelTimeGrid, options = {}) {
      validateTravelTimeGrid(travelTimeGrid);

      if (canvas.width !== travelTimeGrid.widthPx) {
        canvas.width = travelTimeGrid.widthPx;
      }
      if (canvas.height !== travelTimeGrid.heightPx) {
        canvas.height = travelTimeGrid.heightPx;
      }

      const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
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
      if (travelTimeTextureLocation) {
        gl.uniform1i(travelTimeTextureLocation, 0);
      }
      if (travelTimeCycleMinutesLocation) {
        gl.uniform1f(travelTimeCycleMinutesLocation, cycleMinutes);
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

export function formatRenderBackendBadgeText(rendererMode) {
  if (rendererMode === 'webgl') {
    return 'Renderer: WebGL';
  }
  return 'Renderer: CPU';
}

function updateRenderBackendBadge(shell, renderer) {
  if (!shell || typeof shell !== 'object' || !shell.renderBackendBadge) {
    return;
  }

  const rendererMode = renderer?.mode === 'webgl' ? 'webgl' : 'cpu';
  const nextText = formatRenderBackendBadgeText(rendererMode);
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

export function blitPixelGridToCanvas(canvas, pixelGrid) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('canvas must provide getContext("2d")');
  }
  validatePixelGrid(pixelGrid);
  const renderer = getOrCreateIsochroneRenderer(canvas);
  return renderer.draw(pixelGrid);
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
  blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
  return paintedNodeCount;
}

export function paintSettledBatchToGrid(pixelGrid, nodePixels, distSeconds, settledBatch, options = {}) {
  validatePixelGrid(pixelGrid);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  validateSettledBatch(settledBatch);

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  let paintedCount = 0;

  for (const nodeIndex of settledBatch) {
    if (nodeIndex < 0 || nodeIndex >= nodePixels.nodePixelX.length) {
      continue;
    }
    if (!(distSeconds[nodeIndex] < Infinity)) {
      continue;
    }

    const [r, g, b] = timeToColour(distSeconds[nodeIndex], { cycleMinutes: colourCycleMinutes });
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
        { alpha, colourCycleMinutes, stepStride },
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
    searchState,
  } = renderContext;
  if (!incrementalRender) {
    return;
  }

  if (supportsGpuEdgeInterpolation) {
    renderer.clear({
      widthPx: searchState.graph.header.gridWidthPx,
      heightPx: searchState.graph.header.gridHeightPx,
    });
  } else if (supportsGpuTravelTimeRendering) {
    clearTravelTimeGrid(mapData.travelTimeGrid);
    renderer.drawTravelTimeGrid(mapData.travelTimeGrid, {
      cycleMinutes: getColourCycleMinutesFromShell(shell),
    });
  } else {
    clearGrid(mapData.pixelGrid);
    blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
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
    interactiveEdgeStepStride,
    alpha,
    shell,
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
        append: true,
        widthPx: searchState.graph.header.gridWidthPx,
        heightPx: searchState.graph.header.gridHeightPx,
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
      renderer.drawTravelTimeGrid(mapData.travelTimeGrid, { cycleMinutes: colourCycleMinutes }),
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
        { alpha, colourCycleMinutes },
      ),
    );
    profileMs('onSliceDrawMs', () =>
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid),
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
    edgeVertexBuilder,
    edgeTraversalCostSeconds,
    renderer,
    colourCycleMinutes,
    finalEdgeStepStride,
    alpha,
    shell,
  } = renderContext;
  let { paintedNodeCount, paintedEdgeCount } = paintCounts;

  if (supportsGpuEdgeInterpolation) {
    const allEdgeVertices = profileMs('finalCollectMs', () =>
      collectAllReachableTravelTimeEdgeVertices(
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        allowedModeMask,
        {
          builder: edgeVertexBuilder,
          edgeTraversalCostSeconds,
        },
      ),
    );
    paintedEdgeCount = profileMs('finalDrawMs', () =>
      renderer.drawTravelTimeEdges(allEdgeVertices, {
        cycleMinutes: colourCycleMinutes,
        append: false,
        widthPx: searchState.graph.header.gridWidthPx,
        heightPx: searchState.graph.header.gridHeightPx,
      }),
    );
    paintedNodeCount = countFiniteTravelTimes(searchState.distSeconds);
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
      renderer.drawTravelTimeGrid(mapData.travelTimeGrid, { cycleMinutes: colourCycleMinutes }),
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
        { alpha, colourCycleMinutes },
      ),
    );
    profileMs('finalDrawMs', () =>
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid),
    );
  }

  return { paintedNodeCount, paintedEdgeCount };
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
    interactiveEdgeStepStride,
    finalEdgeStepStride,
    alpha,
  };

  profileMs('initialPassMs', () => {
    renderInitialPassByBackend(renderContext);
  });
  setRoutingStatus(shell, formatRoutingStatusCalculating(0));

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
        setRoutingStatus(shell, formatRoutingStatusCalculating(settledNodeCount));
        lastStatusUpdateMs = nowImpl();
      } else {
        const nowMs = nowImpl();
        if (nowMs - lastStatusUpdateMs >= statusUpdateIntervalMs) {
          setRoutingStatus(shell, formatRoutingStatusCalculating(settledNodeCount));
          lastStatusUpdateMs = nowMs;
        }
      }

      if (typeof onSliceExternal === 'function') {
        onSliceExternal(settledBatch);
      }
    },
  });
  const routeElapsedMs = Math.max(0, Math.round(nowImpl() - routeStartMs));

  if (!runSummary.cancelled) {
    if (!skipFinalFullPass) {
      const finalPaintCounts = renderFinalPassByBackend(renderContext, {
        paintedNodeCount,
        paintedEdgeCount,
      });
      paintedNodeCount = finalPaintCounts.paintedNodeCount;
      paintedEdgeCount = finalPaintCounts.paintedEdgeCount;
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
        setRoutingStatus(shell, formatRoutingStatusNoReachable(routeElapsedMs));
      } else {
        setRoutingStatus(shell, formatRoutingStatusDone(routeElapsedMs));
      }
    } else {
      setRoutingStatus(shell, formatRoutingStatusPreview(routeElapsedMs));
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
    { alpha, colourCycleMinutes: cycleMinutes, stepStride },
  );
  paintReachableNodesToGrid(
    referenceGrid,
    mapData.nodePixels,
    searchState.distSeconds,
    { alpha, colourCycleMinutes: cycleMinutes },
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

export function formatRoutingStatusCalculating(settledCount) {
  const safeCount = Math.max(0, Math.floor(settledCount));
  return `Calculating... (${safeCount} nodes settled)`;
}

function formatRoutingDurationSuffix(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  const roundedDurationMs = Math.max(0, Math.round(durationMs));
  return ` (${roundedDurationMs} ms)`;
}

export function formatRoutingStatusDone(durationMs = null) {
  return `Done - full travel-time field ready${formatRoutingDurationSuffix(durationMs)}`;
}

export function formatRoutingStatusPreview(durationMs = null) {
  return `Done - preview updated${formatRoutingDurationSuffix(durationMs)}`;
}

export function formatRoutingStatusNoReachable(durationMs = null) {
  return `Done - no reachable network for selected mode at this start point${formatRoutingDurationSuffix(durationMs)}`;
}

function setRoutingStatus(shell, text) {
  shell.routingStatus.textContent = text;
}

function updateGraphLoadingText(shell, receivedBytes, totalBytes) {
  const receivedText = formatMebibytes(receivedBytes);
  if (totalBytes === null || totalBytes <= 0) {
    shell.loadingText.textContent = `Loading graph: ${receivedText}`;
    return;
  }

  const totalText = formatMebibytes(totalBytes);
  const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
  shell.loadingText.textContent = `Loading graph: ${receivedText} / ${totalText} (${percent}%)`;
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
  window.addEventListener('DOMContentLoaded', () => {
    const shell = initializeAppShell(globalThis.document);
    bindSvgExportControl(shell, { exportCurrentRenderedIsochroneSvg });
    let routingBinding = null;
    bindModeSelectControl(shell, {
      requestIsochroneRedraw() {
        return routingBinding?.requestIsochroneRedraw() ?? false;
      },
    });
    void initializeMapData(shell)
      .then((mapData) => {
        window.addEventListener('resize', () => {
          layoutMapViewportToContainGraph(shell, mapData.graph.header);
          updateDistanceScaleBar(shell, mapData.graph.header);
        });
        routingBinding = bindCanvasClickRouting(shell, mapData);
      })
      .catch((error) => {
        console.error(error);
      });
  });
}
