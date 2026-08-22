import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_MAGIC,
  MinHeap,
  WASM_REQUIRED_MESSAGE,
  clearRenderedIsochrone,
  computeEdgeTraversalCostSeconds,
  computeExportDistanceScaleBar,
  createWebGlIsochroneRenderer,
  createNodeSpatialIndex,
  clearTravelTimeGrid,
  createPixelGrid,
  createTravelTimeGrid,
  createWalkingSearchState,
  ensureWasmSupportOrShowError,
  findNearestNodeIndexForModeFromSpatialIndex,
  mapCanvasPixelToGraphMeters,
  parseBikeSpeedKphFromLocationSearch,
  parseColourCycleMinutesFromLocationSearch,
  parseDepartureDatetimeFromLocationSearch,
  parseLocationIdFromLocationSearch,
  parseGraphBinary,
  parseModeValuesFromLocationSearch,
  parseNodeIndexFromLocationSearch,
  parseWalkSpeedKphFromLocationSearch,
  runConnectionScanFromWalkingReachableStops,
  buildTransitConnectionEdgeVertexData,
  runWalkingIsochroneFromSourceNode,
  buildStaticEdgeVertexTemplateForMode,
  updateTravelTimesInStaticEdgeVertexTemplate,
  persistBikeSpeedKphToLocation,
  persistColourCycleMinutesToLocation,
  persistDepartureDatetimeToLocation,
  persistLocationIdToLocation,
  persistModeValuesToLocation,
  persistNodeIndexToLocation,
  persistWalkSpeedKphToLocation,
  precomputeNodeModeMask,
  precomputeNodePixelCoordinates,
  getOrBuildSnapshotEdgeVertexData,
  getOrBuildEdgeTraversalCostTicksForMode,
  getOrRotateRoutingDistScratchBuffer,
  buildModeSpecificKernelGraphViews,
  drawBoundaryBasemapAlignedToGraphGrid,
  buildStaticEdgeNodeIndexedVertexData,
  layoutMapViewportToContainGraph,
  rerenderIsochroneFromSnapshotWithStatus,
  renderIsochroneLegendIfNeeded,
  runSearchTimeSliced,
  computeRenderGridExtent,
  resolveSpatialIndexCellSizePx,
  setTravelTimePixelMin,
  shouldUploadEdgeGeometry,
  updateDistanceScaleBar,
  timeToColour,
} from '../src/app.js';
import {
  computeProjectedFeatureListBoundingBoxPx,
  getAirportFillStyle,
  getBoundaryStrokeStyle,
  getBoundaryWaterFillStyle,
  getForestFillStyle,
  getInlandWaterFillStyle,
  getWaterwayStrokeStyle,
} from '../src/core/boundary-basemap.js';
import { precomputeEdgeTraversalCostSecondsCache } from '../src/core/routing.js';

const EDGE_MODE_WALK_BIT = 1;
const EDGE_MODE_BIKE_BIT = 1 << 1;
const EDGE_MODE_CAR_BIT = 1 << 2;
const EDGE_MODE_WATER_BIT = 1 << 3;
const CAR_FALLBACK_SPEED_KPH = 30;
const WATER_FALLBACK_SPEED_KPH = 25;

function createFixtureGraph() {
  const nNodes = 3;
  const nEdges = 2;
  const nodeBuffer = new ArrayBuffer(nNodes * 16);
  const edgeBuffer = new ArrayBuffer(nEdges * 12);
  const nodeI32 = new Int32Array(nodeBuffer);
  const nodeU32 = new Uint32Array(nodeBuffer);
  const nodeU16 = new Uint16Array(nodeBuffer);
  const edgeU32 = new Uint32Array(edgeBuffer);
  const edgeU16 = new Uint16Array(edgeBuffer);
  const edgeModeMask = new Uint8Array(nEdges);
  const edgeRoadClassId = new Uint8Array(nEdges);
  const edgeMaxspeedKph = new Uint16Array(nEdges);

  // Node 0 at (0m, 0m), outgoing edge 0.
  nodeI32[0] = 0;
  nodeI32[1] = 0;
  nodeU32[2] = 0;
  nodeU16[6] = 1;

  // Node 1 at (100m, 0m), outgoing edge 1.
  nodeI32[4] = 100;
  nodeI32[5] = 0;
  nodeU32[6] = 1;
  nodeU16[14] = 1;

  // Node 2 at (200m, 0m), terminal.
  nodeI32[8] = 200;
  nodeI32[9] = 0;
  nodeU32[10] = 2;
  nodeU16[22] = 0;

  // Edge 0: 0 -> 1
  edgeU32[0] = 1;
  edgeU16[2] = 72; // walking seconds
  edgeModeMask[0] = EDGE_MODE_WALK_BIT | EDGE_MODE_BIKE_BIT | EDGE_MODE_CAR_BIT;
  edgeRoadClassId[0] = 11;
  edgeMaxspeedKph[0] = 60;
  edgeU32[2] = edgeModeMask[0] | (edgeRoadClassId[0] << 8) | (edgeMaxspeedKph[0] << 16);

  // Edge 1: 1 -> 2
  edgeU32[3] = 2;
  edgeU16[8] = 72; // walking seconds
  edgeModeMask[1] = EDGE_MODE_WALK_BIT | EDGE_MODE_BIKE_BIT | EDGE_MODE_CAR_BIT;
  edgeRoadClassId[1] = 11;
  edgeMaxspeedKph[1] = 60;
  edgeU32[5] = edgeModeMask[1] | (edgeRoadClassId[1] << 8) | (edgeMaxspeedKph[1] << 16);

  return {
    header: {
      nNodes,
      nEdges,
      nStops: 0,
      nTedges: 0,
      originEasting: 1000,
      originNorthing: 2000,
      epsgCode: 25833,
      gridWidthPx: 256,
      gridHeightPx: 256,
      pixelSizeM: 1,
      nodeTableOffset: 64,
      edgeTableOffset: 64 + nNodes * 16,
      stopTableOffset: 64 + nNodes * 16 + nEdges * 12,
    },
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

function createFixtureEdgeCostPrecomputeKernel(graph, options = {}) {
  return {
    precomputeEdgeCostsForGraph({ outCostSeconds, allowedModeMask }) {
      if (options.throwError) {
        throw new Error(options.throwError);
      }
      if (options.fillNaN) {
        outCostSeconds.fill(Number.NaN);
        return;
      }
      for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
        outCostSeconds[edgeIndex] = computeEdgeTraversalCostSeconds(graph, edgeIndex, allowedModeMask);
      }
    },
  };
}

// A small but *correct* CSR-array Dijkstra, standing in for the WASM
// kernel. Unlike createFixtureEdgeCostPrecomputeKernel above (which only
// implements precomputeEdgeCostsForGraph for cost-calculation tests), this
// also implements computeTravelTimeFieldForGraph and
// computeTravelTimeFieldMultiSourceForGraph so it can drive
// runWalkingIsochroneFromSourceNode end to end, including its CSA/transit
// second pass.
function createDijkstraEdgeCostPrecomputeKernel(graph) {
  const WASM_EDGE_COST_TICK_SCALE_TEST = 1000;
  const runDijkstra = ({
    nodeFirstEdgeIndex,
    nodeEdgeCount,
    edgeTargetNodeIndex,
    edgeCostTicks,
    outDistSeconds,
    seeds,
    timeLimitSeconds,
  }) => {
    const nNodes = outDistSeconds.length;
    outDistSeconds.fill(Number.POSITIVE_INFINITY);
    const visited = new Uint8Array(nNodes);
    for (const seed of seeds) {
      if (seed.startDistSeconds < outDistSeconds[seed.nodeIndex]) {
        outDistSeconds[seed.nodeIndex] = seed.startDistSeconds;
      }
    }
    const limit = Number.isFinite(timeLimitSeconds) ? timeLimitSeconds : Number.POSITIVE_INFINITY;
    let settledCount = 0;
    for (;;) {
      let bestNode = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let nodeIndex = 0; nodeIndex < nNodes; nodeIndex += 1) {
        if (!visited[nodeIndex] && outDistSeconds[nodeIndex] < bestDist) {
          bestDist = outDistSeconds[nodeIndex];
          bestNode = nodeIndex;
        }
      }
      if (bestNode === -1 || bestDist > limit) {
        break;
      }
      visited[bestNode] = 1;
      settledCount += 1;
      const firstEdge = nodeFirstEdgeIndex[bestNode];
      const edgeCount = nodeEdgeCount[bestNode];
      for (let i = 0; i < edgeCount; i += 1) {
        const edgeIndex = firstEdge + i;
        const ticks = edgeCostTicks[edgeIndex];
        if (ticks === 0) {
          continue;
        }
        const targetNode = edgeTargetNodeIndex[edgeIndex];
        const candidate = bestDist + ticks / WASM_EDGE_COST_TICK_SCALE_TEST;
        if (candidate < outDistSeconds[targetNode]) {
          outDistSeconds[targetNode] = candidate;
        }
      }
    }
    return { settledNodeCount: settledCount, outDistSecondsView: outDistSeconds };
  };

  return {
    precomputeEdgeCostsForGraph({ outCostSeconds, allowedModeMask }) {
      for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
        const cost = computeEdgeTraversalCostSeconds(graph, edgeIndex, allowedModeMask);
        outCostSeconds[edgeIndex] = Number.isFinite(cost) ? cost : 0;
      }
    },
    computeTravelTimeFieldForGraph({
      nodeFirstEdgeIndex,
      nodeEdgeCount,
      edgeTargetNodeIndex,
      edgeCostTicks,
      outDistSeconds,
      sourceNodeIndex,
      timeLimitSeconds,
    }) {
      return runDijkstra({
        nodeFirstEdgeIndex,
        nodeEdgeCount,
        edgeTargetNodeIndex,
        edgeCostTicks,
        outDistSeconds,
        seeds: [{ nodeIndex: sourceNodeIndex, startDistSeconds: 0 }],
        timeLimitSeconds,
      });
    },
    computeTravelTimeFieldMultiSourceForGraph({
      nodeFirstEdgeIndex,
      nodeEdgeCount,
      edgeTargetNodeIndex,
      edgeCostTicks,
      outDistSeconds,
      seedNodeIndices,
      seedStartDistSeconds,
      timeLimitSeconds,
    }) {
      const seeds = [];
      for (let i = 0; i < seedNodeIndices.length; i += 1) {
        seeds.push({ nodeIndex: seedNodeIndices[i], startDistSeconds: seedStartDistSeconds[i] });
      }
      return runDijkstra({
        nodeFirstEdgeIndex,
        nodeEdgeCount,
        edgeTargetNodeIndex,
        edgeCostTicks,
        outDistSeconds,
        seeds,
        timeLimitSeconds,
      });
    },
  };
}

function createFixtureBinaryBuffer() {
  const headerSize = 64;
  const nodeRecordSize = 16;
  const edgeRecordSize = 12;
  const nNodes = 2;
  const nEdges = 1;
  const nodeTableOffset = headerSize;
  const edgeTableOffset = nodeTableOffset + nNodes * nodeRecordSize;
  const stopTableOffset = edgeTableOffset + nEdges * edgeRecordSize;
  const buffer = new ArrayBuffer(stopTableOffset);
  const view = new DataView(buffer);

  view.setUint32(0, GRAPH_MAGIC, true);
  view.setUint8(4, 2); // version
  view.setUint8(5, 0); // flags
  view.setUint32(8, nNodes, true);
  view.setUint32(12, nEdges, true);
  view.setUint32(16, 0, true); // nStops
  view.setUint32(20, 0, true); // nTedges
  view.setFloat64(24, 392000, true);
  view.setFloat64(32, 5820000, true);
  view.setUint16(40, 25833, true);
  view.setUint16(42, 512, true);
  view.setUint16(44, 512, true);
  view.setFloat32(48, 10, true);
  view.setUint32(52, nodeTableOffset, true);
  view.setUint32(56, edgeTableOffset, true);
  view.setUint32(60, stopTableOffset, true);

  const nodeI32 = new Int32Array(buffer, nodeTableOffset, nNodes * 4);
  const nodeU32 = new Uint32Array(buffer, nodeTableOffset, nNodes * 4);
  const nodeU16 = new Uint16Array(buffer, nodeTableOffset, nNodes * 8);
  nodeI32[0] = 0;
  nodeI32[1] = 0;
  nodeU32[2] = 0;
  nodeU16[6] = 1;
  nodeI32[4] = 100;
  nodeI32[5] = 0;
  nodeU32[6] = 1;
  nodeU16[14] = 0;

  const edgeU32 = new Uint32Array(buffer, edgeTableOffset, nEdges * 3);
  const edgeU16 = new Uint16Array(buffer, edgeTableOffset, nEdges * 6);
  edgeU32[0] = 1;
  edgeU16[2] = 72;
  const modeMask = EDGE_MODE_WALK_BIT | EDGE_MODE_CAR_BIT;
  const roadClassId = 11;
  const maxspeedKph = 50;
  edgeU32[2] = modeMask | (roadClassId << 8) | (maxspeedKph << 16);

  return buffer;
}

// Builds a transit-capable graph binary from a compact description, so the
// several transit tests below don't each repeat ~60 lines of DataView offset
// arithmetic. Nodes are laid out in a line 100m apart along y=0, joined by
// walk/car edges costing 72s each (100m / WALKING_SPEED_M_S).
function createTransitGraphBuffer({ nodeCount = 3, stops, tedges }) {
  const headerSize = 64;
  const nodeRecordSize = 16;
  const edgeRecordSize = 12;
  const stopRecordSize = 24;
  const tedgeRecordSize = 20;
  const nEdges = nodeCount - 1;
  const nodeTableOffset = headerSize;
  const edgeTableOffset = nodeTableOffset + nodeCount * nodeRecordSize;
  const stopTableOffset = edgeTableOffset + nEdges * edgeRecordSize;
  const tedgeTableOffset = stopTableOffset + stops.length * stopRecordSize;
  const buffer = new ArrayBuffer(tedgeTableOffset + tedges.length * tedgeRecordSize);
  const view = new DataView(buffer);

  view.setUint32(0, GRAPH_MAGIC, true);
  view.setUint8(4, 2);
  view.setUint8(5, 1); // flags: has_transit
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, nEdges, true);
  view.setUint32(16, stops.length, true);
  view.setUint32(20, tedges.length, true);
  view.setFloat64(24, 392000, true);
  view.setFloat64(32, 5820000, true);
  view.setUint16(40, 25833, true);
  view.setUint16(42, 512, true);
  view.setUint16(44, 512, true);
  view.setFloat32(48, 10, true);
  view.setUint32(52, nodeTableOffset, true);
  view.setUint32(56, edgeTableOffset, true);
  view.setUint32(60, stopTableOffset, true);

  const nodeI32 = new Int32Array(buffer, nodeTableOffset, nodeCount * 4);
  const nodeU32 = new Uint32Array(buffer, nodeTableOffset, nodeCount * 4);
  const nodeU16 = new Uint16Array(buffer, nodeTableOffset, nodeCount * 8);
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    nodeI32[nodeIndex * 4] = nodeIndex * 100; // x_m
    nodeI32[nodeIndex * 4 + 1] = 0; // y_m
    nodeU32[nodeIndex * 4 + 2] = nodeIndex; // first_edge_index
    nodeU16[nodeIndex * 8 + 6] = nodeIndex < nEdges ? 1 : 0; // outgoing_edge_count
  }

  const edgeU32 = new Uint32Array(buffer, edgeTableOffset, nEdges * 3);
  const edgeU16 = new Uint16Array(buffer, edgeTableOffset, nEdges * 6);
  const modeMask = EDGE_MODE_WALK_BIT | EDGE_MODE_CAR_BIT;
  for (let edgeIndex = 0; edgeIndex < nEdges; edgeIndex += 1) {
    edgeU32[edgeIndex * 3] = edgeIndex + 1; // target_node_index
    edgeU16[edgeIndex * 6 + 2] = 72; // length_m
    edgeU32[edgeIndex * 3 + 2] = modeMask | (11 << 8) | (50 << 16);
  }

  stops.forEach((stop, stopIndex) => {
    const base = stopTableOffset + stopIndex * stopRecordSize;
    view.setInt32(base, stop.xM, true);
    view.setInt32(base + 4, stop.yM ?? 0, true);
    view.setUint32(base + 8, stop.nearestNodeIndex, true);
    view.setUint8(base + 18, stop.transportType ?? 2);
  });

  tedges.forEach((tedge, tedgeIndex) => {
    const base = tedgeTableOffset + tedgeIndex * tedgeRecordSize;
    view.setUint32(base, tedge.fromStop, true);
    view.setUint32(base + 4, tedge.toStop, true);
    view.setUint32(base + 8, tedge.departureSeconds, true);
    view.setUint16(base + 12, tedge.travelSeconds, true);
    view.setUint16(base + 14, tedge.routeId ?? 0, true);
    view.setUint32(base + 16, tedge.serviceDayMask ?? 0b1111111, true);
  });

  return buffer;
}

// 3 nodes in a line (0,0) -> (100,0) -> (200,0), plus 2 stops sitting exactly
// on node 0 and node 2 (zero walk-attach cost) connected by a single fast
// transit edge - a "subway" that bypasses the 144s walk between them.
function createFixtureBinaryBufferWithTransit(serviceDayMask = 0b1111111) {
  return createTransitGraphBuffer({
    nodeCount: 3,
    stops: [
      { xM: 0, nearestNodeIndex: 0 },
      { xM: 200, nearestNodeIndex: 2 },
    ],
    tedges: [
      { fromStop: 0, toStop: 1, departureSeconds: 1000, travelSeconds: 10, serviceDayMask },
    ],
  });
}

test('MinHeap keeps ascending pop order', () => {
  const heap = new MinHeap(8);
  heap.push(4, 9);
  heap.push(1, 3);
  heap.push(2, 5);
  heap.decreaseKey(4, 2);

  assert.equal(heap.pop()?.nodeIndex, 4);
  assert.equal(heap.pop()?.nodeIndex, 1);
  assert.equal(heap.pop()?.nodeIndex, 2);
  assert.equal(heap.pop(), null);
});

test('parseGraphBinary decodes v2 edge mode, class, and speed metadata', () => {
  const graph = parseGraphBinary(createFixtureBinaryBuffer());
  assert.equal(graph.header.nNodes, 2);
  assert.equal(graph.header.nEdges, 1);
  assert.equal(graph.edgeModeMask[0], EDGE_MODE_WALK_BIT | EDGE_MODE_CAR_BIT);
  assert.equal(graph.edgeRoadClassId[0], 11);
  assert.equal(graph.edgeMaxspeedKph[0], 50);
});

test('parseGraphBinary decodes stop and transit-edge tables', () => {
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit());

  assert.equal(graph.header.nStops, 2);
  assert.equal(graph.header.nTedges, 1);
  assert.equal(graph.header.flags & 1, 1);

  assert.equal(graph.stopX[0], 0);
  assert.equal(graph.stopY[0], 0);
  assert.equal(graph.stopNearestNodeIndex[0], 0);
  assert.equal(graph.stopTransportType[0], 2);
  assert.equal(graph.stopX[1], 200);
  assert.equal(graph.stopNearestNodeIndex[1], 2);

  assert.equal(graph.tedgeFromStop[0], 0);
  assert.equal(graph.tedgeToStop[0], 1);
  assert.equal(graph.tedgeDepartureSeconds[0], 1000);
  assert.equal(graph.tedgeTravelSeconds[0], 10);
});

test('runConnectionScanFromWalkingReachableStops seeds a stop reached faster by transit', () => {
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit());
  // Pure walking from node 0: node1=72s, node2=144s.
  const walkDistSeconds = new Float32Array([0, 72, 144]);

  const result = runConnectionScanFromWalkingReachableStops(graph, walkDistSeconds, {
    departureSecondsOfDay: 990,
    departureWeekdayIndex: 2,
    timeLimitSeconds: 200,
  });

  assert.equal(result.seedNodeIndices.length, 1);
  assert.equal(result.seedNodeIndices[0], 2);
  // Board at stop 0 (t=990, zero walk-attach), ride to stop 1 arriving
  // t=1010, walk off (zero attach) -> 20s elapsed, versus 144s on foot.
  assert.equal(result.seedStartDistSeconds[0], 20);
  assert.equal(result.renderableTedgeIndices.length, 1);
  assert.equal(result.renderableTedgeIndices[0], 0);
});

test('runConnectionScanFromWalkingReachableStops keeps every hop of a multi-stop route, and dedupes repeated trips of the same hop', () => {
  // One line running stop0 -> stop1 -> stop2, plus a second, later trip over
  // the identical stop0 -> stop1 hop. Every consecutive hop must come back
  // (this is the A->B, B->C connectivity that renders as a continuous line),
  // while the duplicate hop must collapse to a single drawn segment.
  const graph = parseGraphBinary(createTransitGraphBuffer({
    nodeCount: 3,
    stops: [
      { xM: 0, nearestNodeIndex: 0 },
      { xM: 100, nearestNodeIndex: 1 },
      { xM: 200, nearestNodeIndex: 2 },
    ],
    tedges: [
      { fromStop: 0, toStop: 1, departureSeconds: 1000, travelSeconds: 10 },
      { fromStop: 1, toStop: 2, departureSeconds: 1030, travelSeconds: 10 },
      // Same stop pair as the first hop, a later trip of the same line.
      { fromStop: 0, toStop: 1, departureSeconds: 1200, travelSeconds: 10 },
    ],
  }));
  // Only the origin node is reachable on foot (transit-only routing).
  const walkDistSeconds = new Float32Array([0, Infinity, Infinity]);

  const result = runConnectionScanFromWalkingReachableStops(graph, walkDistSeconds, {
    departureSecondsOfDay: 990,
    departureWeekdayIndex: 2,
    timeLimitSeconds: 600,
  });

  // Two distinct hops drawn (0->1 and 1->2), the repeat of 0->1 deduped away.
  assert.deepEqual(Array.from(result.renderableTedgeIndices), [0, 1]);

  // Riding hop 1 must make stop 2 reachable, i.e. the chain is followed
  // through rather than stopping at the first hop.
  assert.equal(result.stopElapsedSeconds[0], 0); // boarded at the origin
  assert.equal(result.stopElapsedSeconds[1], 1010 - 990);
  assert.equal(result.stopElapsedSeconds[2], 1040 - 990);
});

test('runConnectionScanFromWalkingReachableStops finds no improvement when the connection departs too early', () => {
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit());
  const walkDistSeconds = new Float32Array([0, 72, 144]);

  // Departing at 1500 means the walker reaches stop 0 at t=1500, well
  // after the (single, non-repeating) connection's t=1000 departure —
  // nothing to catch.
  const result = runConnectionScanFromWalkingReachableStops(graph, walkDistSeconds, {
    departureSecondsOfDay: 1500,
    departureWeekdayIndex: 2,
    timeLimitSeconds: 200,
  });

  assert.equal(result.seedNodeIndices.length, 0);
  assert.equal(result.seedStartDistSeconds.length, 0);
});

test('runConnectionScanFromWalkingReachableStops skips a connection whose service_day_mask excludes the departure weekday', () => {
  // Mask 0b0011111 = Monday..Friday only (bit 0 = Monday, matching
  // data_pipeline/gtfs_transit.py's _WEEKDAY_COLUMNS order). Querying for
  // Sunday (index 6) must find the connection timing-eligible but
  // day-ineligible, same as if it didn't exist.
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit(0b0011111));
  const walkDistSeconds = new Float32Array([0, 72, 144]);

  const sundayResult = runConnectionScanFromWalkingReachableStops(graph, walkDistSeconds, {
    departureSecondsOfDay: 990,
    departureWeekdayIndex: 6,
    timeLimitSeconds: 200,
  });
  assert.equal(sundayResult.seedNodeIndices.length, 0);

  const wednesdayResult = runConnectionScanFromWalkingReachableStops(graph, walkDistSeconds, {
    departureSecondsOfDay: 990,
    departureWeekdayIndex: 2,
    timeLimitSeconds: 200,
  });
  assert.equal(wednesdayResult.seedNodeIndices.length, 1);
});

test('runConnectionScanFromWalkingReachableStops only boards stops the walk graph actually reaches', () => {
  // Walking to a stop has to follow the pedestrian graph, never a straight
  // line, or riders would be routed across rivers, railways and private land.
  // walkDistSeconds is that graph search's output, so a stop whose attachment
  // node it never reached must not be boardable no matter how near the
  // platform is as the crow flies.
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit());

  // Origin is node 1, 100 m from stop 0's node - but no walk edge was within
  // budget, so nothing is boardable.
  const strandedResult = runConnectionScanFromWalkingReachableStops(
    graph,
    new Float32Array([Infinity, 0, Infinity]),
    { departureSecondsOfDay: 900, departureWeekdayIndex: 2, timeLimitSeconds: 300 },
  );
  assert.equal(strandedResult.renderableTedgeIndices.length, 0);
  assert.equal(strandedResult.seedNodeIndices.length, 0);

  // Same origin, but now the walk search did reach stop 0's node (72 s away),
  // so that stop can be boarded and the ride carries on to stop 1.
  const connectedResult = runConnectionScanFromWalkingReachableStops(
    graph,
    new Float32Array([72, 0, Infinity]),
    { departureSecondsOfDay: 900, departureWeekdayIndex: 2, timeLimitSeconds: 300 },
  );
  assert.deepEqual(Array.from(connectedResult.renderableTedgeIndices), [0]);
  assert.equal(connectedResult.seedNodeIndices.length, 1);
  assert.equal(connectedResult.seedNodeIndices[0], 2);
  // Boarded at 900+72=972, rode to arrive 1010, i.e. 110 s after departure.
  assert.equal(connectedResult.seedStartDistSeconds[0], 110);
});

test('runConnectionScanFromWalkingReachableStops returns empty seeds for a graph with no stops', () => {
  const graph = parseGraphBinary(createFixtureBinaryBuffer());
  const walkDistSeconds = new Float32Array([0, 72]);

  const result = runConnectionScanFromWalkingReachableStops(graph, walkDistSeconds, {
    departureSecondsOfDay: 0,
    departureWeekdayIndex: 2,
    timeLimitSeconds: 200,
  });

  assert.equal(result.seedNodeIndices.length, 0);
  assert.equal(result.seedStartDistSeconds.length, 0);
});

test('buildTransitConnectionEdgeVertexData emits (x, y, seconds) endpoints coloured by each stop arrival time', () => {
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit());
  const nodePixels = precomputeNodePixelCoordinates(graph);
  // Fixture's single tedge connects stop 0 (nearest node 0) to stop 1
  // (nearest node 2), see createFixtureBinaryBufferWithTransit.
  const renderableTedgeIndices = Uint32Array.from([0]);
  const stopElapsedSeconds = Float64Array.from([30, 80]);

  const packed = buildTransitConnectionEdgeVertexData(
    graph,
    nodePixels,
    renderableTedgeIndices,
    stopElapsedSeconds,
  );

  assert.equal(packed.length, 6);
  assert.equal(packed[0], nodePixels.nodePixelX[0]);
  assert.equal(packed[1], nodePixels.nodePixelY[0]);
  assert.equal(packed[2], 30); // arrival at the boarding stop
  assert.equal(packed[3], nodePixels.nodePixelX[2]);
  assert.equal(packed[4], nodePixels.nodePixelY[2]);
  assert.equal(packed[5], 80); // arrival at the alighting stop
});

test('buildTransitConnectionEdgeVertexData drops connections whose endpoints are unreachable', () => {
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit());
  const nodePixels = precomputeNodePixelCoordinates(graph);

  const packed = buildTransitConnectionEdgeVertexData(
    graph,
    nodePixels,
    Uint32Array.from([0]),
    Float64Array.from([30, Number.POSITIVE_INFINITY]),
  );

  assert.equal(packed.length, 0);
});

test('runWalkingIsochroneFromSourceNode repaints the canvas with transit-augmented distances', async () => {
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit());
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const pixelGrid = createPixelGrid(graph.header.gridWidthPx, graph.header.gridHeightPx);
  const edgeCostPrecomputeKernel = createDijkstraEdgeCostPrecomputeKernel(graph);
  const mapData = { graph, nodePixels, pixelGrid, edgeCostPrecomputeKernel };

  let drawCallCount = 0;
  const shell = {
    isochroneCanvas: {
      getContext() {
        return null;
      },
      __isochroneRenderer: {
        mode: 'cpu',
        draw() {
          drawCallCount += 1;
        },
      },
    },
    routingStatus: { textContent: '' },
  };

  // Node 2 is 144s away on foot (two 72s edges) but only 20s away via the
  // fixture's transit connection (see the CSA-only test above) — a case
  // where the transit pass must strictly improve the result.
  await runWalkingIsochroneFromSourceNode(shell, mapData, 0, 200, {
    allowedModeMask: EDGE_MODE_WALK_BIT,
    transitEnabled: true,
    departureSecondsOfDay: 990,
    departureWeekdayIndex: 2,
    colourCycleMinutes: 60,
  });

  assert.equal(mapData.lastRoutingSnapshot.distSeconds[1], 72);
  assert.equal(mapData.lastRoutingSnapshot.distSeconds[2], 20);
  // The initial pass-1 (walk-only) render paints once; the transit
  // augmentation must trigger a second paint with the improved distances,
  // or the canvas would silently keep showing the walk-only isochrone
  // (144s at node 2) even though the snapshot data says 20s.
  assert.equal(drawCallCount, 2);
});

test('runWalkingIsochroneFromSourceNode does not repaint when transit finds no improvement', async () => {
  const graph = parseGraphBinary(createFixtureBinaryBufferWithTransit());
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const pixelGrid = createPixelGrid(graph.header.gridWidthPx, graph.header.gridHeightPx);
  const edgeCostPrecomputeKernel = createDijkstraEdgeCostPrecomputeKernel(graph);
  const mapData = { graph, nodePixels, pixelGrid, edgeCostPrecomputeKernel };

  let drawCallCount = 0;
  const shell = {
    isochroneCanvas: {
      getContext() {
        return null;
      },
      __isochroneRenderer: {
        mode: 'cpu',
        draw() {
          drawCallCount += 1;
        },
      },
    },
    routingStatus: { textContent: '' },
  };

  // Departing at 1500 misses the fixture's single t=1000 connection (see
  // the matching CSA-only test above), so the walk-only result stands.
  await runWalkingIsochroneFromSourceNode(shell, mapData, 0, 200, {
    allowedModeMask: EDGE_MODE_WALK_BIT,
    transitEnabled: true,
    departureSecondsOfDay: 1500,
    departureWeekdayIndex: 2,
    colourCycleMinutes: 60,
  });

  assert.equal(mapData.lastRoutingSnapshot.distSeconds[2], 144);
  assert.equal(drawCallCount, 1);
});

test('computeEdgeTraversalCostSeconds obeys mode and road-class constraints', () => {
  const graph = createFixtureGraph();
  const walkSeconds = computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_WALK_BIT);
  const bikeSeconds = computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_BIKE_BIT);
  const carSeconds = computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_CAR_BIT);
  assert.equal(walkSeconds, 72);
  assert.ok(bikeSeconds > 0 && bikeSeconds < walkSeconds);
  assert.ok(carSeconds > 0 && carSeconds < bikeSeconds);

  graph.edgeRoadClassId[0] = 15; // motorway
  assert.equal(
    computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_WALK_BIT),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(
    computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_BIKE_BIT),
    Number.POSITIVE_INFINITY,
  );

  graph.edgeModeMask[0] = EDGE_MODE_CAR_BIT;
  graph.edgeMaxspeedKph[0] = 0;
  assert.ok(
    computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_CAR_BIT) <
      72 * (50 / CAR_FALLBACK_SPEED_KPH),
  );
});

test('computeEdgeTraversalCostSeconds costs ferry edges at ferry speed regardless of boarding mode', () => {
  const graph = createFixtureGraph();

  // Edge 0 (0 -> 1, ~100m) is a foot-passenger ferry with a baked 36 kph
  // crossing speed, not the ~72s walking-pace baked into edgeU16
  // walking-cost.
  const WALKING_SPEED_M_S = 1.39;
  const bakedWalkingCostSeconds = graph.edgeU16[2];
  const distanceMeters = bakedWalkingCostSeconds * WALKING_SPEED_M_S;
  graph.edgeModeMask[0] = EDGE_MODE_WALK_BIT | EDGE_MODE_WATER_BIT;
  graph.edgeMaxspeedKph[0] = 36;
  const expectedFerrySeconds = distanceMeters / ((36 * 1000) / 3600);

  // Riding a ferry needs Ferry selected *and* a mode you can board it in.
  // Walk alone used to be enough, which let a walking isochrone cross open
  // water - Portsmouth reached the Isle of Wight on foot.
  assert.equal(
    computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_WALK_BIT),
    Number.POSITIVE_INFINITY,
  );
  // Ferry alone cannot reach the terminal in the first place.
  assert.equal(
    computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_WATER_BIT),
    Number.POSITIVE_INFINITY,
  );
  assert.ok(
    Math.abs(
      computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_WALK_BIT | EDGE_MODE_WATER_BIT)
        - expectedFerrySeconds,
    ) < 1e-6,
  );
  assert.notEqual(expectedFerrySeconds, bakedWalkingCostSeconds);
  // A bike cannot board a walk-only vessel even with Ferry selected.
  assert.equal(
    computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_BIKE_BIT | EDGE_MODE_WATER_BIT),
    Number.POSITIVE_INFINITY,
  );

  // A drive-on ferry takes Car + Ferry, not Walk + Ferry.
  graph.edgeModeMask[0] = EDGE_MODE_CAR_BIT | EDGE_MODE_WATER_BIT;
  assert.equal(
    computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_WALK_BIT | EDGE_MODE_WATER_BIT),
    Number.POSITIVE_INFINITY,
  );
  assert.ok(
    computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_CAR_BIT | EDGE_MODE_WATER_BIT) > 0,
  );

  // With no baked maxspeed, a water edge falls back to WATER_FALLBACK_SPEED_KPH.
  graph.edgeModeMask[0] = EDGE_MODE_WATER_BIT;
  graph.edgeMaxspeedKph[0] = 0;
  const fallbackMetersPerSecond = (WATER_FALLBACK_SPEED_KPH * 1000) / 3600;
  const expectedFallbackSeconds = distanceMeters / fallbackMetersPerSecond;
  assert.ok(
    Math.abs(
      computeEdgeTraversalCostSeconds(graph, 0, EDGE_MODE_WATER_BIT) - expectedFallbackSeconds,
    ) < 1e-6,
  );
});

test('createWalkingSearchState settles reachable nodes and computes best costs', () => {
  const graph = createFixtureGraph();
  const state = createWalkingSearchState(
    graph,
    0,
    Number.POSITIVE_INFINITY,
    EDGE_MODE_CAR_BIT,
    {
      edgeCostPrecomputeKernel: createFixtureEdgeCostPrecomputeKernel(graph),
    },
  );
  while (!state.isDone()) {
    state.expandOne();
  }

  assert.equal(state.settledCount, 3);
  assert.ok(Number.isFinite(state.distSeconds[2]));
  assert.ok(Math.abs(state.distSeconds[2] - 12) < 0.05);
});

test('createWalkingSearchState seeds extra sources alongside the primary source', () => {
  const graph = createFixtureGraph();
  const withoutSeed = createWalkingSearchState(
    graph,
    0,
    Number.POSITIVE_INFINITY,
    EDGE_MODE_CAR_BIT,
    { edgeCostPrecomputeKernel: createFixtureEdgeCostPrecomputeKernel(graph) },
  );
  while (!withoutSeed.isDone()) {
    withoutSeed.expandOne();
  }

  // node 2 (terminal, no outgoing edges) is reached at ~12s by driving
  // through node 1. Seeding it directly at 1s (as if a transit leg got
  // there faster) must win, without affecting node 1's own distance (no
  // edge runs from node 2 back to node 1).
  const withSeed = createWalkingSearchState(
    graph,
    0,
    Number.POSITIVE_INFINITY,
    EDGE_MODE_CAR_BIT,
    {
      edgeCostPrecomputeKernel: createFixtureEdgeCostPrecomputeKernel(graph),
      extraSeeds: [{ nodeIndex: 2, startDistSeconds: 1 }],
    },
  );
  while (!withSeed.isDone()) {
    withSeed.expandOne();
  }

  assert.ok(withoutSeed.distSeconds[2] > 1);
  assert.equal(withSeed.distSeconds[2], 1);
  assert.equal(withSeed.distSeconds[1], withoutSeed.distSeconds[1]);
});

test('createWalkingSearchState precomputes edge traversal cache for active mode', () => {
  const graph = createFixtureGraph();
  const state = createWalkingSearchState(
    graph,
    0,
    Number.POSITIVE_INFINITY,
    EDGE_MODE_CAR_BIT,
    {
      edgeCostPrecomputeKernel: createFixtureEdgeCostPrecomputeKernel(graph),
    },
  );

  assert.equal(state.edgeTraversalCostSeconds.length, graph.header.nEdges);
  for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
    assert.ok(!Number.isNaN(state.edgeTraversalCostSeconds[edgeIndex]));
  }
});

test('getOrBuildEdgeTraversalCostTicksForMode quantizes, caches per source array, and invalidates on a new source', () => {
  const graph = createFixtureGraph();
  const edgeTraversalCostSeconds = new Float32Array([1.2, Number.POSITIVE_INFINITY]);

  const first = getOrBuildEdgeTraversalCostTicksForMode(
    graph,
    EDGE_MODE_CAR_BIT,
    edgeTraversalCostSeconds,
  );
  const firstAgain = getOrBuildEdgeTraversalCostTicksForMode(
    graph,
    EDGE_MODE_CAR_BIT,
    edgeTraversalCostSeconds,
  );
  // A different edgeTraversalCostSeconds array for the same mode mask (e.g.
  // recomputed after a walk/bike speed change) must not reuse the ticks
  // cached from the previous array — same mask, different content.
  const second = getOrBuildEdgeTraversalCostTicksForMode(
    graph,
    EDGE_MODE_CAR_BIT,
    new Float32Array([9.9, 9.9]),
  );
  const bike = getOrBuildEdgeTraversalCostTicksForMode(
    graph,
    EDGE_MODE_BIKE_BIT,
    new Float32Array([0.5, 0]),
  );

  assert.equal(first, firstAgain);
  assert.equal(first[0], Math.ceil(edgeTraversalCostSeconds[0] * 1000));
  assert.equal(first[1], 0);
  assert.notEqual(first, second);
  assert.equal(second[0], Math.ceil(9.9 * 1000));
  assert.equal(second[1], Math.ceil(9.9 * 1000));
  assert.notEqual(first, bike);
  assert.equal(bike[0], 500);
  assert.equal(bike[1], 0);
});

test('getOrRotateRoutingDistScratchBuffer alternates between two reusable buffers', () => {
  const mapData = {};
  const first = getOrRotateRoutingDistScratchBuffer(mapData, 3);
  const second = getOrRotateRoutingDistScratchBuffer(mapData, 3);
  const third = getOrRotateRoutingDistScratchBuffer(mapData, 3);

  assert.ok(first instanceof Float32Array);
  assert.ok(second instanceof Float32Array);
  assert.equal(first.length, 3);
  assert.equal(second.length, 3);
  assert.notEqual(first, second);
  assert.equal(third, first);
});

test('getOrRotateRoutingDistScratchBuffer rebuilds buffers when node count changes', () => {
  const mapData = {};
  const first = getOrRotateRoutingDistScratchBuffer(mapData, 2);
  const second = getOrRotateRoutingDistScratchBuffer(mapData, 2);
  const resized = getOrRotateRoutingDistScratchBuffer(mapData, 4);

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(resized.length, 4);
  assert.notEqual(resized, first);
  assert.notEqual(resized, second);
});

test('createWalkingSearchState can use provided edge-cost precompute kernel', () => {
  const graph = createFixtureGraph();
  let kernelCallCount = 0;
  const state = createWalkingSearchState(graph, 0, Number.POSITIVE_INFINITY, EDGE_MODE_CAR_BIT, {
    edgeCostPrecomputeKernel: {
      precomputeEdgeCostsForGraph({ outCostSeconds }) {
        kernelCallCount += 1;
        outCostSeconds.fill(5);
      },
    },
  });

  assert.equal(kernelCallCount, 1);
  assert.equal(state.edgeTraversalCostSeconds[0], 5);
  assert.equal(state.edgeTraversalCostSeconds[1], 5);
});

test('createWalkingSearchState rejects kernel failure instead of falling back to JS', () => {
  const graph = createFixtureGraph();
  let kernelFailureCount = 0;
  assert.throws(
    () =>
      createWalkingSearchState(graph, 0, Number.POSITIVE_INFINITY, EDGE_MODE_CAR_BIT, {
        edgeCostPrecomputeKernel: createFixtureEdgeCostPrecomputeKernel(graph, {
          throwError: 'kernel unavailable',
        }),
        onKernelError() {
          kernelFailureCount += 1;
        },
      }),
    /kernel unavailable/,
  );
  assert.equal(kernelFailureCount, 1);
});

test('precomputeEdgeTraversalCostSecondsCache requires kernel and validates output', () => {
  const graph = createFixtureGraph();
  assert.throws(
    () =>
      precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, null, {}),
    /required and must expose precomputeEdgeCostsForGraph/,
  );

  let kernelErrorCount = 0;
  assert.throws(
    () =>
      precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, null, {
        edgeCostPrecomputeKernel: createFixtureEdgeCostPrecomputeKernel(graph, {
          throwError: 'kernel unavailable',
        }),
        onKernelError() {
          kernelErrorCount += 1;
        },
      }),
    /kernel unavailable/,
  );
  assert.equal(kernelErrorCount, 1);

  assert.throws(
    () =>
      precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, null, {
        edgeCostPrecomputeKernel: createFixtureEdgeCostPrecomputeKernel(graph, {
          fillNaN: true,
        }),
      }),
    /produced invalid cost at edge 0/,
  );
});

test('precomputeEdgeTraversalCostSecondsCache skips repeat kernel runs for same mode and output buffer', () => {
  const graph = createFixtureGraph();
  let kernelCallCount = 0;
  const kernel = {
    precomputeEdgeCostsForGraph({ outCostSeconds }) {
      kernelCallCount += 1;
      outCostSeconds.fill(7);
    },
  };

  const cachedA = precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, null, {
    edgeCostPrecomputeKernel: kernel,
  });
  const cachedB = precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, null, {
    edgeCostPrecomputeKernel: kernel,
  });
  const external = new Float32Array(graph.header.nEdges);
  precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, external, {
    edgeCostPrecomputeKernel: kernel,
  });
  precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, external, {
    edgeCostPrecomputeKernel: kernel,
  });

  assert.equal(cachedA, cachedB);
  assert.equal(kernelCallCount, 2);
});

test('buildModeSpecificKernelGraphViews compacts adjacency to finite tick edges only', () => {
  const graph = createFixtureGraph();
  const edgeTraversalCostTicks = new Uint32Array([1000, 0]);

  const compactViews = buildModeSpecificKernelGraphViews(
    graph,
    EDGE_MODE_CAR_BIT,
    edgeTraversalCostTicks,
  );

  assert.equal(compactViews.nodeFirstEdgeIndex.length, graph.header.nNodes);
  assert.equal(compactViews.nodeEdgeCount.length, graph.header.nNodes);
  assert.equal(compactViews.edgeTargetNodeIndex.length, 1);
  assert.equal(compactViews.edgeCostTicks.length, 1);
  assert.deepEqual(Array.from(compactViews.nodeFirstEdgeIndex), [0, 1, 1]);
  assert.deepEqual(Array.from(compactViews.nodeEdgeCount), [1, 0, 0]);
  assert.deepEqual(Array.from(compactViews.edgeTargetNodeIndex), [1]);
  assert.deepEqual(Array.from(compactViews.edgeCostTicks), [1000]);
});

test('node spatial index search prefers nearest node with an allowed mode', () => {
  const graph = createFixtureGraph();
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const nodeModeMask = precomputeNodeModeMask(graph);
  const spatialIndex = createNodeSpatialIndex(graph, nodePixels);

  const modeNode = findNearestNodeIndexForModeFromSpatialIndex(
    spatialIndex,
    nodePixels,
    nodeModeMask,
    200,
    255,
    EDGE_MODE_CAR_BIT,
  );
  assert.equal(modeNode, 1);
});

test('mapCanvasPixelToGraphMeters maps y-axis from canvas-down to northing-up', () => {
  const graph = createFixtureGraph();
  const topLeft = mapCanvasPixelToGraphMeters(graph, 0, 0);
  const bottomLeft = mapCanvasPixelToGraphMeters(graph, 0, graph.header.gridHeightPx - 1);
  assert.equal(topLeft.easting, 1000);
  assert.equal(topLeft.northing, 2000 + 255);
  assert.equal(bottomLeft.northing, 2000);
});

test('ensureWasmSupportOrShowError renders required message when WASM is unavailable', () => {
  const shell = {
    isochroneCanvas: {
      style: { pointerEvents: 'auto' },
      dataset: { graphLoaded: 'true' },
    },
    loadingOverlay: {
      hidden: true,
      classList: { remove() {} },
    },
    loadingText: { textContent: '' },
    loadingProgressBar: { style: { width: '' } },
    routingStatus: { textContent: '' },
  };

  const result = ensureWasmSupportOrShowError(shell, { runtimeGlobal: {} });

  assert.equal(result, false);
  assert.equal(shell.isochroneCanvas.style.pointerEvents, 'none');
  assert.equal(shell.isochroneCanvas.dataset.graphLoaded, 'false');
  assert.equal(shell.loadingOverlay.hidden, false);
  assert.equal(shell.loadingText.textContent, WASM_REQUIRED_MESSAGE);
  assert.equal(shell.routingStatus.textContent, WASM_REQUIRED_MESSAGE);
});

test('runSearchTimeSliced treats cancellation raised during expandOne as cancelled before onSlice runs', async () => {
  let cancelled = false;
  let done = false;
  let onSliceCallCount = 0;
  const searchState = {
    isDone() {
      return done;
    },
    expandOne() {
      cancelled = true;
      done = true;
      return 7;
    },
  };

  const summary = await runSearchTimeSliced(searchState, {
    isCancelled() {
      return cancelled;
    },
    onSlice() {
      onSliceCallCount += 1;
    },
    nowImpl() {
      return 0;
    },
  });

  assert.equal(summary.cancelled, true);
  assert.equal(summary.totalSettledCount, 1);
  assert.equal(summary.sliceCount, 0);
  assert.equal(onSliceCallCount, 0);
});

test('clearRenderedIsochrone clears stale routing snapshot and renderer state before a new map loads', () => {
  let clearCallCount = 0;
  const shell = {
    isochroneCanvas: {
      __isochroneRenderer: {
        draw() {},
        clear() {
          clearCallCount += 1;
        },
      },
    },
  };
  const pixelGrid = createPixelGrid(2, 2);
  pixelGrid.rgba.fill(255);
  const travelTimeGrid = createTravelTimeGrid(2, 2);
  travelTimeGrid.seconds.fill(12);
  const mapData = {
    pixelGrid,
    travelTimeGrid,
    lastRoutingSnapshot: { sourceNodeIndex: 42 },
  };

  clearRenderedIsochrone(shell, mapData);

  assert.equal(clearCallCount, 1);
  assert.equal(mapData.lastRoutingSnapshot, null);
  for (let i = 3; i < pixelGrid.rgba.length; i += 4) {
    assert.equal(pixelGrid.rgba[i], 0);
  }
  assert.ok(Array.from(travelTimeGrid.seconds).every((value) => value === -1));
});

test('timeToColour wraps to the beginning after each configured cycle', () => {
  const start = timeToColour(0, { cycleMinutes: 60 });
  const afterCycle = timeToColour(3600, { cycleMinutes: 60 });
  const secondBand = timeToColour(13 * 60, { cycleMinutes: 60 });
  const startLight = timeToColour(0, { cycleMinutes: 60, theme: 'light' });
  assert.deepEqual(start, [0, 255, 255]);
  assert.deepEqual(afterCycle, start);
  assert.deepEqual(secondBand, [64, 255, 64]);
  assert.deepEqual(startLight, [0, 110, 210]);
  assert.notDeepEqual(startLight, start);
});

test('renderIsochroneLegendIfNeeded renders print-safe swatches and caches by theme', () => {
  const shell = {
    isochroneLegend: { innerHTML: '' },
    lastRenderedLegendCycleMinutes: null,
    lastRenderedLegendTheme: null,
  };

  const firstRender = renderIsochroneLegendIfNeeded(shell, 75, { theme: 'light' });
  assert.equal(firstRender, true);
  assert.ok(shell.isochroneLegend.innerHTML.includes('class="legend-swatch-svg"'));
  assert.ok(shell.isochroneLegend.innerHTML.includes('fill="rgb(0, 110, 210)"'));
  assert.ok(!shell.isochroneLegend.innerHTML.includes('>■<'));

  const cachedRender = renderIsochroneLegendIfNeeded(shell, 75, { theme: 'light' });
  assert.equal(cachedRender, false);

  const themeChangeRender = renderIsochroneLegendIfNeeded(shell, 75, { theme: 'dark' });
  assert.equal(themeChangeRender, true);
});

test('renderIsochroneLegendIfNeeded localizes time ranges and rerenders when locale changes', () => {
  const shell = {
    isochroneLegend: { innerHTML: '' },
    lastRenderedLegendCycleMinutes: null,
    lastRenderedLegendTheme: null,
    lastRenderedLegendLocale: null,
    locale: 'en',
  };
  const englishMessages = {
    'legend.duration.minuteOnly': '{minutes} min',
    'legend.duration.hourOnly': '{hours} h',
    'legend.duration.hourMinute': '{hours} h {minutes} min',
    'legend.range': '{start}–{end}',
    'legend.repeat': 'Colours repeat every {duration}.',
  };
  const frenchMessages = {
    'legend.duration.minuteOnly': '{minutes} min',
    'legend.duration.hourOnly': '{hours} h',
    'legend.duration.hourMinute': '{hours} h {minutes} min',
    'legend.range': '{start}–{end}',
    'legend.repeat': 'Les couleurs se répètent toutes les {duration}.',
  };

  const firstRender = renderIsochroneLegendIfNeeded(shell, 120, {
    theme: 'dark',
    locale: 'en',
    messages: englishMessages,
  });
  assert.equal(firstRender, true);
  assert.ok(shell.isochroneLegend.innerHTML.includes('48 min–1 h 12 min'));
  assert.ok(shell.isochroneLegend.innerHTML.includes('Colours repeat every 2 h.'));

  const localeChangeRender = renderIsochroneLegendIfNeeded(shell, 120, {
    theme: 'dark',
    locale: 'fr',
    messages: frenchMessages,
  });
  assert.equal(localeChangeRender, true);
  assert.ok(shell.isochroneLegend.innerHTML.includes('48 min–1 h 12 min'));
  assert.ok(shell.isochroneLegend.innerHTML.includes('Les couleurs se répètent toutes les 2 h.'));
});

test('updateDistanceScaleBar sets distance-aligned segment width for patterned bar', () => {
  const lineStyle = {
    width: '',
    values: {},
    setProperty(name, value) {
      this.values[name] = value;
    },
  };
  const shell = {
    distanceScale: {},
    distanceScaleLine: { style: lineStyle },
    distanceScaleLabel: { textContent: '' },
    isochroneCanvas: {
      getBoundingClientRect() {
        return { width: 1000, height: 500 };
      },
    },
  };
  const graphHeader = {
    originEasting: 0,
    originNorthing: 0,
    gridWidthPx: 1000,
    gridHeightPx: 500,
    pixelSizeM: 10,
  };

  updateDistanceScaleBar(shell, graphHeader);
  assert.equal(shell.distanceScaleLine.style.width, '100px');
  assert.equal(shell.distanceScaleLabel.textContent, '1.0 km');
  assert.equal(shell.distanceScaleLine.style.values['--scale-segment-width-px'], '20px');
});

test('updateDistanceScaleBar reflects zoomed viewport scale', () => {
  const lineStyle = {
    width: '',
    values: {},
    setProperty(name, value) {
      this.values[name] = value;
    },
  };
  const shell = {
    distanceScale: {},
    distanceScaleLine: { style: lineStyle },
    distanceScaleLabel: { textContent: '' },
    isochroneCanvas: {
      getBoundingClientRect() {
        return { width: 1000, height: 500 };
      },
    },
  };
  const graphHeader = {
    originEasting: 0,
    originNorthing: 0,
    gridWidthPx: 1000,
    gridHeightPx: 500,
    pixelSizeM: 10,
  };

  updateDistanceScaleBar(shell, graphHeader, {
    viewport: {
      scale: 2,
      offsetXPx: 250,
      offsetYPx: 0,
    },
  });

  assert.equal(shell.distanceScaleLine.style.width, '100px');
  assert.equal(shell.distanceScaleLabel.textContent, '500 m');
  assert.equal(shell.distanceScaleLine.style.values['--scale-segment-width-px'], '20px');
});

test('computeExportDistanceScaleBar sizes the bar for the unzoomed export pixel grid, not the live viewport', () => {
  const graphHeader = { pixelSizeM: 10 };

  const exportScaleBar = computeExportDistanceScaleBar(graphHeader);

  // Matches the zoom=1 on-screen case (metresPerCssPixel === pixelSizeM) from
  // the 'sets distance-aligned segment width' test above, regardless of any
  // zoom level the live map view happens to be at when export is triggered.
  assert.equal(exportScaleBar.lineWidthPx, 100);
  assert.equal(exportScaleBar.segmentWidthPx, 20);
  assert.equal(exportScaleBar.label, '1.0 km');
});

test('computeExportDistanceScaleBar requires a positive pixelSizeM', () => {
  assert.throws(() => computeExportDistanceScaleBar({ pixelSizeM: 0 }));
  assert.throws(() => computeExportDistanceScaleBar(null));
});

test('layoutMapViewportToContainGraph clears legacy contained-layout sizing', () => {
  const style = {
    values: {
      '--map-aspect-ratio': '4 / 3',
      '--map-aspect-ratio-num': '1.333333',
    },
    width: '400px',
    height: '300px',
    aspectRatio: '4 / 3',
    transform: 'scale(2)',
    transformOrigin: '0 0',
    setProperty(name, value) {
      this.values[name] = value;
    },
  };
  const shell = {
    canvasStack: {
      style,
    },
  };

  const result = layoutMapViewportToContainGraph(shell, {
    originEasting: 0,
    originNorthing: 0,
    gridWidthPx: 4575,
    gridHeightPx: 3743,
    pixelSizeM: 10,
  });

  assert.equal(result.aspectRatio, 4575 / 3743);
  assert.equal(style.values['--map-aspect-ratio'], '');
  assert.equal(style.values['--map-aspect-ratio-num'], '');
  assert.equal(style.width, '');
  assert.equal(style.height, '');
  assert.equal(style.aspectRatio, '');
  assert.equal(style.transform, '');
  assert.equal(style.transformOrigin, '');
});

test('drawBoundaryBasemapAlignedToGraphGrid sizes canvas to display frame and preserves equal x/y scale', () => {
  const transformCalls = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    clearRect() {},
    setTransform(...args) {
      transformCalls.push(args);
    },
  };
  const boundaryCanvas = {
    width: 0,
    height: 0,
    getBoundingClientRect() {
      return { width: 800, height: 300 };
    },
    getContext(kind) {
      assert.equal(kind, '2d');
      return context;
    },
  };
  const graphHeader = {
    originEasting: 0,
    originNorthing: 0,
    gridWidthPx: 400,
    gridHeightPx: 300,
    pixelSizeM: 1,
  };
  const payload = {
    coordinate_space: {
      width: 400,
      height: 300,
      x_origin: 0,
      y_origin: 299,
      axis: 'x-right-y-down',
    },
    features: [
      {
        name: 'frame',
        paths: [
          [
            [0, 0],
            [399, 0],
            [399, 299],
            [0, 299],
            [0, 0],
          ],
        ],
      },
    ],
  };

  drawBoundaryBasemapAlignedToGraphGrid(boundaryCanvas, payload, graphHeader);

  assert.equal(boundaryCanvas.width, 800);
  assert.equal(boundaryCanvas.height, 300);
  assert.deepEqual(transformCalls[0], [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(
    transformCalls[1].map((value) => (Object.is(value, -0) ? 0 : value)),
    [1, 0, 0, 1, 200, 0],
  );
  assert.equal(context.lineWidth, 1.2);
});

test('drawBoundaryBasemapAlignedToGraphGrid renders water behind administrative boundaries', () => {
  const operations = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    beginPath() {
      operations.push({ type: 'beginPath' });
    },
    moveTo() {},
    lineTo() {},
    closePath() {
      operations.push({ type: 'closePath' });
    },
    fill() {
      operations.push({ type: 'fill', fillStyle: this.fillStyle });
    },
    stroke() {
      operations.push({ type: 'stroke', strokeStyle: this.strokeStyle });
    },
    clearRect() {},
    setTransform() {},
  };
  const boundaryCanvas = {
    width: 800,
    height: 300,
    getBoundingClientRect() {
      return { width: 800, height: 300 };
    },
    getContext(kind) {
      assert.equal(kind, '2d');
      return context;
    },
  };
  const graphHeader = {
    originEasting: 0,
    originNorthing: 0,
    gridWidthPx: 400,
    gridHeightPx: 300,
    pixelSizeM: 1,
  };
  const payload = {
    coordinate_space: {
      width: 400,
      height: 300,
      x_origin: 0,
      y_origin: 299,
      axis: 'x-right-y-down',
    },
    water_features: [
      {
        paths: [
          [
            [0, 0],
            [399, 0],
            [399, 299],
            [0, 299],
            [0, 0],
          ],
        ],
      },
    ],
    features: [
      {
        name: 'frame',
        paths: [
          [
            [100, 100],
            [300, 100],
            [300, 200],
            [100, 200],
            [100, 100],
          ],
        ],
      },
    ],
  };

  drawBoundaryBasemapAlignedToGraphGrid(boundaryCanvas, payload, graphHeader, {
    colourTheme: 'dark',
  });

  const fillOperations = operations.filter((operation) => operation.type === 'fill');
  const strokeOperations = operations.filter((operation) => operation.type === 'stroke');

  assert.equal(fillOperations.length, 2);
  assert.equal(strokeOperations.length, 1);
  assert.equal(fillOperations[0].fillStyle, getBoundaryWaterFillStyle('dark'));
  assert.equal(fillOperations[1].fillStyle, 'rgba(0, 0, 0, 0)');
  assert.equal(strokeOperations[0].strokeStyle, getBoundaryStrokeStyle('dark'));
});

test('drawBoundaryBasemapAlignedToGraphGrid draws forest/inland-water/waterway layers in order', () => {
  const operations = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    beginPath() {
      operations.push({ type: 'beginPath' });
    },
    moveTo() {},
    lineTo() {},
    closePath() {
      operations.push({ type: 'closePath' });
    },
    fill() {
      operations.push({ type: 'fill', fillStyle: this.fillStyle });
    },
    stroke() {
      operations.push({ type: 'stroke', strokeStyle: this.strokeStyle, lineWidth: this.lineWidth });
    },
    clearRect() {},
    setTransform() {},
  };
  const boundaryCanvas = {
    width: 800,
    height: 300,
    getBoundingClientRect() {
      return { width: 800, height: 300 };
    },
    getContext(kind) {
      assert.equal(kind, '2d');
      return context;
    },
  };
  const graphHeader = {
    originEasting: 0,
    originNorthing: 0,
    gridWidthPx: 400,
    gridHeightPx: 300,
    pixelSizeM: 1,
  };
  const closedSquare = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  const payload = {
    coordinate_space: {
      width: 400,
      height: 300,
      x_origin: 0,
      y_origin: 299,
      axis: 'x-right-y-down',
    },
    water_features: [{ paths: [closedSquare] }],
    forest_features: [{ name: 'BigForest', paths: [closedSquare] }],
    airport_features: [{ name: 'BigAirport', paths: [closedSquare] }],
    inland_water_features: [{ name: 'BigLake', paths: [closedSquare] }],
    waterway_features: [
      { name: 'NavigableRiver', category: 'river', navigable: true, paths: [[[0, 0], [10, 10]]] },
      { name: 'NonNavigableStream', category: 'stream', navigable: false, paths: [[[1, 1], [9, 9]]] },
    ],
    features: [
      {
        name: 'frame',
        paths: [
          [
            [100, 100],
            [300, 100],
            [300, 200],
            [100, 200],
            [100, 100],
          ],
        ],
      },
    ],
  };

  drawBoundaryBasemapAlignedToGraphGrid(boundaryCanvas, payload, graphHeader, {
    colourTheme: 'dark',
  });

  const fillOperations = operations.filter((operation) => operation.type === 'fill');
  const strokeOperations = operations.filter((operation) => operation.type === 'stroke');

  // Bottom-to-top fill order: forest, airports, inland water, sea, then the
  // (transparent) closed-boundary-path fill.
  assert.equal(fillOperations.length, 5);
  assert.equal(fillOperations[0].fillStyle, getForestFillStyle('dark'));
  assert.equal(fillOperations[1].fillStyle, getAirportFillStyle('dark'));
  assert.equal(fillOperations[2].fillStyle, getInlandWaterFillStyle('dark'));
  assert.equal(fillOperations[3].fillStyle, getBoundaryWaterFillStyle('dark'));
  assert.equal(fillOperations[4].fillStyle, 'rgba(0, 0, 0, 0)');

  // Waterway strokes happen before the admin boundary stroke, navigable
  // rendered with a thicker line than non-navigable.
  assert.equal(strokeOperations.length, 3);
  assert.equal(strokeOperations[0].strokeStyle, getWaterwayStrokeStyle('dark', true));
  assert.equal(strokeOperations[1].strokeStyle, getWaterwayStrokeStyle('dark', false));
  assert.equal(strokeOperations[2].strokeStyle, getBoundaryStrokeStyle('dark'));
  assert.ok(strokeOperations[0].lineWidth > strokeOperations[1].lineWidth);
});

test('createWebGlIsochroneRenderer requests an anti-aliased WebGL context', () => {
  const requestedContexts = [];
  const canvas = {
    getContext(kind, attributes) {
      requestedContexts.push({ kind, attributes });
      return null;
    },
  };

  const renderer = createWebGlIsochroneRenderer(canvas);

  assert.equal(renderer, null);
  assert.deepEqual(
    requestedContexts.map(({ kind, attributes }) => ({
      kind,
      antialias: attributes.antialias,
      alpha: attributes.alpha,
    })),
    [
      { kind: 'webgl2', antialias: true, alpha: true },
      { kind: 'webgl', antialias: true, alpha: true },
    ],
  );
});

test('parseNodeIndexFromLocationSearch validates and clamps invalid params', () => {
  assert.equal(parseNodeIndexFromLocationSearch('?node=12', 100), 12);
  assert.equal(parseNodeIndexFromLocationSearch('?node=-1', 100), null);
  assert.equal(parseNodeIndexFromLocationSearch('?node=foo', 100), null);
  assert.equal(parseNodeIndexFromLocationSearch('?node=100', 100), null);
  assert.equal(parseNodeIndexFromLocationSearch('', 100), null);
});

test('parseLocationIdFromLocationSearch returns a trimmed region id when present', () => {
  assert.equal(parseLocationIdFromLocationSearch('?region=rome'), 'rome');
  assert.equal(parseLocationIdFromLocationSearch('?region=%20london%20'), 'london');
  assert.equal(parseLocationIdFromLocationSearch('?region='), null);
  assert.equal(parseLocationIdFromLocationSearch(''), null);
});

test('persistNodeIndexToLocation rewrites URL when the node actually changes', () => {
  const locationObject = { href: 'https://example.test/map?foo=bar#viewport' };
  let replacedUrl = null;
  const historyObject = {
    replaceState(_state, _title, url) {
      replacedUrl = url;
    },
  };

  const changed = persistNodeIndexToLocation(9, { locationObject, historyObject });
  assert.equal(changed, true);
  assert.equal(replacedUrl, '/map?foo=bar&node=9#viewport');

  locationObject.href = 'https://example.test/map?foo=bar&node=9#viewport';
  const unchanged = persistNodeIndexToLocation(9, { locationObject, historyObject });
  assert.equal(unchanged, false);
});

test('persistLocationIdToLocation writes region query value, clears node, and preserves other params', () => {
  const locationObject = {
    href: 'https://example.test/map?foo=bar&node=123&modes=walk%2Ccar&cycle=75&lang=fr#viewport',
  };
  let replacedUrl = null;
  const historyObject = {
    replaceState(_state, _title, url) {
      replacedUrl = url;
    },
  };

  const changed = persistLocationIdToLocation('rome', { locationObject, historyObject });
  assert.equal(changed, true);
  assert.equal(
    replacedUrl,
    '/map?foo=bar&modes=walk%2Ccar&cycle=75&lang=fr&region=rome#viewport',
  );

  locationObject.href =
    'https://example.test/map?foo=bar&modes=walk%2Ccar&cycle=75&lang=fr&region=rome#viewport';
  const unchanged = persistLocationIdToLocation('rome', { locationObject, historyObject });
  assert.equal(unchanged, false);
});

test('parseModeValuesFromLocationSearch normalizes and validates values', () => {
  assert.deepEqual(parseModeValuesFromLocationSearch('?modes=car,bike'), ['bike', 'car']);
  assert.deepEqual(parseModeValuesFromLocationSearch('?modes=walk,car,car'), ['walk', 'car']);
  assert.equal(parseModeValuesFromLocationSearch('?modes=invalid'), null);
  assert.equal(parseModeValuesFromLocationSearch(''), null);
});

test('persistModeValuesToLocation writes canonical mode query values', () => {
  const locationObject = { href: 'https://example.test/map?foo=bar#viewport' };
  let replacedUrl = null;
  const historyObject = {
    replaceState(_state, _title, url) {
      replacedUrl = url;
    },
  };

  const changed = persistModeValuesToLocation(['car', 'bike', 'car'], {
    locationObject,
    historyObject,
  });
  assert.equal(changed, true);
  assert.equal(replacedUrl, '/map?foo=bar&modes=bike%2Ccar#viewport');

  locationObject.href = 'https://example.test/map?foo=bar&modes=bike%2Ccar#viewport';
  const unchanged = persistModeValuesToLocation(['bike', 'car'], { locationObject, historyObject });
  assert.equal(unchanged, false);
});

test('parseColourCycleMinutesFromLocationSearch validates and clamps values', () => {
  assert.equal(parseColourCycleMinutesFromLocationSearch('?cycle=75'), 75);
  assert.equal(parseColourCycleMinutesFromLocationSearch('?cycle=1'), 5);
  assert.equal(parseColourCycleMinutesFromLocationSearch('?cycle=9999'), 24 * 60);
  assert.equal(parseColourCycleMinutesFromLocationSearch('?cycle=foo'), null);
  assert.equal(parseColourCycleMinutesFromLocationSearch(''), null);
});

test('persistColourCycleMinutesToLocation writes cycle query value', () => {
  const locationObject = { href: 'https://example.test/map?foo=bar#viewport' };
  let replacedUrl = null;
  const historyObject = {
    replaceState(_state, _title, url) {
      replacedUrl = url;
    },
  };

  const changed = persistColourCycleMinutesToLocation(75, { locationObject, historyObject });
  assert.equal(changed, true);
  assert.equal(replacedUrl, '/map?foo=bar&cycle=75#viewport');

  locationObject.href = 'https://example.test/map?foo=bar&cycle=75#viewport';
  const unchanged = persistColourCycleMinutesToLocation(75, { locationObject, historyObject });
  assert.equal(unchanged, false);
});

test('parseDepartureDatetimeFromLocationSearch validates the ISO datetime-local shape', () => {
  assert.equal(parseDepartureDatetimeFromLocationSearch('?departure=2026-08-12T08:30'), '2026-08-12T08:30');
  assert.equal(parseDepartureDatetimeFromLocationSearch('?departure=2026-08-12'), null);
  assert.equal(parseDepartureDatetimeFromLocationSearch('?departure=not-a-date'), null);
  assert.equal(parseDepartureDatetimeFromLocationSearch(''), null);
});

test('persistDepartureDatetimeToLocation writes the departure query value', () => {
  const locationObject = { href: 'https://example.test/map?foo=bar#viewport' };
  let replacedUrl = null;
  const historyObject = {
    replaceState(_state, _title, url) {
      replacedUrl = url;
    },
  };

  const changed = persistDepartureDatetimeToLocation('2026-08-12T08:30', { locationObject, historyObject });
  assert.equal(changed, true);
  assert.equal(replacedUrl, '/map?foo=bar&departure=2026-08-12T08%3A30#viewport');

  locationObject.href = replacedUrl.replace('/map', 'https://example.test/map');
  const unchanged = persistDepartureDatetimeToLocation('2026-08-12T08:30', { locationObject, historyObject });
  assert.equal(unchanged, false);

  assert.throws(() => persistDepartureDatetimeToLocation('not-a-datetime'), /ISO YYYY-MM-DDTHH:MM/);
});

test('parseWalkSpeedKphFromLocationSearch and parseBikeSpeedKphFromLocationSearch validate and bound values', () => {
  assert.equal(parseWalkSpeedKphFromLocationSearch('?walkKph=5.5'), 5.5);
  assert.equal(parseWalkSpeedKphFromLocationSearch('?walkKph=0'), null);
  assert.equal(parseWalkSpeedKphFromLocationSearch('?walkKph=foo'), null);
  assert.equal(parseWalkSpeedKphFromLocationSearch(''), null);

  assert.equal(parseBikeSpeedKphFromLocationSearch('?bikeKph=25'), 25);
  assert.equal(parseBikeSpeedKphFromLocationSearch('?bikeKph=-5'), null);
});

test('persistWalkSpeedKphToLocation and persistBikeSpeedKphToLocation write their own query params', () => {
  const locationObject = { href: 'https://example.test/map?foo=bar#viewport' };
  let replacedUrl = null;
  const historyObject = {
    replaceState(_state, _title, url) {
      replacedUrl = url;
    },
  };

  const walkChanged = persistWalkSpeedKphToLocation(5, { locationObject, historyObject });
  assert.equal(walkChanged, true);
  assert.equal(replacedUrl, '/map?foo=bar&walkKph=5#viewport');

  locationObject.href = replacedUrl.replace('/map', 'https://example.test/map');
  const bikeChanged = persistBikeSpeedKphToLocation(20, { locationObject, historyObject });
  assert.equal(bikeChanged, true);
  assert.equal(replacedUrl, '/map?foo=bar&walkKph=5&bikeKph=20#viewport');
});

test('rerenderIsochroneFromSnapshotWithStatus sets done status with elapsed milliseconds', () => {
  const shell = {
    routingStatus: { textContent: 'Ready.' },
  };
  const mapData = {};
  let rerenderCallCount = 0;
  const nowValues = [100, 147];

  const rerendered = rerenderIsochroneFromSnapshotWithStatus(shell, mapData, {
    nowImpl() {
      return nowValues.shift();
    },
    rerenderImpl(receivedShell, receivedMapData) {
      rerenderCallCount += 1;
      assert.equal(receivedShell, shell);
      assert.equal(receivedMapData, mapData);
      return true;
    },
  });

  assert.equal(rerendered, true);
  assert.equal(rerenderCallCount, 1);
  assert.equal(shell.routingStatus.textContent, 'Done - full travel-time field ready (47 ms)');
});

test('rerenderIsochroneFromSnapshotWithStatus preserves status when rerender is unavailable', () => {
  const shell = {
    routingStatus: { textContent: 'Calculating... (42 nodes settled)' },
  };

  const rerendered = rerenderIsochroneFromSnapshotWithStatus(shell, {}, {
    nowImpl() {
      return 200;
    },
    rerenderImpl() {
      return false;
    },
  });

  assert.equal(rerendered, false);
  assert.equal(shell.routingStatus.textContent, 'Calculating... (42 nodes settled)');
});

test('getOrBuildSnapshotEdgeVertexData reuses cached edge vertices when mode mask matches', () => {
  const graph = createFixtureGraph();
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const cachedEdgeVertices = new Float32Array([1, 2, 3, 4, 5, 6]);
  const snapshot = {
    distSeconds: new Float32Array([0, 10, 20]),
    allowedModeMask: EDGE_MODE_CAR_BIT,
    edgeTraversalCostSeconds: new Float32Array(graph.header.nEdges),
    edgeVertexData: cachedEdgeVertices,
    edgeVertexDataModeMask: EDGE_MODE_CAR_BIT,
  };
  let collectCallCount = 0;

  const edgeVertexData = getOrBuildSnapshotEdgeVertexData(
    { graph, nodePixels },
    snapshot,
    {
      collectEdgeVerticesImpl() {
        collectCallCount += 1;
        return new Float32Array([9, 9, 9, 9, 9, 9]);
      },
    },
  );

  assert.equal(edgeVertexData, cachedEdgeVertices);
  assert.equal(snapshot.edgeVertexData, cachedEdgeVertices);
  assert.equal(collectCallCount, 0);
});

test('getOrBuildSnapshotEdgeVertexData rebuilds and stores vertices when cache is missing', () => {
  const graph = createFixtureGraph();
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const snapshot = {
    distSeconds: new Float32Array([0, 10, 20]),
    allowedModeMask: EDGE_MODE_BIKE_BIT,
    edgeTraversalCostSeconds: new Float32Array(graph.header.nEdges),
  };
  const rebuiltEdgeVertices = new Float32Array([10, 11, 12, 13, 14, 15]);
  let collectCallCount = 0;

  const edgeVertexData = getOrBuildSnapshotEdgeVertexData(
    { graph, nodePixels },
    snapshot,
    {
      collectEdgeVerticesImpl(receivedGraph, receivedNodePixels, receivedDistSeconds, receivedModeMask, collectOptions) {
        collectCallCount += 1;
        assert.equal(receivedGraph, graph);
        assert.equal(receivedNodePixels, nodePixels);
        assert.equal(receivedDistSeconds, snapshot.distSeconds);
        assert.equal(receivedModeMask, EDGE_MODE_BIKE_BIT);
        assert.equal(collectOptions.edgeTraversalCostSeconds, snapshot.edgeTraversalCostSeconds);
        return rebuiltEdgeVertices;
      },
    },
  );

  assert.equal(collectCallCount, 1);
  assert.equal(edgeVertexData, rebuiltEdgeVertices);
  assert.equal(snapshot.edgeVertexData, rebuiltEdgeVertices);
  assert.equal(snapshot.edgeVertexDataModeMask, EDGE_MODE_BIKE_BIT);
});

test('shouldUploadEdgeGeometry only skips upload for unchanged reusable full-frame geometry', () => {
  const edgeVertexData = new Float32Array([1, 2, 3, 4, 5, 6]);

  assert.equal(
    shouldUploadEdgeGeometry(null, 0, edgeVertexData, { append: false, reuseUploadedGeometry: true }),
    true,
  );
  assert.equal(
    shouldUploadEdgeGeometry(edgeVertexData, edgeVertexData.length, edgeVertexData, {
      append: false,
      reuseUploadedGeometry: true,
    }),
    false,
  );
  assert.equal(
    shouldUploadEdgeGeometry(edgeVertexData, edgeVertexData.length, edgeVertexData, {
      append: true,
      reuseUploadedGeometry: true,
    }),
    true,
  );
  assert.equal(
    shouldUploadEdgeGeometry(edgeVertexData, edgeVertexData.length, edgeVertexData, {
      append: false,
      reuseUploadedGeometry: false,
    }),
    true,
  );
});

test('shouldUploadEdgeGeometry re-uploads when the other edge program last wrote the buffer', () => {
  // Both WebGL edge programs draw from one shared vertex buffer. A transit-only
  // frame (plain 6-float layout) followed by a walking frame that reuses its
  // cached node-indexed template would otherwise match on array identity and
  // skip the upload, leaving the node-indexed program to read the transit
  // bytes under a 24-byte stride - long spurious chords across the map.
  const edgeVertexData = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  assert.equal(
    shouldUploadEdgeGeometry(edgeVertexData, edgeVertexData.length, edgeVertexData, {
      append: false,
      reuseUploadedGeometry: true,
      previousLayout: 'plain',
      layout: 'node-indexed',
    }),
    true,
  );
  assert.equal(
    shouldUploadEdgeGeometry(edgeVertexData, edgeVertexData.length, edgeVertexData, {
      append: false,
      reuseUploadedGeometry: true,
      previousLayout: 'node-indexed',
      layout: 'node-indexed',
    }),
    false,
  );
});

test('buildStaticEdgeVertexTemplateForMode stores reusable x/y geometry and edge metadata', () => {
  const graph = createFixtureGraph();
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const edgeTraversalCostSeconds = new Float32Array([10, 10]);

  const template = buildStaticEdgeVertexTemplateForMode(
    graph,
    nodePixels,
    EDGE_MODE_CAR_BIT,
    {
      edgeTraversalCostSeconds,
    },
  );

  assert.equal(template.edgeCount, 2);
  assert.equal(template.sourceNodeIndices.length, 2);
  assert.equal(template.targetNodeIndices.length, 2);
  assert.equal(template.edgeIndices.length, 2);
  assert.equal(template.edgeVertexData.length, 12);
  assert.deepEqual(Array.from(template.sourceNodeIndices), [0, 1]);
  assert.deepEqual(Array.from(template.targetNodeIndices), [1, 2]);
  assert.deepEqual(Array.from(template.edgeIndices), [0, 1]);

  const node0x = nodePixels.nodePixelX[0];
  const node0y = nodePixels.nodePixelY[0];
  const node1x = nodePixels.nodePixelX[1];
  const node1y = nodePixels.nodePixelY[1];
  assert.equal(template.edgeVertexData[0], node0x);
  assert.equal(template.edgeVertexData[1], node0y);
  assert.equal(template.edgeVertexData[3], node1x);
  assert.equal(template.edgeVertexData[4], node1y);
});

test('updateTravelTimesInStaticEdgeVertexTemplate updates only t-values and marks unreachable edges', () => {
  const graph = createFixtureGraph();
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const edgeTraversalCostSeconds = new Float32Array([10, 10]);
  const template = buildStaticEdgeVertexTemplateForMode(
    graph,
    nodePixels,
    EDGE_MODE_CAR_BIT,
    {
      edgeTraversalCostSeconds,
    },
  );
  const distSeconds = new Float32Array([0, 10, 20]);
  const x0Before = template.edgeVertexData[0];
  const y0Before = template.edgeVertexData[1];
  const x1Before = template.edgeVertexData[3];
  const y1Before = template.edgeVertexData[4];

  const visibleEdgeCount = updateTravelTimesInStaticEdgeVertexTemplate(
    template,
    distSeconds,
    edgeTraversalCostSeconds,
  );
  assert.equal(visibleEdgeCount, 2);
  assert.equal(template.edgeVertexData[2], 0);
  assert.equal(template.edgeVertexData[5], 10);
  assert.equal(template.edgeVertexData[8], 10);
  assert.equal(template.edgeVertexData[11], 20);
  assert.equal(template.edgeVertexData[0], x0Before);
  assert.equal(template.edgeVertexData[1], y0Before);
  assert.equal(template.edgeVertexData[3], x1Before);
  assert.equal(template.edgeVertexData[4], y1Before);

  distSeconds[1] = Number.POSITIVE_INFINITY;
  const visibleAfterDisconnect = updateTravelTimesInStaticEdgeVertexTemplate(
    template,
    distSeconds,
    edgeTraversalCostSeconds,
  );
  assert.equal(visibleAfterDisconnect, 0);
  assert.equal(template.edgeVertexData[2], -1);
  assert.equal(template.edgeVertexData[5], -1);
  assert.equal(template.edgeVertexData[8], -1);
  assert.equal(template.edgeVertexData[11], -1);
});

test('buildStaticEdgeNodeIndexedVertexData packs static vertex attributes for shader-side interpolation', () => {
  const graph = createFixtureGraph();
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const edgeTraversalCostSeconds = new Float32Array([10, 20]);
  const template = buildStaticEdgeVertexTemplateForMode(
    graph,
    nodePixels,
    EDGE_MODE_CAR_BIT,
    {
      edgeTraversalCostSeconds,
    },
  );

  const packed = buildStaticEdgeNodeIndexedVertexData(template, edgeTraversalCostSeconds);
  assert.ok(packed instanceof Float32Array);
  assert.equal(packed.length, template.edgeCount * 12);

  // Edge 0, start vertex
  assert.equal(packed[0], template.edgeVertexData[0]);
  assert.equal(packed[1], template.edgeVertexData[1]);
  assert.equal(packed[2], template.sourceNodeIndices[0]);
  assert.equal(packed[3], template.targetNodeIndices[0]);
  assert.equal(packed[4], edgeTraversalCostSeconds[template.edgeIndices[0]]);
  assert.equal(packed[5], 0);

  // Edge 0, end vertex
  assert.equal(packed[6], template.edgeVertexData[3]);
  assert.equal(packed[7], template.edgeVertexData[4]);
  assert.equal(packed[8], template.sourceNodeIndices[0]);
  assert.equal(packed[9], template.targetNodeIndices[0]);
  assert.equal(packed[10], edgeTraversalCostSeconds[template.edgeIndices[0]]);
  assert.equal(packed[11], 1);
});

test('computeProjectedFeatureListBoundingBoxPx spans every point across every feature and path', () => {
  const projectedFeatures = [
    { name: 'a', paths: [[[10, 20], [30, 5]]] },
    { name: 'b', paths: [[[-5, 40], [15, 15]], [[100, 100]]] },
  ];

  const bbox = computeProjectedFeatureListBoundingBoxPx(projectedFeatures);

  assert.deepEqual(bbox, { minX: -5, minY: 5, maxX: 100, maxY: 100 });
});

test('computeProjectedFeatureListBoundingBoxPx returns null for empty or missing features', () => {
  assert.equal(computeProjectedFeatureListBoundingBoxPx([]), null);
  assert.equal(computeProjectedFeatureListBoundingBoxPx(undefined), null);
  assert.equal(computeProjectedFeatureListBoundingBoxPx([{ name: 'empty', paths: [] }]), null);
});

test('computeProjectedFeatureListBoundingBoxPx ignores non-finite points', () => {
  const projectedFeatures = [
    { name: 'a', paths: [[[10, 20], [Number.NaN, 5], [30, Number.POSITIVE_INFINITY]]] },
  ];

  const bbox = computeProjectedFeatureListBoundingBoxPx(projectedFeatures);

  assert.deepEqual(bbox, { minX: 10, minY: 20, maxX: 10, maxY: 20 });
});

test('render grids are sized to the visible view, not the routing graph', () => {
  // Portsmouth's routing grid is sized to a ferry route that reaches France:
  // 20570 x 24802 cells, ~2 GB as floats for each of the two render grids,
  // every cell of it written by the clears. The city is about 15 km across.
  const portsmouthHeader = { gridWidthPx: 20570, gridHeightPx: 24802 };
  const cityBoundingBox = { minX: 11000, minY: 23000, maxX: 12500, maxY: 24500 };

  const extent = computeRenderGridExtent(portsmouthHeader, cityBoundingBox);

  assert.ok(extent.widthPx * extent.heightPx < 5_000_000, 'must not allocate the ferry envelope');
  assert.ok(extent.originXPx > 0 && extent.originYPx > 0, 'grid is offset to the city');
  // Covers the boundary box with padding to match the viewport's own fit.
  assert.ok(extent.originXPx <= cityBoundingBox.minX);
  assert.ok(extent.originXPx + extent.widthPx >= cityBoundingBox.maxX);
  assert.ok(extent.originYPx + extent.heightPx >= cityBoundingBox.maxY);
});

test('render grid extent stays within the GPU texture limit even without a boundary box', () => {
  // The travel-time grid is uploaded as one texture, so an axis wider than
  // GL_MAX_TEXTURE_SIZE could never be drawn however much memory existed.
  const extent = computeRenderGridExtent({ gridWidthPx: 20570, gridHeightPx: 24802 }, null);

  assert.ok(extent.widthPx <= 16384);
  assert.ok(extent.heightPx <= 16384);
  assert.ok(extent.widthPx * extent.heightPx <= 16_000_000);
});

test('a small region is unchanged by the render grid budget', () => {
  const extent = computeRenderGridExtent({ gridWidthPx: 896, gridHeightPx: 958 }, null);

  assert.deepEqual(extent, { originXPx: 0, originYPx: 0, widthPx: 896, heightPx: 958 });
});

test('grid writes use graph coordinates and clip outside the grid extent', () => {
  // Painters are unaware of the offset: they write graph pixel coordinates and
  // the grid subtracts its own origin, so anything off-extent falls out
  // through the bounds check that was already there.
  const grid = createTravelTimeGrid(4, 4, { originXPx: 100, originYPx: 200 });
  clearTravelTimeGrid(grid);

  assert.equal(setTravelTimePixelMin(grid, 100, 200, 30), true, 'grid origin maps to cell 0,0');
  assert.equal(grid.seconds[0], 30);
  assert.equal(setTravelTimePixelMin(grid, 103, 203, 45), true);
  assert.equal(grid.seconds[3 * 4 + 3], 45);

  assert.equal(setTravelTimePixelMin(grid, 99, 200, 10), false, 'left of the extent');
  assert.equal(setTravelTimePixelMin(grid, 104, 200, 10), false, 'right of the extent');
  assert.equal(setTravelTimePixelMin(grid, 100, 199, 10), false, 'above the extent');
});

test('spatial index buckets by node density instead of one cell per pixel', () => {
  // Portsmouth's routing grid spans a ferry route to France. One bucket per
  // 10 m pixel meant 20570 x 24802 Int32 cells - 2 GB, every byte written -
  // to hold 22,024 nodes.
  const portsmouthCellSize = resolveSpatialIndexCellSizePx(20570, 24802, 22024);
  const cells = Math.ceil(20570 / portsmouthCellSize) * Math.ceil(24802 / portsmouthCellSize);
  assert.ok(cells < 200_000, `expected a small bucket grid, got ${cells} cells`);

  // A dense city gets finer buckets from the same rule.
  const berlinCellSize = resolveSpatialIndexCellSizePx(4576, 3763, 600_000);
  assert.ok(berlinCellSize < portsmouthCellSize);
  assert.ok(berlinCellSize >= 1);
});

test('bucketed spatial index still returns the true nearest node', () => {
  // The early-exit bound has to account for cell size, or the ring search can
  // stop while a nearer node sits in an unvisited cell.
  const graph = createFixtureGraph();
  const nodePixels = precomputeNodePixelCoordinates(graph);
  const nodeModeMask = precomputeNodeModeMask(graph);

  for (const cellSizePx of [1, 2, 3, 8, 64]) {
    const index = createNodeSpatialIndex(graph, nodePixels, { cellSizePx });
    for (let xPx = 0; xPx < graph.header.gridWidthPx; xPx += 1) {
      for (let yPx = 0; yPx < graph.header.gridHeightPx; yPx += 1) {
        const found = findNearestNodeIndexForModeFromSpatialIndex(
          index, nodePixels, nodeModeMask, xPx, yPx, EDGE_MODE_WALK_BIT,
        );
        // Brute force the same answer.
        let best = -1;
        let bestDistance = Infinity;
        for (let i = 0; i < graph.header.nNodes; i += 1) {
          if (!(nodeModeMask[i] & EDGE_MODE_WALK_BIT)) continue;
          const dx = nodePixels.nodePixelX[i] - xPx;
          const dy = nodePixels.nodePixelY[i] - yPx;
          const d = dx * dx + dy * dy;
          if (d < bestDistance) { bestDistance = d; best = i; }
        }
        const foundDx = nodePixels.nodePixelX[found] - xPx;
        const foundDy = nodePixels.nodePixelY[found] - yPx;
        assert.equal(
          foundDx * foundDx + foundDy * foundDy,
          bestDistance,
          `cellSizePx=${cellSizePx} at (${xPx},${yPx}): got node ${found}, expected ${best}`,
        );
      }
    }
  }
});
