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

test('buildRenderedIsochroneSvgDocument layers boundary image and vector isochrone edges', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 640,
    heightPx: 480,
    boundaryLayerDataUrl: 'data:image/png;base64,AAA',
    backgroundColor: 'rgb(17, 24, 32)',
    edgeVertexData: new Float32Array([10, 12, 0, 22, 24, 0]),
    title: 'Isochrone of Berlin, by Car',
    scaleBarLabel: '1 km',
    scaleBarWidthPx: 96,
    copyrightNotice:
      'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL): https://www.openstreetmap.org/copyright',
  });

  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('viewBox="0 0 640 480"'));
  assert.ok(svg.includes('<title>Isochrone of Berlin, by Car</title>'));
  assert.ok(svg.includes('>Isochrone of Berlin, by Car<'));
  assert.ok(svg.includes('id="isochrone-background"'));
  assert.ok(svg.includes('fill="rgb(17, 24, 32)"'));
  assert.ok(svg.includes('href="data:image/png;base64,AAA"'));
  assert.ok(svg.includes('<g id="isochrone-edges">'));
  assert.ok(svg.includes('stroke="rgb(0, 255, 255)"'));
  assert.ok(svg.includes('id="isochrone-legend"'));
  assert.ok(svg.includes('Colours repeat every'));
  assert.ok(svg.includes('id="isochrone-scale"'));
  assert.ok(svg.includes('>1 km<'));
  assert.ok(svg.includes('id="isochrone-copyright"'));
});

test('buildRenderedIsochroneSvgDocument escapes title text', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 2,
    heightPx: 2,
    boundaryLayerDataUrl: 'data:image/png;base64,AAA',
    edgeVertexData: new Float32Array([0, 0, 0, 1, 1, 0]),
    title: 'Berlin <Isochrone> & "Legend"',
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

test('buildIsochroneEdgeLineMarkup renders one SVG line per edge segment', () => {
  const markup = buildIsochroneEdgeLineMarkup(new Float32Array([1, 2, 0, 3, 4, 0]));
  assert.ok(markup.includes('<line'));
  assert.ok(markup.includes('x1="1"'));
  assert.ok(markup.includes('y2="4"'));
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

test('exportCurrentRenderedIsochroneSvg emits downloadable vector SVG', () => {
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
  const documentObject = {
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
      toDataURL() {
        return 'data:image/png;base64,AAA';
      },
    },
    isochroneCanvas: {
      width: 100,
      height: 80,
    },
    mapRegion: { id: 'map-region' },
  };
  const getComputedStyleImpl = (node) => {
    if (node === shell.isochroneCanvas) {
      return { backgroundColor: 'rgba(0, 0, 0, 0)' };
    }
    if (node === shell.mapRegion) {
      return { backgroundColor: 'rgb(17, 24, 32)' };
    }
    return { backgroundColor: 'transparent' };
  };

  const result = exportCurrentRenderedIsochroneSvg(shell, {
    edgeVertexData: new Float32Array([0, 0, 0, 10, 10, 0]),
    filename: 'isochrone-test.svg',
    getComputedStyleImpl,
    documentObject,
    urlObject,
    scheduleRevoke(callback) {
      callback();
    },
  });

  assert.equal(result.filename, 'isochrone-test.svg');
  assert.ok(result.svgDocument.includes('id="isochrone-background"'));
  assert.ok(result.svgDocument.includes('fill="rgb(17, 24, 32)"'));
  assert.ok(result.svgDocument.includes('<line'));
  assert.equal(appendedNode, anchor);
  assert.equal(anchor.download, 'isochrone-test.svg');
  assert.equal(anchor.href, 'blob:test');
  assert.equal(clicked, 1);
  assert.equal(removed, 1);
  assert.equal(revokedUrl, 'blob:test');
});

test('exportCurrentRenderedIsochroneSvg allows empty edge data for blank-map export', () => {
  const shell = {
    boundaryCanvas: {
      toDataURL() {
        return 'data:image/png;base64,AAA';
      },
    },
    isochroneCanvas: {
      width: 100,
      height: 80,
    },
  };
  const documentObject = {
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

  const result = exportCurrentRenderedIsochroneSvg(shell, {
    documentObject,
    urlObject,
    scheduleRevoke(callback) {
      callback();
    },
  });

  assert.ok(result.svgDocument.includes('<g id="isochrone-edges">'));
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
