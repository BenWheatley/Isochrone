import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCommonMessagesToDocument,
  formatCommonMessage,
  loadCommonLocaleBundle,
  resolveSupportedLocale,
} from '../src/ui/localization.js';

function createElementFixture(textContent, attributes = {}) {
  const attributeMap = new Map(Object.entries(attributes));
  return {
    textContent,
    setAttribute(name, value) {
      attributeMap.set(name, String(value));
    },
    getAttribute(name) {
      return attributeMap.has(name) ? attributeMap.get(name) : null;
    },
    getAttributeNames() {
      return [...attributeMap.keys()];
    },
  };
}

test('resolveSupportedLocale normalizes regional variants and falls back to english', () => {
  assert.equal(resolveSupportedLocale('de-DE'), 'de');
  assert.equal(resolveSupportedLocale('fr_CA'), 'fr');
  assert.equal(resolveSupportedLocale('es-ES'), 'en');
  assert.equal(resolveSupportedLocale(''), 'en');
});

test('formatCommonMessage interpolates named placeholders', () => {
  const messages = {
    'routing.done': 'Done - full travel-time field ready{durationSuffix}',
    'routing.durationSuffix': ' ({durationMs} ms)',
  };

  assert.equal(
    formatCommonMessage(messages, 'routing.done', { durationSuffix: ' (42 ms)' }),
    'Done - full travel-time field ready (42 ms)',
  );
  assert.equal(
    formatCommonMessage(messages, 'routing.durationSuffix', { durationMs: 42 }),
    ' (42 ms)',
  );
});

test('applyCommonMessagesToDocument updates text, attributes, and document title', () => {
  const heading = createElementFixture('Isochrone', { 'data-i18n': 'body.title' });
  const summary = createElementFixture('Options', {
    'data-i18n': 'body.options',
    'data-i18n-attr-aria-label': 'body.options.open',
  });
  const mapRegion = createElementFixture('', {
    'data-i18n-attr-aria-label': 'body.map.aria',
  });
  const doc = {
    title: 'Isochrone',
    documentElement: {
      lang: 'en',
    },
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') {
        return [heading, summary];
      }
      if (selector === '*') {
        return [heading, summary, mapRegion];
      }
      return [];
    },
  };

  applyCommonMessagesToDocument(doc, {
    locale: 'de',
    messages: {
      'head.title': 'Isochrone DE',
      'body.title': 'Isochrone DE',
      'body.options': 'Optionen',
      'body.options.open': 'Optionsmenu öffnen',
      'body.map.aria': 'Kartenansicht',
    },
  });

  assert.equal(doc.title, 'Isochrone DE');
  assert.equal(doc.documentElement.lang, 'de');
  assert.equal(heading.textContent, 'Isochrone DE');
  assert.equal(summary.textContent, 'Optionen');
  assert.equal(summary.getAttribute('aria-label'), 'Optionsmenu öffnen');
  assert.equal(mapRegion.getAttribute('aria-label'), 'Kartenansicht');
});

test('loadCommonLocaleBundle falls back from regional locale to base locale bundle', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).endsWith('/locales/de/common.json')) {
      return {
        ok: true,
        async json() {
          return { 'head.title': 'Isochrone DE' };
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async json() {
        return {};
      },
    };
  };

  const bundle = await loadCommonLocaleBundle({
    locale: 'de-DE',
    fetchImpl,
    baseUrl: new URL('https://example.test/src/app.js'),
  });

  assert.equal(bundle.locale, 'de');
  assert.equal(bundle.messages['head.title'], 'Isochrone DE');
  assert.deepEqual(fetchCalls, ['https://example.test/locales/de/common.json']);
});
