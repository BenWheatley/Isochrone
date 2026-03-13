#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  EDGE_MODE_BIKE_BIT,
  EDGE_MODE_CAR_BIT,
  EDGE_MODE_WALK_BIT,
} from '../src/config/constants.js';
import { parseGraphBinary } from '../src/app.js';
import {
  runRoutingBenchmark,
  sampleEligibleSourceNodeIndices,
} from '../src/perf/routing-benchmark.js';
import {
  createWasmRoutingKernelFacade,
  instantiateRoutingKernelWasmFromBytes,
} from '../src/wasm/routing-kernel.js';

const DEFAULT_GRAPH_PATH = 'data_pipeline/output/graph-walk.bin';
const DEFAULT_SAMPLE_COUNT = 24;
const DEFAULT_SEED = 1337;
const DEFAULT_MODE_LIST = ['car'];
const DEFAULT_HEAP_STRATEGIES = ['decrease-key', 'duplicate-push'];
const DEFAULT_EDGE_KERNEL = 'js';
const DEFAULT_WASM_PATH = 'web/wasm/routing-kernel.wasm';

function parseArgs(argv) {
  const args = {
    graphPath: DEFAULT_GRAPH_PATH,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    seed: DEFAULT_SEED,
    modes: DEFAULT_MODE_LIST,
    heapStrategies: DEFAULT_HEAP_STRATEGIES,
    edgeKernel: DEFAULT_EDGE_KERNEL,
    wasmPath: DEFAULT_WASM_PATH,
    outputJsonPath: null,
    includePerRun: false,
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
    } else if (token === '--heap-strategies') {
      const strategyListRaw = requireArgValue(argv, ++index, token);
      args.heapStrategies = strategyListRaw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (args.heapStrategies.length === 0) {
        throw new Error('--heap-strategies must contain at least one strategy');
      }
    } else if (token === '--edge-kernel') {
      const value = requireArgValue(argv, ++index, token).trim().toLowerCase();
      if (value !== 'js' && value !== 'wasm' && value !== 'auto') {
        throw new Error('--edge-kernel must be one of: js, wasm, auto');
      }
      args.edgeKernel = value;
    } else if (token === '--wasm-path') {
      args.wasmPath = requireArgValue(argv, ++index, token);
    } else if (token === '--output-json') {
      args.outputJsonPath = requireArgValue(argv, ++index, token);
    } else if (token === '--include-per-run') {
      args.includePerRun = true;
    } else if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
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
    "  --heap-strategies <list>       Comma-separated: decrease-key,duplicate-push",
    '  --edge-kernel <mode>           js | wasm | auto (default: js)',
    `  --wasm-path <path>             WASM binary path (default: ${DEFAULT_WASM_PATH})`,
    '  --output-json <path>           Optional JSON report path',
    '  --include-per-run              Include per-run details in JSON report',
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

  let edgeCostPrecomputeKernel = null;
  let resolvedEdgeKernel = 'js';
  if (args.edgeKernel === 'wasm' || args.edgeKernel === 'auto') {
    const wasmPath = path.resolve(process.cwd(), args.wasmPath);
    try {
      const wasmPayload = await fs.readFile(wasmPath);
      const wasmModule = await instantiateRoutingKernelWasmFromBytes(
        wasmPayload.buffer.slice(
          wasmPayload.byteOffset,
          wasmPayload.byteOffset + wasmPayload.byteLength,
        ),
      );
      edgeCostPrecomputeKernel = createWasmRoutingKernelFacade(wasmModule.exports);
      resolvedEdgeKernel = 'wasm';
    } catch (error) {
      if (args.edgeKernel === 'wasm') {
        throw error;
      }
      console.warn('WASM kernel not available for benchmark, falling back to JS.');
      resolvedEdgeKernel = 'js';
      edgeCostPrecomputeKernel = null;
    }
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

  console.log(`Loaded graph: nodes=${graph.header.nNodes} edges=${graph.header.nEdges}`);
  console.log(`Edge-cost precompute kernel: ${resolvedEdgeKernel}`);

  for (const mode of modeMasks) {
    const sampled = sampleEligibleSourceNodeIndices(graph, {
      sampleCount: args.sampleCount,
      allowedModeMask: mode.mask,
      seed: args.seed,
    });
    console.log(
      `\nMode ${formatModeMask(mode.mask)}: sampled ${sampled.deliveredSampleCount}/${sampled.requestedSampleCount} sources`,
    );

    const modeEntry = {
      requestedMode: mode.token,
      modeMask: mode.mask,
      modeLabel: formatModeMask(mode.mask),
      sampleStats: sampled,
      strategyResults: [],
    };

    for (const heapStrategy of args.heapStrategies) {
      const benchmark = runRoutingBenchmark(graph, {
        sourceNodeIndices: sampled.nodeIndices,
        allowedModeMask: mode.mask,
        heapStrategy,
        edgeCostPrecomputeKernel,
        nowImpl: () => performance.now(),
        cpuUsageImpl: () => process.cpuUsage(),
        includePerRun: args.includePerRun,
      });
      modeEntry.strategyResults.push(benchmark);
      console.log(`  ${heapStrategy}: ${formatMetric(benchmark.wallMs)}; ms/settled=${benchmark.msPerSettledNode.toFixed(6)}`);
    }

    report.results.push(modeEntry);
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
