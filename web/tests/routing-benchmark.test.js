import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSeededRng,
  runRoutingBenchmark,
  sampleEligibleSourceNodeIndices,
  summarizePairedDeltas,
  summarizeNumberSeries,
  summarizeStableSeries,
} from '../src/perf/routing-benchmark.js';
import {
  EDGE_MODE_CAR_BIT,
} from '../src/config/constants.js';
import { computeEdgeTraversalCostSeconds } from '../src/core/routing.js';

function createGraphWithNoEdges(nodeCount = 8) {
  const nodeBuffer = new ArrayBuffer(nodeCount * 16);
  return {
    header: {
      nNodes: nodeCount,
      nEdges: 0,
      gridWidthPx: 32,
      gridHeightPx: 32,
    },
    nodeI32: new Int32Array(nodeBuffer),
    nodeU32: new Uint32Array(nodeBuffer),
    nodeU16: new Uint16Array(nodeBuffer),
    edgeU32: new Uint32Array(0),
    edgeU16: new Uint16Array(0),
    edgeModeMask: new Uint8Array(0),
    edgeRoadClassId: new Uint8Array(0),
    edgeMaxspeedKph: new Uint16Array(0),
  };
}

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

  nodeI32[0] = 0;
  nodeI32[1] = 0;
  nodeU32[2] = 0;
  nodeU16[6] = 1;

  nodeI32[4] = 100;
  nodeI32[5] = 0;
  nodeU32[6] = 1;
  nodeU16[14] = 1;

  nodeI32[8] = 200;
  nodeI32[9] = 0;
  nodeU32[10] = 2;
  nodeU16[22] = 0;

  edgeU32[0] = 1;
  edgeU16[2] = 72;
  edgeModeMask[0] = EDGE_MODE_CAR_BIT;
  edgeRoadClassId[0] = 11;
  edgeMaxspeedKph[0] = 60;
  edgeU32[2] = edgeModeMask[0] | (edgeRoadClassId[0] << 8) | (edgeMaxspeedKph[0] << 16);

  edgeU32[3] = 2;
  edgeU16[8] = 72;
  edgeModeMask[1] = EDGE_MODE_CAR_BIT;
  edgeRoadClassId[1] = 11;
  edgeMaxspeedKph[1] = 60;
  edgeU32[5] = edgeModeMask[1] | (edgeRoadClassId[1] << 8) | (edgeMaxspeedKph[1] << 16);

  return {
    header: {
      nNodes,
      nEdges,
      gridWidthPx: 256,
      gridHeightPx: 256,
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

function createFixtureEdgeCostPrecomputeKernel(graph) {
  return {
    precomputeEdgeCostsForGraph({ outCostSeconds, allowedModeMask }) {
      for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
        outCostSeconds[edgeIndex] = computeEdgeTraversalCostSeconds(graph, edgeIndex, allowedModeMask);
      }
    },
  };
}

test('createSeededRng returns deterministic pseudorandom sequence', () => {
  const rngA = createSeededRng(123);
  const rngB = createSeededRng(123);
  const sequenceA = [rngA(), rngA(), rngA(), rngA()];
  const sequenceB = [rngB(), rngB(), rngB(), rngB()];
  assert.deepEqual(sequenceA, sequenceB);
});

test('summarizeNumberSeries returns expected summary stats', () => {
  const summary = summarizeNumberSeries([1, 2, 3, 4, 5]);
  assert.equal(summary.count, 5);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 5);
  assert.equal(summary.mean, 3);
  assert.equal(summary.p50, 3);
  assert.equal(summary.p95, 4);
  assert.equal(summary.p99, 4);
});

test('summarizeStableSeries reports stable when relative MAD is below threshold', () => {
  const summary = summarizeStableSeries([100, 101, 99, 100.5, 100], {
    maxRelativeMad: 0.03,
  });

  assert.equal(summary.isStable, true);
  assert.ok(summary.relativeMad <= 0.03);
});

test('summarizeStableSeries reports unstable when relative MAD exceeds threshold', () => {
  const summary = summarizeStableSeries([100, 140, 70, 130, 60], {
    maxRelativeMad: 0.05,
  });

  assert.equal(summary.isStable, false);
  assert.ok(summary.relativeMad > 0.05);
});

test('summarizePairedDeltas classifies faster/slower/inconclusive runs', () => {
  const faster = summarizePairedDeltas(
    [100, 102, 98, 101],
    [90, 92, 89, 95],
    { significanceThresholdPct: 0.05 },
  );
  assert.equal(faster.classification, 'faster');
  assert.ok(faster.fasterCount > faster.slowerCount);
  assert.ok(faster.deltaPct.mean < 0);

  const slower = summarizePairedDeltas(
    [100, 102, 98, 101],
    [111, 112, 109, 110],
    { significanceThresholdPct: 0.05 },
  );
  assert.equal(slower.classification, 'slower');
  assert.ok(slower.slowerCount > slower.fasterCount);
  assert.ok(slower.deltaPct.mean > 0);

  const inconclusive = summarizePairedDeltas(
    [100, 100, 100, 100],
    [99, 101, 100, 100],
    { significanceThresholdPct: 0.05 },
  );
  assert.equal(inconclusive.classification, 'inconclusive');
});

test('sampleEligibleSourceNodeIndices honors deterministic seeded eligibility sampling', () => {
  const graph = createGraphWithNoEdges(10);
  const eligibleNodes = new Set([0, 2, 4, 6, 8]);
  const sampleA = sampleEligibleSourceNodeIndices(graph, {
    sampleCount: 4,
    seed: 99,
    isNodeEligible: (nodeIndex) => eligibleNodes.has(nodeIndex),
  });
  const sampleB = sampleEligibleSourceNodeIndices(graph, {
    sampleCount: 4,
    seed: 99,
    isNodeEligible: (nodeIndex) => eligibleNodes.has(nodeIndex),
  });

  assert.equal(sampleA.deliveredSampleCount, 4);
  assert.deepEqual(sampleA.nodeIndices, sampleB.nodeIndices);
  assert.ok(sampleA.nodeIndices.every((nodeIndex) => eligibleNodes.has(nodeIndex)));
});

test('runRoutingBenchmark returns aggregate metrics for sampled routes', () => {
  const graph = createFixtureGraph();
  const nowValues = [
    0, 1, 2, 3, 4, 5,
    10, 11, 12, 13, 14, 15,
  ];
  let nowIndex = 0;

  const benchmark = runRoutingBenchmark(graph, {
    sourceNodeIndices: [0, 1],
    allowedModeMask: EDGE_MODE_CAR_BIT,
    heapStrategy: 'decrease-key',
    edgeCostPrecomputeKernel: createFixtureEdgeCostPrecomputeKernel(graph),
    nowImpl: () => {
      const value = nowValues[nowIndex] ?? nowValues[nowValues.length - 1];
      nowIndex += 1;
      return value;
    },
    cpuUsageImpl: null,
  });

  assert.equal(benchmark.runCount, 2);
  assert.equal(benchmark.heapStrategy, 'decrease-key');
  assert.ok(benchmark.totalSettledNodes >= 3);
  assert.ok(benchmark.wallMs.mean >= 1);
  assert.ok(benchmark.expandWallMs.mean >= 1);
  assert.ok(benchmark.msPerSettledNode > 0);
});

test('runRoutingBenchmark requires a WASM edge-cost precompute kernel', () => {
  const graph = createFixtureGraph();
  assert.throws(
    () =>
      runRoutingBenchmark(graph, {
        sourceNodeIndices: [0],
        allowedModeMask: EDGE_MODE_CAR_BIT,
        heapStrategy: 'decrease-key',
        edgeCostPrecomputeKernel: null,
      }),
    /must expose precomputeEdgeCostsForGraph/,
  );
});
