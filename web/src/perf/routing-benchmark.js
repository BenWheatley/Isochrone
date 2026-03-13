import {
  EDGE_MODE_CAR_BIT,
} from '../config/constants.js';
import {
  createWalkingSearchState,
  nodeHasAllowedModeOutgoingEdge,
} from '../core/routing.js';
import { validateGraphForRouting } from '../core/graph-validation.js';

const DEFAULT_MAX_SAMPLE_ATTEMPTS_MULTIPLIER = 64;

export function createSeededRng(seed = 0x1234abcd) {
  if (!Number.isInteger(seed)) {
    throw new Error('seed must be an integer');
  }

  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function summarizeNumberSeries(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('values must be a non-empty array');
  }

  const numericValues = values.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('values must contain only finite numbers');
    }
    return value;
  });

  const sorted = numericValues.slice().sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0];
  const max = sorted[count - 1];
  const sum = sorted.reduce((total, value) => total + value, 0);
  const mean = sum / count;

  return {
    count,
    min,
    max,
    mean,
    p50: quantileFromSorted(sorted, 0.5),
    p95: quantileFromSorted(sorted, 0.95),
    p99: quantileFromSorted(sorted, 0.99),
  };
}

function quantileFromSorted(sortedValues, quantile) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) {
    throw new Error('sortedValues must be a non-empty array');
  }
  if (typeof quantile !== 'number' || quantile < 0 || quantile > 1) {
    throw new Error('quantile must be between 0 and 1');
  }
  const index = Math.floor((sortedValues.length - 1) * quantile);
  return sortedValues[index];
}

export function sampleEligibleSourceNodeIndices(graph, options = {}) {
  validateGraphForRouting(graph);
  const {
    sampleCount,
    allowedModeMask = EDGE_MODE_CAR_BIT,
    seed = 1337,
    isNodeEligible = null,
    maxAttemptsMultiplier = DEFAULT_MAX_SAMPLE_ATTEMPTS_MULTIPLIER,
  } = options;

  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    throw new Error('sampleCount must be a positive integer');
  }
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  if (!Number.isInteger(maxAttemptsMultiplier) || maxAttemptsMultiplier <= 0) {
    throw new Error('maxAttemptsMultiplier must be a positive integer');
  }
  if (isNodeEligible !== null && typeof isNodeEligible !== 'function') {
    throw new Error('isNodeEligible must be a function when provided');
  }

  const nodeCount = graph.header.nNodes;
  const maxSamples = Math.min(sampleCount, nodeCount);
  const random = createSeededRng(seed);
  const selected = [];
  const seen = new Uint8Array(nodeCount);
  const edgeTraversalCostSeconds = null;
  const eligibilityFn = isNodeEligible
    ?? ((nodeIndex) =>
      nodeHasAllowedModeOutgoingEdge(graph, nodeIndex, allowedModeMask, edgeTraversalCostSeconds));
  const maxAttempts = Math.max(maxSamples * maxAttemptsMultiplier, maxSamples);
  let attempts = 0;

  while (selected.length < maxSamples && attempts < maxAttempts) {
    attempts += 1;
    const nodeIndex = Math.floor(random() * nodeCount);
    if (seen[nodeIndex] === 1) {
      continue;
    }
    seen[nodeIndex] = 1;
    if (eligibilityFn(nodeIndex)) {
      selected.push(nodeIndex);
    }
  }

  if (selected.length < maxSamples) {
    for (let nodeIndex = 0; nodeIndex < nodeCount && selected.length < maxSamples; nodeIndex += 1) {
      if (seen[nodeIndex] === 1) {
        continue;
      }
      seen[nodeIndex] = 1;
      if (eligibilityFn(nodeIndex)) {
        selected.push(nodeIndex);
      }
    }
  }

  return {
    nodeIndices: selected,
    requestedSampleCount: sampleCount,
    deliveredSampleCount: selected.length,
    attempts,
  };
}

export function runRoutingBenchmark(graph, options = {}) {
  validateGraphForRouting(graph);
  const {
    sourceNodeIndices,
    allowedModeMask = EDGE_MODE_CAR_BIT,
    heapStrategy = 'decrease-key',
    edgeCostPrecomputeKernel = null,
    nowImpl = defaultNowMs,
    cpuUsageImpl = defaultCpuUsage,
    includePerRun = false,
  } = options;

  if (!Array.isArray(sourceNodeIndices) || sourceNodeIndices.length === 0) {
    throw new Error('sourceNodeIndices must be a non-empty array');
  }
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  if (heapStrategy !== 'decrease-key' && heapStrategy !== 'duplicate-push') {
    throw new Error("heapStrategy must be 'decrease-key' or 'duplicate-push'");
  }
  if (
    edgeCostPrecomputeKernel !== null
    && (
      typeof edgeCostPrecomputeKernel !== 'object'
      || typeof edgeCostPrecomputeKernel.precomputeEdgeCostsForGraph !== 'function'
    )
  ) {
    throw new Error(
      'edgeCostPrecomputeKernel must expose precomputeEdgeCostsForGraph(...) when provided',
    );
  }
  if (typeof nowImpl !== 'function') {
    throw new Error('nowImpl must be a function');
  }
  if (cpuUsageImpl !== null && typeof cpuUsageImpl !== 'function') {
    throw new Error('cpuUsageImpl must be a function when provided');
  }

  const wallMsValues = [];
  const setupWallMsValues = [];
  const expandWallMsValues = [];
  const cpuMsValues = [];
  const setupCpuMsValues = [];
  const expandCpuMsValues = [];
  const settledNodeCounts = [];
  const perRun = [];

  for (const sourceNodeIndex of sourceNodeIndices) {
    if (
      !Number.isInteger(sourceNodeIndex)
      || sourceNodeIndex < 0
      || sourceNodeIndex >= graph.header.nNodes
    ) {
      throw new Error(`sourceNodeIndex out of range: ${sourceNodeIndex}`);
    }

    const wallStartMs = nowImpl();
    const cpuStart = cpuUsageImpl ? cpuUsageImpl() : null;

    const setupWallStartMs = nowImpl();
    const setupCpuStart = cpuUsageImpl ? cpuUsageImpl() : null;
    const searchState = createWalkingSearchState(
      graph,
      sourceNodeIndex,
      Number.POSITIVE_INFINITY,
      allowedModeMask,
      {
        heapStrategy,
        edgeCostPrecomputeKernel,
      },
    );
    const setupWallMs = Math.max(0, nowImpl() - setupWallStartMs);
    const setupCpuMs = setupCpuStart && cpuUsageImpl
      ? cpuUsageDeltaMs(setupCpuStart, cpuUsageImpl())
      : null;

    const expandWallStartMs = nowImpl();
    const expandCpuStart = cpuUsageImpl ? cpuUsageImpl() : null;
    while (!searchState.isDone()) {
      searchState.expandOne();
    }
    const expandWallMs = Math.max(0, nowImpl() - expandWallStartMs);
    const expandCpuMs = expandCpuStart && cpuUsageImpl
      ? cpuUsageDeltaMs(expandCpuStart, cpuUsageImpl())
      : null;

    const wallMs = Math.max(0, nowImpl() - wallStartMs);
    const cpuMs = cpuStart && cpuUsageImpl ? cpuUsageDeltaMs(cpuStart, cpuUsageImpl()) : null;
    const settledNodeCount = searchState.settledCount;

    wallMsValues.push(wallMs);
    setupWallMsValues.push(setupWallMs);
    expandWallMsValues.push(expandWallMs);
    settledNodeCounts.push(settledNodeCount);
    if (cpuMs !== null) {
      cpuMsValues.push(cpuMs);
    }
    if (setupCpuMs !== null) {
      setupCpuMsValues.push(setupCpuMs);
    }
    if (expandCpuMs !== null) {
      expandCpuMsValues.push(expandCpuMs);
    }

    if (includePerRun) {
      perRun.push({
        sourceNodeIndex,
        wallMs,
        setupWallMs,
        expandWallMs,
        cpuMs,
        setupCpuMs,
        expandCpuMs,
        settledNodeCount,
      });
    }
  }

  const wallMsSummary = summarizeNumberSeries(wallMsValues);
  const setupWallMsSummary = summarizeNumberSeries(setupWallMsValues);
  const expandWallMsSummary = summarizeNumberSeries(expandWallMsValues);

  const settledSummary = summarizeNumberSeries(settledNodeCounts);
  const totalSettledNodes = settledNodeCounts.reduce((total, value) => total + value, 0);
  const totalExpandWallMs = expandWallMsValues.reduce((total, value) => total + value, 0);

  const result = {
    runCount: sourceNodeIndices.length,
    heapStrategy,
    allowedModeMask,
    totalSettledNodes,
    wallMs: wallMsSummary,
    setupWallMs: setupWallMsSummary,
    expandWallMs: expandWallMsSummary,
    settledNodeCount: settledSummary,
    msPerSettledNode: totalSettledNodes > 0 ? totalExpandWallMs / totalSettledNodes : Infinity,
  };

  if (cpuMsValues.length > 0) {
    result.cpuMs = summarizeNumberSeries(cpuMsValues);
  }
  if (setupCpuMsValues.length > 0) {
    result.setupCpuMs = summarizeNumberSeries(setupCpuMsValues);
  }
  if (expandCpuMsValues.length > 0) {
    result.expandCpuMs = summarizeNumberSeries(expandCpuMsValues);
  }
  if (includePerRun) {
    result.perRun = perRun;
  }

  return result;
}

function defaultNowMs() {
  if (globalThis.performance && typeof globalThis.performance.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

function defaultCpuUsage() {
  const processObject = globalThis.process;
  if (processObject && typeof processObject.cpuUsage === 'function') {
    return processObject.cpuUsage();
  }
  return null;
}

function cpuUsageDeltaMs(startUsage, endUsage) {
  if (
    !startUsage
    || !endUsage
    || typeof startUsage.user !== 'number'
    || typeof startUsage.system !== 'number'
    || typeof endUsage.user !== 'number'
    || typeof endUsage.system !== 'number'
  ) {
    return null;
  }

  const deltaMicroseconds = (endUsage.user - startUsage.user) + (endUsage.system - startUsage.system);
  return Math.max(0, deltaMicroseconds / 1000);
}
