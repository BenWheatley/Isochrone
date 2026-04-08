import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLocationRegistry } from '../src/core/location-registry.js';

test('parseLocationRegistry sorts locations alphabetically at runtime', () => {
  const registry = parseLocationRegistry({
    locations: [
      {
        id: 'rome',
        name: 'Rome',
        graphFileName: 'rome-graph.bin.gz',
        boundaryFileName: 'rome-boundaries.json',
      },
      {
        id: 'berlin',
        name: 'Berlin',
        graphFileName: 'berlin-graph.bin.gz',
        boundaryFileName: 'berlin-boundaries.json',
      },
      {
        id: 'luxembourg-country',
        name: 'Luxembourg',
        graphFileName: 'luxembourg-graph.bin.gz',
        boundaryFileName: 'luxembourg-boundaries.json',
      },
      {
        id: 'london',
        name: 'london',
        graphFileName: 'london-graph.bin.gz',
        boundaryFileName: 'london-boundaries.json',
      },
    ],
  });

  assert.deepEqual(
    registry.locations.map((entry) => entry.id),
    ['berlin', 'london', 'luxembourg-country', 'rome'],
  );
});
