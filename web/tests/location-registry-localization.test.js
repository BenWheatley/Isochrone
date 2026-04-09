import assert from 'node:assert/strict';
import test from 'node:test';

import {
  localizeLocationRegistry,
  parseLocationRegistry,
  resolveLocationDisplayName,
} from '../src/core/location-registry.js';

test('parseLocationRegistry accepts optional localizedNames payloads', () => {
  const registry = parseLocationRegistry({
    locations: [
      {
        id: 'cologne',
        name: 'Cologne',
        localizedNames: {
          de: 'Köln',
          fr: 'Cologne',
        },
        graphFileName: 'cologne-graph.bin.gz',
        boundaryFileName: 'cologne-district-boundaries-canvas.json',
      },
    ],
  });

  assert.deepEqual(registry.locations[0], {
    id: 'cologne',
    name: 'Cologne',
    localizedNames: {
      de: 'Köln',
      fr: 'Cologne',
    },
    graphFileName: 'cologne-graph.bin.gz',
    boundaryFileName: 'cologne-district-boundaries-canvas.json',
  });
});

test('resolveLocationDisplayName prefers localized names and falls back to canonical name', () => {
  const location = {
    id: 'cologne',
    name: 'Cologne',
    localizedNames: {
      de: 'Köln',
      fr: 'Cologne',
    },
    graphFileName: 'cologne-graph.bin.gz',
    boundaryFileName: 'cologne-district-boundaries-canvas.json',
  };

  assert.equal(resolveLocationDisplayName(location, 'de'), 'Köln');
  assert.equal(resolveLocationDisplayName(location, 'de-DE'), 'Köln');
  assert.equal(resolveLocationDisplayName(location, 'fr'), 'Cologne');
  assert.equal(resolveLocationDisplayName(location, 'en'), 'Cologne');
});

test('localizeLocationRegistry sorts by localized display name for the active locale', () => {
  const registry = parseLocationRegistry({
    locations: [
      {
        id: 'cologne',
        name: 'Cologne',
        localizedNames: { de: 'Köln' },
        graphFileName: 'cologne-graph.bin.gz',
        boundaryFileName: 'cologne-district-boundaries-canvas.json',
      },
      {
        id: 'athens',
        name: 'Athens',
        localizedNames: { de: 'Athen' },
        graphFileName: 'athens-graph.bin.gz',
        boundaryFileName: 'athens-district-boundaries-canvas.json',
      },
      {
        id: 'berlin',
        name: 'Berlin',
        graphFileName: 'graph-walk.bin.gz',
        boundaryFileName: 'berlin-district-boundaries-canvas.json',
      },
    ],
  });

  const localized = localizeLocationRegistry(registry, 'de');

  assert.deepEqual(
    localized.locations.map((entry) => ({ id: entry.id, name: entry.name })),
    [
      { id: 'athens', name: 'Athen' },
      { id: 'berlin', name: 'Berlin' },
      { id: 'cologne', name: 'Köln' },
    ],
  );
});

test('localizeLocationRegistry preserves canonical names across repeated localization passes', () => {
  const registry = parseLocationRegistry({
    locations: [
      {
        id: 'cologne',
        name: 'Cologne',
        localizedNames: { de: 'Köln', fr: 'Cologne' },
        graphFileName: 'cologne-graph.bin.gz',
        boundaryFileName: 'cologne-district-boundaries-canvas.json',
      },
    ],
  });

  const german = localizeLocationRegistry(registry, 'de');
  const french = localizeLocationRegistry(german, 'fr');

  assert.equal(german.locations[0].name, 'Köln');
  assert.equal(french.locations[0].name, 'Cologne');
  assert.equal(french.locations[0].canonicalName, 'Cologne');
});
