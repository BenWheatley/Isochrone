import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindSvgExportControl,
  buildRenderedIsochroneSvgDocument,
  buildSvgExportFilename,
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

test('buildRenderedIsochroneSvgDocument layers boundary and isochrone images', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 640,
    heightPx: 480,
    boundaryLayerDataUrl: 'data:image/png;base64,AAA',
    isochroneLayerDataUrl: 'data:image/png;base64,BBB',
    title: 'Berlin Isochrone',
  });

  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('viewBox="0 0 640 480"'));
  assert.ok(svg.includes('<title>Berlin Isochrone</title>'));
  assert.ok(svg.includes('href="data:image/png;base64,AAA"'));
  assert.ok(svg.includes('href="data:image/png;base64,BBB"'));
});

test('buildRenderedIsochroneSvgDocument escapes title text', () => {
  const svg = buildRenderedIsochroneSvgDocument({
    widthPx: 2,
    heightPx: 2,
    boundaryLayerDataUrl: 'data:image/png;base64,AAA',
    isochroneLayerDataUrl: 'data:image/png;base64,BBB',
    title: 'Berlin <Isochrone> & "Legend"',
  });

  assert.ok(svg.includes('<title>Berlin &lt;Isochrone&gt; &amp; &quot;Legend&quot;</title>'));
});

test('buildSvgExportFilename formats local timestamp deterministically', () => {
  const fileName = buildSvgExportFilename(new Date(2026, 2, 11, 9, 8, 7));
  assert.equal(fileName, 'isochrone-20260311-090807.svg');
});

test('bindSvgExportControl invokes export callback on button click', () => {
  const exportSvgButton = createButtonStub();
  const shell = { exportSvgButton };

  let exportCount = 0;
  const binding = bindSvgExportControl(shell, {
    exportCurrentRenderedIsochroneSvg() {
      exportCount += 1;
      return { filename: 'isochrone-test.svg' };
    },
  });

  exportSvgButton.emit('click');
  assert.equal(exportCount, 1);

  binding.dispose();
  exportSvgButton.emit('click');
  assert.equal(exportCount, 1);
});
