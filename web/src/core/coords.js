import { LAST_CLICKED_NODE_QUERY_PARAM } from '../config/constants.js';
import { validateGraphForRouting } from './graph-validation.js';

export function mapCanvasPixelToGraphMeters(graph, xPx, yPx) {
  validateGraphForRouting(graph);

  if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) {
    throw new Error('xPx and yPx must be finite numbers');
  }

  const easting = graph.header.originEasting + xPx * graph.header.pixelSizeM;
  const northing =
    graph.header.originNorthing + (graph.header.gridHeightPx - 1 - yPx) * graph.header.pixelSizeM;

  return { easting, northing };
}

export function mapClientPointToCanvasPixel(canvas, clientX, clientY) {
  if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
    throw new Error('canvas must provide getBoundingClientRect()');
  }
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    throw new Error('clientX and clientY must be finite numbers');
  }
  if (!Number.isInteger(canvas.width) || canvas.width <= 0) {
    throw new Error('canvas.width must be a positive integer');
  }
  if (!Number.isInteger(canvas.height) || canvas.height <= 0) {
    throw new Error('canvas.height must be a positive integer');
  }

  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    throw new Error('canvas bounding box must have positive width and height');
  }

  const normalizedX = (clientX - rect.left) / rect.width;
  const normalizedY = (clientY - rect.top) / rect.height;
  const xPx = clampInt(Math.floor(normalizedX * canvas.width), 0, canvas.width - 1);
  const yPx = clampInt(Math.floor(normalizedY * canvas.height), 0, canvas.height - 1);

  return { xPx, yPx };
}

export function parseNodeIndexFromLocationSearch(locationSearch, maxNodeCount) {
  if (!Number.isInteger(maxNodeCount) || maxNodeCount <= 0) {
    throw new Error('maxNodeCount must be a positive integer');
  }
  if (typeof locationSearch !== 'string' || locationSearch.length === 0) {
    return null;
  }

  const params = new URLSearchParams(locationSearch);
  const rawNodeIndex = params.get(LAST_CLICKED_NODE_QUERY_PARAM);
  if (rawNodeIndex === null) {
    return null;
  }
  if (!/^\d+$/.test(rawNodeIndex)) {
    return null;
  }

  const nodeIndex = Number.parseInt(rawNodeIndex, 10);
  if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= maxNodeCount) {
    return null;
  }
  return nodeIndex;
}

export function persistNodeIndexToLocation(nodeIndex, options = {}) {
  if (!Number.isInteger(nodeIndex) || nodeIndex < 0) {
    throw new Error('nodeIndex must be a non-negative integer');
  }

  const locationObject = options.locationObject ?? globalThis.location ?? null;
  const historyObject = options.historyObject ?? globalThis.history ?? null;
  if (!locationObject || typeof locationObject.href !== 'string') {
    return false;
  }
  if (!historyObject || typeof historyObject.replaceState !== 'function') {
    return false;
  }

  const nextUrl = new URL(locationObject.href);
  const nodeText = String(nodeIndex);
  if (nextUrl.searchParams.get(LAST_CLICKED_NODE_QUERY_PARAM) === nodeText) {
    return false;
  }

  nextUrl.searchParams.set(LAST_CLICKED_NODE_QUERY_PARAM, nodeText);
  historyObject.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  return true;
}

function clampInt(value, minValue, maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}
