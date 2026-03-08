export const DEFAULT_BOUNDARY_BASEMAP_URL =
  '../data_pipeline/output/berlin-district-boundaries-canvas.json';
export const DEFAULT_GRAPH_BINARY_URL = '../data_pipeline/output/graph-walk.bin';
export const GRAPH_MAGIC = 0x49534f43;

const HEADER_SIZE = 64;
const NODE_RECORD_SIZE = 16;
const EDGE_RECORD_SIZE = 12;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const LOADING_FADE_MS = 180;

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

export function createWalkingSearchState(graph, sourceNodeIndex, timeLimitSeconds) {
  validateGraphForRouting(graph);

  if (!Number.isInteger(sourceNodeIndex) || sourceNodeIndex < 0 || sourceNodeIndex >= graph.header.nNodes) {
    throw new Error(`sourceNodeIndex out of range: ${sourceNodeIndex}`);
  }
  if (!Number.isFinite(timeLimitSeconds) || timeLimitSeconds <= 0) {
    throw new Error('timeLimitSeconds must be a positive finite number');
  }

  const distSeconds = new Float32Array(graph.header.nNodes);
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

        if (cost > timeLimitSeconds) {
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
          const targetIndex = graph.edgeU32[edgeIndex * 3];
          const edgeCostSeconds = graph.edgeU16[edgeIndex * 6 + 2];
          const nextCost = cost + edgeCostSeconds;

          if (nextCost > timeLimitSeconds) {
            continue;
          }
          if (nextCost < distSeconds[targetIndex]) {
            distSeconds[targetIndex] = nextCost;

            const heapPosition = heap.positionLookup[targetIndex];
            if (heapPosition === -1) {
              heap.push(targetIndex, nextCost);
            } else {
              heap.decreaseKey(targetIndex, nextCost);
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

export function findNearestNodeForCanvasPixel(mapData, xPx, yPx) {
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }

  const { easting, northing } = mapCanvasPixelToGraphMeters(mapData.graph, xPx, yPx);
  const xM = easting - mapData.graph.header.originEasting;
  const yM = northing - mapData.graph.header.originNorthing;
  const nodeIndex = findNearestNodeIndex(mapData.graph, xM, yM);

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

export function readTimeLimitMinutes(timeLimitMinutesInput) {
  if (!timeLimitMinutesInput || timeLimitMinutesInput.tagName !== 'INPUT') {
    throw new Error('timeLimitMinutesInput must be an <input>');
  }
  if (timeLimitMinutesInput.type !== 'range') {
    throw new Error('timeLimitMinutesInput must be type="range"');
  }

  const parsed = Number.parseInt(timeLimitMinutesInput.value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error('time limit input value must parse to a finite integer');
  }
  return clampInt(parsed, 5, 90);
}

function updateTimeLimitMinutesLabel(shell) {
  const timeLimitMinutes = readTimeLimitMinutes(shell.timeLimitMinutesInput);
  shell.timeLimitMinutesValue.textContent = `${timeLimitMinutes} min`;
  return timeLimitMinutes;
}

export function bindCanvasClickRouting(shell, mapData, options = {}) {
  if (!shell || !shell.isochroneCanvas) {
    throw new Error('shell.isochroneCanvas is required');
  }
  if (!shell.timeLimitMinutesInput || !shell.timeLimitMinutesValue) {
    throw new Error('shell time limit controls are required');
  }
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }

  const timeLimitDebounceMs = options.timeLimitDebounceMs ?? 200;
  if (!Number.isFinite(timeLimitDebounceMs) || timeLimitDebounceMs < 0) {
    throw new Error('timeLimitDebounceMs must be a non-negative finite number');
  }

  let activeRunToken = null;
  let lastClickedNodeIndex = null;
  let debounceTimeoutId = null;
  let isDisposed = false;

  const resolveTimeLimitMinutes = () => {
    if (Number.isFinite(options.timeLimitMinutes)) {
      return Math.max(1, Math.round(options.timeLimitMinutes));
    }
    return updateTimeLimitMinutesLabel(shell);
  };

  const runFromNodeIndex = async (nodeIndex) => {
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

    try {
      const timeLimitMinutes = resolveTimeLimitMinutes();
      const timeLimitSeconds = options.timeLimitSeconds ?? minutesToSeconds(timeLimitMinutes);
      const runSummary = await runWalkingIsochroneFromSourceNode(
        shell,
        mapData,
        nodeIndex,
        timeLimitSeconds,
        {
          ...options,
          timeLimitMinutes,
          isCancelled: () => runToken.cancelled,
        },
      );

      if (activeRunToken === runToken) {
        activeRunToken = null;
      }

      return {
        nodeIndex,
        timeLimitMinutes,
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
    const nearest = findNearestNodeForCanvasPixel(mapData, xPx, yPx);
    lastClickedNodeIndex = nearest.nodeIndex;
    const runSummary = await runFromNodeIndex(nearest.nodeIndex);

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

  const handleTimeLimitInput = () => {
    updateTimeLimitMinutesLabel(shell);

    if (lastClickedNodeIndex === null) {
      return;
    }
    if (debounceTimeoutId !== null) {
      clearTimeout(debounceTimeoutId);
    }

    debounceTimeoutId = setTimeout(() => {
      debounceTimeoutId = null;
      void runFromNodeIndex(lastClickedNodeIndex).catch((error) => {
        setRoutingStatus(shell, 'Routing failed.');
        console.error(error);
      });
    }, timeLimitDebounceMs);
  };

  shell.isochroneCanvas.addEventListener('click', handleCanvasClick);
  shell.timeLimitMinutesInput.addEventListener('input', handleTimeLimitInput);

  const dispose = () => {
    if (isDisposed) {
      return;
    }
    isDisposed = true;

    if (activeRunToken !== null) {
      activeRunToken.cancelled = true;
      activeRunToken = null;
    }

    if (debounceTimeoutId !== null) {
      clearTimeout(debounceTimeoutId);
      debounceTimeoutId = null;
    }

    shell.isochroneCanvas.removeEventListener('click', handleCanvasClick);
    shell.timeLimitMinutesInput.removeEventListener('input', handleTimeLimitInput);
  };

  return { dispose, runFromCanvasPixel };
}

export async function runWalkingIsochroneFromSourceNode(
  shell,
  mapData,
  sourceNodeIndex,
  timeLimitSeconds,
  options = {},
) {
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }

  const searchState = createWalkingSearchState(mapData.graph, sourceNodeIndex, timeLimitSeconds);
  const timeLimitMinutes = options.timeLimitMinutes ?? Math.max(1, Math.round(timeLimitSeconds / 60));
  const runSummary = await runSearchTimeSlicedWithRendering(shell, mapData, searchState, {
    ...options,
    timeLimitMinutes,
  });
  runPostMvpTransitStub(mapData.graph, searchState);
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

export function minutesToSeconds(minutes) {
  if (minutes < 0) {
    throw new Error('minutes must be non-negative');
  }

  return Math.round(minutes * 60);
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
  const timeLimitMinutesInput = resolvedDocument.getElementById('time-limit-minutes');
  const timeLimitMinutesValue = resolvedDocument.getElementById('time-limit-value');

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
  if (!timeLimitMinutesInput || timeLimitMinutesInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="time-limit-minutes">');
  }
  if (timeLimitMinutesInput.type !== 'range') {
    throw new Error('index.html time limit input must be type="range"');
  }
  if (!timeLimitMinutesValue || timeLimitMinutesValue.tagName !== 'OUTPUT') {
    throw new Error('index.html is missing <output id="time-limit-value">');
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
  timeLimitMinutesValue.textContent = `${readTimeLimitMinutes(timeLimitMinutesInput)} min`;

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
    timeLimitMinutesInput,
    timeLimitMinutesValue,
    loadingFadeTimeoutId: null,
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
  context.fillStyle = 'rgba(19, 94, 137, 0.10)';
  context.strokeStyle = 'rgba(19, 94, 137, 0.85)';
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
  context.fillStyle = 'rgba(19, 94, 137, 0.10)';
  context.strokeStyle = 'rgba(19, 94, 137, 0.85)';
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
    version: view.getUint8(4),
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

  return {
    header,
    nodeI32,
    nodeU32,
    nodeU16,
    edgeU32,
    edgeU16,
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

    const graph = parseGraphBinary(buffer);
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
    layoutMapViewportToContainGraph(shell, graph.header);
    const alignedBoundarySummary = drawBoundaryBasemapAlignedToGraphGrid(
      shell.boundaryCanvas,
      boundaryLoad.boundaryPayload,
      graph.header,
    );
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

export function timeToColour(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('seconds must be a non-negative finite number');
  }

  const minutes = seconds / 60;

  if (minutes <= 5) {
    return [32, 163, 78];
  }
  if (minutes <= 15) {
    return [214, 201, 37];
  }
  if (minutes <= 30) {
    return [230, 138, 43];
  }
  if (minutes <= 45) {
    return [210, 58, 54];
  }

  // Clamp over-limit travel times to the outermost ramp colour.
  return [210, 58, 54];
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

export function paintReachableNodesToGrid(pixelGrid, nodePixels, distSeconds, options = {}) {
  validatePixelGrid(pixelGrid);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);

  const alpha = options.alpha ?? 180;
  let paintedCount = 0;

  for (let nodeIndex = 0; nodeIndex < nodePixels.nodePixelX.length; nodeIndex += 1) {
    if (distSeconds[nodeIndex] < Infinity) {
      const [r, g, b] = timeToColour(distSeconds[nodeIndex]);
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

  const alpha = options.alpha ?? 180;
  let paintedCount = 0;

  for (const nodeIndex of settledBatch) {
    if (nodeIndex < 0 || nodeIndex >= nodePixels.nodePixelX.length) {
      continue;
    }
    if (!(distSeconds[nodeIndex] < Infinity)) {
      continue;
    }

    const [r, g, b] = timeToColour(distSeconds[nodeIndex]);
    const xPx = nodePixels.nodePixelX[nodeIndex];
    const yPx = nodePixels.nodePixelY[nodeIndex];
    if (setPixel(pixelGrid, xPx, yPx, r, g, b, alpha)) {
      paintedCount += 1;
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

  const alpha = options.alpha ?? 180;
  const onSliceExternal = options.onSlice;
  let paintedNodeCount = 0;
  let settledNodeCount = 0;

  const runSummary = await runSearchTimeSliced(searchState, {
    ...options,
    onSlice(settledBatch) {
      settledNodeCount += settledBatch.length;
      paintedNodeCount += paintSettledBatchToGrid(
        mapData.pixelGrid,
        mapData.nodePixels,
        searchState.distSeconds,
        settledBatch,
        { alpha },
      );
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
      setRoutingStatus(shell, formatRoutingStatusCalculating(settledNodeCount));

      if (typeof onSliceExternal === 'function') {
        onSliceExternal(settledBatch);
      }
    },
  });

  if (!runSummary.cancelled) {
    const doneMinutes = options.timeLimitMinutes ?? 30;
    setRoutingStatus(shell, formatRoutingStatusDone(doneMinutes));
  }

  return {
    ...runSummary,
    paintedNodeCount,
  };
}

export function formatRoutingStatusCalculating(settledCount) {
  const safeCount = Math.max(0, Math.floor(settledCount));
  return `Calculating... (${safeCount} nodes settled)`;
}

export function formatRoutingStatusDone(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  return `Done - reachable area for ${safeMinutes} min walk`;
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
    void initializeMapData(shell)
      .then((mapData) => {
        window.addEventListener('resize', () => {
          layoutMapViewportToContainGraph(shell, mapData.graph.header);
        });
        bindCanvasClickRouting(shell, mapData);
      })
      .catch((error) => {
        console.error(error);
      });
  });
}
