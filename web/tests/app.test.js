import { describe, expect, it } from 'vitest';

import { initializeAppShell, minutesToSeconds } from '../src/app.js';

describe('minutesToSeconds', () => {
  it('converts integer minutes', () => {
    expect(minutesToSeconds(3)).toBe(180);
  });

  it('rounds to nearest second for fractional minutes', () => {
    expect(minutesToSeconds(1.25)).toBe(75);
  });

  it('rejects negative values', () => {
    expect(() => minutesToSeconds(-1)).toThrow('minutes must be non-negative');
  });
});

describe('initializeAppShell', () => {
  it('wires required shell elements and sets loading text', () => {
    const map = { tagName: 'CANVAS' };
    const loading = { tagName: 'DIV', textContent: '' };
    const fakeDocument = {
      getElementById(id) {
        if (id === 'map') return map;
        if (id === 'loading') return loading;
        return null;
      },
    };

    const result = initializeAppShell(fakeDocument);

    expect(result.mapCanvas).toBe(map);
    expect(result.loadingOverlay).toBe(loading);
    expect(loading.textContent).toBe('Loading map and graph data...');
  });

  it('throws if the map canvas is missing', () => {
    const fakeDocument = {
      getElementById() {
        return null;
      },
    };

    expect(() => initializeAppShell(fakeDocument)).toThrow(
      'index.html is missing <canvas id="map">',
    );
  });
});
