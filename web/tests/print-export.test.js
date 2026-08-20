import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindPrintControl,
  buildIsochronePrintDocument,
  printCurrentRenderedIsochrone,
} from '../src/export/print.js';
import { collectShellCopyrightNotice } from '../src/export/scene.js';

function createPrintDocumentStub() {
  const frameDocument = {
    written: '',
    open() {},
    write(markup) {
      this.written += markup;
    },
    close() {},
  };
  const iframe = {
    contentDocument: frameDocument,
    removed: false,
    printCount: 0,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    remove() {
      this.removed = true;
    },
  };
  iframe.contentWindow = {
    document: frameDocument,
    focus() {},
    print() {
      iframe.printCount += 1;
    },
  };
  const documentObject = {
    documentElement: { dataset: {} },
    appended: [],
    body: {
      appendChild(node) {
        documentObject.appended.push(node);
      },
    },
    createElement() {
      return iframe;
    },
  };
  return { documentObject, iframe, frameDocument };
}

function createShellStub(documentObject) {
  return {
    boundaryCanvas: { width: 640, height: 480, ownerDocument: documentObject },
    isochroneCanvas: { width: 640, height: 480, ownerDocument: documentObject },
  };
}

function createButtonStub() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
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

test('buildIsochronePrintDocument inlines the SVG without its XML declaration', () => {
  const svgDocument = '<?xml version="1.0" encoding="UTF-8"?>\n<svg><title>x</title></svg>';
  const printDocument = buildIsochronePrintDocument(svgDocument, { title: 'Berlin & walking' });

  assert.ok(!printDocument.includes('<?xml'));
  assert.ok(printDocument.includes('<svg><title>x</title></svg>'));
  assert.ok(printDocument.includes('<title>Berlin &amp; walking</title>'));
  // No page margins: the poster carries its own margin, title, key, scale
  // and credits, so it should fill the sheet edge to edge.
  assert.ok(printDocument.includes('@page { margin: 0; }'));
});

test('print stylesheet sizes against the page box, not the screen viewport', () => {
  const printDocument = buildIsochronePrintDocument('<svg></svg>');

  // vh/vw are defined against the screen viewport even when printing, which
  // Safari takes literally; percentages resolve against the page area, which
  // is the sheet. Combined with overflow:hidden the old rules gave Safari a
  // blank page.
  assert.ok(!printDocument.includes('vh'));
  assert.ok(!printDocument.includes('vw'));
  assert.ok(!printDocument.includes('overflow: hidden'));
  assert.ok(printDocument.includes('html, body { margin: 0; padding: 0; height: 100%; }'));
});

test('printCurrentRenderedIsochrone prints the vector document, not the canvas', () => {
  const { documentObject, iframe, frameDocument } = createPrintDocumentStub();
  const shell = createShellStub(documentObject);
  const cleanupCallbacks = [];

  const result = printCurrentRenderedIsochrone(shell, {
    edgeVertexData: new Float32Array([1, 2, 0, 3, 4, 60]),
    title: 'Isochrone test',
    copyrightNotice: 'Map data © OpenStreetMap contributors',
    documentObject,
    scheduleCleanup(callback) {
      cleanupCallbacks.push(callback);
    },
  });

  assert.equal(iframe.printCount, 1);
  assert.equal(documentObject.appended.length, 1);
  assert.ok(frameDocument.written.includes('<svg'));
  assert.ok(result.svgDocument.includes('d="M1 2L3 4"'));
  // The overlay word-wraps, so match a single word rather than the phrase.
  assert.ok(result.printDocument.includes('OpenStreetMap'));

  // The frame must outlive the synchronous print() call.
  assert.equal(iframe.removed, false);
  for (const callback of cleanupCallbacks) {
    callback();
  }
  assert.equal(iframe.removed, true);
});

test('bindPrintControl reports success and failure through its callbacks', async () => {
  const printButton = createButtonStub();
  const shell = { printButton };
  const successes = [];
  const errors = [];

  const binding = bindPrintControl(shell, {
    printCurrentRenderedIsochrone() {
      return { printDocument: '<html></html>' };
    },
    onPrintSuccess(result) {
      successes.push(result);
    },
    onPrintError(error) {
      errors.push(error);
    },
  });
  printButton.emit('click');
  await flushTasks();

  assert.equal(successes.length, 1);
  assert.equal(errors.length, 0);
  binding.dispose();

  const failingButton = createButtonStub();
  bindPrintControl(
    { printButton: failingButton },
    {
      printCurrentRenderedIsochrone() {
        throw new Error('no printer');
      },
      onPrintError(error) {
        errors.push(error);
      },
    },
  );
  failingButton.emit('click');
  await flushTasks();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'no printer');
});

test('collectShellCopyrightNotice includes transit credit only when it is on screen', () => {
  const osm = { textContent: 'Map data © OpenStreetMap contributors' };
  const transit = { textContent: 'Transit data © VBB', hidden: true };

  assert.equal(
    collectShellCopyrightNotice({ routingDisclaimerOsm: osm, routingDisclaimerTransit: transit }),
    'Map data © OpenStreetMap contributors',
  );

  transit.hidden = false;
  assert.equal(
    collectShellCopyrightNotice({ routingDisclaimerOsm: osm, routingDisclaimerTransit: transit }),
    'Map data © OpenStreetMap contributors Transit data © VBB',
  );
});
