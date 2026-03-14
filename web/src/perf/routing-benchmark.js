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
  const numericValues = toFiniteNumberArray(values, 'values');

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

export function summarizeStableSeries(values, options = {}) {
  const numericValues = toFiniteNumberArray(values, 'values');
  const { maxRelativeMad = 0.05 } = options;
  if (typeof maxRelativeMad !== 'number' || !Number.isFinite(maxRelativeMad) || maxRelativeMad <= 0) {
    throw new Error('maxRelativeMad must be a positive finite number');
  }

  const summary = summarizeNumberSeries(numericValues);
  const median = summary.p50;
  const absoluteDeviations = numericValues.map((value) => Math.abs(value - median));
  const mad = summarizeNumberSeries(absoluteDeviations).p50;
  const relativeMad = median === 0 ? (mad === 0 ? 0 : Infinity) : mad / Math.abs(median);

  const variance = numericValues.reduce((total, value) => {
    const delta = value - summary.mean;
    return total + (delta * delta);
  }, 0) / numericValues.length;
  const standardDeviation = Math.sqrt(variance);
  const coefficientOfVariation =
    summary.mean === 0 ? (standardDeviation === 0 ? 0 : Infinity) : standardDeviation / Math.abs(summary.mean);

  return {
    ...summary,
    median,
    mad,
    relativeMad,
    standardDeviation,
    coefficientOfVariation,
    maxRelativeMad,
    isStable: relativeMad <= maxRelativeMad,
  };
}

export function summarizePairedDeltas(baselineValues, candidateValues, options = {}) {
  const baseline = toFiniteNumberArray(baselineValues, 'baselineValues');
  const candidate = toFiniteNumberArray(candidateValues, 'candidateValues');
  if (baseline.length !== candidate.length) {
    throw new Error('baselineValues and candidateValues must have identical length');
  }

  const {
    significanceThresholdPct = 0.03,
    classificationWinRatio = 0.7,
  } = options;
  if (
    typeof significanceThresholdPct !== 'number'
    || !Number.isFinite(significanceThresholdPct)
    || significanceThresholdPct < 0
  ) {
    throw new Error('significanceThresholdPct must be a non-negative finite number');
  }
  if (
    typeof classificationWinRatio !== 'number'
    || !Number.isFinite(classificationWinRatio)
    || classificationWinRatio < 0.5
    || classificationWinRatio > 1
  ) {
    throw new Error('classificationWinRatio must be a finite number between 0.5 and 1');
  }

  const deltaMsValues = [];
  const deltaPctValues = [];
  let fasterCount = 0;
  let slowerCount = 0;
  let unchangedCount = 0;

  for (let index = 0; index < baseline.length; index += 1) {
    const baselineValue = baseline[index];
    if (baselineValue <= 0) {
      throw new Error('baselineValues must contain only positive numbers');
    }
    const candidateValue = candidate[index];
    const deltaMs = candidateValue - baselineValue;
    const deltaPct = deltaMs / baselineValue;
    deltaMsValues.push(deltaMs);
    deltaPctValues.push(deltaPct);
    if (deltaMs < 0) {
      fasterCount += 1;
    } else if (deltaMs > 0) {
      slowerCount += 1;
    } else {
      unchangedCount += 1;
    }
  }

  const runCount = baseline.length;
  const fasterRatio = fasterCount / runCount;
  const slowerRatio = slowerCount / runCount;
  const deltaMs = summarizeNumberSeries(deltaMsValues);
  const deltaPct = summarizeNumberSeries(deltaPctValues);

  let classification = 'inconclusive';
  if (fasterRatio >= classificationWinRatio && deltaPct.p50 <= -significanceThresholdPct) {
    classification = 'faster';
  } else if (slowerRatio >= classificationWinRatio && deltaPct.p50 >= significanceThresholdPct) {
    classification = 'slower';
  }

  return {
    runCount,
    significanceThresholdPct,
    classificationWinRatio,
    fasterCount,
    slowerCount,
    unchangedCount,
    fasterRatio,
    slowerRatio,
    deltaMs,
    deltaPct,
    classification,
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

function toFiniteNumberArray(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return values.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label} must contain only finite numbers`);
    }
    return value;
  });
}

export function sampleEligibleSourceNodeIndices(graph, options = {}) {
  validateGraphForRouting(graph);
  const {
    sampleCount,
    allowedModeMask = EDGE_MODE_CAR_BIT,
    seed = 1337,
    isNodeEligible = null,
    edgeTraversalCostSeconds = null,
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
  if (
    isNodeEligible === null
    && (
      !(edgeTraversalCostSeconds instanceof Float32Array)
      || edgeTraversalCostSeconds.length < graph.header.nEdges
    )
  ) {
    throw new Error(
      'edgeTraversalCostSeconds must be a Float32Array covering graph.header.nEdges when isNodeEligible is not provided',
    );
  }

  const nodeCount = graph.header.nNodes;
  const maxSamples = Math.min(sampleCount, nodeCount);
  const random = createSeededRng(seed);
  const selected = [];
  const seen = new Uint8Array(nodeCount);
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
    edgeCostPrecomputeKernel,
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
    edgeCostPrecomputeKernel === null
    || typeof edgeCostPrecomputeKernel !== 'object'
    || typeof edgeCostPrecomputeKernel.precomputeEdgeCostsForGraph !== 'function'
  ) {
    throw new Error(
      'edgeCostPrecomputeKernel is required and must expose precomputeEdgeCostsForGraph(...)',
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
