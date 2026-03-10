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
const INTERACTIVE_EDGE_INTERPOLATION_STEP_STRIDE = 3;
const FINAL_EDGE_INTERPOLATION_STEP_STRIDE = 1;

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

  const dragDebounceMs = options.dragDebounceMs ?? 60;
  const nowImpl = options.nowImpl ?? defaultNowMs;
  if (!Number.isFinite(dragDebounceMs) || dragDebounceMs < 0) {
    throw new Error('options.dragDebounceMs must be a non-negative finite number');
  }
  if (typeof nowImpl !== 'function') {
    throw new Error('options.nowImpl must be a function when provided');
  }
  const normalizedDragDebounceMs = Math.round(dragDebounceMs);

  let activeRunToken = null;
  let isDisposed = false;
  let isPointerDown = false;
  let dragDebounceTimerId = null;
  let pendingDebouncePoint = null;
  let queuedDragPoint = null;
  let dragRunInFlight = false;
  let lastPointerInteractionPoint = null;
  let lastDragRunRequestMs = Number.NEGATIVE_INFINITY;
  let activeRunNodeIndex = -1;
  let activeRunModeMask = 0;
  let lastCompletedNodeIndex = -1;
  let lastCompletedModeMask = 0;

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
    activeRunNodeIndex = nodeIndex;
    activeRunModeMask = modeMask ?? getAllowedModeMaskFromShell(shell);

    clearGrid(mapData.pixelGrid);
    highlightNodeIndexOnIsochroneCanvas(shell, mapData, nodeIndex);
    const allowedModeMask = activeRunModeMask;
    const colourCycleMinutes = getColourCycleMinutesFromShell(shell);
    renderIsochroneLegendIfNeeded(shell, colourCycleMinutes);

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
        activeRunNodeIndex = -1;
        activeRunModeMask = 0;
      }
      if (!runSummary.cancelled) {
        lastCompletedNodeIndex = nodeIndex;
        lastCompletedModeMask = allowedModeMask;
      }

      return {
        nodeIndex,
        ...runSummary,
      };
    } catch (error) {
      if (activeRunToken === runToken) {
        activeRunToken = null;
        activeRunNodeIndex = -1;
        activeRunModeMask = 0;
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

  const drainQueuedRuns = async () => {
    if (dragRunInFlight || isDisposed) {
      return;
    }
    dragRunInFlight = true;

    try {
      while (queuedDragPoint !== null && !isDisposed) {
        const nextPoint = queuedDragPoint;
        queuedDragPoint = null;
        try {
          await runFromNodeIndex(nextPoint.nodeIndex, nextPoint.allowedModeMask);
        } catch (error) {
          setRoutingStatus(shell, 'Routing failed.');
          console.error(error);
        }
      }
    } finally {
      dragRunInFlight = false;
      if (!isDisposed && queuedDragPoint !== null) {
        void drainQueuedRuns();
      }
    }
  };

  const pointsMatch = (point, xPx, yPx) => {
    return point !== null && point.xPx === xPx && point.yPx === yPx;
  };

  const queueRunFromCanvasPixel = (xPx, yPx, queueOptions = {}) => {
    if (isDisposed) {
      return;
    }
    const allowedModeMask = getAllowedModeMaskFromShell(shell);
    const nearest = findNearestNodeForCanvasPixel(mapData, xPx, yPx, { allowedModeMask });
    if (
      queuedDragPoint !== null
      && queuedDragPoint.nodeIndex === nearest.nodeIndex
      && queuedDragPoint.allowedModeMask === allowedModeMask
    ) {
      return;
    }
    if (
      activeRunToken !== null
      && activeRunNodeIndex === nearest.nodeIndex
      && activeRunModeMask === allowedModeMask
      && queueOptions.cancelInFlight !== true
    ) {
      return;
    }
    if (
      activeRunToken === null
      && lastCompletedNodeIndex === nearest.nodeIndex
      && lastCompletedModeMask === allowedModeMask
    ) {
      return;
    }
    if (
      queueOptions.cancelInFlight === true
      && activeRunToken !== null
      && (activeRunNodeIndex !== nearest.nodeIndex || activeRunModeMask !== allowedModeMask)
    ) {
      activeRunToken.cancelled = true;
    }
    queuedDragPoint = {
      xPx,
      yPx,
      nodeIndex: nearest.nodeIndex,
      allowedModeMask,
    };
    void drainQueuedRuns();
  };

  const clearDragDebounceTimer = () => {
    if (dragDebounceTimerId !== null) {
      clearTimeout(dragDebounceTimerId);
      dragDebounceTimerId = null;
    }
  };

  const flushPendingDebouncedDragRun = () => {
    if (pendingDebouncePoint === null) {
      return;
    }
    const { xPx, yPx } = pendingDebouncePoint;
    pendingDebouncePoint = null;
    lastDragRunRequestMs = nowImpl();
    queueRunFromCanvasPixel(xPx, yPx, { cancelInFlight: true });
  };

  const scheduleDebouncedDragRun = (xPx, yPx) => {
    if (isDisposed) {
      return;
    }
    if (pointsMatch(pendingDebouncePoint, xPx, yPx)) {
      return;
    }

    pendingDebouncePoint = { xPx, yPx };
    if (normalizedDragDebounceMs <= 0) {
      clearDragDebounceTimer();
      flushPendingDebouncedDragRun();
      return;
    }

    const elapsedSinceLastRequestMs = nowImpl() - lastDragRunRequestMs;
    if (
      !Number.isFinite(elapsedSinceLastRequestMs)
      || elapsedSinceLastRequestMs >= normalizedDragDebounceMs
    ) {
      clearDragDebounceTimer();
      flushPendingDebouncedDragRun();
      return;
    }

    if (dragDebounceTimerId !== null) {
      return;
    }

    const remainingDebounceMs = Math.max(0, normalizedDragDebounceMs - elapsedSinceLastRequestMs);
    dragDebounceTimerId = setTimeout(() => {
      dragDebounceTimerId = null;
      flushPendingDebouncedDragRun();
    }, remainingDebounceMs);
  };

  const releasePointerCaptureIfHeld = (event) => {
    if (
      typeof shell.isochroneCanvas.hasPointerCapture !== 'function'
      || typeof shell.isochroneCanvas.releasePointerCapture !== 'function'
      || !Number.isInteger(event.pointerId)
    ) {
      return;
    }
    if (shell.isochroneCanvas.hasPointerCapture(event.pointerId)) {
      shell.isochroneCanvas.releasePointerCapture(event.pointerId);
    }
  };

  const isPrimaryPointerEvent = (event) => {
    if (Number.isInteger(event.button) && event.button !== 0) {
      return false;
    }
    if (Number.isInteger(event.buttons) && event.buttons !== 0 && (event.buttons & 1) === 0) {
      return false;
    }
    return true;
  };

  const handlePointerDown = (event) => {
    if (!isPrimaryPointerEvent(event)) {
      return;
    }
    isPointerDown = true;
    if (
      typeof shell.isochroneCanvas.setPointerCapture === 'function'
      && Number.isInteger(event.pointerId)
    ) {
      shell.isochroneCanvas.setPointerCapture(event.pointerId);
    }
    clearDragDebounceTimer();
    pendingDebouncePoint = null;
    lastPointerInteractionPoint = null;
  };

  const handlePointerMove = (event) => {
    if (!isPointerDown) {
      return;
    }
    if (Number.isInteger(event.buttons) && (event.buttons & 1) === 0) {
      isPointerDown = false;
      releasePointerCaptureIfHeld(event);
      return;
    }
    const { xPx, yPx } = mapClientPointToCanvasPixel(
      shell.isochroneCanvas,
      event.clientX,
      event.clientY,
    );
    if (pointsMatch(lastPointerInteractionPoint, xPx, yPx)) {
      return;
    }
    lastPointerInteractionPoint = { xPx, yPx };
    scheduleDebouncedDragRun(xPx, yPx);
  };

  const handlePointerUp = (event) => {
    if (!isPrimaryPointerEvent(event)) {
      return;
    }
    if (!isPointerDown) {
      return;
    }
    const { xPx, yPx } = mapClientPointToCanvasPixel(
      shell.isochroneCanvas,
      event.clientX,
      event.clientY,
    );
    const hadPendingDebouncedPoint = pendingDebouncePoint !== null;
    const wasSameAsLastMove = pointsMatch(lastPointerInteractionPoint, xPx, yPx);
    clearDragDebounceTimer();
    pendingDebouncePoint = null;
    if (hadPendingDebouncedPoint || !wasSameAsLastMove) {
      queueRunFromCanvasPixel(xPx, yPx, { cancelInFlight: true });
    }
    isPointerDown = false;
    lastPointerInteractionPoint = null;
    releasePointerCaptureIfHeld(event);
  };

  const handlePointerCancel = (event) => {
    isPointerDown = false;
    clearDragDebounceTimer();
    pendingDebouncePoint = null;
    lastPointerInteractionPoint = null;
    releasePointerCaptureIfHeld(event);
  };

  shell.isochroneCanvas.addEventListener('pointerdown', handlePointerDown);
  shell.isochroneCanvas.addEventListener('pointermove', handlePointerMove);
  shell.isochroneCanvas.addEventListener('pointerup', handlePointerUp);
  shell.isochroneCanvas.addEventListener('pointercancel', handlePointerCancel);

  const dispose = () => {
    if (isDisposed) {
      return;
    }
    isDisposed = true;

    if (activeRunToken !== null) {
      activeRunToken.cancelled = true;
      activeRunToken = null;
    }
    activeRunNodeIndex = -1;
    activeRunModeMask = 0;
    lastCompletedNodeIndex = -1;
    lastCompletedModeMask = 0;
    clearDragDebounceTimer();
    isPointerDown = false;
    pendingDebouncePoint = null;
    queuedDragPoint = null;
    dragRunInFlight = false;
    lastPointerInteractionPoint = null;

    shell.isochroneCanvas.removeEventListener('pointerdown', handlePointerDown);
    shell.isochroneCanvas.removeEventListener('pointermove', handlePointerMove);
    shell.isochroneCanvas.removeEventListener('pointerup', handlePointerUp);
    shell.isochroneCanvas.removeEventListener('pointercancel', handlePointerCancel);
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
  const renderBackendBadge = resolvedDocument.getElementById('render-backend-badge');
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
  if (!renderBackendBadge || renderBackendBadge.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="render-backend-badge">');
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
  renderBackendBadge.textContent = 'Renderer: Detecting...';
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
    renderBackendBadge,
    modeSelect,
    colourCycleMinutesInput,
    distanceScale,
    distanceScaleLine,
    distanceScaleLabel,
    isochroneLegend,
    loadingFadeTimeoutId: null,
    lastRenderedLegendCycleMinutes: null,
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
    renderIsochroneLegendIfNeeded(shell, cycleMinutes);
  };

  for (const option of shell.modeSelect.options) {
    option.selected = option.value === 'car';
  }
  getAllowedModeMaskFromShell(shell);
  getColourCycleMinutesFromShell(shell);
  renderIsochroneLegendIfNeeded(shell, getColourCycleMinutesFromShell(shell));
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
    hideLoadingOverlay(shell);

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

vec3 mapCycleColour(float cycleRatio) {
  if (cycleRatio <= 5.0 / 60.0) {
    return vec3(0.0, 255.0, 255.0);
  }
  if (cycleRatio <= 15.0 / 60.0) {
    return vec3(64.0, 255.0, 64.0);
  }
  if (cycleRatio <= 30.0 / 60.0) {
    return vec3(255.0, 255.0, 64.0);
  }
  if (cycleRatio <= 45.0 / 60.0) {
    return vec3(255.0, 140.0, 0.0);
  }
  return vec3(255.0, 64.0, 160.0);
}

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

vec3 mapCycleColour(float cycleRatio) {
  if (cycleRatio <= 5.0 / 60.0) {
    return vec3(0.0, 255.0, 255.0);
  }
  if (cycleRatio <= 15.0 / 60.0) {
    return vec3(64.0, 255.0, 64.0);
  }
  if (cycleRatio <= 30.0 / 60.0) {
    return vec3(255.0, 255.0, 64.0);
  }
  if (cycleRatio <= 45.0 / 60.0) {
    return vec3(255.0, 140.0, 0.0);
  }
  return vec3(255.0, 64.0, 160.0);
}

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

vec3 mapCycleColour(float cycleRatio) {
  if (cycleRatio <= 5.0 / 60.0) {
    return vec3(0.0, 255.0, 255.0);
  }
  if (cycleRatio <= 15.0 / 60.0) {
    return vec3(64.0, 255.0, 64.0);
  }
  if (cycleRatio <= 30.0 / 60.0) {
    return vec3(255.0, 255.0, 64.0);
  }
  if (cycleRatio <= 45.0 / 60.0) {
    return vec3(255.0, 140.0, 0.0);
  }
  return vec3(255.0, 64.0, 160.0);
}

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

  const renderer = {
    mode: 'webgl',
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
      gl.bufferData(gl.ARRAY_BUFFER, edgeVertexData, gl.DYNAMIC_DRAW);
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
) {
  if (sourceNodeIndex < 0 || sourceNodeIndex >= graph.header.nNodes) {
    return 0;
  }

  const startSeconds = distSeconds[sourceNodeIndex];
  if (!Number.isFinite(startSeconds)) {
    return 0;
  }

  let paintedCount = 0;
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
      { alpha, colourCycleMinutes, stepStride },
    );
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
  const stepStride = options.stepStride ?? 1;
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
) {
  if (sourceNodeIndex < 0 || sourceNodeIndex >= graph.header.nNodes) {
    return 0;
  }

  const startSeconds = distSeconds[sourceNodeIndex];
  if (!Number.isFinite(startSeconds)) {
    return 0;
  }

  let paintedCount = 0;
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
    paintedCount += paintInterpolatedEdgeTravelTimesToGrid(
      travelTimeGrid,
      x0,
      y0,
      startSeconds,
      x1,
      y1,
      expectedTargetSeconds,
      { stepStride },
    );
  }

  return paintedCount;
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
    );
  }
  return paintedCount;
}

function collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  edgeSlackSeconds,
  outputVertices,
) {
  if (sourceNodeIndex < 0 || sourceNodeIndex >= graph.header.nNodes) {
    return 0;
  }

  const startSeconds = distSeconds[sourceNodeIndex];
  if (!Number.isFinite(startSeconds)) {
    return 0;
  }

  let segmentCount = 0;
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

    outputVertices.push(
      x0,
      y0,
      startSeconds,
      nodePixels.nodePixelX[targetNodeIndex],
      nodePixels.nodePixelY[targetNodeIndex],
      expectedTargetSeconds,
    );
    segmentCount += 1;
  }

  return segmentCount;
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
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }

  const outputVertices = [];
  for (const sourceNodeIndex of settledBatch) {
    collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      edgeSlackSeconds,
      outputVertices,
    );
  }

  return new Float32Array(outputVertices);
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
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }

  const outputVertices = [];
  for (let sourceNodeIndex = 0; sourceNodeIndex < graph.header.nNodes; sourceNodeIndex += 1) {
    collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      edgeSlackSeconds,
      outputVertices,
    );
  }

  return new Float32Array(outputVertices);
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

  const renderer = getOrCreateIsochroneRenderer(shell.isochroneCanvas);
  updateRenderBackendBadge(shell, renderer);
  const supportsGpuEdgeInterpolation = typeof renderer.drawTravelTimeEdges === 'function';
  const supportsGpuTravelTimeRendering = typeof renderer.drawTravelTimeGrid === 'function';
  if (supportsGpuTravelTimeRendering && !mapData.travelTimeGrid) {
    throw new Error('mapData.travelTimeGrid is required for GPU travel-time rendering');
  }

  if (supportsGpuEdgeInterpolation) {
    clearGrid(mapData.pixelGrid);
    blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
  } else if (supportsGpuTravelTimeRendering) {
    clearTravelTimeGrid(mapData.travelTimeGrid);
    renderer.drawTravelTimeGrid(mapData.travelTimeGrid, {
      cycleMinutes: getColourCycleMinutesFromShell(shell),
    });
  } else {
    clearGrid(mapData.pixelGrid);
    blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
  }
  setRoutingStatus(shell, formatRoutingStatusCalculating(0));

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const allowedModeMask = searchState.allowedModeMask ?? EDGE_MODE_CAR_BIT;
  const nowImpl = options.nowImpl ?? defaultNowMs;
  const statusUpdateIntervalMs = options.statusUpdateIntervalMs ?? 120;
  const interactiveEdgeStepStride =
    options.interactiveEdgeStepStride ?? INTERACTIVE_EDGE_INTERPOLATION_STEP_STRIDE;
  const finalEdgeStepStride = options.finalEdgeStepStride ?? FINAL_EDGE_INTERPOLATION_STEP_STRIDE;
  const paritySampleCount = options.gpuParitySampleCount ?? 0;
  const onSliceExternal = options.onSlice;
  let paintedNodeCount = 0;
  let paintedEdgeCount = 0;
  let settledNodeCount = 0;
  if (typeof nowImpl !== 'function') {
    throw new Error('nowImpl must be a function');
  }
  if (!Number.isFinite(statusUpdateIntervalMs) || statusUpdateIntervalMs < 0) {
    throw new Error('statusUpdateIntervalMs must be a non-negative finite number');
  }
  const normalizedStatusUpdateIntervalMs = Math.round(statusUpdateIntervalMs);
  const routeStartMs = nowImpl();
  let lastStatusUpdateMs = routeStartMs;

  const runSummary = await runSearchTimeSliced(searchState, {
    ...options,
    onSlice(settledBatch) {
      settledNodeCount += settledBatch.length;
      if (supportsGpuEdgeInterpolation) {
        const batchEdgeVertices = collectSettledBatchTravelTimeEdgeVertices(
          searchState.graph,
          mapData.nodePixels,
          searchState.distSeconds,
          settledBatch,
          allowedModeMask,
        );
        paintedEdgeCount += renderer.drawTravelTimeEdges(batchEdgeVertices, {
          cycleMinutes: colourCycleMinutes,
          append: true,
          widthPx: searchState.graph.header.gridWidthPx,
          heightPx: searchState.graph.header.gridHeightPx,
        });
        paintedNodeCount = settledNodeCount;
      } else if (supportsGpuTravelTimeRendering) {
        paintedEdgeCount += paintSettledBatchEdgeInterpolationsToTravelTimeGrid(
          mapData.travelTimeGrid,
          searchState.graph,
          mapData.nodePixels,
          searchState.distSeconds,
          settledBatch,
          allowedModeMask,
          { stepStride: interactiveEdgeStepStride },
        );
        paintedNodeCount += paintSettledBatchTravelTimesToGrid(
          mapData.travelTimeGrid,
          mapData.nodePixels,
          searchState.distSeconds,
          settledBatch,
        );
        renderer.drawTravelTimeGrid(mapData.travelTimeGrid, { cycleMinutes: colourCycleMinutes });
      } else {
        paintedEdgeCount += paintSettledBatchEdgeInterpolationsToGrid(
          mapData.pixelGrid,
          searchState.graph,
          mapData.nodePixels,
          searchState.distSeconds,
          settledBatch,
          allowedModeMask,
          { alpha, colourCycleMinutes, stepStride: interactiveEdgeStepStride },
        );
        paintedNodeCount += paintSettledBatchToGrid(
          mapData.pixelGrid,
          mapData.nodePixels,
          searchState.distSeconds,
          settledBatch,
          { alpha, colourCycleMinutes },
        );
        blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
      }
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
    if (supportsGpuEdgeInterpolation) {
      clearGrid(mapData.pixelGrid);
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
      const allEdgeVertices = collectAllReachableTravelTimeEdgeVertices(
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        allowedModeMask,
      );
      paintedEdgeCount = renderer.drawTravelTimeEdges(allEdgeVertices, {
        cycleMinutes: colourCycleMinutes,
        append: false,
        widthPx: searchState.graph.header.gridWidthPx,
        heightPx: searchState.graph.header.gridHeightPx,
      });
      paintedNodeCount = countFiniteTravelTimes(searchState.distSeconds);
    } else if (supportsGpuTravelTimeRendering) {
      clearTravelTimeGrid(mapData.travelTimeGrid);
      paintedEdgeCount = paintAllReachableEdgeInterpolationsToTravelTimeGrid(
        mapData.travelTimeGrid,
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        allowedModeMask,
        { stepStride: finalEdgeStepStride },
      );
      paintedNodeCount = paintReachableNodesTravelTimesToGrid(
        mapData.travelTimeGrid,
        mapData.nodePixels,
        searchState.distSeconds,
      );
      renderer.drawTravelTimeGrid(mapData.travelTimeGrid, { cycleMinutes: colourCycleMinutes });
    } else {
      clearGrid(mapData.pixelGrid);
      paintedEdgeCount = paintAllReachableEdgeInterpolationsToGrid(
        mapData.pixelGrid,
        searchState.graph,
        mapData.nodePixels,
        searchState.distSeconds,
        allowedModeMask,
        { alpha, colourCycleMinutes, stepStride: finalEdgeStepStride },
      );
      paintedNodeCount = paintReachableNodesToGrid(
        mapData.pixelGrid,
        mapData.nodePixels,
        searchState.distSeconds,
        { alpha, colourCycleMinutes },
      );
      blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);
    }

    if (supportsGpuEdgeInterpolation && paritySampleCount > 0) {
      const parityResult = runGpuCpuParityDiagnostic(
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
      );
      console.info('GPU/CPU parity diagnostic', parityResult);
    }

    if (paintedNodeCount <= 1) {
      setRoutingStatus(shell, formatRoutingStatusNoReachable(routeElapsedMs));
    } else {
      setRoutingStatus(shell, formatRoutingStatusDone(routeElapsedMs));
    }
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

export function formatRoutingStatusNoReachable(durationMs = null) {
  return `Done - no reachable network for selected mode at this start point${formatRoutingDurationSuffix(durationMs)}`;
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
