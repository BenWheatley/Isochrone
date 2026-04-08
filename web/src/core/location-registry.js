import {
  DEFAULT_BOUNDARY_BASEMAP_URL,
  DEFAULT_BOUNDARY_FILE_NAME,
  DEFAULT_GRAPH_BINARY_URL,
  DEFAULT_GRAPH_FILE_NAME,
  DEFAULT_LOCATION_ID,
  DEFAULT_LOCATION_NAME,
  DEFAULT_LOCATION_REGISTRY_URL,
} from '../config/constants.js';

function normalizeNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function compareLocationEntriesAlphabetically(left, right) {
  const nameOrder = left.name.localeCompare(right.name, undefined, {
    sensitivity: 'base',
    numeric: true,
  });
  if (nameOrder !== 0) {
    return nameOrder;
  }
  return left.id.localeCompare(right.id, undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

export function createDefaultLocationRegistry() {
  return {
    locations: [
      {
        id: DEFAULT_LOCATION_ID,
        name: DEFAULT_LOCATION_NAME,
        graphFileName: DEFAULT_GRAPH_FILE_NAME,
        boundaryFileName: DEFAULT_BOUNDARY_FILE_NAME,
      },
    ],
  };
}

export function parseLocationRegistry(payload) {
  const locations = payload?.locations;
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('location registry must contain a non-empty locations array');
  }

  const seenLocationIds = new Set();
  const normalizedLocations = locations.map((entry, index) => {
    const id = normalizeNonEmptyString(entry?.id, `locations[${index}].id`);
    const name = normalizeNonEmptyString(entry?.name, `locations[${index}].name`);
    const graphFileName = normalizeNonEmptyString(
      entry?.graphFileName,
      `locations[${index}].graphFileName`,
    );
    const boundaryFileName = normalizeNonEmptyString(
      entry?.boundaryFileName,
      `locations[${index}].boundaryFileName`,
    );
    if (seenLocationIds.has(id)) {
      throw new Error(`duplicate location id: ${id}`);
    }
    seenLocationIds.add(id);
    return { id, name, graphFileName, boundaryFileName };
  });

  normalizedLocations.sort(compareLocationEntriesAlphabetically);
  return {
    locations: normalizedLocations,
  };
}

export function findLocationById(registry, locationId) {
  if (!registry || typeof registry !== 'object') {
    return null;
  }
  const normalizedLocationId =
    typeof locationId === 'string' && locationId.trim().length > 0
      ? locationId.trim()
      : '';
  if (normalizedLocationId.length === 0) {
    return null;
  }
  return registry.locations?.find((entry) => entry.id === normalizedLocationId) ?? null;
}

export function resolveLocationEntry(registry, locationId, fallbackLocationId = DEFAULT_LOCATION_ID) {
  const directMatch = findLocationById(registry, locationId);
  if (directMatch) {
    return directMatch;
  }
  const fallbackMatch = findLocationById(registry, fallbackLocationId);
  if (fallbackMatch) {
    return fallbackMatch;
  }
  return registry?.locations?.[0] ?? null;
}

export function buildLocationAssetUrls(locationEntry) {
  if (!locationEntry || typeof locationEntry !== 'object') {
    return {
      graphUrl: DEFAULT_GRAPH_BINARY_URL,
      boundaryUrl: DEFAULT_BOUNDARY_BASEMAP_URL,
    };
  }
  return {
    graphUrl: `../data_pipeline/output/${locationEntry.graphFileName ?? DEFAULT_GRAPH_FILE_NAME}`,
    boundaryUrl:
      `../data_pipeline/output/${locationEntry.boundaryFileName ?? DEFAULT_BOUNDARY_FILE_NAME}`,
  };
}

export async function loadLocationRegistry(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;
  const baseUrl = options.baseUrl ?? import.meta.url;
  const registryUrl = options.registryUrl ?? DEFAULT_LOCATION_REGISTRY_URL;
  const fallbackRegistry = createDefaultLocationRegistry();

  if (typeof fetchImpl !== 'function') {
    return fallbackRegistry;
  }

  try {
    const response = await fetchImpl(new URL(registryUrl, baseUrl));
    if (!response?.ok) {
      return fallbackRegistry;
    }
    const parsed = await response.json();
    return parseLocationRegistry(parsed);
  } catch (_error) {
    return fallbackRegistry;
  }
}
