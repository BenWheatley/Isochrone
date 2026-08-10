import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindSvgExportControl,
  buildIsochroneEdgeLineMarkup,
  buildRenderedIsochroneSvgDocument,
  buildSvgExportFilename,
  exportCurrentRenderedIsochroneSvg,
  formatIsochroneExportTitle,
} from '../src/export/svg.js';

function createButtonStub() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const listenerSet = listeners.get(type) ?? new Set();
      listenerSet.add(listener);
      listeners.set(type, listenerSet);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ type });
      }
    },
  };
}

function flushTasks() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createGraphHeader() {
  return {
    originEasting: 0,
    originNorthing: 0,
    gridWidthPx: 100,
    gridHeightPx: 100,
    pixelSizeM: 1,
  };
}

function createBoundaryPayload() {
  return {
    coordinate_space: {
      x_origin: 0,
      y_origin: 99,
      width: 100,
      height: 100,
      axis: 'x-right-y-down',
    },
    features: [
      {
        name: 'Test boundary',
        relation_id: 1,
        paths: [[[10, 10], [20, 20], [30, 30]]],
      },
    ],
    water_features: [
      {
        name: 'Sea',
        paths: [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]]],
      },
    ],
    forest_features: [
      {
        name: 'Forest',
        paths: [[[50, 50], [60, 50], [60, 60], [50, 60], [50, 50]]],
      },
    ],
    airport_features: [
      {
        name: 'Airport',
        paths: [[[45, 5], [48, 5], [48, 8], [45, 8], [45, 5]]],
      },
    ],
    inland_water_features: [
      {
        name: 'Lake',
        paths: [[[70, 70], [80, 70], [80, 80], [70, 80], [70, 70]]],
      },
    ],
    waterway_features: [
      { name: 'River', category: 'river', navigable: true, paths: [[[5, 90], [15, 90]]] },
      { name: 'Stream', category: 'stream', navigable: false, paths: [[[25, 90], [35, 90]]] },
    ],
  };
}

function createComputedStyleStub(valuesByElement = new Map()) {
  return (element) => {
    const values = valuesByElement.get(element) ?? {};
    return {
      backgroundColor: values.backgroundColor ?? 'transparent',
      getPropertyValue(name) {
        return values[name] ?? '';
      },
    };
  };
}

test('buildIsochroneEdgeLineMarkup skips hidden edges and applies theme palette', () => {
  const markup = buildIsochroneEdgeLineMarkup(
    new Float32Array([
      1,
      2,
      -1,
      3,
      4,
      -1,
      10,
      12,
      0,
      22,
      24,
      60,
    ]),
    { cycleMinutes: 75, theme: 'light' },
  );

  assert.equal(markup.match(/<line /g)?.length ?? 0, 1);
  assert.ok(markup.includes('stroke="rgb(0, 110, 210)"'));
  assert.ok(!markup.includes('x1="1"'));
});

test('buildRenderedIsochroneSvgDocument uses full-region graph coordinates and ignores viewport zoom', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 100,
    heightPx: 100,
    backgroundColour: '#111820',
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    viewport: {
      scale: 2,
      offsetXPx: 5,
      offsetYPx: 3,
    },
    edgeVertexData: new Float32Array([10, 10, 0, 20, 20, 60]),
    title: 'Isochrone of Test, by Car',
    scaleBarLabel: '1 km',
    scaleBarWidthPx: 96,
    scaleBarSegmentWidthPx: 24,
    overlayColours: {
      overlayBackground: 'rgba(4, 12, 18, 0.88)',
      overlayBorder: 'rgba(130, 170, 210, 0.55)',
      overlayText: '#dceaf8',
      overlayNote: '#c0d4e8',
      scaleLineBackground: '#f6fbff',
      scaleLineAlternate: '#31577a',
      scaleLineBorder: '#c1d6e9',
      boundaryStroke: 'rgba(125, 175, 220, 0.55)',
    },
  });

  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(svg.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('viewBox="0 0 100 100"'));
  assert.ok(!svg.includes('<image '));
  assert.ok(svg.includes('id="isochrone-boundaries"'));
  assert.ok(svg.includes('d="M 10 10 L 20 20 L 30 30"'));
  assert.ok(svg.includes('x1="10"'));
  assert.ok(svg.includes('y1="10"'));
  assert.ok(svg.includes('x2="20"'));
  assert.ok(svg.includes('y2="20"'));
});

test('buildRenderedIsochroneSvgDocument exports sea, forest, airport, inland-water, and waterway layers', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 100,
    heightPx: 100,
    backgroundColour: '#111820',
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    edgeVertexData: new Float32Array(0),
  });

  // Gap fix: coastal sea water_features were previously drawn on canvas but
  // never exported to SVG at all.
  assert.ok(svg.includes('id="isochrone-sea"'));
  assert.ok(svg.includes('id="isochrone-forest"'));
  assert.ok(svg.includes('id="isochrone-airports"'));
  assert.ok(svg.includes('id="isochrone-inland-water"'));
  assert.ok(svg.includes('id="isochrone-waterways"'));

  assert.equal(svg.match(/<g id="isochrone-sea">[\s\S]*?<\/g>/)?.[0].match(/<path/g)?.length, 1);
  assert.ok(/<g id="isochrone-forest">[\s\S]*?fill="[^"]+"[\s\S]*?<\/g>/.test(svg));
  assert.ok(/<g id="isochrone-airports">[\s\S]*?fill="[^"]+"[\s\S]*?<\/g>/.test(svg));

  const waterwayGroup = svg.match(/<g id="isochrone-waterways">[\s\S]*?<\/g>/)?.[0];
  assert.equal(waterwayGroup.match(/<path/g)?.length, 2);
  assert.ok(waterwayGroup.includes('fill="none"'));

  // Bottom-to-top draw order: forest, airports, inland water, sea, waterways,
  // boundaries.
  const forestIndex = svg.indexOf('id="isochrone-forest"');
  const airportsIndex = svg.indexOf('id="isochrone-airports"');
  const inlandWaterIndex = svg.indexOf('id="isochrone-inland-water"');
  const seaIndex = svg.indexOf('id="isochrone-sea"');
  const waterwaysIndex = svg.indexOf('id="isochrone-waterways"');
  const boundariesIndex = svg.indexOf('id="isochrone-boundaries"');
  assert.ok(forestIndex < airportsIndex);
  assert.ok(airportsIndex < inlandWaterIndex);
  assert.ok(inlandWaterIndex < seaIndex);
  assert.ok(seaIndex < waterwaysIndex);
  assert.ok(waterwaysIndex < boundariesIndex);
});

test('buildRenderedIsochroneSvgDocument distinguishes navigable from non-navigable waterway strokes', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 100,
    heightPx: 100,
    backgroundColour: '#111820',
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    edgeVertexData: new Float32Array(0),
    theme: 'light',
  });

  const waterwayGroup = svg.match(/<g id="isochrone-waterways">[\s\S]*?<\/g>/)?.[0];
  const strokeColours = [...waterwayGroup.matchAll(/stroke="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(strokeColours.length, 2);
  assert.notEqual(strokeColours[0], strokeColours[1]);
});

test('buildRenderedIsochroneSvgDocument omits natural-feature groups when the boundary payload has none', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 100,
    heightPx: 100,
    backgroundColour: '#111820',
    graphHeader: createGraphHeader(),
    boundaryPayload: {
      coordinate_space: {
        x_origin: 0,
        y_origin: 99,
        width: 100,
        height: 100,
        axis: 'x-right-y-down',
      },
      features: [{ name: 'Test boundary', paths: [[[10, 10], [20, 20], [30, 30]]] }],
    },
    edgeVertexData: new Float32Array(0),
  });

  assert.ok(!svg.includes('id="isochrone-sea"'));
  assert.ok(!svg.includes('id="isochrone-forest"'));
  assert.ok(!svg.includes('id="isochrone-airports"'));
  assert.ok(!svg.includes('id="isochrone-inland-water"'));
  assert.ok(!svg.includes('id="isochrone-waterways"'));
  assert.ok(svg.includes('id="isochrone-boundaries"'));
});

test('exportCurrentRenderedIsochroneSvg uses graph extent instead of current canvas viewport size', () => {
  const documentObject = {
    documentElement: { dataset: {} },
    body: {
      appendChild() {},
    },
    createElement() {
      return {
        click() {},
        remove() {},
        style: {},
      };
    },
  };
  const urlObject = {
    createObjectURL() {
      return 'blob:test';
    },
    revokeObjectURL() {},
  };
  const shell = {
    boundaryCanvas: {
      width: 25,
      height: 25,
      ownerDocument: documentObject,
    },
    isochroneCanvas: {
      width: 25,
      height: 25,
      ownerDocument: documentObject,
    },
  };

  const result = exportCurrentRenderedIsochroneSvg(shell, {
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    edgeVertexData: new Float32Array([10, 10, 0, 20, 20, 60]),
    viewport: {
      scale: 8,
      offsetXPx: 99,
      offsetYPx: 99,
    },
    documentObject,
    urlObject,
    scheduleRevoke(callback) {
      callback();
    },
  });

  assert.ok(result.svgDocument.includes('viewBox="0 0 100 100"'));
  assert.ok(result.svgDocument.includes('d="M 10 10 L 20 20 L 30 30"'));
  assert.ok(result.svgDocument.includes('x2="20"'));
});

test('buildRenderedIsochroneSvgDocument localizes legend note and range labels', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 100,
    heightPx: 100,
    backgroundColour: '#111820',
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    edgeVertexData: new Float32Array([10, 10, 0, 20, 20, 60]),
    cycleMinutes: 120,
    messages: {
      'legend.duration.minuteOnly': '{minutes} Min.',
      'legend.duration.hourOnly': '{hours} Std.',
      'legend.duration.hourMinute': '{hours} Std. {minutes} Min.',
      'legend.range': '{start}–{end}',
      'legend.repeat': 'Farben wiederholen sich alle {duration}.',
    },
    overlayColours: {
      overlayBackground: 'rgba(4, 12, 18, 0.88)',
      overlayBorder: 'rgba(130, 170, 210, 0.55)',
      overlayText: '#dceaf8',
      overlayNote: '#c0d4e8',
      scaleLineBackground: '#f6fbff',
      scaleLineAlternate: '#31577a',
      scaleLineBorder: '#c1d6e9',
      boundaryStroke: 'rgba(125, 175, 220, 0.55)',
    },
  });

  assert.ok(svg.includes('48 Min.–1 Std. 12 Min.'));
  assert.ok(svg.includes('Farben wiederholen sich alle 2 Std.'));
});

test('buildRenderedIsochroneSvgDocument uses theme-derived overlay colours and patterned scale bar', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 100,
    heightPx: 100,
    backgroundColour: '#ffffff',
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    edgeVertexData: new Float32Array([10, 10, 0, 20, 20, 60]),
    scaleBarLabel: '1 km',
    scaleBarWidthPx: 96,
    scaleBarSegmentWidthPx: 24,
    theme: 'light',
    overlayColours: {
      overlayBackground: 'rgba(251, 253, 255, 0.92)',
      overlayBorder: 'rgba(97, 130, 159, 0.62)',
      overlayText: '#173750',
      overlayNote: '#365772',
      scaleLineBackground: '#21435d',
      scaleLineAlternate: '#eef5fb',
      scaleLineBorder: '#21435d',
      boundaryStroke: 'rgba(58, 94, 126, 0.62)',
    },
  });

  assert.ok(!svg.includes('fill="rgba(251, 253, 255, 0.92)"'));
  assert.ok(!svg.includes('stroke="rgba(97, 130, 159, 0.62)"'));
  assert.ok(svg.includes('fill="#173750"'));
  assert.ok(svg.includes('fill="#365772"'));
  assert.ok(svg.includes('stroke="rgb(0, 110, 210)"'));
  assert.ok(svg.includes('id="isochrone-scale-pattern"'));
  assert.ok(svg.includes('fill="#21435d"'));
  assert.ok(svg.includes('fill="#eef5fb"'));
});

test('buildRenderedIsochroneSvgDocument omits outer overlay boxes and keeps full copyright text', () => {
  const copyrightNotice =
    'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL): '
    + 'https://www.openstreetmap.org/copyright Additional disclaimer text should remain fully visible '
    + 'in the SVG export without truncation.';
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 600,
    heightPx: 400,
    backgroundColour: '#111820',
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    edgeVertexData: new Float32Array([10, 10, 0, 20, 20, 60]),
    title: 'Isochrone of Test, by Car',
    scaleBarLabel: '1 km',
    scaleBarWidthPx: 96,
    scaleBarSegmentWidthPx: 24,
    copyrightNotice,
    overlayColours: {
      overlayBackground: 'rgba(4, 12, 18, 0.88)',
      overlayBorder: 'rgba(130, 170, 210, 0.55)',
      overlayText: '#dceaf8',
      overlayNote: '#c0d4e8',
      scaleLineBackground: '#f6fbff',
      scaleLineAlternate: '#31577a',
      scaleLineBorder: '#c1d6e9',
      boundaryStroke: 'rgba(125, 175, 220, 0.55)',
    },
  });

  assert.ok(svg.includes('id="isochrone-title"'));
  assert.ok(svg.includes('id="isochrone-legend"'));
  assert.ok(svg.includes('id="isochrone-scale"'));
  assert.ok(svg.includes('id="isochrone-copyright"'));
  assert.ok(!svg.includes('fill="rgba(4, 12, 18, 0.88)"'));
  assert.ok(!svg.includes('stroke="rgba(130, 170, 210, 0.55)"'));
  assert.ok(!svg.includes('...'));
  assert.ok(svg.includes('Additional'));
  assert.ok(svg.includes('disclaimer'));
  assert.ok(svg.includes('fully'));
  assert.ok(svg.includes('without truncation.'));
});

test('buildRenderedIsochroneSvgDocument escapes title text', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 100,
    heightPx: 100,
    backgroundColour: '#111820',
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    edgeVertexData: new Float32Array([10, 10, 0, 20, 20, 60]),
    title: 'Berlin <Isochrone> & "Legend"',
    overlayColours: {
      overlayBackground: 'rgba(4, 12, 18, 0.88)',
      overlayBorder: 'rgba(130, 170, 210, 0.55)',
      overlayText: '#dceaf8',
      overlayNote: '#c0d4e8',
      scaleLineBackground: '#f6fbff',
      scaleLineAlternate: '#31577a',
      scaleLineBorder: '#c1d6e9',
      boundaryStroke: 'rgba(125, 175, 220, 0.55)',
    },
  });

  assert.ok(svg.includes('<title>Berlin &lt;Isochrone&gt; &amp; &quot;Legend&quot;</title>'));
});

test('buildSvgExportFilename formats local timestamp deterministically', () => {
  const fileName = buildSvgExportFilename(new Date(2026, 2, 11, 9, 8, 7));
  assert.equal(fileName, 'isochrone-20260311-090807.svg');
});

test('formatIsochroneExportTitle composes location and transport mode labels', () => {
  const title = formatIsochroneExportTitle('Berlin', ['Walk', 'Bike', 'Car']);
  assert.equal(title, 'Isochrone of Berlin, by Walk, Bike, Car');
});

test('bindSvgExportControl invokes export callback on button click', async () => {
  const exportSvgButton = createButtonStub();
  const shell = { exportSvgButton };

  let exportCount = 0;
  let successCount = 0;
  const binding = bindSvgExportControl(shell, {
    exportCurrentRenderedIsochroneSvg() {
      exportCount += 1;
      return { filename: 'isochrone-test.svg' };
    },
    onExportSuccess() {
      successCount += 1;
    },
  });

  exportSvgButton.emit('click');
  assert.equal(exportCount, 1);
  await flushTasks();
  assert.equal(successCount, 1);

  binding.dispose();
  exportSvgButton.emit('click');
  assert.equal(exportCount, 1);
});

test('bindSvgExportControl forwards errors to onExportError callback', () => {
  const exportSvgButton = createButtonStub();
  const shell = { exportSvgButton };

  let errorCount = 0;
  const binding = bindSvgExportControl(shell, {
    exportCurrentRenderedIsochroneSvg() {
      throw new Error('boom');
    },
    onExportError() {
      errorCount += 1;
    },
  });

  exportSvgButton.emit('click');
  assert.equal(errorCount, 1);
  binding.dispose();
});

test('exportCurrentRenderedIsochroneSvg emits downloadable vector SVG with current theme colours', () => {
  let appendedNode = null;
  let clicked = 0;
  let removed = 0;
  let revokedUrl = null;
  const anchor = {
    href: '',
    download: '',
    rel: '',
    style: {},
    click() {
      clicked += 1;
    },
    remove() {
      removed += 1;
    },
  };
  const documentElement = { dataset: { theme: 'light' } };
  const documentObject = {
    documentElement,
    body: {
      appendChild(node) {
        appendedNode = node;
      },
    },
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return anchor;
    },
  };
  const urlObject = {
    createObjectURL() {
      return 'blob:test';
    },
    revokeObjectURL(url) {
      revokedUrl = url;
    },
  };
  const shell = {
    boundaryCanvas: {
      width: 100,
      height: 100,
      ownerDocument: documentObject,
    },
    isochroneCanvas: {
      width: 100,
      height: 100,
      ownerDocument: documentObject,
    },
    mapRegion: { id: 'map-region' },
  };
  const styleValues = new Map([
    [
      documentElement,
      {
        backgroundColor: '#eef2f5',
        '--map-overlay-bg': 'rgba(251, 253, 255, 0.92)',
        '--map-overlay-border': 'rgba(97, 130, 159, 0.62)',
        '--map-overlay-text': '#173750',
        '--map-overlay-note': '#365772',
        '--map-scale-line-bg': '#21435d',
        '--map-scale-line-alt': '#eef5fb',
        '--map-scale-line-border': '#21435d',
      },
    ],
    [shell.mapRegion, { backgroundColor: '#ffffff' }],
  ]);

  const result = exportCurrentRenderedIsochroneSvg(shell, {
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    edgeVertexData: new Float32Array([10, 10, 0, 20, 20, 60]),
    title: 'Isochrone of Test, by Car',
    scaleBarLabel: '1 km',
    scaleBarWidthPx: 96,
    scaleBarSegmentWidthPx: 24,
    theme: 'light',
    getComputedStyleImpl: createComputedStyleStub(styleValues),
    documentObject,
    urlObject,
    scheduleRevoke(callback) {
      callback();
    },
  });

  assert.equal(result.filename.endsWith('.svg'), true);
  assert.ok(result.svgDocument.includes('fill="#ffffff"'));
  assert.ok(!result.svgDocument.includes('fill="rgba(251, 253, 255, 0.92)"'));
  assert.ok(!result.svgDocument.includes('stroke="rgba(97, 130, 159, 0.62)"'));
  assert.ok(result.svgDocument.includes('stroke="rgb(0, 110, 210)"'));
  assert.ok(result.svgDocument.includes('id="isochrone-boundaries"'));
  assert.equal(appendedNode, anchor);
  assert.equal(anchor.href, 'blob:test');
  assert.equal(clicked, 1);
  assert.equal(removed, 1);
  assert.equal(revokedUrl, 'blob:test');
});

test('exportCurrentRenderedIsochroneSvg allows blank isochrone export when no routed edges are available', () => {
  const documentObject = {
    documentElement: {},
    body: {
      appendChild() {},
    },
    createElement() {
      return {
        click() {},
        remove() {},
        style: {},
      };
    },
  };
  const urlObject = {
    createObjectURL() {
      return 'blob:test';
    },
    revokeObjectURL() {},
  };
  const shell = {
    boundaryCanvas: {
      width: 100,
      height: 100,
      ownerDocument: documentObject,
    },
    isochroneCanvas: {
      width: 100,
      height: 100,
      ownerDocument: documentObject,
    },
  };

  const result = exportCurrentRenderedIsochroneSvg(shell, {
    graphHeader: createGraphHeader(),
    boundaryPayload: createBoundaryPayload(),
    documentObject,
    urlObject,
    scheduleRevoke(callback) {
      callback();
    },
  });

  assert.ok(result.svgDocument.includes('<g id="isochrone-edges">'));
  assert.ok(result.svgDocument.includes('id="isochrone-boundaries"'));
});

test('bindSvgExportControl handles async export callback resolution', async () => {
  const exportSvgButton = createButtonStub();
  const shell = { exportSvgButton };

  let successCount = 0;
  const binding = bindSvgExportControl(shell, {
    async exportCurrentRenderedIsochroneSvg() {
      await flushTasks();
      return { filename: 'isochrone-async.svg' };
    },
    onExportSuccess() {
      successCount += 1;
    },
  });

  exportSvgButton.emit('click');
  await flushTasks();
  await flushTasks();
  assert.equal(successCount, 1);
  binding.dispose();
});
