#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  EDGE_MODE_BIKE_BIT,
  EDGE_MODE_CAR_BIT,
  EDGE_MODE_WALK_BIT,
} from '../src/config/constants.js';
import {
  sampleEligibleSourceNodeIndices,
  summarizePairedDeltas,
  summarizeNumberSeries,
  summarizeStableSeries,
} from '../src/perf/routing-benchmark.js';
import { precomputeEdgeTraversalCostSecondsCache } from '../src/core/routing.js';
import {
  buildModeSpecificKernelGraphViews,
  getOrBuildEdgeTraversalCostTicksForMode,
  parseGraphBinary,
} from '../src/app.js';
import {
  createWasmRoutingKernelFacade,
  instantiateRoutingKernelWasmFromBytes,
} from '../src/wasm/routing-kernel.js';

const DEFAULT_GRAPH_PATH = 'data_pipeline/output/graph-walk.bin';
const DEFAULT_SAMPLE_COUNT = 24;
const DEFAULT_SEED = 1337;
const DEFAULT_MODE_LIST = ['car'];
const DEFAULT_WASM_PATH = 'web/wasm/routing-kernel.wasm';
const DEFAULT_STABLE_WARMUP_ROUNDS = 3;
const DEFAULT_STABLE_MEASUREMENT_ROUNDS = 5;
const DEFAULT_MAX_RELATIVE_MAD = 0.05;
const DEFAULT_SIGNIFICANCE_THRESHOLD_PCT = 0.03;
const DEFAULT_CLASSIFICATION_WIN_RATIO = 0.7;

function parseArgs(argv) {
  const args = {
    graphPath: DEFAULT_GRAPH_PATH,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    seed: DEFAULT_SEED,
    modes: DEFAULT_MODE_LIST,
    wasmPath: DEFAULT_WASM_PATH,
    outputJsonPath: null,
    includePerRun: false,
    stable: false,
    warmupRounds: DEFAULT_STABLE_WARMUP_ROUNDS,
    measurementRounds: DEFAULT_STABLE_MEASUREMENT_ROUNDS,
    maxRelativeMad: DEFAULT_MAX_RELATIVE_MAD,
    baselineJsonPath: null,
    significanceThresholdPct: DEFAULT_SIGNIFICANCE_THRESHOLD_PCT,
    classificationWinRatio: DEFAULT_CLASSIFICATION_WIN_RATIO,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--graph') {
      args.graphPath = requireArgValue(argv, ++index, token);
    } else if (token === '--samples') {
      args.sampleCount = parsePositiveInteger(requireArgValue(argv, ++index, token), token);
    } else if (token === '--seed') {
      args.seed = parseInteger(requireArgValue(argv, ++index, token), token);
    } else if (token === '--modes') {
      const modeListRaw = requireArgValue(argv, ++index, token);
      args.modes = modeListRaw.split(',').map((mode) => mode.trim()).filter(Boolean);
      if (args.modes.length === 0) {
        throw new Error('--modes must contain at least one mode token');
      }
    } else if (token === '--wasm-path') {
      args.wasmPath = requireArgValue(argv, ++index, token);
    } else if (token === '--output-json') {
      args.outputJsonPath = requireArgValue(argv, ++index, token);
    } else if (token === '--include-per-run') {
      args.includePerRun = true;
    } else if (token === '--stable') {
      args.stable = true;
    } else if (token === '--warmup-rounds') {
      args.warmupRounds = parseNonNegativeInteger(requireArgValue(argv, ++index, token), token);
    } else if (token === '--measurement-rounds') {
      args.measurementRounds = parsePositiveInteger(requireArgValue(argv, ++index, token), token);
    } else if (token === '--max-relative-mad') {
      args.maxRelativeMad = parsePositiveFloat(requireArgValue(argv, ++index, token), token);
    } else if (token === '--baseline-json') {
      args.baselineJsonPath = requireArgValue(argv, ++index, token);
      args.stable = true;
    } else if (token === '--significance-threshold-pct') {
      args.significanceThresholdPct = parseNonNegativeFloat(requireArgValue(argv, ++index, token), token);
    } else if (token === '--classification-win-ratio') {
      const parsed = parsePositiveFloat(requireArgValue(argv, ++index, token), token);
      if (parsed < 0.5 || parsed > 1) {
        throw new Error(`${token} must be between 0.5 and 1`);
      }
      args.classificationWinRatio = parsed;
    } else if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (args.stable && args.measurementRounds < 3) {
    throw new Error('--measurement-rounds must be at least 3 when --stable is enabled');
  }

  return args;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveFloat(value, flag) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

function parseNonNegativeFloat(value, flag) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return parsed;
}

function requireArgValue(argv, valueIndex, flag) {
  const value = argv[valueIndex];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printUsage() {
  const usage = [
    'Usage: node web/scripts/benchmark-routing.mjs [options]',
    '',
    'Options:',
    '  --graph <path>                 Path to graph binary (default: data_pipeline/output/graph-walk.bin)',
    '  --samples <n>                  Number of random source nodes per mode (default: 24)',
    '  --seed <n>                     Integer seed for deterministic sampling (default: 1337)',
    '  --modes <list>                 Comma-separated: walk,bike,car,walk+bike,walk+car,bike+car,all',
    `  --wasm-path <path>             WASM binary path (default: ${DEFAULT_WASM_PATH})`,
    '  --output-json <path>           Optional JSON report path',
    '  --include-per-run              Include per-run details in JSON report',
    '  --stable                       Run warmup + repeated measured rounds for lower variance',
    `  --warmup-rounds <n>            Stable mode warmup rounds (default: ${DEFAULT_STABLE_WARMUP_ROUNDS})`,
    `  --measurement-rounds <n>       Stable mode measured rounds, >=3 (default: ${DEFAULT_STABLE_MEASUREMENT_ROUNDS})`,
    `  --max-relative-mad <f>         Stability threshold for relative MAD (default: ${DEFAULT_MAX_RELATIVE_MAD})`,
    '  --baseline-json <path>         Optional stable benchmark JSON to compare against (paired deltas)',
    `  --significance-threshold-pct <f>  Delta threshold for faster/slower classification (default: ${DEFAULT_SIGNIFICANCE_THRESHOLD_PCT})`,
    `  --classification-win-ratio <f>    Required directional win ratio for classification (default: ${DEFAULT_CLASSIFICATION_WIN_RATIO})`,
    '  --help                         Show this help',
  ];
  console.log(usage.join('\n'));
}

function parseModeMask(modeToken) {
  const normalized = modeToken.trim().toLowerCase();
  if (normalized === 'walk') {
    return EDGE_MODE_WALK_BIT;
  }
  if (normalized === 'bike') {
    return EDGE_MODE_BIKE_BIT;
  }
  if (normalized === 'car') {
    return EDGE_MODE_CAR_BIT;
  }
  if (normalized === 'all') {
    return EDGE_MODE_WALK_BIT | EDGE_MODE_BIKE_BIT | EDGE_MODE_CAR_BIT;
  }

  const parts = normalized.split('+').map((value) => value.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid mode token: ${modeToken}`);
  }

  let mask = 0;
  for (const part of parts) {
    if (part === 'walk') {
      mask |= EDGE_MODE_WALK_BIT;
    } else if (part === 'bike') {
      mask |= EDGE_MODE_BIKE_BIT;
    } else if (part === 'car') {
      mask |= EDGE_MODE_CAR_BIT;
    } else {
      throw new Error(`Invalid mode token part: ${part}`);
    }
  }

  if (mask === 0) {
    throw new Error(`Invalid mode token: ${modeToken}`);
  }
  return mask;
}

function formatModeMask(mask) {
  const labels = [];
  if ((mask & EDGE_MODE_WALK_BIT) !== 0) {
    labels.push('walk');
  }
  if ((mask & EDGE_MODE_BIKE_BIT) !== 0) {
    labels.push('bike');
  }
  if ((mask & EDGE_MODE_CAR_BIT) !== 0) {
    labels.push('car');
  }
  return labels.join('+');
}

function formatMetric(summary) {
  return `mean=${summary.mean.toFixed(2)}ms p50=${summary.p50.toFixed(2)}ms p95=${summary.p95.toFixed(2)}ms`;
}

function defaultCpuUsage() {
  if (typeof process.cpuUsage === 'function') {
    return process.cpuUsage();
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
  const deltaMicros = (endUsage.user - startUsage.user) + (endUsage.system - startUsage.system);
  return Math.max(0, deltaMicros / 1000);
}

function countFiniteTravelTimes(distSeconds) {
  if (!distSeconds || typeof distSeconds.length !== 'number') {
    return 0;
  }
  let settled = 0;
  for (let index = 0; index < distSeconds.length; index += 1) {
    if (distSeconds[index] < Infinity) {
      settled += 1;
    }
  }
  return settled;
}

function summarizePhase(values) {
  if (values.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };
  }
  return summarizeNumberSeries(values);
}

function summarizeStableModeRounds(rounds, options = {}) {
  if (!Array.isArray(rounds) || rounds.length === 0) {
    throw new Error('rounds must be a non-empty array');
  }
  const { maxRelativeMad = DEFAULT_MAX_RELATIVE_MAD } = options;

  const roundMeanTotalWallMs = rounds.map((round) => round.phaseBenchmark.phaseWallMs.total.mean);
  const roundMeanSearchWallMs = rounds.map((round) => round.phaseBenchmark.phaseWallMs.search.mean);
  const roundMeanTotalCpuMs = rounds
    .map((round) => round.phaseBenchmark.phaseCpuMs?.total?.mean ?? null)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const roundMeanSearchCpuMs = rounds
    .map((round) => round.phaseBenchmark.phaseCpuMs?.search?.mean ?? null)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));

  const totalWallMs = summarizeStableSeries(roundMeanTotalWallMs, { maxRelativeMad });
  const searchWallMs = summarizeStableSeries(roundMeanSearchWallMs, { maxRelativeMad });
  const totalCpuMs = roundMeanTotalCpuMs.length > 0
    ? summarizeStableSeries(roundMeanTotalCpuMs, { maxRelativeMad })
    : null;
  const searchCpuMs = roundMeanSearchCpuMs.length > 0
    ? summarizeStableSeries(roundMeanSearchCpuMs, { maxRelativeMad })
    : null;

  return {
    roundsMeasured: rounds.length,
    roundMeanTotalWallMs,
    roundMeanSearchWallMs,
    roundMeanTotalCpuMs,
    roundMeanSearchCpuMs,
    stability: {
      totalWallMs,
      searchWallMs,
      totalCpuMs,
      searchCpuMs,
      isStable: totalWallMs.isStable && searchWallMs.isStable,
    },
  };
}

function readBaselineSeriesForMode(baselineReport, modeLabel) {
  if (
    !baselineReport
    || typeof baselineReport !== 'object'
    || !Array.isArray(baselineReport.results)
  ) {
    return null;
  }
  const baselineModeEntry = baselineReport.results.find((entry) => entry.modeLabel === modeLabel);
  if (!baselineModeEntry || !baselineModeEntry.stableBenchmark) {
    return null;
  }
  const series = baselineModeEntry.stableBenchmark.roundMeanTotalWallMs;
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }
  return series;
}

function classifyAgainstBaseline(
  baselineSeries,
  candidateSeries,
  {
    significanceThresholdPct = DEFAULT_SIGNIFICANCE_THRESHOLD_PCT,
    classificationWinRatio = DEFAULT_CLASSIFICATION_WIN_RATIO,
  } = {},
) {
  if (!Array.isArray(baselineSeries) || !Array.isArray(candidateSeries)) {
    return null;
  }
  const commonLength = Math.min(baselineSeries.length, candidateSeries.length);
  if (commonLength <= 0) {
    return null;
  }
  const baselineTrimmed = baselineSeries.slice(0, commonLength);
  const candidateTrimmed = candidateSeries.slice(0, commonLength);
  const paired = summarizePairedDeltas(
    baselineTrimmed,
    candidateTrimmed,
    {
      significanceThresholdPct,
      classificationWinRatio,
    },
  );
  return {
    pairedRoundCount: commonLength,
    baselineRoundCount: baselineSeries.length,
    candidateRoundCount: candidateSeries.length,
    ...paired,
  };
}

function formatStableSummary(summary) {
  return `median=${summary.median.toFixed(2)}ms MAD=${summary.mad.toFixed(2)}ms relMAD=${(summary.relativeMad * 100).toFixed(2)}%`;
}

function formatPct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function runWasmPhaseBenchmark(graph, options = {}) {
  const {
    sourceNodeIndices,
    allowedModeMask,
    edgeCostPrecomputeKernel,
    nowImpl = () => performance.now(),
    cpuUsageImpl = defaultCpuUsage,
    includePerRun = false,
  } = options;

  if (!Array.isArray(sourceNodeIndices) || sourceNodeIndices.length === 0) {
    throw new Error('sourceNodeIndices must be a non-empty array');
  }
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  if (
    edgeCostPrecomputeKernel === null
    || typeof edgeCostPrecomputeKernel !== 'object'
    || typeof edgeCostPrecomputeKernel.precomputeEdgeCostsForGraph !== 'function'
    || typeof edgeCostPrecomputeKernel.computeTravelTimeFieldForGraph !== 'function'
  ) {
    throw new Error(
      'edgeCostPrecomputeKernel must expose precomputeEdgeCostsForGraph(...) and computeTravelTimeFieldForGraph(...)',
    );
  }
  if (typeof nowImpl !== 'function') {
    throw new Error('nowImpl must be a function');
  }
  if (cpuUsageImpl !== null && typeof cpuUsageImpl !== 'function') {
    throw new Error('cpuUsageImpl must be a function when provided');
  }

  const precomputeWallMsValues = [];
  const tickPackWallMsValues = [];
  const searchWallMsValues = [];
  const distOutputWallMsValues = [];
  const totalWallMsValues = [];
  const precomputeCpuMsValues = [];
  const tickPackCpuMsValues = [];
  const searchCpuMsValues = [];
  const distOutputCpuMsValues = [];
  const totalCpuMsValues = [];
  const settledNodeCounts = [];
  const perRun = [];

  const distOutputScratch = new Float32Array(graph.header.nNodes);
  const outDistSeconds = new Float32Array(graph.header.nNodes);
  let kernelGraphViews = null;

  for (const sourceNodeIndex of sourceNodeIndices) {
    if (
      !Number.isInteger(sourceNodeIndex)
      || sourceNodeIndex < 0
      || sourceNodeIndex >= graph.header.nNodes
    ) {
      throw new Error(`sourceNodeIndex out of range: ${sourceNodeIndex}`);
    }

    const runWallStartMs = nowImpl();
    const runCpuStart = cpuUsageImpl ? cpuUsageImpl() : null;

    const precomputeWallStartMs = nowImpl();
    const precomputeCpuStart = cpuUsageImpl ? cpuUsageImpl() : null;
    const edgeTraversalCostSeconds = precomputeEdgeTraversalCostSecondsCache(
      graph,
      allowedModeMask,
      null,
      {
        edgeCostPrecomputeKernel,
      },
    );
    const precomputeWallMs = Math.max(0, nowImpl() - precomputeWallStartMs);
    const precomputeCpuMs = precomputeCpuStart && cpuUsageImpl
      ? cpuUsageDeltaMs(precomputeCpuStart, cpuUsageImpl())
      : null;

    const tickPackWallStartMs = nowImpl();
    const tickPackCpuStart = cpuUsageImpl ? cpuUsageImpl() : null;
    const edgeTraversalCostTicks = getOrBuildEdgeTraversalCostTicksForMode(
      graph,
      allowedModeMask,
      edgeTraversalCostSeconds,
    );
    if (
      !kernelGraphViews
      || kernelGraphViews.edgeCostTicksRef !== edgeTraversalCostTicks
    ) {
      kernelGraphViews = buildModeSpecificKernelGraphViews(
        graph,
        allowedModeMask,
        edgeTraversalCostTicks,
      );
    }
    const tickPackWallMs = Math.max(0, nowImpl() - tickPackWallStartMs);
    const tickPackCpuMs = tickPackCpuStart && cpuUsageImpl
      ? cpuUsageDeltaMs(tickPackCpuStart, cpuUsageImpl())
      : null;

    const searchWallStartMs = nowImpl();
    const searchCpuStart = cpuUsageImpl ? cpuUsageImpl() : null;
    const kernelResult = edgeCostPrecomputeKernel.computeTravelTimeFieldForGraph({
      nodeFirstEdgeIndex: kernelGraphViews.nodeFirstEdgeIndex,
      nodeEdgeCount: kernelGraphViews.nodeEdgeCount,
      edgeTargetNodeIndex: kernelGraphViews.edgeTargetNodeIndex,
      edgeCostTicks: kernelGraphViews.edgeCostTicks,
      outDistSeconds,
      sourceNodeIndex,
      returnSharedOutputView: true,
      timeLimitSeconds: Number.POSITIVE_INFINITY,
    });
    const searchWallMs = Math.max(0, nowImpl() - searchWallStartMs);
    const searchCpuMs = searchCpuStart && cpuUsageImpl
      ? cpuUsageDeltaMs(searchCpuStart, cpuUsageImpl())
      : null;

    const distOutputWallStartMs = nowImpl();
    const distOutputCpuStart = cpuUsageImpl ? cpuUsageImpl() : null;
    const kernelDistOutputView =
      kernelResult
      && typeof kernelResult === 'object'
      && kernelResult.outDistSecondsView instanceof Float32Array
      && kernelResult.outDistSecondsView.length === outDistSeconds.length
        ? kernelResult.outDistSecondsView
        : outDistSeconds;
    distOutputScratch.set(kernelDistOutputView);
    const distOutputWallMs = Math.max(0, nowImpl() - distOutputWallStartMs);
    const distOutputCpuMs = distOutputCpuStart && cpuUsageImpl
      ? cpuUsageDeltaMs(distOutputCpuStart, cpuUsageImpl())
      : null;

    const totalWallMs = Math.max(0, nowImpl() - runWallStartMs);
    const totalCpuMs = runCpuStart && cpuUsageImpl ? cpuUsageDeltaMs(runCpuStart, cpuUsageImpl()) : null;
    const settledNodeCount =
      kernelResult && Number.isInteger(kernelResult.settledNodeCount)
        ? kernelResult.settledNodeCount
        : countFiniteTravelTimes(kernelDistOutputView);

    precomputeWallMsValues.push(precomputeWallMs);
    tickPackWallMsValues.push(tickPackWallMs);
    searchWallMsValues.push(searchWallMs);
    distOutputWallMsValues.push(distOutputWallMs);
    totalWallMsValues.push(totalWallMs);
    settledNodeCounts.push(settledNodeCount);
    if (precomputeCpuMs !== null) {
      precomputeCpuMsValues.push(precomputeCpuMs);
    }
    if (tickPackCpuMs !== null) {
      tickPackCpuMsValues.push(tickPackCpuMs);
    }
    if (searchCpuMs !== null) {
      searchCpuMsValues.push(searchCpuMs);
    }
    if (distOutputCpuMs !== null) {
      distOutputCpuMsValues.push(distOutputCpuMs);
    }
    if (totalCpuMs !== null) {
      totalCpuMsValues.push(totalCpuMs);
    }
    if (includePerRun) {
      perRun.push({
        sourceNodeIndex,
        settledNodeCount,
        precomputeWallMs,
        tickPackWallMs,
        searchWallMs,
        distOutputWallMs,
        totalWallMs,
        precomputeCpuMs,
        tickPackCpuMs,
        searchCpuMs,
        distOutputCpuMs,
        totalCpuMs,
      });
    }
  }

  const totalSettledNodes = settledNodeCounts.reduce((accumulator, value) => accumulator + value, 0);
  const totalSearchWallMs = searchWallMsValues.reduce((accumulator, value) => accumulator + value, 0);
  const totalMsPerSettledNode = totalSettledNodes > 0 ? totalSearchWallMs / totalSettledNodes : Infinity;

  const result = {
    runCount: sourceNodeIndices.length,
    allowedModeMask,
    totalSettledNodes,
    msPerSettledNode: totalMsPerSettledNode,
    settledNodeCount: summarizePhase(settledNodeCounts),
    phaseWallMs: {
      precompute: summarizePhase(precomputeWallMsValues),
      tickPack: summarizePhase(tickPackWallMsValues),
      search: summarizePhase(searchWallMsValues),
      distOutput: summarizePhase(distOutputWallMsValues),
      total: summarizePhase(totalWallMsValues),
    },
  };

  if (totalCpuMsValues.length > 0) {
    result.phaseCpuMs = {
      precompute: summarizePhase(precomputeCpuMsValues),
      tickPack: summarizePhase(tickPackCpuMsValues),
      search: summarizePhase(searchCpuMsValues),
      distOutput: summarizePhase(distOutputCpuMsValues),
      total: summarizePhase(totalCpuMsValues),
    };
  }
  if (includePerRun) {
    result.perRun = perRun;
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const graphPath = path.resolve(process.cwd(), args.graphPath);
  const binaryPayload = await fs.readFile(graphPath);
  const graph = parseGraphBinary(
    binaryPayload.buffer.slice(
      binaryPayload.byteOffset,
      binaryPayload.byteOffset + binaryPayload.byteLength,
    ),
  );

  const modeMasks = args.modes.map((modeToken) => ({
    token: modeToken,
    mask: parseModeMask(modeToken),
  }));

  const wasmPath = path.resolve(process.cwd(), args.wasmPath);
  const wasmPayload = await fs.readFile(wasmPath);
  const wasmModule = await instantiateRoutingKernelWasmFromBytes(
    wasmPayload.buffer.slice(
      wasmPayload.byteOffset,
      wasmPayload.byteOffset + wasmPayload.byteLength,
    ),
  );
  const edgeCostPrecomputeKernel = createWasmRoutingKernelFacade(wasmModule.exports);
  const resolvedEdgeKernel = 'wasm';
  const baselineJsonPath = args.baselineJsonPath ? path.resolve(process.cwd(), args.baselineJsonPath) : null;
  let baselineReport = null;
  if (baselineJsonPath) {
    const baselinePayload = await fs.readFile(baselineJsonPath, 'utf-8');
    baselineReport = JSON.parse(baselinePayload);
  }

  const report = {
    generatedAtIso: new Date().toISOString(),
    graphPath,
    edgeKernel: resolvedEdgeKernel,
    graphStats: {
      nNodes: graph.header.nNodes,
      nEdges: graph.header.nEdges,
      epsgCode: graph.header.epsgCode,
    },
    sampleCountRequested: args.sampleCount,
    seed: args.seed,
    results: [],
  };
  if (args.stable) {
    report.stableConfig = {
      warmupRounds: args.warmupRounds,
      measurementRounds: args.measurementRounds,
      maxRelativeMad: args.maxRelativeMad,
      significanceThresholdPct: args.significanceThresholdPct,
      classificationWinRatio: args.classificationWinRatio,
      baselineJsonPath,
    };
  }

  console.log(`Loaded graph: nodes=${graph.header.nNodes} edges=${graph.header.nEdges}`);
  console.log(`Edge-cost precompute kernel: ${resolvedEdgeKernel}`);
  if (args.stable) {
    console.log(
      `Stable mode: warmupRounds=${args.warmupRounds} measurementRounds=${args.measurementRounds} maxRelativeMad=${formatPct(args.maxRelativeMad)}`,
    );
    if (baselineJsonPath) {
      console.log(`Baseline comparison: ${baselineJsonPath}`);
    }
  }

  let stableModeCount = 0;
  let unstableModeCount = 0;
  let fasterComparedCount = 0;
  let slowerComparedCount = 0;
  let inconclusiveComparedCount = 0;
  let comparedModeCount = 0;

  for (const mode of modeMasks) {
    const edgeTraversalCostSeconds = precomputeEdgeTraversalCostSecondsCache(
      graph,
      mode.mask,
      null,
      {
        edgeCostPrecomputeKernel,
      },
    );
    const sampled = sampleEligibleSourceNodeIndices(graph, {
      sampleCount: args.sampleCount,
      allowedModeMask: mode.mask,
      seed: args.seed,
      edgeTraversalCostSeconds,
    });
    console.log(
      `\nMode ${formatModeMask(mode.mask)}: sampled ${sampled.deliveredSampleCount}/${sampled.requestedSampleCount} sources`,
    );

    const modeEntry = {
      requestedMode: mode.token,
      modeMask: mode.mask,
      modeLabel: formatModeMask(mode.mask),
      sampleStats: sampled,
      phaseBenchmark: null,
    };

    if (!args.stable) {
      const phaseBenchmark = runWasmPhaseBenchmark(graph, {
        sourceNodeIndices: sampled.nodeIndices,
        allowedModeMask: mode.mask,
        edgeCostPrecomputeKernel,
        nowImpl: () => performance.now(),
        cpuUsageImpl: () => process.cpuUsage(),
        includePerRun: args.includePerRun,
      });
      modeEntry.phaseBenchmark = phaseBenchmark;
      console.log(
        `  precompute: ${formatMetric(phaseBenchmark.phaseWallMs.precompute)}`,
      );
      console.log(
        `  tick-pack:  ${formatMetric(phaseBenchmark.phaseWallMs.tickPack)}`,
      );
      console.log(
        `  search:     ${formatMetric(phaseBenchmark.phaseWallMs.search)}`,
      );
      console.log(
        `  dist-output:${formatMetric(phaseBenchmark.phaseWallMs.distOutput)}`,
      );
      console.log(
        `  total:      ${formatMetric(phaseBenchmark.phaseWallMs.total)}; ms/settled=${phaseBenchmark.msPerSettledNode.toFixed(6)}`,
      );
    } else {
      if (args.warmupRounds > 0) {
        console.log(`  warmup: running ${args.warmupRounds} rounds (discarded)`);
      }
      for (let warmupRound = 0; warmupRound < args.warmupRounds; warmupRound += 1) {
        runWasmPhaseBenchmark(graph, {
          sourceNodeIndices: sampled.nodeIndices,
          allowedModeMask: mode.mask,
          edgeCostPrecomputeKernel,
          nowImpl: () => performance.now(),
          cpuUsageImpl: () => process.cpuUsage(),
          includePerRun: false,
        });
      }

      const measuredRounds = [];
      for (let roundIndex = 0; roundIndex < args.measurementRounds; roundIndex += 1) {
        const phaseBenchmark = runWasmPhaseBenchmark(graph, {
          sourceNodeIndices: sampled.nodeIndices,
          allowedModeMask: mode.mask,
          edgeCostPrecomputeKernel,
          nowImpl: () => performance.now(),
          cpuUsageImpl: () => process.cpuUsage(),
          includePerRun: args.includePerRun,
        });
        measuredRounds.push({
          roundIndex: roundIndex + 1,
          phaseBenchmark,
        });
      }

      const stableBenchmark = summarizeStableModeRounds(measuredRounds, {
        maxRelativeMad: args.maxRelativeMad,
      });
      const latestRound = measuredRounds[measuredRounds.length - 1];
      modeEntry.phaseBenchmark = latestRound.phaseBenchmark;
      modeEntry.stableBenchmark = {
        warmupRounds: args.warmupRounds,
        measurementRounds: args.measurementRounds,
        maxRelativeMad: args.maxRelativeMad,
        rounds: measuredRounds,
        ...stableBenchmark,
      };

      const stability = stableBenchmark.stability;
      if (stability.isStable) {
        stableModeCount += 1;
      } else {
        unstableModeCount += 1;
      }

      console.log(
        `  stable total:  ${formatStableSummary(stability.totalWallMs)} (${stability.totalWallMs.isStable ? 'PASS' : 'FAIL'})`,
      );
      console.log(
        `  stable search: ${formatStableSummary(stability.searchWallMs)} (${stability.searchWallMs.isStable ? 'PASS' : 'FAIL'})`,
      );
      const lastPhase = latestRound.phaseBenchmark;
      console.log(
        `  latest round: total=${formatMetric(lastPhase.phaseWallMs.total)}; search=${formatMetric(lastPhase.phaseWallMs.search)}; ms/settled=${lastPhase.msPerSettledNode.toFixed(6)}`,
      );

      if (baselineReport) {
        const baselineSeries = readBaselineSeriesForMode(baselineReport, modeEntry.modeLabel);
        if (baselineSeries) {
          const baselineComparison = classifyAgainstBaseline(
            baselineSeries,
            stableBenchmark.roundMeanTotalWallMs,
            {
              significanceThresholdPct: args.significanceThresholdPct,
              classificationWinRatio: args.classificationWinRatio,
            },
          );
          if (baselineComparison) {
            modeEntry.baselineComparison = baselineComparison;
            comparedModeCount += 1;
            if (baselineComparison.classification === 'faster') {
              fasterComparedCount += 1;
            } else if (baselineComparison.classification === 'slower') {
              slowerComparedCount += 1;
            } else {
              inconclusiveComparedCount += 1;
            }
            console.log(
              `  baseline compare: ${baselineComparison.classification} (median delta=${baselineComparison.deltaMs.p50.toFixed(2)}ms, median pct delta=${formatPct(baselineComparison.deltaPct.p50)})`,
            );
          } else {
            console.log('  baseline compare: unavailable (no overlapping measured rounds)');
          }
        } else {
          console.log('  baseline compare: unavailable (mode missing or no stable rounds in baseline)');
        }
      }
    }

    report.results.push(modeEntry);
  }

  if (args.stable) {
    report.stableSummary = {
      stableModeCount,
      unstableModeCount,
      pass: unstableModeCount === 0,
      maxRelativeMad: args.maxRelativeMad,
    };
    if (baselineReport) {
      report.stableSummary.baselineComparison = {
        comparedModeCount,
        fasterComparedCount,
        slowerComparedCount,
        inconclusiveComparedCount,
      };
    }
    console.log(
      `\nStability gate: ${report.stableSummary.pass ? 'PASS' : 'FAIL'} (${stableModeCount} stable, ${unstableModeCount} unstable)`,
    );
    if (baselineReport) {
      console.log(
        `Baseline classification: compared=${comparedModeCount} faster=${fasterComparedCount} slower=${slowerComparedCount} inconclusive=${inconclusiveComparedCount}`,
      );
    }
  }

  if (args.outputJsonPath) {
    const outputPath = path.resolve(process.cwd(), args.outputJsonPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    console.log(`\nWrote benchmark report: ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
