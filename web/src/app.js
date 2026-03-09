export const DEFAULT_BOUNDARY_BASEMAP_URL =
  '../data_pipeline/output/berlin-district-boundaries-canvas.json';
export const DEFAULT_GRAPH_BINARY_URL = '../data_pipeline/output/graph-walk.bin.gz';
export const GRAPH_MAGIC = 0x49534f43;

const HEADER_SIZE = 64;
const NODE_RECORD_SIZE = 16;
const EDGE_RECORD_SIZE = 12;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const LOADING_FADE_MS = 180;
const SUPPORTED_GRAPH_VERSIONS = new Set([2]);
const EDGE_MODE_WALK_BIT = 1;
const EDGE_MODE_BIKE_BIT = 1 << 1;
const EDGE_MODE_CAR_BIT = 1 << 2;
const WALKING_SPEED_M_S = 1.39;
const BIKE_CRUISE_SPEED_KPH = 20;
const CAR_FALLBACK_SPEED_KPH = 30;
const ROAD_CLASS_MOTORWAY = 15;
const DEFAULT_COLOUR_CYCLE_MINUTES = 60;
const EDGE_INTERPOLATION_SLACK_SECONDS = 0.75;

export class MinHeap {
  constructor(maxNodeCount) {
    if (!Number.isInteger(maxNodeCount) || maxNodeCount <= 0) {
      throw new Error('maxNodeCount must be a positive integer');
    }

    this.maxNodeCount = maxNodeCount;
    this.count = 0;
    this.costs = new Float64Array(Math.min(1024, maxNodeCount));
    this.nodeIndices = new Int32Array(Math.min(1024, maxNodeCount));
    this.positionLookup = new Int32Array(maxNodeCount);
    this.positionLookup.fill(-1);
  }

  get size() {
    return this.count;
  }

  isEmpty() {
    return this.count === 0;
  }

  push(nodeIndex, cost) {
    this._validateNodeIndex(nodeIndex);
    this._validateFiniteCost(cost, 'cost');

    const existingPosition = this.positionLookup[nodeIndex];
    if (existingPosition !== -1) {
      if (cost < this.costs[existingPosition]) {
        this.decreaseKey(nodeIndex, cost);
      }
      return;
    }

    this._ensureCapacity(this.count + 1);
    this.costs[this.count] = cost;
    this.nodeIndices[this.count] = nodeIndex;
    this.positionLookup[nodeIndex] = this.count;
    this._bubbleUp(this.count);
    this.count += 1;
  }

  pop() {
    if (this.count === 0) {
      return null;
    }

    const rootNodeIndex = this.nodeIndices[0];
    const rootCost = this.costs[0];
    this.positionLookup[rootNodeIndex] = -1;

    const lastIndex = this.count - 1;
    this.count -= 1;

    if (this.count > 0) {
      const lastNodeIndex = this.nodeIndices[lastIndex];
      const lastCost = this.costs[lastIndex];
      this.nodeIndices[0] = lastNodeIndex;
      this.costs[0] = lastCost;
      this.positionLookup[lastNodeIndex] = 0;
      this._bubbleDown(0);
    }

    return {
      nodeIndex: rootNodeIndex,
      cost: rootCost,
    };
  }

  decreaseKey(nodeIndex, newCost) {
    this._validateNodeIndex(nodeIndex);
    this._validateFiniteCost(newCost, 'newCost');

    const position = this.positionLookup[nodeIndex];
    if (position === -1) {
      throw new Error(`node ${nodeIndex} is not in the heap`);
    }
    if (newCost > this.costs[position]) {
      throw new Error('decreaseKey cannot increase a key');
    }

    this.costs[position] = newCost;
    this._bubbleUp(position);
  }

  _bubbleUp(startIndex) {
    let index = startIndex;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.costs[parent] <= this.costs[index]) {
        break;
      }
      this._swap(index, parent);
      index = parent;
    }
  }

  _bubbleDown(startIndex) {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      if (left < this.count && this.costs[left] < this.costs[smallest]) {
        smallest = left;
      }
      if (right < this.count && this.costs[right] < this.costs[smallest]) {
        smallest = right;
      }

      if (smallest === index) {
        break;
      }
      this._swap(index, smallest);
      index = smallest;
    }
  }

  _swap(a, b) {
    const nodeA = this.nodeIndices[a];
    const nodeB = this.nodeIndices[b];

    const costA = this.costs[a];
    this.costs[a] = this.costs[b];
    this.costs[b] = costA;

    this.nodeIndices[a] = nodeB;
    this.nodeIndices[b] = nodeA;
    this.positionLookup[nodeA] = b;
    this.positionLookup[nodeB] = a;
  }

  _ensureCapacity(minCapacity) {
    if (this.costs.length >= minCapacity) {
      return;
    }

    let nextCapacity = this.costs.length;
    while (nextCapacity < minCapacity) {
      nextCapacity *= 2;
    }

    const nextCosts = new Float64Array(nextCapacity);
    nextCosts.set(this.costs);
    this.costs = nextCosts;

    const nextNodeIndices = new Int32Array(nextCapacity);
    nextNodeIndices.set(this.nodeIndices);
    this.nodeIndices = nextNodeIndices;
  }

  _validateNodeIndex(nodeIndex) {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= this.maxNodeCount) {
      throw new Error(`nodeIndex out of range: ${nodeIndex}`);
    }
  }

  _validateFiniteCost(cost, fieldName) {
    if (!Number.isFinite(cost)) {
      throw new Error(`${fieldName} must be finite`);
    }
  }
}

export function runMinHeapSelfTest(seed = 0x12345678) {
  const maxCount = 1000;
  const heap = new MinHeap(maxCount);
  let randomState = seed >>> 0;

  const nextRandom = () => {
    randomState = (1664525 * randomState + 1013904223) >>> 0;
    return randomState / 4294967296;
  };

  for (let i = 0; i < 1000; i += 1) {
    heap.push(i, nextRandom() * 1000);
  }

  for (let i = 0; i < 100; i += 1) {
    const nodeIndex = i * 3;
    if (nodeIndex < maxCount) {
      heap.decreaseKey(nodeIndex, i / 10);
    }
  }

  let lastCost = -Infinity;
  let poppedCount = 0;
  while (!heap.isEmpty()) {
    const entry = heap.pop();
    if (!entry) {
      throw new Error('heap pop returned null before heap was empty');
    }
    if (entry.cost < lastCost) {
      throw new Error(
        `heap order violation at item ${poppedCount}: ${entry.cost} < previous ${lastCost}`,
      );
    }
    lastCost = entry.cost;
    poppedCount += 1;
  }

  if (poppedCount !== maxCount) {
    throw new Error(`heap self-test popped ${poppedCount} items, expected ${maxCount}`);
  }
  return true;
}

export function createWalkingSearchState(
  graph,
  sourceNodeIndex,
  timeLimitSeconds = Number.POSITIVE_INFINITY,
  allowedModeMask = EDGE_MODE_CAR_BIT,
) {
  validateGraphForRouting(graph);

  if (!Number.isInteger(sourceNodeIndex) || sourceNodeIndex < 0 || sourceNodeIndex >= graph.header.nNodes) {
    throw new Error(`sourceNodeIndex out of range: ${sourceNodeIndex}`);
  }
  if (
    !(
      timeLimitSeconds === Number.POSITIVE_INFINITY ||
      (Number.isFinite(timeLimitSeconds) && timeLimitSeconds > 0)
    )
  ) {
    throw new Error('timeLimitSeconds must be a positive finite number or Infinity');
  }
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const distSeconds = new Float64Array(graph.header.nNodes);
  distSeconds.fill(Infinity);
  const settled = new Uint8Array(graph.header.nNodes);
  const heap = new MinHeap(graph.header.nNodes);

  distSeconds[sourceNodeIndex] = 0;
  heap.push(sourceNodeIndex, 0);

  let done = false;
  let settledCount = 0;

  return {
    graph,
    sourceNodeIndex,
    timeLimitSeconds,
    allowedModeMask,
    distSeconds,
    settled,
    heap,
    get done() {
      return done;
    },
    get settledCount() {
      return settledCount;
    },
    isDone() {
      return done || heap.isEmpty();
    },
    expandOne() {
      if (done) {
        return -1;
      }

      while (!heap.isEmpty()) {
        const entry = heap.pop();
        if (!entry) {
          done = true;
          return -1;
        }

        const nodeIndex = entry.nodeIndex;
        const cost = entry.cost;

        if (Number.isFinite(timeLimitSeconds) && cost > timeLimitSeconds) {
          done = true;
          return -1;
        }
        if (settled[nodeIndex] === 1) {
          continue;
        }

        settled[nodeIndex] = 1;
        settledCount += 1;

        const firstEdgeIndex = graph.nodeU32[nodeIndex * 4 + 2];
        const edgeCount = graph.nodeU16[nodeIndex * 8 + 6];
        const endEdgeIndex = firstEdgeIndex + edgeCount;

        for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
          if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
            continue;
          }
          const targetIndex = graph.edgeU32[edgeIndex * 3];
          const edgeCostSeconds = computeEdgeTraversalCostSeconds(graph, edgeIndex, allowedModeMask);
          if (!Number.isFinite(edgeCostSeconds) || edgeCostSeconds <= 0) {
            continue;
          }
          const nextCost = cost + edgeCostSeconds;

          if (Number.isFinite(timeLimitSeconds) && nextCost > timeLimitSeconds) {
            continue;
          }
          if (nextCost < distSeconds[targetIndex]) {
            const heapPosition = heap.positionLookup[targetIndex];
            if (heapPosition === -1) {
              distSeconds[targetIndex] = nextCost;
              heap.push(targetIndex, nextCost);
            } else if (nextCost < heap.costs[heapPosition]) {
              distSeconds[targetIndex] = nextCost;
              heap.decreaseKey(targetIndex, nextCost);
            } else {
              // Keep distance cache consistent with queued best cost under rounding edge cases.
              distSeconds[targetIndex] = heap.costs[heapPosition];
            }
          }
        }

        if (heap.isEmpty()) {
          done = true;
        }
        return nodeIndex;
      }

      done = true;
      return -1;
    },
  };
}

export function computeEdgeTraversalCostSeconds(graph, edgeIndex, allowedModeMask) {
  const edgeModeMask = graph.edgeModeMask[edgeIndex];
  if ((edgeModeMask & allowedModeMask) === 0) {
    return Infinity;
  }

  const walkingCostSeconds = graph.edgeU16[edgeIndex * 6 + 2];
  if (walkingCostSeconds <= 0) {
    return Infinity;
  }

  const distanceMeters = Math.max(1, walkingCostSeconds * WALKING_SPEED_M_S);
  const edgeMaxspeedKph = graph.edgeMaxspeedKph[edgeIndex];
  let bestCostSeconds = Infinity;

  if ((allowedModeMask & EDGE_MODE_WALK_BIT) !== 0 && (edgeModeMask & EDGE_MODE_WALK_BIT) !== 0) {
    const isMotorway = graph.edgeRoadClassId[edgeIndex] === ROAD_CLASS_MOTORWAY;
    if (!isMotorway) {
      bestCostSeconds = Math.min(bestCostSeconds, walkingCostSeconds);
    }
  }

  if ((allowedModeMask & EDGE_MODE_BIKE_BIT) !== 0 && (edgeModeMask & EDGE_MODE_BIKE_BIT) !== 0) {
    const isMotorway = graph.edgeRoadClassId[edgeIndex] === ROAD_CLASS_MOTORWAY;
    if (!isMotorway) {
      const bikeSpeedKph = Math.min(BIKE_CRUISE_SPEED_KPH, edgeMaxspeedKph);
      if (bikeSpeedKph > 0) {
        const bikeMetersPerSecond = (bikeSpeedKph * 1000) / 3600;
        bestCostSeconds = Math.min(bestCostSeconds, distanceMeters / bikeMetersPerSecond);
      }
    }
  }

  if ((allowedModeMask & EDGE_MODE_CAR_BIT) !== 0 && (edgeModeMask & EDGE_MODE_CAR_BIT) !== 0) {
    const carSpeedKph = edgeMaxspeedKph > 0 ? edgeMaxspeedKph : CAR_FALLBACK_SPEED_KPH;
    if (carSpeedKph > 0) {
      const carMetersPerSecond = (carSpeedKph * 1000) / 3600;
      bestCostSeconds = Math.min(bestCostSeconds, distanceMeters / carMetersPerSecond);
    }
  }

  return Number.isFinite(bestCostSeconds) ? bestCostSeconds : Infinity;
}

export function findNearestNodeIndex(graph, xM, yM) {
  validateGraphForRouting(graph);

  if (!Number.isFinite(xM) || !Number.isFinite(yM)) {
    throw new Error('xM and yM must be finite numbers');
  }

  let nearestNodeIndex = -1;
  let nearestDistanceSquared = Infinity;

  for (let nodeIndex = 0; nodeIndex < graph.header.nNodes; nodeIndex += 1) {
    const nodeXM = graph.nodeI32[nodeIndex * 4];
    const nodeYM = graph.nodeI32[nodeIndex * 4 + 1];
    const dx = nodeXM - xM;
    const dy = nodeYM - yM;
    const distanceSquared = dx * dx + dy * dy;

    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearestNodeIndex = nodeIndex;
    }
  }

  if (nearestNodeIndex < 0) {
    throw new Error('graph contains no nodes');
  }
  return nearestNodeIndex;
}

function nodeHasAllowedModeOutgoingEdge(graph, nodeIndex, allowedModeMask) {
  const firstEdgeIndex = graph.nodeU32[nodeIndex * 4 + 2];
  const edgeCount = graph.nodeU16[nodeIndex * 8 + 6];
  const endEdgeIndex = firstEdgeIndex + edgeCount;

  for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
    if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
      continue;
    }
    const edgeCostSeconds = computeEdgeTraversalCostSeconds(graph, edgeIndex, allowedModeMask);
    if (Number.isFinite(edgeCostSeconds) && edgeCostSeconds > 0) {
      return true;
    }
  }

  return false;
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

    if (!nodeHasAllowedModeOutgoingEdge(graph, nodeIndex, allowedModeMask)) {
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

export function mapCanvasPixelToGraphMeters(graph, xPx, yPx) {
  validateGraphForRouting(graph);

  if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) {
    throw new Error('xPx and yPx must be finite numbers');
  }

  const easting = graph.header.originEasting + xPx * graph.header.pixelSizeM;
  const northing =
    graph.header.originNorthing + (graph.header.gridHeightPx - 1 - yPx) * graph.header.pixelSizeM;

  return { easting, northing };
}

export function mapClientPointToCanvasPixel(canvas, clientX, clientY) {
  if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
    throw new Error('canvas must provide getBoundingClientRect()');
  }
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    throw new Error('clientX and clientY must be finite numbers');
  }
  if (!Number.isInteger(canvas.width) || canvas.width <= 0) {
    throw new Error('canvas.width must be a positive integer');
  }
  if (!Number.isInteger(canvas.height) || canvas.height <= 0) {
    throw new Error('canvas.height must be a positive integer');
  }

  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    throw new Error('canvas bounding box must have positive width and height');
  }

  const normalizedX = (clientX - rect.left) / rect.width;
  const normalizedY = (clientY - rect.top) / rect.height;
  const xPx = clampInt(Math.floor(normalizedX * canvas.width), 0, canvas.width - 1);
  const yPx = clampInt(Math.floor(normalizedY * canvas.height), 0, canvas.height - 1);

  return { xPx, yPx };
}

export function findNearestNodeForCanvasPixel(mapData, xPx, yPx, options = {}) {
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }

  const { easting, northing } = mapCanvasPixelToGraphMeters(mapData.graph, xPx, yPx);
  const xM = easting - mapData.graph.header.originEasting;
  const yM = northing - mapData.graph.header.originNorthing;
  const allowedModeMask = options.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  const nodeIndex = findNearestNodeIndexForMode(mapData.graph, xM, yM, allowedModeMask);

  return {
    nodeIndex,
    easting,
    northing,
    xM,
    yM,
  };
}

export function highlightNodeIndexOnIsochroneCanvas(shell, mapData, nodeIndex, options = {}) {
  if (!shell || !shell.isochroneCanvas) {
    throw new Error('shell.isochroneCanvas is required');
  }
  if (!mapData || typeof mapData !== 'object') {
    throw new Error('mapData must be an object');
  }

  validatePixelGrid(mapData.pixelGrid);
  validateNodePixels(mapData.nodePixels);

  if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= mapData.nodePixels.nodePixelX.length) {
    throw new Error(`nodeIndex out of range: ${nodeIndex}`);
  }

  const rgba = options.rgba ?? [12, 163, 242, 255];
  if (!Array.isArray(rgba) || rgba.length < 4) {
    throw new Error('options.rgba must be [r, g, b, a]');
  }

  const r = clampInt(Math.round(rgba[0]), 0, 255);
  const g = clampInt(Math.round(rgba[1]), 0, 255);
  const b = clampInt(Math.round(rgba[2]), 0, 255);
  const alpha = clampInt(Math.round(rgba[3]), 0, 255);
  const xPx = mapData.nodePixels.nodePixelX[nodeIndex];
  const yPx = mapData.nodePixels.nodePixelY[nodeIndex];

  setPixel(mapData.pixelGrid, xPx, yPx, r, g, b, alpha);
  blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);

  return { nodeIndex, xPx, yPx };
}

export function bindCanvasClickRouting(shell, mapData, options = {}) {
  if (!shell || !shell.isochroneCanvas) {
    throw new Error('shell.isochroneCanvas is required');
  }
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }

  let activeRunToken = null;
  let isDisposed = false;

  const runFromNodeIndex = async (nodeIndex, modeMask = null) => {
    if (isDisposed) {
      throw new Error('routing click handler is disposed');
    }
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= mapData.graph.header.nNodes) {
      throw new Error(`nodeIndex out of range: ${nodeIndex}`);
    }

    if (activeRunToken !== null) {
      activeRunToken.cancelled = true;
    }

    const runToken = { cancelled: false };
    activeRunToken = runToken;

    clearGrid(mapData.pixelGrid);
    blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
    highlightNodeIndexOnIsochroneCanvas(shell, mapData, nodeIndex);
    const allowedModeMask = modeMask ?? getAllowedModeMaskFromShell(shell);
    renderIsochroneLegend(shell, getColourCycleMinutesFromShell(shell));
    const colourCycleMinutes = getColourCycleMinutesFromShell(shell);

    try {
      const runSummary = await runWalkingIsochroneFromSourceNode(
        shell,
        mapData,
        nodeIndex,
        Number.POSITIVE_INFINITY,
        {
          ...options,
          allowedModeMask,
          colourCycleMinutes,
          isCancelled: () => runToken.cancelled,
        },
      );

      if (activeRunToken === runToken) {
        activeRunToken = null;
      }

      return {
        nodeIndex,
        ...runSummary,
      };
    } catch (error) {
      if (activeRunToken === runToken) {
        activeRunToken = null;
      }
      throw error;
    }
  };

  const runFromCanvasPixel = async (xPx, yPx) => {
    const allowedModeMask = getAllowedModeMaskFromShell(shell);
    const nearest = findNearestNodeForCanvasPixel(mapData, xPx, yPx, { allowedModeMask });
    const runSummary = await runFromNodeIndex(nearest.nodeIndex, allowedModeMask);

    return {
      ...nearest,
      ...runSummary,
    };
  };

  const handleCanvasClick = (event) => {
    const { xPx, yPx } = mapClientPointToCanvasPixel(
      shell.isochroneCanvas,
      event.clientX,
      event.clientY,
    );
    void runFromCanvasPixel(xPx, yPx).catch((error) => {
      setRoutingStatus(shell, 'Routing failed.');
      console.error(error);
    });
  };

  shell.isochroneCanvas.addEventListener('click', handleCanvasClick);

  const dispose = () => {
    if (isDisposed) {
      return;
    }
    isDisposed = true;

    if (activeRunToken !== null) {
      activeRunToken.cancelled = true;
      activeRunToken = null;
    }

    shell.isochroneCanvas.removeEventListener('click', handleCanvasClick);
  };

  return { dispose, runFromCanvasPixel };
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
  const searchState = createWalkingSearchState(
    mapData.graph,
    sourceNodeIndex,
    timeLimitSeconds,
    allowedModeMask,
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

export function initializeAppShell(doc) {
  const resolvedDocument = doc ?? globalThis.document;
  if (!resolvedDocument) {
    throw new Error('document is not available');
  }

  const mapRegion = resolvedDocument.getElementById('map-region');
  const isochroneCanvas =
    resolvedDocument.getElementById('isochrone') ?? resolvedDocument.getElementById('map');
  const boundaryCanvas = resolvedDocument.getElementById('boundaries');
  const canvasStack = resolvedDocument.getElementById('canvas-stack');
  const loadingOverlay = resolvedDocument.getElementById('loading');
  const loadingText = resolvedDocument.getElementById('loading-text');
  const loadingProgressBar = resolvedDocument.getElementById('loading-progress-bar');
  const routingStatus = resolvedDocument.getElementById('routing-status');
  const modeSelect = resolvedDocument.getElementById('mode-select');
  const colourCycleMinutesInput = resolvedDocument.getElementById('colour-cycle-minutes');
  const distanceScale = resolvedDocument.getElementById('distance-scale');
  const distanceScaleLine = resolvedDocument.getElementById('distance-scale-line');
  const distanceScaleLabel = resolvedDocument.getElementById('distance-scale-label');
  const isochroneLegend = resolvedDocument.getElementById('isochrone-legend');

  if (!mapRegion || mapRegion.tagName !== 'SECTION') {
    throw new Error('index.html is missing <section id="map-region">');
  }
  if (!isochroneCanvas || isochroneCanvas.tagName !== 'CANVAS') {
    throw new Error('index.html is missing <canvas id="isochrone">');
  }
  if (!boundaryCanvas || boundaryCanvas.tagName !== 'CANVAS') {
    throw new Error('index.html is missing <canvas id="boundaries">');
  }
  if (!canvasStack || canvasStack.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="canvas-stack">');
  }
  if (!loadingOverlay || loadingOverlay.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="loading">');
  }
  if (!loadingText || loadingText.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="loading-text">');
  }
  if (!loadingProgressBar || loadingProgressBar.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="loading-progress-bar">');
  }
  if (!routingStatus || routingStatus.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="routing-status">');
  }
  if (!modeSelect || modeSelect.tagName !== 'SELECT') {
    throw new Error('index.html is missing <select id="mode-select">');
  }
  if (!colourCycleMinutesInput || colourCycleMinutesInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="colour-cycle-minutes">');
  }
  if (!distanceScale || distanceScale.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="distance-scale">');
  }
  if (!distanceScaleLine || distanceScaleLine.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="distance-scale-line">');
  }
  if (!distanceScaleLabel || distanceScaleLabel.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="distance-scale-label">');
  }
  if (!isochroneLegend || isochroneLegend.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="isochrone-legend">');
  }

  sizeCanvasToCssPixels(isochroneCanvas);
  sizeCanvasToCssPixels(boundaryCanvas);

  isochroneCanvas.style.pointerEvents = 'none';
  isochroneCanvas.dataset.graphLoaded = 'false';
  loadingOverlay.hidden = false;
  loadingOverlay.classList.remove('is-fading');
  loadingText.textContent = 'Loading district boundaries...';
  setLoadingProgressBar(loadingProgressBar, 0);
  routingStatus.textContent = 'Ready.';
  for (const option of modeSelect.options) {
    option.selected = option.value === 'car';
  }

  return {
    mapRegion,
    isochroneCanvas,
    mapCanvas: isochroneCanvas,
    boundaryCanvas,
    canvasStack,
    loadingOverlay,
    loadingText,
    loadingProgressBar,
    routingStatus,
    modeSelect,
    colourCycleMinutesInput,
    distanceScale,
    distanceScaleLine,
    distanceScaleLabel,
    isochroneLegend,
    loadingFadeTimeoutId: null,
  };
}

export function getAllowedModeMaskFromShell(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }

  const selectedOptions = shell.modeSelect?.selectedOptions;
  let allowedModeMask = 0;

  for (const option of selectedOptions ?? []) {
    const optionValue = option.value;
    if (optionValue === 'walk') {
      allowedModeMask |= EDGE_MODE_WALK_BIT;
    }
    if (optionValue === 'bike') {
      allowedModeMask |= EDGE_MODE_BIKE_BIT;
    }
    if (optionValue === 'car') {
      allowedModeMask |= EDGE_MODE_CAR_BIT;
    }
  }

  if (allowedModeMask === 0) {
    if (shell.modeSelect) {
      for (const option of shell.modeSelect.options) {
        option.selected = option.value === 'car';
      }
    }
    return EDGE_MODE_CAR_BIT;
  }

  return allowedModeMask;
}

export function getColourCycleMinutesFromShell(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }

  const rawCycleValue = shell.colourCycleMinutesInput?.value;
  const parsedCycleMinutes = Number.parseInt(rawCycleValue ?? '', 10);
  if (!Number.isFinite(parsedCycleMinutes) || parsedCycleMinutes <= 0) {
    if (shell.colourCycleMinutesInput) {
      shell.colourCycleMinutesInput.value = String(DEFAULT_COLOUR_CYCLE_MINUTES);
    }
    return DEFAULT_COLOUR_CYCLE_MINUTES;
  }

  const clampedCycleMinutes = clampInt(parsedCycleMinutes, 5, 24 * 60);
  if (shell.colourCycleMinutesInput) {
    shell.colourCycleMinutesInput.value = String(clampedCycleMinutes);
  }
  return clampedCycleMinutes;
}

export function bindModeSelectControl(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }
  if (!shell.modeSelect || !shell.colourCycleMinutesInput || !shell.isochroneLegend) {
    throw new Error('mode and colour controls are required');
  }

  const handleSelectChange = () => {
    getAllowedModeMaskFromShell(shell);
  };
  const handleCycleChange = () => {
    const cycleMinutes = getColourCycleMinutesFromShell(shell);
    renderIsochroneLegend(shell, cycleMinutes);
  };

  for (const option of shell.modeSelect.options) {
    option.selected = option.value === 'car';
  }
  getAllowedModeMaskFromShell(shell);
  getColourCycleMinutesFromShell(shell);
  renderIsochroneLegend(shell, getColourCycleMinutesFromShell(shell));
  shell.modeSelect.addEventListener('change', handleSelectChange);
  shell.colourCycleMinutesInput.addEventListener('change', handleCycleChange);

  return {
    dispose() {
      shell.modeSelect.removeEventListener('change', handleSelectChange);
      shell.colourCycleMinutesInput.removeEventListener('change', handleCycleChange);
    },
  };
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

export function createBoundaryCanvasTransform(coordinateSpace, canvasWidth, canvasHeight) {
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error('canvas width/height must be positive');
  }

  const scale = Math.min(
    canvasWidth / coordinateSpace.width,
    canvasHeight / coordinateSpace.height,
  );
  const offsetX = (canvasWidth - coordinateSpace.width * scale) / 2;
  const offsetY = (canvasHeight - coordinateSpace.height * scale) / 2;

  return { scale, offsetX, offsetY };
}

export function mapBoundaryPathToCanvas(path, transform) {
  return path.map(([x, y]) => [
    transform.offsetX + x * transform.scale,
    transform.offsetY + y * transform.scale,
  ]);
}

export function drawBoundaryBasemap(boundaryCanvas, payload) {
  if (!boundaryCanvas || typeof boundaryCanvas.getContext !== 'function') {
    throw new Error('boundaryCanvas must provide getContext("2d")');
  }

  sizeCanvasToCssPixels(boundaryCanvas);

  const parsed = parseBoundaryBasemapPayload(payload);
  const context = boundaryCanvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to get 2D context for boundary canvas');
  }

  const transform = createBoundaryCanvasTransform(
    parsed.coordinateSpace,
    boundaryCanvas.width,
    boundaryCanvas.height,
  );

  context.clearRect(0, 0, boundaryCanvas.width, boundaryCanvas.height);
  context.fillStyle = 'rgba(0, 0, 0, 0)';
  context.strokeStyle = 'rgba(125, 175, 220, 0.55)';
  context.lineWidth = 1.2;
  context.lineJoin = 'round';
  context.lineCap = 'round';

  let renderedPathCount = 0;

  for (const feature of parsed.features) {
    for (const path of feature.paths) {
      const mappedPath = mapBoundaryPathToCanvas(path, transform);
      if (mappedPath.length < 2) {
        continue;
      }

      context.beginPath();
      context.moveTo(mappedPath[0][0], mappedPath[0][1]);
      for (let i = 1; i < mappedPath.length; i += 1) {
        context.lineTo(mappedPath[i][0], mappedPath[i][1]);
      }

      if (isClosedPath(mappedPath)) {
        context.closePath();
        context.fill();
      }

      context.stroke();
      renderedPathCount += 1;
    }
  }

  return {
    featureCount: parsed.features.length,
    pathCount: renderedPathCount,
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
    layoutMapViewportToContainGraph(shell, graph.header);
    const alignedBoundarySummary = drawBoundaryBasemapAlignedToGraphGrid(
      shell.boundaryCanvas,
      boundaryLoad.boundaryPayload,
      graph.header,
    );
    renderIsochroneLegend(shell, getColourCycleMinutesFromShell(shell));
    updateDistanceScaleBar(shell, graph.header);
    hideLoadingOverlay(shell);

    const nodePixels = precomputeNodePixelCoordinates(graph);
    const pixelGrid = createPixelGrid(graph.header.gridWidthPx, graph.header.gridHeightPx);
    clearGrid(pixelGrid);

    return {
      boundarySummary: boundaryLoad.boundarySummary,
      alignedBoundarySummary,
      graph,
      nodePixels,
      pixelGrid,
    };
  } catch (error) {
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

  const boundaries = [0, 5 / 60, 15 / 60, 30 / 60, 45 / 60, 1];
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
    const rangeLabel =
      index === colours.length - 1
        ? `${formatLegendDuration(rangeStartMinutes)}+`
        : `${formatLegendDuration(rangeStartMinutes)}-${formatLegendDuration(rangeEndMinutes)}`;

    legendRows.push(
      `<div class="legend-row"><span class="legend-swatch" style="background: rgb(${colour[0]}, ${colour[1]}, ${colour[2]});"></span><span>${rangeLabel}</span></div>`,
    );
  }

  shell.isochroneLegend.innerHTML = legendRows.join('');
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

export function timeToColour(seconds, options = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('seconds must be a non-negative finite number');
  }

  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive finite number');
  }
  const cyclePositionMinutes = (seconds / 60) % cycleMinutes;
  const cycleRatio = cyclePositionMinutes / cycleMinutes;

  if (cycleRatio <= 5 / 60) {
    return [0, 255, 255];
  }
  if (cycleRatio <= 15 / 60) {
    return [64, 255, 64];
  }
  if (cycleRatio <= 30 / 60) {
    return [255, 255, 64];
  }
  if (cycleRatio <= 45 / 60) {
    return [255, 140, 0];
  }

  // Last quarter band in each cycle.
  return [255, 64, 160];
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
  const startX = Math.round(x0);
  const startY = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const totalSteps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY));
  let paintedCount = 0;
  let stepIndex = 0;

  rasterizeLinePixels(x0, y0, x1, y1, (xPx, yPx) => {
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

export function blitPixelGridToCanvas(canvas, pixelGrid) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('canvas must provide getContext("2d")');
  }
  validatePixelGrid(pixelGrid);

  if (canvas.width !== pixelGrid.widthPx) {
    canvas.width = pixelGrid.widthPx;
  }
  if (canvas.height !== pixelGrid.heightPx) {
    canvas.height = pixelGrid.heightPx;
  }

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to get 2D context for isochrone canvas');
  }

  const imageData = new ImageData(pixelGrid.rgba, pixelGrid.widthPx, pixelGrid.heightPx);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.putImageData(imageData, 0, 0);
  return imageData;
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
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }

  let paintedCount = 0;

  for (const sourceNodeIndex of settledBatch) {
    if (sourceNodeIndex < 0 || sourceNodeIndex >= graph.header.nNodes) {
      continue;
    }

    const startSeconds = distSeconds[sourceNodeIndex];
    if (!Number.isFinite(startSeconds)) {
      continue;
    }

    const x0 = nodePixels.nodePixelX[sourceNodeIndex];
    const y0 = nodePixels.nodePixelY[sourceNodeIndex];
    const firstEdgeIndex = graph.nodeU32[sourceNodeIndex * 4 + 2];
    const edgeCount = graph.nodeU16[sourceNodeIndex * 8 + 6];
    const endEdgeIndex = firstEdgeIndex + edgeCount;

    for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
      if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
        continue;
      }

      const edgeCostSeconds = computeEdgeTraversalCostSeconds(graph, edgeIndex, allowedModeMask);
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
      paintedCount += paintInterpolatedEdgeToGrid(
        pixelGrid,
        x0,
        y0,
        startSeconds,
        x1,
        y1,
        expectedTargetSeconds,
        { alpha, colourCycleMinutes },
      );
    }
  }

  return paintedCount;
}

export async function runSearchTimeSliced(searchState, options = {}) {
  validateSearchState(searchState);

  const sliceBudgetMs = options.sliceBudgetMs ?? 8;
  const onSlice = options.onSlice ?? (() => {});
  const isCancelled = options.isCancelled ?? (() => false);
  const nowImpl = options.nowImpl ?? defaultNowMs;
  const requestAnimationFrameImpl = options.requestAnimationFrameImpl ?? globalThis.requestAnimationFrame;

  if (!Number.isFinite(sliceBudgetMs) || sliceBudgetMs <= 0) {
    throw new Error('sliceBudgetMs must be a positive finite number');
  }
  if (typeof onSlice !== 'function') {
    throw new Error('onSlice must be a function');
  }
  if (typeof isCancelled !== 'function') {
    throw new Error('isCancelled must be a function');
  }
  if (typeof nowImpl !== 'function') {
    throw new Error('nowImpl must be a function');
  }

  let totalSettledCount = 0;
  let sliceCount = 0;
  let cancelled = false;

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

      const settledNodeIndex = searchState.expandOne();
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
      await waitForAnimationFrame(requestAnimationFrameImpl);
    }
  }

  return {
    totalSettledCount,
    sliceCount,
    cancelled,
  };
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

  clearGrid(mapData.pixelGrid);
  blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
  setRoutingStatus(shell, formatRoutingStatusCalculating(0));

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const allowedModeMask = searchState.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  const onSliceExternal = options.onSlice;
  let paintedNodeCount = 0;
  let paintedEdgeCount = 0;
  let settledNodeCount = 0;

  const runSummary = await runSearchTimeSliced(searchState, {
    ...options,
    onSlice(settledBatch) {
      settledNodeCount += settledBatch.length;
      paintedEdgeCount += paintSettledBatchEdgeInterpolationsToGrid(
        mapData.pixelGrid,
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        settledBatch,
        allowedModeMask,
        { alpha, colourCycleMinutes },
      );
      paintedNodeCount += paintSettledBatchToGrid(
        mapData.pixelGrid,
        mapData.nodePixels,
        searchState.distSeconds,
        settledBatch,
        { alpha, colourCycleMinutes },
      );
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
      setRoutingStatus(shell, formatRoutingStatusCalculating(settledNodeCount));

      if (typeof onSliceExternal === 'function') {
        onSliceExternal(settledBatch);
      }
    },
  });

  if (!runSummary.cancelled) {
    if (paintedNodeCount <= 1) {
      setRoutingStatus(shell, 'Done - no reachable network for selected mode at this start point.');
    } else {
      setRoutingStatus(shell, formatRoutingStatusDone());
    }
  }

  return {
    ...runSummary,
    paintedEdgeCount,
    paintedNodeCount,
  };
}

export function formatRoutingStatusCalculating(settledCount) {
  const safeCount = Math.max(0, Math.floor(settledCount));
  return `Calculating... (${safeCount} nodes settled)`;
}

export function formatRoutingStatusDone() {
  return 'Done - full travel-time field ready';
}

function setRoutingStatus(shell, text) {
  shell.routingStatus.textContent = text;
}

function sizeCanvasToCssPixels(canvas) {
  if (typeof canvas.getBoundingClientRect !== 'function') {
    return;
  }

  const { width, height } = canvas.getBoundingClientRect();
  if (width < 2 || height < 2) {
    return;
  }

  const nextWidth = Math.round(width);
  const nextHeight = Math.round(height);

  if (canvas.width !== nextWidth) {
    canvas.width = nextWidth;
  }
  if (canvas.height !== nextHeight) {
    canvas.height = nextHeight;
  }
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

function hideLoadingOverlay(shell) {
  if (shell.loadingFadeTimeoutId !== null) {
    clearTimeout(shell.loadingFadeTimeoutId);
    shell.loadingFadeTimeoutId = null;
  }
  shell.loadingOverlay.hidden = true;
  shell.loadingOverlay.classList.remove('is-fading');
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

function validateGraphForNodePixels(graph) {
  if (!graph || typeof graph !== 'object') {
    throw new Error('graph must be an object');
  }
  if (!graph.header || typeof graph.header !== 'object') {
    throw new Error('graph.header is required');
  }
  if (!Number.isInteger(graph.header.nNodes) || graph.header.nNodes < 0) {
    throw new Error('graph.header.nNodes must be a non-negative integer');
  }
  if (!Number.isInteger(graph.header.gridWidthPx) || graph.header.gridWidthPx <= 0) {
    throw new Error('graph.header.gridWidthPx must be a positive integer');
  }
  if (!Number.isInteger(graph.header.gridHeightPx) || graph.header.gridHeightPx <= 0) {
    throw new Error('graph.header.gridHeightPx must be a positive integer');
  }
  if (!(graph.nodeI32 instanceof Int32Array)) {
    throw new Error('graph.nodeI32 must be an Int32Array');
  }
  if (graph.nodeI32.length < graph.header.nNodes * 4) {
    throw new Error('graph.nodeI32 is too short for node records');
  }
}

function validateGraphForRouting(graph) {
  validateGraphForNodePixels(graph);

  if (!Number.isInteger(graph.header.nEdges) || graph.header.nEdges < 0) {
    throw new Error('graph.header.nEdges must be a non-negative integer');
  }
  if (!(graph.nodeU32 instanceof Uint32Array)) {
    throw new Error('graph.nodeU32 must be a Uint32Array');
  }
  if (!(graph.nodeU16 instanceof Uint16Array)) {
    throw new Error('graph.nodeU16 must be a Uint16Array');
  }
  if (!(graph.edgeU32 instanceof Uint32Array)) {
    throw new Error('graph.edgeU32 must be a Uint32Array');
  }
  if (!(graph.edgeU16 instanceof Uint16Array)) {
    throw new Error('graph.edgeU16 must be a Uint16Array');
  }
  if (!(graph.edgeModeMask instanceof Uint8Array)) {
    throw new Error('graph.edgeModeMask must be a Uint8Array');
  }
  if (!(graph.edgeRoadClassId instanceof Uint8Array)) {
    throw new Error('graph.edgeRoadClassId must be a Uint8Array');
  }
  if (!(graph.edgeMaxspeedKph instanceof Uint16Array)) {
    throw new Error('graph.edgeMaxspeedKph must be a Uint16Array');
  }

  if (graph.nodeU32.length < graph.header.nNodes * 4) {
    throw new Error('graph.nodeU32 is too short for node records');
  }
  if (graph.nodeU16.length < graph.header.nNodes * 8) {
    throw new Error('graph.nodeU16 is too short for node records');
  }
  if (graph.edgeU32.length < graph.header.nEdges * 3) {
    throw new Error('graph.edgeU32 is too short for edge records');
  }
  if (graph.edgeU16.length < graph.header.nEdges * 6) {
    throw new Error('graph.edgeU16 is too short for edge records');
  }
  if (graph.edgeModeMask.length < graph.header.nEdges) {
    throw new Error('graph.edgeModeMask is too short for edge records');
  }
  if (graph.edgeRoadClassId.length < graph.header.nEdges) {
    throw new Error('graph.edgeRoadClassId is too short for edge records');
  }
  if (graph.edgeMaxspeedKph.length < graph.header.nEdges) {
    throw new Error('graph.edgeMaxspeedKph is too short for edge records');
  }
}

function validateGraphHeaderForBoundaryAlignment(graphHeader) {
  if (!graphHeader || typeof graphHeader !== 'object') {
    throw new Error('graphHeader must be an object');
  }
  if (!Number.isFinite(graphHeader.originEasting)) {
    throw new Error('graphHeader.originEasting must be finite');
  }
  if (!Number.isFinite(graphHeader.originNorthing)) {
    throw new Error('graphHeader.originNorthing must be finite');
  }
  if (!Number.isInteger(graphHeader.gridWidthPx) || graphHeader.gridWidthPx <= 0) {
    throw new Error('graphHeader.gridWidthPx must be a positive integer');
  }
  if (!Number.isInteger(graphHeader.gridHeightPx) || graphHeader.gridHeightPx <= 0) {
    throw new Error('graphHeader.gridHeightPx must be a positive integer');
  }
  if (!Number.isFinite(graphHeader.pixelSizeM) || graphHeader.pixelSizeM <= 0) {
    throw new Error('graphHeader.pixelSizeM must be a positive finite number');
  }
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
    bindModeSelectControl(shell);
    void initializeMapData(shell)
      .then((mapData) => {
        window.addEventListener('resize', () => {
          layoutMapViewportToContainGraph(shell, mapData.graph.header);
          updateDistanceScaleBar(shell, mapData.graph.header);
        });
        bindCanvasClickRouting(shell, mapData);
      })
      .catch((error) => {
        console.error(error);
      });
  });
}
