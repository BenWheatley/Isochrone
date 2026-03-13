import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_MAGIC,
  MinHeap,
  WASM_REQUIRED_MESSAGE,
  computeEdgeTraversalCostSeconds,
  createNodeSpatialIndex,
  createWalkingSearchState,
  ensureWasmSupportOrShowError,
  findNearestNodeIndexForModeFromSpatialIndex,
  mapCanvasPixelToGraphMeters,
  parseColourCycleMinutesFromLocationSearch,
  parseGraphBinary,
  parseModeValuesFromLocationSearch,
  parseNodeIndexFromLocationSearch,
  buildStaticEdgeVertexTemplateForMode,
  updateTravelTimesInStaticEdgeVertexTemplate,
  persistColourCycleMinutesToLocation,
  persistModeValuesToLocation,
  persistNodeIndexToLocation,
  precomputeNodeModeMask,
  precomputeNodePixelCoordinates,
  getOrBuildSnapshotEdgeVertexData,
  rerenderIsochroneFromSnapshotWithStatus,
  renderIsochroneLegendIfNeeded,
  shouldUploadEdgeGeometry,
  updateDistanceScaleBar,
  timeToColour,
} from '../src/app.js';
import { precomputeEdgeTraversalCostSecondsCache } from '../src/core/routing.js';

const EDGE_MODE_WALK_BIT = 1;
const EDGE_MODE_BIKE_BIT = 1 << 1;
const EDGE_MODE_CAR_BIT = 1 << 2;
const CAR_FALLBACK_SPEED_KPH = 30;

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

test('createWalkingSearchState settles reachable nodes and computes best costs', () => {
  const graph = createFixtureGraph();
  const state = createWalkingSearchState(graph, 0, Number.POSITIVE_INFINITY, EDGE_MODE_CAR_BIT);
  while (!state.isDone()) {
    state.expandOne();
  }

  assert.equal(state.settledCount, 3);
  assert.ok(Number.isFinite(state.distSeconds[2]));
  assert.ok(Math.abs(state.distSeconds[2] - 12) < 0.05);
});

test('createWalkingSearchState precomputes edge traversal cache for active mode', () => {
  const graph = createFixtureGraph();
  const state = createWalkingSearchState(graph, 0, Number.POSITIVE_INFINITY, EDGE_MODE_CAR_BIT);

  assert.equal(state.edgeTraversalCostSeconds.length, graph.header.nEdges);
  for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
    assert.ok(!Number.isNaN(state.edgeTraversalCostSeconds[edgeIndex]));
  }
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

test('createWalkingSearchState falls back to JS edge-cost precompute on kernel failure', () => {
  const graph = createFixtureGraph();
  let kernelFailureCount = 0;
  const state = createWalkingSearchState(graph, 0, Number.POSITIVE_INFINITY, EDGE_MODE_CAR_BIT, {
    edgeCostPrecomputeKernel: {
      precomputeEdgeCostsForGraph() {
        throw new Error('kernel unavailable');
      },
    },
    onKernelError() {
      kernelFailureCount += 1;
    },
  });

  assert.equal(kernelFailureCount, 1);
  assert.ok(Number.isFinite(state.edgeTraversalCostSeconds[0]));
  assert.ok(Number.isFinite(state.edgeTraversalCostSeconds[1]));
  while (!state.isDone()) {
    state.expandOne();
  }
  assert.ok(Math.abs(state.distSeconds[2] - 12) < 0.05);
});

test('precomputeEdgeTraversalCostSecondsCache strictKernel disallows fallback', () => {
  const graph = createFixtureGraph();
  assert.throws(
    () =>
      precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, null, {
        strictKernel: true,
      }),
    /required when strictKernel=true/,
  );

  let kernelErrorCount = 0;
  assert.throws(
    () =>
      precomputeEdgeTraversalCostSecondsCache(graph, EDGE_MODE_CAR_BIT, null, {
        strictKernel: true,
        edgeCostPrecomputeKernel: {
          precomputeEdgeCostsForGraph() {
            throw new Error('kernel unavailable');
          },
        },
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
        strictKernel: true,
        edgeCostPrecomputeKernel: {
          precomputeEdgeCostsForGraph({ outCostSeconds }) {
            outCostSeconds.fill(Number.NaN);
          },
        },
      }),
    /produced invalid cost at edge 0/,
  );
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
        return { width: 1000 };
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

test('parseNodeIndexFromLocationSearch validates and clamps invalid params', () => {
  assert.equal(parseNodeIndexFromLocationSearch('?node=12', 100), 12);
  assert.equal(parseNodeIndexFromLocationSearch('?node=-1', 100), null);
  assert.equal(parseNodeIndexFromLocationSearch('?node=foo', 100), null);
  assert.equal(parseNodeIndexFromLocationSearch('?node=100', 100), null);
  assert.equal(parseNodeIndexFromLocationSearch('', 100), null);
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
