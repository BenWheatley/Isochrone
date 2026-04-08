import {
  COLOUR_CYCLE_QUERY_PARAM,
  LANGUAGE_QUERY_PARAM,
  LAST_CLICKED_NODE_QUERY_PARAM,
  MODE_SELECTION_QUERY_PARAM,
  SELECTED_REGION_QUERY_PARAM,
} from '../config/constants.js';
import { validateGraphForRouting } from './graph-validation.js';

const CANONICAL_MODE_VALUES = ['walk', 'bike', 'car'];

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

export function parseLocationIdFromLocationSearch(locationSearch) {
  if (typeof locationSearch !== 'string' || locationSearch.length === 0) {
    return null;
  }

  const params = new URLSearchParams(locationSearch);
  const rawLocationId = params.get(SELECTED_REGION_QUERY_PARAM);
  if (rawLocationId === null) {
    return null;
  }

  const locationId = rawLocationId.trim();
  return locationId.length > 0 ? locationId : null;
}

export function parseLanguageFromLocationSearch(locationSearch) {
  if (typeof locationSearch !== 'string' || locationSearch.length === 0) {
    return null;
  }

  const params = new URLSearchParams(locationSearch);
  const rawLanguage = params.get(LANGUAGE_QUERY_PARAM);
  if (rawLanguage === null) {
    return null;
  }

  const language = rawLanguage.trim();
  return language.length > 0 ? language : null;
}

export function persistLocationIdToLocation(locationId, options = {}) {
  if (typeof locationId !== 'string' || locationId.trim().length === 0) {
    throw new Error('locationId must be a non-empty string');
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
  const normalizedLocationId = locationId.trim();
  if (nextUrl.searchParams.get(SELECTED_REGION_QUERY_PARAM) === normalizedLocationId) {
    return false;
  }

  nextUrl.searchParams.set(SELECTED_REGION_QUERY_PARAM, normalizedLocationId);
  historyObject.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  return true;
}

export function parseModeValuesFromLocationSearch(locationSearch) {
  if (typeof locationSearch !== 'string' || locationSearch.length === 0) {
    return null;
  }

  const params = new URLSearchParams(locationSearch);
  const rawModes = params.get(MODE_SELECTION_QUERY_PARAM);
  if (rawModes === null || rawModes.length === 0) {
    return null;
  }

  const selected = new Set();
  for (const rawModeValue of rawModes.split(',')) {
    const modeValue = rawModeValue.trim();
    if (CANONICAL_MODE_VALUES.includes(modeValue)) {
      selected.add(modeValue);
    }
  }

  if (selected.size === 0) {
    return null;
  }
  return CANONICAL_MODE_VALUES.filter((modeValue) => selected.has(modeValue));
}

export function persistModeValuesToLocation(modeValues, options = {}) {
  if (!Array.isArray(modeValues)) {
    throw new Error('modeValues must be an array');
  }
  const selected = new Set();
  for (const modeValue of modeValues) {
    if (typeof modeValue !== 'string' || !CANONICAL_MODE_VALUES.includes(modeValue)) {
      throw new Error(`invalid mode value: ${modeValue}`);
    }
    selected.add(modeValue);
  }
  if (selected.size === 0) {
    throw new Error('modeValues must include at least one mode');
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
  const canonicalValue = CANONICAL_MODE_VALUES.filter((modeValue) => selected.has(modeValue)).join(',');
  if (nextUrl.searchParams.get(MODE_SELECTION_QUERY_PARAM) === canonicalValue) {
    return false;
  }

  nextUrl.searchParams.set(MODE_SELECTION_QUERY_PARAM, canonicalValue);
  historyObject.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  return true;
}

export function parseColourCycleMinutesFromLocationSearch(locationSearch, options = {}) {
  const minMinutes = options.minMinutes ?? 5;
  const maxMinutes = options.maxMinutes ?? 24 * 60;
  if (!Number.isInteger(minMinutes) || !Number.isInteger(maxMinutes) || minMinutes > maxMinutes) {
    throw new Error('minMinutes/maxMinutes must be valid integer bounds');
  }
  if (typeof locationSearch !== 'string' || locationSearch.length === 0) {
    return null;
  }

  const params = new URLSearchParams(locationSearch);
  const rawCycle = params.get(COLOUR_CYCLE_QUERY_PARAM);
  if (rawCycle === null) {
    return null;
  }
  if (!/^\d+$/.test(rawCycle)) {
    return null;
  }

  const parsedMinutes = Number.parseInt(rawCycle, 10);
  if (!Number.isFinite(parsedMinutes)) {
    return null;
  }
  return clampInt(parsedMinutes, minMinutes, maxMinutes);
}

export function persistColourCycleMinutesToLocation(cycleMinutes, options = {}) {
  if (!Number.isInteger(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive integer');
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
  const cycleText = String(cycleMinutes);
  if (nextUrl.searchParams.get(COLOUR_CYCLE_QUERY_PARAM) === cycleText) {
    return false;
  }

  nextUrl.searchParams.set(COLOUR_CYCLE_QUERY_PARAM, cycleText);
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
