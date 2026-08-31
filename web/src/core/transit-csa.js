import { TRANSIT_MIN_TRANSFER_SECONDS, WALKING_SPEED_M_S } from '../config/constants.js';
import { validateGraphForRouting } from './graph-validation.js';
import { validateNodePixels } from './routing-validation.js';

// Connection Scan Algorithm pass over the graph's transit tables, plus the
// line geometry it produces for rendering.

export function runConnectionScanFromWalkingReachableStops(graph, walkDistSeconds, options = {}) {
  validateGraphForRouting(graph);
  const nStops = graph.header.nStops;
  if (!Number.isInteger(nStops) || nStops < 0) {
    throw new Error('graph.header.nStops must be a non-negative integer');
  }
  if (nStops === 0) {
    return { seedNodeIndices: new Uint32Array(0), seedStartDistSeconds: new Float32Array(0) };
  }
  if (!walkDistSeconds || typeof walkDistSeconds.length !== 'number') {
    throw new Error('walkDistSeconds must be an array-like of per-node elapsed seconds');
  }
  const departureSecondsOfDay = options.departureSecondsOfDay;
  if (!Number.isFinite(departureSecondsOfDay) || departureSecondsOfDay < 0) {
    throw new Error('options.departureSecondsOfDay must be a non-negative finite number');
  }
  const departureWeekdayIndex = options.departureWeekdayIndex;
  if (
    !Number.isInteger(departureWeekdayIndex)
    || departureWeekdayIndex < 0
    || departureWeekdayIndex > 6
  ) {
    throw new Error('options.departureWeekdayIndex must be an integer between 0 and 6');
  }
  const departureWeekdayBit = 1 << departureWeekdayIndex;
  const timeLimitSeconds =
    Number.isFinite(options.timeLimitSeconds) && options.timeLimitSeconds > 0
      ? options.timeLimitSeconds
      : Number.POSITIVE_INFINITY;
  const budgetEndSeconds = departureSecondsOfDay + timeLimitSeconds;
  const walkingSpeedMps =
    Number.isFinite(options.walkingSpeedMps) && options.walkingSpeedMps > 0
      ? options.walkingSpeedMps
      : WALKING_SPEED_M_S;
  const minTransferSeconds =
    Number.isFinite(options.minTransferSeconds) && options.minTransferSeconds >= 0
      ? options.minTransferSeconds
      : TRANSIT_MIN_TRANSFER_SECONDS;

  // How far the rider will walk on any one leg - to the first stop, between
  // stops when changing, and away from the last one. Passed explicitly rather
  // than inferred from walkDistSeconds's own limit, because when Walk is a
  // selected mode that field is deliberately unbounded: the walking isochrone
  // is a legitimate result in its own right, but it must not let someone walk
  // an hour to a station and call it a transit journey.
  const walkBudgetSeconds =
    Number.isFinite(options.walkBudgetSeconds) && options.walkBudgetSeconds >= 0
      ? options.walkBudgetSeconds
      : Number.POSITIVE_INFINITY;

  const earliestArrivalSeconds = new Float64Array(nStops).fill(Number.POSITIVE_INFINITY);
  const walkAttachCostSeconds = new Float64Array(nStops);
  const improvedByTransit = new Uint8Array(nStops);

  for (let stopIndex = 0; stopIndex < nStops; stopIndex += 1) {
    const nodeIndex = graph.stopNearestNodeIndex[stopIndex];
    const dx = graph.stopX[stopIndex] - graph.nodeI32[nodeIndex * 4];
    const dy = graph.stopY[stopIndex] - graph.nodeI32[nodeIndex * 4 + 1];
    const attachCostSeconds = Math.sqrt(dx * dx + dy * dy) / walkingSpeedMps;
    walkAttachCostSeconds[stopIndex] = attachCostSeconds;

    // Reaching a stop means walking to it on the walk graph and then covering
    // the short fixed offset between the graph node the stop is pinned to and
    // the platform itself. The whole of that is the access leg, so the whole
    // of it is what the budget applies to.
    let bestArrivalSeconds = Number.POSITIVE_INFINITY;
    const walkElapsedSeconds = walkDistSeconds[nodeIndex];
    if (
      Number.isFinite(walkElapsedSeconds)
      && walkElapsedSeconds + attachCostSeconds <= walkBudgetSeconds
    ) {
      bestArrivalSeconds = departureSecondsOfDay + walkElapsedSeconds + attachCostSeconds;
    }
    if (bestArrivalSeconds <= budgetEndSeconds) {
      earliestArrivalSeconds[stopIndex] = bestArrivalSeconds;
    }
  }

  // A change of vehicle is a walk between two stop ids plus the time it takes
  // to alight, cross to the next platform and board. The walk is read from the
  // graph, where the pipeline stored it having routed it over the pedestrian
  // network and unioned it with the feed's own transfers.txt - so a stop on
  // the far bank of a river is not a 100 m walk, and an interchange OSM has
  // failed to join is not lost.
  //
  // Relaxed one hop at a time, on each improvement, rather than over a
  // transitive closure: a rider walking from stop to stop to stop is a rider
  // walking, not changing, and the walk graph already models that.
  const hasTransferTable =
    graph.stopFirstTransferIndex instanceof Uint32Array
    && graph.stopTransferCount instanceof Uint16Array
    && graph.transferToStopIndex instanceof Uint32Array;
  const relaxTransfersFromStop = (fromStopIndex, arrivalSeconds) => {
    if (!hasTransferTable) {
      return;
    }
    const firstTransfer = graph.stopFirstTransferIndex[fromStopIndex];
    const endTransfer = firstTransfer + graph.stopTransferCount[fromStopIndex];
    for (let t = firstTransfer; t < endTransfer; t += 1) {
      const transferWalkSeconds = graph.transferWalkDistanceM[t] / walkingSpeedMps;
      if (transferWalkSeconds > walkBudgetSeconds) {
        continue;
      }
      // The feed's own minimum for this interchange where it declares one,
      // which is routinely five minutes rather than the generic floor; zero
      // means it said nothing, so fall back to the floor.
      const declaredMinimumSeconds = graph.transferMinSeconds[t];
      const changeSeconds = declaredMinimumSeconds > 0
        ? declaredMinimumSeconds
        : minTransferSeconds;
      const candidateSeconds = arrivalSeconds + Math.max(transferWalkSeconds, changeSeconds);
      if (candidateSeconds > budgetEndSeconds) {
        continue;
      }
      const toStopIndex = graph.transferToStopIndex[t];
      if (candidateSeconds < earliestArrivalSeconds[toStopIndex]) {
        earliestArrivalSeconds[toStopIndex] = candidateSeconds;
        improvedByTransit[toStopIndex] = 1;
      }
    }
  };

  // Every connection whose boarding stop is reachable in time is renderable,
  // not just the one that happens to win each stop's earliest-arrival race -
  // so a route's consecutive hops (A->B, B->C, C->D) all appear, instead of
  // the sparse, visually disconnected spanning tree the winners alone form.
  // Deduplicated by stop pair: several trips of the same line share one
  // A->B geometry and would otherwise be drawn on top of each other.
  const renderableTedgeIndices = new Uint32Array(graph.header.nTedges);
  const seenStopPairs = new Set();
  let renderableTedgeCount = 0;

  const nTedges = graph.header.nTedges;
  for (let tedgeIndex = 0; tedgeIndex < nTedges; tedgeIndex += 1) {
    const departureSeconds = graph.tedgeDepartureSeconds[tedgeIndex];
    if (departureSeconds > budgetEndSeconds) {
      break;
    }
    if (!(graph.tedgeServiceDayMask[tedgeIndex] & departureWeekdayBit)) {
      continue;
    }
    const fromStopIndex = graph.tedgeFromStop[tedgeIndex];
    if (departureSeconds < earliestArrivalSeconds[fromStopIndex]) {
      continue;
    }
    const toStopIndex = graph.tedgeToStop[tedgeIndex];
    const candidateArrivalSeconds = departureSeconds + graph.tedgeTravelSeconds[tedgeIndex];
    if (candidateArrivalSeconds > budgetEndSeconds) {
      continue;
    }
    const stopPairKey = fromStopIndex * nStops + toStopIndex;
    if (!seenStopPairs.has(stopPairKey)) {
      seenStopPairs.add(stopPairKey);
      renderableTedgeIndices[renderableTedgeCount] = tedgeIndex;
      renderableTedgeCount += 1;
    }
    if (candidateArrivalSeconds < earliestArrivalSeconds[toStopIndex]) {
      earliestArrivalSeconds[toStopIndex] = candidateArrivalSeconds;
      improvedByTransit[toStopIndex] = 1;
      // Immediately, not in a later sweep: connections are scanned in
      // departure order, so a stop made reachable now can only ever be
      // boarded by a connection this loop has not reached yet. That is what
      // keeps one forward pass correct.
      relaxTransfersFromStop(toStopIndex, candidateArrivalSeconds);
    }
  }

  // Elapsed time at the stop itself (no platform->node attach walk, unlike
  // the pass-2 seeds below): this is what rendering colours each end of a
  // connection by, and it is defined for every reachable stop rather than
  // only the transit-improved ones.
  const stopElapsedSeconds = new Float64Array(nStops).fill(Number.POSITIVE_INFINITY);
  for (let stopIndex = 0; stopIndex < nStops; stopIndex += 1) {
    const arrivalSeconds = earliestArrivalSeconds[stopIndex];
    if (Number.isFinite(arrivalSeconds)) {
      stopElapsedSeconds[stopIndex] = Math.max(0, arrivalSeconds - departureSecondsOfDay);
    }
  }

  const seedNodeIndicesList = [];
  const seedStartDistSecondsList = [];
  for (let stopIndex = 0; stopIndex < nStops; stopIndex += 1) {
    if (!improvedByTransit[stopIndex]) {
      continue;
    }
    const elapsedSeconds =
      earliestArrivalSeconds[stopIndex] - departureSecondsOfDay + walkAttachCostSeconds[stopIndex];
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      continue;
    }
    seedNodeIndicesList.push(graph.stopNearestNodeIndex[stopIndex]);
    seedStartDistSecondsList.push(elapsedSeconds);
  }

  return {
    seedNodeIndices: Uint32Array.from(seedNodeIndicesList),
    seedStartDistSeconds: Float32Array.from(seedStartDistSecondsList),
    stopElapsedSeconds,
    renderableTedgeIndices: renderableTedgeIndices.subarray(0, renderableTedgeCount),
  };
}

export function buildTransitConnectionEdgeVertexData(
  graph,
  nodePixels,
  renderableTedgeIndices,
  stopElapsedSeconds,
) {
  validateGraphForRouting(graph);
  validateNodePixels(nodePixels);
  if (!(renderableTedgeIndices instanceof Uint32Array)) {
    throw new Error('renderableTedgeIndices must be a Uint32Array');
  }
  if (!ArrayBuffer.isView(stopElapsedSeconds)) {
    throw new Error('stopElapsedSeconds must be a typed array');
  }

  const candidateCount = renderableTedgeIndices.length;
  const packedVertexData = new Float32Array(candidateCount * 6);
  let writeEdgeIndex = 0;
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
    const tedgeIndex = renderableTedgeIndices[candidateIndex];
    const fromStopIndex = graph.tedgeFromStop[tedgeIndex];
    const toStopIndex = graph.tedgeToStop[tedgeIndex];
    const fromSeconds = stopElapsedSeconds[fromStopIndex];
    const toSeconds = stopElapsedSeconds[toStopIndex];
    if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds)) {
      continue;
    }

    const fromNodeIndex = graph.stopNearestNodeIndex[fromStopIndex];
    const toNodeIndex = graph.stopNearestNodeIndex[toStopIndex];
    const base = writeEdgeIndex * 6;
    packedVertexData[base] = nodePixels.nodePixelX[fromNodeIndex];
    packedVertexData[base + 1] = nodePixels.nodePixelY[fromNodeIndex];
    packedVertexData[base + 2] = fromSeconds;
    packedVertexData[base + 3] = nodePixels.nodePixelX[toNodeIndex];
    packedVertexData[base + 4] = nodePixels.nodePixelY[toNodeIndex];
    packedVertexData[base + 5] = toSeconds;
    writeEdgeIndex += 1;
  }

  return packedVertexData.subarray(0, writeEdgeIndex * 6);
}
