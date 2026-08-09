import { clampInt } from '../core/math.js';
import {
  EDGE_INTERPOLATION_SLACK_SECONDS,
} from '../config/constants.js';
import { DEFAULT_COLOUR_CYCLE_MINUTES, normalizeIsochroneTheme, timeToColour } from './colour.js';
import {
  getEdgeTraversalCostSeconds,
} from '../core/routing.js';
import { validateGraphForRouting } from '../core/graph-validation.js';
import {
  validateDistSeconds,
  validateEdgeTraversalCostSecondsLookup,
  validateNodePixels,
  validateSettledBatch,
} from '../core/routing-validation.js';
import {
  setPixel,
  setTravelTimePixelMin,
  validatePixelGrid,
  validateTravelTimeGrid,
} from './pixel-grid.js';

// Rasterising the travel-time field along graph edges.
//
// Every routine here walks the same structure - settled nodes, then their
// mode-eligible outgoing edges, interpolating time along each edge - and
// differs only in where the result goes: an RGBA pixel grid (2D canvas), a
// travel-time seconds grid (GPU colours from seconds), or a vertex buffer
// (GPU draws the edges directly).

// Defaults and guards shared by every batch/all-reachable entry point below.
// Callers validate their own sink (pixel grid, travel-time grid) and the
// settled batch first, so validation order is unchanged; only this option
// policy is centralised, so a default can't drift between the six variants.
function normalizeEdgeInterpolationOptions(graph, allowedModeMask, options, {
  validateStepStride = true,
} = {}) {
  if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
    throw new Error('allowedModeMask must be a positive 8-bit integer');
  }

  const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
  const stepStride = options.stepStride ?? 1;
  const edgeTraversalCostSeconds = validateEdgeTraversalCostSecondsLookup(
    options.edgeTraversalCostSeconds,
    graph.header.nEdges,
  );
  if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
    throw new Error('edgeSlackSeconds must be a non-negative finite number');
  }
  if (validateStepStride && (!Number.isInteger(stepStride) || stepStride <= 0)) {
    throw new Error('stepStride must be a positive integer');
  }

  return {
    alpha: options.alpha ?? 255,
    colourCycleMinutes: options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES,
    colourTheme: normalizeIsochroneTheme(options.colourTheme, 'dark'),
    edgeSlackSeconds,
    stepStride,
    edgeTraversalCostSeconds,
  };
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
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
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
    const [r, g, b] = timeToColour(seconds, {
      cycleMinutes: colourCycleMinutes,
      theme: colourTheme,
    });
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
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
  let paintedCount = 0;

  for (let nodeIndex = 0; nodeIndex < nodePixels.nodePixelX.length; nodeIndex += 1) {
    if (distSeconds[nodeIndex] < Infinity) {
      const [r, g, b] = timeToColour(distSeconds[nodeIndex], {
        cycleMinutes: colourCycleMinutes,
        theme: colourTheme,
      });
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

export function forEachEligibleOutgoingEdgeFromSourceNode(
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  edgeSlackSeconds,
  edgeTraversalCostSeconds,
  onEligibleEdge,
) {
  if (typeof onEligibleEdge !== 'function') {
    throw new Error('onEligibleEdge must be a function');
  }
  if (sourceNodeIndex < 0 || sourceNodeIndex >= graph.header.nNodes) {
    return 0;
  }

  const startSeconds = distSeconds[sourceNodeIndex];
  if (!Number.isFinite(startSeconds)) {
    return 0;
  }

  let totalContribution = 0;
  const x0 = nodePixels.nodePixelX[sourceNodeIndex];
  const y0 = nodePixels.nodePixelY[sourceNodeIndex];
  const firstEdgeIndex = graph.nodeU32[sourceNodeIndex * 4 + 2];
  const edgeCount = graph.nodeU16[sourceNodeIndex * 8 + 6];
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
    const callbackContribution = onEligibleEdge(
      x0,
      y0,
      startSeconds,
      x1,
      y1,
      expectedTargetSeconds,
      targetNodeIndex,
      edgeIndex,
    );
    if (Number.isFinite(callbackContribution)) {
      totalContribution += callbackContribution;
    }
  }

  return totalContribution;
}

export function paintEligibleOutgoingEdgesFromSourceNode(
  pixelGrid,
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  alpha,
  colourCycleMinutes,
  colourTheme,
  edgeSlackSeconds,
  stepStride,
  edgeTraversalCostSeconds,
) {
  return forEachEligibleOutgoingEdgeFromSourceNode(
    graph,
    nodePixels,
    distSeconds,
    sourceNodeIndex,
    allowedModeMask,
    edgeSlackSeconds,
    edgeTraversalCostSeconds,
    (x0, y0, startSeconds, x1, y1, expectedTargetSeconds) =>
      paintInterpolatedEdgeToGrid(
        pixelGrid,
        x0,
        y0,
        startSeconds,
        x1,
        y1,
        expectedTargetSeconds,
        { alpha, colourCycleMinutes, colourTheme, stepStride },
      ),
  );
}

export function paintEligibleOutgoingEdgesFromSourceNodeToTravelTimeGrid(
  travelTimeGrid,
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  edgeSlackSeconds,
  stepStride,
  edgeTraversalCostSeconds,
) {
  return forEachEligibleOutgoingEdgeFromSourceNode(
    graph,
    nodePixels,
    distSeconds,
    sourceNodeIndex,
    allowedModeMask,
    edgeSlackSeconds,
    edgeTraversalCostSeconds,
    (x0, y0, startSeconds, x1, y1, expectedTargetSeconds) =>
      paintInterpolatedEdgeTravelTimesToGrid(
        travelTimeGrid,
        x0,
        y0,
        startSeconds,
        x1,
        y1,
        expectedTargetSeconds,
        { stepStride },
      ),
  );
}

export function paintSettledBatchToGrid(pixelGrid, nodePixels, distSeconds, settledBatch, options = {}) {
  validatePixelGrid(pixelGrid);
  validateNodePixels(nodePixels);
  validateDistSeconds(distSeconds, nodePixels.nodePixelX.length);
  validateSettledBatch(settledBatch);

  const alpha = options.alpha ?? 255;
  const colourCycleMinutes = options.colourCycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  const colourTheme = normalizeIsochroneTheme(options.colourTheme, 'dark');
  let paintedCount = 0;

  for (const nodeIndex of settledBatch) {
    if (nodeIndex < 0 || nodeIndex >= nodePixels.nodePixelX.length) {
      continue;
    }
    if (!(distSeconds[nodeIndex] < Infinity)) {
      continue;
    }

    const [r, g, b] = timeToColour(distSeconds[nodeIndex], {
      cycleMinutes: colourCycleMinutes,
      theme: colourTheme,
    });
    const xPx = nodePixels.nodePixelX[nodeIndex];
    const yPx = nodePixels.nodePixelY[nodeIndex];
    if (setPixel(pixelGrid, xPx, yPx, r, g, b, alpha)) {
      paintedCount += 1;
    }
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
  const {
    alpha,
    colourCycleMinutes,
    colourTheme,
    edgeSlackSeconds,
    stepStride,
    edgeTraversalCostSeconds,
  } = normalizeEdgeInterpolationOptions(graph, allowedModeMask, options);

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
      colourTheme,
      edgeSlackSeconds,
      stepStride,
      edgeTraversalCostSeconds,
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
  const {
    edgeSlackSeconds,
    stepStride,
    edgeTraversalCostSeconds,
  } = normalizeEdgeInterpolationOptions(graph, allowedModeMask, options);

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
      edgeTraversalCostSeconds,
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
  const {
    alpha,
    colourCycleMinutes,
    colourTheme,
    edgeSlackSeconds,
    stepStride,
    edgeTraversalCostSeconds,
  } = normalizeEdgeInterpolationOptions(graph, allowedModeMask, options);

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
      colourTheme,
      edgeSlackSeconds,
      stepStride,
      edgeTraversalCostSeconds,
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
  const {
    edgeSlackSeconds,
    stepStride,
    edgeTraversalCostSeconds,
  } = normalizeEdgeInterpolationOptions(graph, allowedModeMask, options);

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
      edgeTraversalCostSeconds,
    );
  }
  return paintedCount;
}

export function createEdgeVertexBufferBuilder(initialCapacityFloats = 32768) {
  if (!Number.isInteger(initialCapacityFloats) || initialCapacityFloats <= 0) {
    throw new Error('initialCapacityFloats must be a positive integer');
  }
  return {
    data: new Float32Array(initialCapacityFloats),
    length: 0,
  };
}

export function validateEdgeVertexBufferBuilder(builder) {
  if (!builder || typeof builder !== 'object') {
    throw new Error('builder must be an object');
  }
  if (!(builder.data instanceof Float32Array)) {
    throw new Error('builder.data must be a Float32Array');
  }
  if (!Number.isInteger(builder.length) || builder.length < 0 || builder.length > builder.data.length) {
    throw new Error('builder.length must be a valid index within builder.data');
  }
}

export function resetEdgeVertexBufferBuilder(builder) {
  validateEdgeVertexBufferBuilder(builder);
  builder.length = 0;
  return builder;
}

export function ensureEdgeVertexBufferBuilderCapacity(builder, requiredLength) {
  validateEdgeVertexBufferBuilder(builder);
  if (builder.data.length >= requiredLength) {
    return;
  }
  let nextLength = builder.data.length;
  while (nextLength < requiredLength) {
    nextLength *= 2;
  }
  const nextData = new Float32Array(nextLength);
  nextData.set(builder.data.subarray(0, builder.length));
  builder.data = nextData;
}

export function appendEdgeVertexSegment(builder, x0, y0, t0, x1, y1, t1) {
  ensureEdgeVertexBufferBuilderCapacity(builder, builder.length + 6);
  const offset = builder.length;
  builder.data[offset] = x0;
  builder.data[offset + 1] = y0;
  builder.data[offset + 2] = t0;
  builder.data[offset + 3] = x1;
  builder.data[offset + 4] = y1;
  builder.data[offset + 5] = t1;
  builder.length += 6;
}

export function finalizeEdgeVertexBufferBuilder(builder) {
  validateEdgeVertexBufferBuilder(builder);
  return builder.data.subarray(0, builder.length);
}

export function collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
  graph,
  nodePixels,
  distSeconds,
  sourceNodeIndex,
  allowedModeMask,
  edgeSlackSeconds,
  edgeVertexBuilder,
  edgeTraversalCostSeconds,
) {
  return forEachEligibleOutgoingEdgeFromSourceNode(
    graph,
    nodePixels,
    distSeconds,
    sourceNodeIndex,
    allowedModeMask,
    edgeSlackSeconds,
    edgeTraversalCostSeconds,
    (x0, y0, startSeconds, x1, y1, expectedTargetSeconds) => {
      appendEdgeVertexSegment(
        edgeVertexBuilder,
        x0,
        y0,
        startSeconds,
        x1,
        y1,
        expectedTargetSeconds,
      );
      return 1;
    },
  );
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
  const {
    edgeSlackSeconds,
    edgeTraversalCostSeconds,
  } = normalizeEdgeInterpolationOptions(graph, allowedModeMask, options, {
    validateStepStride: false,
  });

  const builder = resetEdgeVertexBufferBuilder(options.builder ?? createEdgeVertexBufferBuilder());
  for (const sourceNodeIndex of settledBatch) {
    collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      edgeSlackSeconds,
      builder,
      edgeTraversalCostSeconds,
    );
  }

  return finalizeEdgeVertexBufferBuilder(builder);
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
  const {
    edgeSlackSeconds,
    edgeTraversalCostSeconds,
  } = normalizeEdgeInterpolationOptions(graph, allowedModeMask, options, {
    validateStepStride: false,
  });

  const builder = resetEdgeVertexBufferBuilder(options.builder ?? createEdgeVertexBufferBuilder());
  for (let sourceNodeIndex = 0; sourceNodeIndex < graph.header.nNodes; sourceNodeIndex += 1) {
    collectEligibleOutgoingTravelTimeEdgeVerticesFromSourceNode(
      graph,
      nodePixels,
      distSeconds,
      sourceNodeIndex,
      allowedModeMask,
      edgeSlackSeconds,
      builder,
      edgeTraversalCostSeconds,
    );
  }

  return finalizeEdgeVertexBufferBuilder(builder);
}
