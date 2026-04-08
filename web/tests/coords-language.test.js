import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLanguageFromLocationSearch } from '../src/core/coords.js';

test('parseLanguageFromLocationSearch returns trimmed lang query values', () => {
  assert.equal(parseLanguageFromLocationSearch('?lang=de'), 'de');
  assert.equal(parseLanguageFromLocationSearch('?region=paris&lang= fr '), 'fr');
});

test('parseLanguageFromLocationSearch returns null when lang is missing or blank', () => {
  assert.equal(parseLanguageFromLocationSearch(''), null);
  assert.equal(parseLanguageFromLocationSearch('?region=berlin'), null);
  assert.equal(parseLanguageFromLocationSearch('?lang=   '), null);
});
