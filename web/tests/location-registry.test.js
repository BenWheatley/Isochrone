import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_BOUNDARY_FILE_NAME,
  DEFAULT_GRAPH_FILE_NAME,
  DEFAULT_LOCATION_ID,
  DEFAULT_LOCATION_NAME,
} from '../src/config/constants.js';
import {
  buildLocationAssetUrls,
  createDefaultLocationRegistry,
  findLocationById,
  loadLocationRegistry,
  parseLocationRegistry,
  resolveLocationEntry,
} from '../src/core/location-registry.js';

function createRegistryFixture() {
  return {
    locations: [
      {
        id: ' paris ',
        name: ' Paris ',
        localizedNames: {
          'fr-FR': ' Paris ',
        },
        graphFileName: 'paris-routing.graph.bin.gz',
        boundaryFileName: 'paris-boundaries.canvas.json',
      },
      {
        id: 'berlin',
        name: 'Berlin',
        graphFileName: 'berlin-routing.graph.bin.gz',
        boundaryFileName: 'berlin-boundaries.canvas.json',
      },
    ],
  };
}

test('parseLocationRegistry normalizes entries and preserves optional localized names', () => {
  const registry = parseLocationRegistry(createRegistryFixture());

  assert.equal(registry.locations.length, 2);

  const paris = findLocationById(registry, 'paris');
  assert.ok(paris);
  assert.equal(paris.id, 'paris');
  assert.equal(paris.name, 'Paris');
  assert.equal(paris.graphFileName, 'paris-routing.graph.bin.gz');
  assert.equal(paris.boundaryFileName, 'paris-boundaries.canvas.json');
  assert.deepEqual(paris.localizedNames, { 'fr-fr': 'Paris' });

  const berlin = findLocationById(registry, 'berlin');
  assert.ok(berlin);
  assert.equal(berlin.localizedNames, undefined);
});

test('parseLocationRegistry rejects malformed entries instead of accepting partial data', () => {
  assert.throws(
    () =>
      parseLocationRegistry({
        locations: [
          {
            id: 'berlin',
            name: 'Berlin',
            localizedNames: [],
            graphFileName: 'graph.bin.gz',
            boundaryFileName: 'boundaries.json',
          },
        ],
      }),
    /localizedNames must be an object/i,
  );
  assert.throws(
    () =>
      parseLocationRegistry({
        locations: [
          {
            id: 'berlin',
            name: 'Berlin',
            graphFileName: 'graph.bin.gz',
            boundaryFileName: 'boundaries.json',
          },
          {
            id: 'berlin',
            name: 'Duplicate',
            graphFileName: 'other-graph.bin.gz',
            boundaryFileName: 'other-boundaries.json',
          },
        ],
      }),
    /duplicate location id/i,
  );
});

test('resolveLocationEntry returns direct matches and stable fallbacks', () => {
  const registry = parseLocationRegistry(createRegistryFixture());

  assert.equal(resolveLocationEntry(registry, 'berlin')?.id, 'berlin');
  assert.equal(resolveLocationEntry(registry, 'madrid', 'paris')?.id, 'paris');
  assert.equal(resolveLocationEntry(registry, '', 'berlin')?.id, 'berlin');
});

test('createDefaultLocationRegistry exposes the configured default location contract', () => {
  const registry = createDefaultLocationRegistry();

  assert.equal(registry.locations.length, 1);
  const defaultEntry = registry.locations[0];
  assert.equal(defaultEntry.id, DEFAULT_LOCATION_ID);
  assert.equal(defaultEntry.name, DEFAULT_LOCATION_NAME);
  assert.equal(defaultEntry.graphFileName, DEFAULT_GRAPH_FILE_NAME);
  assert.equal(defaultEntry.boundaryFileName, DEFAULT_BOUNDARY_FILE_NAME);
});

test('committed locations.json stays parseable and includes the configured default location', async () => {
  const registryJson = await readFile(new URL('../src/data/locations.json', import.meta.url), 'utf8');
  const parsed = parseLocationRegistry(JSON.parse(registryJson));

  assert.ok(parsed.locations.length >= 1);
  assert.ok(parsed.locations.every((entry) => entry.id.length > 0));
  assert.ok(parsed.locations.every((entry) => entry.name.length > 0));
  assert.ok(parsed.locations.every((entry) => entry.graphFileName.endsWith('.gz')));
  assert.ok(parsed.locations.every((entry) => entry.boundaryFileName.endsWith('.json')));

  for (const entry of parsed.locations) {
    if (entry.localizedNames === undefined) {
      continue;
    }
    assert.ok(typeof entry.localizedNames === 'object');
    assert.ok(Object.keys(entry.localizedNames).length > 0);
  }

  const defaultEntry = findLocationById(parsed, DEFAULT_LOCATION_ID);
  assert.ok(defaultEntry);
  assert.equal(defaultEntry.name, DEFAULT_LOCATION_NAME);
  assert.equal(defaultEntry.graphFileName, DEFAULT_GRAPH_FILE_NAME);
  assert.equal(defaultEntry.boundaryFileName, DEFAULT_BOUNDARY_FILE_NAME);
});

test('buildLocationAssetUrls resolves graph and boundary fetch URLs from file names', () => {
  assert.deepEqual(
    buildLocationAssetUrls({
      id: 'berlin',
      name: 'Berlin',
      graphFileName: 'graph-walk.bin.gz',
      boundaryFileName: 'berlin-district-boundaries-canvas.json',
    }),
    {
      graphUrl: '../data_pipeline/output/graph-walk.bin.gz',
      boundaryUrl: '../data_pipeline/output/berlin-district-boundaries-canvas.json',
    },
  );
});

test('loadLocationRegistry fetches the manifest and delegates validation to parseLocationRegistry', async () => {
  const requestedUrls = [];
  const registry = await loadLocationRegistry({
    baseUrl: new URL('../src/core/location-registry.js', import.meta.url),
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        async json() {
          return createRegistryFixture();
        },
      };
    },
  });

  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /\/data\/locations\.json$/);
  assert.equal(findLocationById(registry, 'paris')?.name, 'Paris');
  assert.equal(findLocationById(registry, 'paris')?.localizedNames?.['fr-fr'], 'Paris');
});

test('loadLocationRegistry falls back to the default registry when fetch fails', async () => {
  const registry = await loadLocationRegistry({
    fetchImpl: async () => {
      throw new Error('network unavailable');
    },
  });

  assert.deepEqual(registry, createDefaultLocationRegistry());
});
