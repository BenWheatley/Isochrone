import {
  BIKE_CRUISE_SPEED_KPH,
  CAR_FALLBACK_SPEED_KPH,
  EDGE_MODE_BIKE_BIT,
  EDGE_MODE_CAR_BIT,
  EDGE_MODE_WALK_BIT,
  EDGE_MODE_BOARDING_BITS,
  EDGE_MODE_WATER_BIT,
  EDGE_TRAVERSAL_COST_CACHE_PROPERTY,
  ROAD_CLASS_MOTORWAY,
  WALKING_SPEED_M_S,
  WATER_FALLBACK_SPEED_KPH,
} from '../config/constants.js';
import { DuplicateEntryMinHeap, MinHeap } from './heap.js';
import { validateGraphForRouting } from './graph-validation.js';

const EDGE_WALK_COST_SECONDS_CACHE_PROPERTY = '__edgeWalkCostSeconds';
const EDGE_TRAVERSAL_COST_READY_CACHE_PROPERTY = '__edgeTraversalCostReadyByModeMask';

export function createWalkingSearchState(
  graph,
  sourceNodeIndex,
  timeLimitSeconds = Number.POSITIVE_INFINITY,
  allowedModeMask = EDGE_MODE_CAR_BIT,
  options = {},
) {
  validateGraphForRouting(graph);
  const nNodes = graph.header.nNodes;

  if (!Number.isInteger(sourceNodeIndex) || sourceNodeIndex < 0 || sourceNodeIndex >= nNodes) {
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
  if (!options || typeof options !== 'object') {
    throw new Error('options must be an object');
  }
  const edgeCostPrecomputeKernel = options.edgeCostPrecomputeKernel ?? null;
  if (
    edgeCostPrecomputeKernel === null
    || typeof edgeCostPrecomputeKernel !== 'object'
    || typeof edgeCostPrecomputeKernel.precomputeEdgeCostsForGraph !== 'function'
  ) {
    throw new Error(
      'options.edgeCostPrecomputeKernel is required and must expose precomputeEdgeCostsForGraph(...)',
    );
  }
  if (options.onKernelError !== null && options.onKernelError !== undefined && typeof options.onKernelError !== 'function') {
    throw new Error('options.onKernelError must be a function when provided');
  }
  const extraSeeds = options.extraSeeds ?? [];
  if (!Array.isArray(extraSeeds)) {
    throw new Error('options.extraSeeds must be an array when provided');
  }
  for (const seed of extraSeeds) {
    if (
      !seed
      || !Number.isInteger(seed.nodeIndex)
      || seed.nodeIndex < 0
      || seed.nodeIndex >= nNodes
    ) {
      throw new Error('options.extraSeeds entries must have a valid nodeIndex');
    }
    if (!Number.isFinite(seed.startDistSeconds) || seed.startDistSeconds < 0) {
      throw new Error('options.extraSeeds entries must have a non-negative startDistSeconds');
    }
  }

  const nodeU32 = graph.nodeU32;
  const nodeU16 = graph.nodeU16;
  const edgeU32 = graph.edgeU32;
  const edgeModeMask = graph.edgeModeMask;
  const heapStrategy = options.heapStrategy ?? 'decrease-key';
  if (heapStrategy !== 'decrease-key' && heapStrategy !== 'duplicate-push') {
    throw new Error("options.heapStrategy must be 'decrease-key' or 'duplicate-push'");
  }
  const useDuplicatePushHeap = heapStrategy === 'duplicate-push';
  const edgeTraversalCostSeconds = precomputeEdgeTraversalCostSecondsCache(
    graph,
    allowedModeMask,
    null,
    {
      edgeCostPrecomputeKernel,
      onKernelError: options.onKernelError ?? null,
      walkingSpeedMps: options.walkingSpeedMps,
      bikeCruiseSpeedKph: options.bikeCruiseSpeedKph,
    },
  );
  const distSeconds = new Float64Array(nNodes);
  distSeconds.fill(Infinity);
  const settled = new Uint8Array(nNodes);
  const heap = useDuplicatePushHeap ? new DuplicateEntryMinHeap(nNodes) : new MinHeap(nNodes);
  const heapPositionLookup = heap.positionLookup;
  const hasFiniteTimeLimit = Number.isFinite(timeLimitSeconds);

  distSeconds[sourceNodeIndex] = 0;
  heap.push(sourceNodeIndex, 0);

  // Additional seeds (e.g. transit-reached stops from a prior CSA pass) are
  // pushed alongside the primary source before any pops begin, so this is
  // a true multi-source Dijkstra in one pass — matching the WASM kernel's
  // compute_travel_time_field_multi_source approach.
  for (const seed of extraSeeds) {
    if (seed.startDistSeconds < distSeconds[seed.nodeIndex]) {
      distSeconds[seed.nodeIndex] = seed.startDistSeconds;
      heap.push(seed.nodeIndex, seed.startDistSeconds);
    }
  }

  let done = false;
  let settledCount = 0;
  const heapPopEntry = { nodeIndex: -1, cost: 0 };

  return {
    graph,
    sourceNodeIndex,
    timeLimitSeconds,
    allowedModeMask,
    heapStrategy,
    edgeTraversalCostSeconds,
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
        if (!heap.popInto(heapPopEntry)) {
          done = true;
          return -1;
        }

        const nodeIndex = heapPopEntry.nodeIndex;
        const cost = heapPopEntry.cost;

        if (useDuplicatePushHeap && cost > distSeconds[nodeIndex]) {
          continue;
        }
        if (hasFiniteTimeLimit && cost > timeLimitSeconds) {
          done = true;
          return -1;
        }
        if (settled[nodeIndex] === 1) {
          continue;
        }

        settled[nodeIndex] = 1;
        settledCount += 1;

        const firstEdgeIndex = nodeU32[nodeIndex * 4 + 2];
        const edgeCount = nodeU16[nodeIndex * 8 + 6];
        const endEdgeIndex = firstEdgeIndex + edgeCount;

        for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
          if ((edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
            continue;
          }
          const targetIndex = edgeU32[edgeIndex * 3];
          const edgeCostSeconds = edgeTraversalCostSeconds[edgeIndex];
          if (!Number.isFinite(edgeCostSeconds) || edgeCostSeconds <= 0) {
            continue;
          }
          const nextCost = cost + edgeCostSeconds;

          if (hasFiniteTimeLimit && nextCost > timeLimitSeconds) {
            continue;
          }
          if (nextCost < distSeconds[targetIndex]) {
            if (useDuplicatePushHeap) {
              distSeconds[targetIndex] = nextCost;
              heap.push(targetIndex, nextCost);
            } else {
              const heapPosition = heapPositionLookup[targetIndex];
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

export function computeEdgeTraversalCostSeconds(graph, edgeIndex, allowedModeMask, options = {}) {
  const edgeModeMask = graph.edgeModeMask[edgeIndex];
  if ((edgeModeMask & allowedModeMask) === 0) {
    return Infinity;
  }

  const walkingCostSeconds = graph.edgeU16[edgeIndex * 6 + 2];
  if (walkingCostSeconds <= 0) {
    return Infinity;
  }

  const walkingSpeedMps =
    Number.isFinite(options.walkingSpeedMps) && options.walkingSpeedMps > 0
      ? options.walkingSpeedMps
      : WALKING_SPEED_M_S;
  const bikeCruiseSpeedKph =
    Number.isFinite(options.bikeCruiseSpeedKph) && options.bikeCruiseSpeedKph > 0
      ? options.bikeCruiseSpeedKph
      : BIKE_CRUISE_SPEED_KPH;

  // distanceMeters is reconstructed from the graph's baked-in walking cost
  // using the build-time WALKING_SPEED_M_S constant (the speed the data
  // pipeline actually assumed when it computed walkingCostSeconds from real
  // edge geometry) — not options.walkingSpeedMps, which is a user preference
  // applied only to the walk-mode cost below. Using the user's speed here
  // would corrupt the physical distance that bike/car/water costs derive
  // from. Mirrors wasm/routing-kernel/src/lib.rs's edge_cost_seconds.
  const distanceMeters = Math.max(1, walkingCostSeconds * WALKING_SPEED_M_S);
  const edgeMaxspeedKph = graph.edgeMaxspeedKph[edgeIndex];

  if ((edgeModeMask & EDGE_MODE_WATER_BIT) !== 0) {
    // A ferry needs Ferry selected *and* a way to get aboard: a walk-on ferry
    // carries the walk bit, a drive-on ferry the car bit, and so on. Matching
    // on the boarding bit alone let ferries be used whenever Walk was ticked,
    // which is how a Portsmouth walking isochrone crossed the Solent.
    if ((allowedModeMask & EDGE_MODE_WATER_BIT) === 0) {
      return Infinity;
    }
    const boardingModeMask = edgeModeMask & EDGE_MODE_BOARDING_BITS;
    if (boardingModeMask !== 0 && (allowedModeMask & boardingModeMask) === 0) {
      return Infinity;
    }

    // Crossing time itself doesn't depend on which boarding bit matched -
    // always cost it at the baked ferry speed (duration-tag-derived, explicit
    // maxspeed, or the flat fallback, resolved at build time into
    // edgeMaxspeedKph).
    const waterSpeedKph = edgeMaxspeedKph > 0 ? edgeMaxspeedKph : WATER_FALLBACK_SPEED_KPH;
    if (waterSpeedKph <= 0) {
      return Infinity;
    }
    const waterMetersPerSecond = (waterSpeedKph * 1000) / 3600;
    return distanceMeters / waterMetersPerSecond;
  }

  let bestCostSeconds = Infinity;

  if ((allowedModeMask & EDGE_MODE_WALK_BIT) !== 0 && (edgeModeMask & EDGE_MODE_WALK_BIT) !== 0) {
    const isMotorway = graph.edgeRoadClassId[edgeIndex] === ROAD_CLASS_MOTORWAY;
    if (!isMotorway) {
      bestCostSeconds = Math.min(bestCostSeconds, distanceMeters / walkingSpeedMps);
    }
  }

  if ((allowedModeMask & EDGE_MODE_BIKE_BIT) !== 0 && (edgeModeMask & EDGE_MODE_BIKE_BIT) !== 0) {
    const isMotorway = graph.edgeRoadClassId[edgeIndex] === ROAD_CLASS_MOTORWAY;
    if (!isMotorway) {
      const bikeSpeedKph = Math.min(bikeCruiseSpeedKph, edgeMaxspeedKph);
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

// Cache keys fold in walkingSpeedMps/bikeCruiseSpeedKph alongside
// allowedModeMask so a speed change doesn't reuse cost arrays precomputed
// under a different speed. Call sites that never customize speed (e.g.
// nearest-node spatial lookups) omit options and key into the default-speed
// slot, which is what they want anyway.
function resolveEdgeTraversalCostCacheKey(allowedModeMask, options) {
  const walkingSpeedMps =
    Number.isFinite(options?.walkingSpeedMps) && options.walkingSpeedMps > 0
      ? options.walkingSpeedMps
      : WALKING_SPEED_M_S;
  const bikeCruiseSpeedKph =
    Number.isFinite(options?.bikeCruiseSpeedKph) && options.bikeCruiseSpeedKph > 0
      ? options.bikeCruiseSpeedKph
      : BIKE_CRUISE_SPEED_KPH;
  return `${allowedModeMask}:${walkingSpeedMps}:${bikeCruiseSpeedKph}`;
}

export function getOrCreateEdgeTraversalCostSecondsCache(graph, allowedModeMask, options = {}) {
  validateGraphForRouting(graph);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const cacheKey = resolveEdgeTraversalCostCacheKey(allowedModeMask, options);
  let edgeTraversalCostCacheByModeMask = graph[EDGE_TRAVERSAL_COST_CACHE_PROPERTY];
  if (!edgeTraversalCostCacheByModeMask || typeof edgeTraversalCostCacheByModeMask !== 'object') {
    edgeTraversalCostCacheByModeMask = Object.create(null);
    graph[EDGE_TRAVERSAL_COST_CACHE_PROPERTY] = edgeTraversalCostCacheByModeMask;
  }

  let edgeTraversalCostSeconds = edgeTraversalCostCacheByModeMask[cacheKey];
  if (
    !(edgeTraversalCostSeconds instanceof Float32Array)
    || edgeTraversalCostSeconds.length < graph.header.nEdges
  ) {
    edgeTraversalCostSeconds = new Float32Array(graph.header.nEdges);
    edgeTraversalCostSeconds.fill(Number.NaN);
    edgeTraversalCostCacheByModeMask[cacheKey] = edgeTraversalCostSeconds;
    const readyCacheByModeMask = getOrCreateEdgeTraversalCostReadyCacheByModeMask(graph);
    delete readyCacheByModeMask[cacheKey];
  }

  return edgeTraversalCostSeconds;
}

export function precomputeEdgeTraversalCostSecondsCache(
  graph,
  allowedModeMask,
  edgeTraversalCostSeconds = null,
  options = {},
) {
  validateGraphForRouting(graph);
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }
  if (!options || typeof options !== 'object') {
    throw new Error('options must be an object');
  }

  const cacheKey = resolveEdgeTraversalCostCacheKey(allowedModeMask, options);
  const costSeconds = edgeTraversalCostSeconds
    ?? getOrCreateEdgeTraversalCostSecondsCache(graph, allowedModeMask, options);
  if (!(costSeconds instanceof Float32Array) || costSeconds.length < graph.header.nEdges) {
    throw new Error('edgeTraversalCostSeconds must be a Float32Array covering graph.header.nEdges');
  }

  const edgeCostPrecomputeKernel = options.edgeCostPrecomputeKernel ?? null;
  if (
    edgeCostPrecomputeKernel === null
    || typeof edgeCostPrecomputeKernel !== 'object'
    || typeof edgeCostPrecomputeKernel.precomputeEdgeCostsForGraph !== 'function'
  ) {
    throw new Error(
      'options.edgeCostPrecomputeKernel is required and must expose precomputeEdgeCostsForGraph(...)',
    );
  }

  const readyCacheByModeMask = getOrCreateEdgeTraversalCostReadyCacheByModeMask(graph);
  if (readyCacheByModeMask[cacheKey] === costSeconds) {
    return costSeconds;
  }

  try {
    edgeCostPrecomputeKernel.precomputeEdgeCostsForGraph({
      edgeModeMask: graph.edgeModeMask,
      edgeRoadClassId: graph.edgeRoadClassId,
      edgeMaxspeedKph: graph.edgeMaxspeedKph,
      edgeWalkCostSeconds: getOrCreateEdgeWalkCostSeconds(graph),
      outCostSeconds: costSeconds,
      allowedModeMask,
      walkingSpeedMps: options.walkingSpeedMps,
      bikeCruiseSpeedKph: options.bikeCruiseSpeedKph,
    });
  } catch (error) {
    if (typeof options.onKernelError === 'function') {
      options.onKernelError(error);
    }
    throw error;
  }

  for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
    const cachedCostSeconds = costSeconds[edgeIndex];
    const cachedCostIsValid =
      cachedCostSeconds === Infinity || (Number.isFinite(cachedCostSeconds) && cachedCostSeconds > 0);
    if (!cachedCostIsValid) {
      throw new Error(`WASM edge-cost precompute produced invalid cost at edge ${edgeIndex}`);
    }
  }

  readyCacheByModeMask[cacheKey] = costSeconds;

  return costSeconds;
}

function getOrCreateEdgeTraversalCostReadyCacheByModeMask(graph) {
  let readyCacheByModeMask = graph[EDGE_TRAVERSAL_COST_READY_CACHE_PROPERTY];
  if (!readyCacheByModeMask || typeof readyCacheByModeMask !== 'object') {
    readyCacheByModeMask = Object.create(null);
    graph[EDGE_TRAVERSAL_COST_READY_CACHE_PROPERTY] = readyCacheByModeMask;
  }
  return readyCacheByModeMask;
}

function getOrCreateEdgeWalkCostSeconds(graph) {
  let edgeWalkCostSeconds = graph[EDGE_WALK_COST_SECONDS_CACHE_PROPERTY];
  if (
    !(edgeWalkCostSeconds instanceof Uint16Array)
    || edgeWalkCostSeconds.length < graph.header.nEdges
  ) {
    edgeWalkCostSeconds = new Uint16Array(graph.header.nEdges);
    for (let edgeIndex = 0; edgeIndex < graph.header.nEdges; edgeIndex += 1) {
      edgeWalkCostSeconds[edgeIndex] = graph.edgeU16[edgeIndex * 6 + 2];
    }
    graph[EDGE_WALK_COST_SECONDS_CACHE_PROPERTY] = edgeWalkCostSeconds;
  }
  return edgeWalkCostSeconds;
}

export function getEdgeTraversalCostSeconds(
  graph,
  edgeIndex,
  allowedModeMask,
  edgeTraversalCostSeconds = null,
) {
  void allowedModeMask;
  if (
    !(edgeTraversalCostSeconds instanceof Float32Array)
    || edgeTraversalCostSeconds.length < graph.header.nEdges
  ) {
    throw new Error(
      'edgeTraversalCostSeconds precompute cache is required and must cover graph.header.nEdges',
    );
  }
  const cachedCostSeconds = edgeTraversalCostSeconds[edgeIndex];
  if (Number.isNaN(cachedCostSeconds)) {
    throw new Error(`edgeTraversalCostSeconds has NaN for edge ${edgeIndex}`);
  }
  return cachedCostSeconds;
}

export function nodeHasAllowedModeOutgoingEdge(
  graph,
  nodeIndex,
  allowedModeMask,
  edgeTraversalCostSeconds = null,
) {
  const firstEdgeIndex = graph.nodeU32[nodeIndex * 4 + 2];
  const edgeCount = graph.nodeU16[nodeIndex * 8 + 6];
  const endEdgeIndex = firstEdgeIndex + edgeCount;

  for (let edgeIndex = firstEdgeIndex; edgeIndex < endEdgeIndex; edgeIndex += 1) {
    if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0) {
      continue;
    }
    const edgeCostSeconds = getEdgeTraversalCostSeconds(
      graph,
      edgeIndex,
      allowedModeMask,
      edgeTraversalCostSeconds,
    );
    if (Number.isFinite(edgeCostSeconds) && edgeCostSeconds > 0) {
      return true;
    }
  }

  return false;
}
