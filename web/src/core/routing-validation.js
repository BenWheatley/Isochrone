// Argument guards shared by the routing and painting paths. Separate from
// graph-validation.js, which validates the graph binary's own structure.

export function validateEdgeTraversalCostSecondsLookup(edgeTraversalCostSeconds, expectedLength) {
  if (edgeTraversalCostSeconds === null || edgeTraversalCostSeconds === undefined) {
    return null;
  }
  if (!(edgeTraversalCostSeconds instanceof Float32Array)) {
    throw new Error('edgeTraversalCostSeconds must be a Float32Array when provided');
  }
  if (edgeTraversalCostSeconds.length < expectedLength) {
    throw new Error('edgeTraversalCostSeconds is too short for edge records');
  }
  return edgeTraversalCostSeconds;
}

export function validateNodePixels(nodePixels) {
  if (!nodePixels || typeof nodePixels !== 'object') {
    throw new Error('nodePixels must be an object');
  }
  if (!(nodePixels.nodePixelX instanceof Uint16Array)) {
    throw new Error('nodePixels.nodePixelX must be a Uint16Array');
  }
  if (!(nodePixels.nodePixelY instanceof Uint16Array)) {
    throw new Error('nodePixels.nodePixelY must be a Uint16Array');
  }
  if (nodePixels.nodePixelX.length !== nodePixels.nodePixelY.length) {
    throw new Error('node pixel arrays must have equal lengths');
  }
}

export function validateDistSeconds(distSeconds, expectedLength) {
  if (!distSeconds || typeof distSeconds.length !== 'number') {
    throw new Error('distSeconds must be an array-like sequence');
  }
  if (distSeconds.length < expectedLength) {
    throw new Error('distSeconds is shorter than node pixel arrays');
  }
}

export function validateSettledBatch(settledBatch) {
  if (!settledBatch || typeof settledBatch[Symbol.iterator] !== 'function') {
    throw new Error('settledBatch must be iterable');
  }
}

export function validateSearchState(searchState) {
  if (!searchState || typeof searchState !== 'object') {
    throw new Error('searchState must be an object');
  }
  if (typeof searchState.expandOne !== 'function') {
    throw new Error('searchState.expandOne must be a function');
  }
  if (typeof searchState.isDone !== 'function' && typeof searchState.done !== 'boolean') {
    throw new Error('searchState must expose isDone() or done boolean');
  }
}
