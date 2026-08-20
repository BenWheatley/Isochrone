import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIsochroneRenderer,
  createWebGlIsochroneRenderer,
  resetWebGlRendererSupportCache,
} from '../src/render/isochrone-renderer.js';

/**
 * A canvas that behaves like a real one in the way that matters here: once a
 * WebGL context has been handed out, getContext('2d') returns null forever.
 */
function createCanvasStub({ webglFails = false } = {}) {
  const canvas = {
    width: 0,
    height: 0,
    contextType: null,
    getContext(type) {
      if (type === '2d') {
        if (canvas.contextType !== null && canvas.contextType !== '2d') {
          return null;
        }
        canvas.contextType = '2d';
        return { clearRect() {}, putImageData() {}, drawImage() {} };
      }
      if (type === 'webgl2' || type === 'webgl') {
        if (webglFails) {
          return null;
        }
        if (canvas.contextType !== null && canvas.contextType !== 'webgl') {
          return null;
        }
        canvas.contextType = 'webgl';
        return { getExtension: () => null };
      }
      return null;
    },
  };
  return canvas;
}

test('a canvas without WebGL still gets a working 2D renderer', () => {
  resetWebGlRendererSupportCache();
  const documentStub = { createElement: () => createCanvasStub({ webglFails: true }) };
  const canvas = createCanvasStub({ webglFails: true });
  canvas.ownerDocument = documentStub;

  const renderer = createIsochroneRenderer(canvas);

  assert.equal(renderer.mode, '2d');
  resetWebGlRendererSupportCache();
});

test('probing on a throwaway canvas leaves the real canvas usable by 2D', () => {
  // The regression this guards: WebGL support was probed by building the
  // renderer on the real canvas. Any failure after the context was acquired
  // left the canvas bound to WebGL, so the 2D fallback got null back and threw
  // "Unable to get 2D context for isochrone canvas" - masking the real cause
  // and killing the app on browsers where WebGL init fails (Safari).
  resetWebGlRendererSupportCache();
  let probesCreated = 0;
  const documentStub = {
    createElement() {
      probesCreated += 1;
      return createCanvasStub({ webglFails: true });
    },
  };
  const canvas = createCanvasStub({ webglFails: true });
  canvas.ownerDocument = documentStub;

  const renderer = createIsochroneRenderer(canvas);

  assert.equal(probesCreated, 1, 'support must be decided on a throwaway canvas');
  assert.equal(canvas.contextType, '2d', 'the real canvas must never be WebGL-bound');
  assert.equal(renderer.mode, '2d');
  resetWebGlRendererSupportCache();
});


/** Records every getContext call so the request pattern can be asserted. */
function createContextCountingCanvas({ webgl2 = true, lost = false } = {}) {
  const requests = [];
  const canvas = {
    width: 0,
    height: 0,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    remove() { this.removed = true; },
    getContext(type) {
      requests.push(type);
      if (type === 'webgl2' && webgl2) {
        return { isContextLost: () => lost, getExtension: () => null };
      }
      if (type === 'webgl' && !webgl2) {
        return { isContextLost: () => lost, getExtension: () => null };
      }
      return null;
    },
  };
  canvas.requests = requests;
  return canvas;
}

test('a successful webgl2 request does not also ask for webgl', () => {
  // Safari reports the redundant second request as "WebGL: context lost": a
  // canvas already bound to webgl2 can never hand out webgl, so asking spends
  // a context request that cannot succeed.
  const canvas = createContextCountingCanvas({ webgl2: true });
  try {
    createWebGlIsochroneRenderer(canvas);
  } catch {
    // Construction fails on this stub well after context acquisition, which
    // is all this test cares about.
  }

  assert.deepEqual(canvas.requests, ['webgl2']);
});

test('webgl is only requested when webgl2 declines', () => {
  const canvas = createContextCountingCanvas({ webgl2: false });
  try {
    createWebGlIsochroneRenderer(canvas);
  } catch {
    // As above.
  }

  assert.deepEqual(canvas.requests, ['webgl2', 'webgl']);
});

test('probing releases its context without asking the canvas for a new one', () => {
  // Releasing by calling getContext again would *create* a context on a probe
  // that failed - the opposite of releasing, and worse on a browser already
  // short of contexts.
  resetWebGlRendererSupportCache();
  let loseContextCalls = 0;
  const probeContext = {
    isContextLost: () => false,
    getExtension: (name) =>
      (name === 'WEBGL_lose_context' ? { loseContext() { loseContextCalls += 1; } } : null),
  };
  const probeCanvas = {
    width: 0,
    height: 0,
    removed: false,
    setAttribute() {},
    remove() { this.removed = true; },
    getContextCalls: 0,
    getContext(type) {
      this.getContextCalls += 1;
      return type === 'webgl2' ? probeContext : null;
    },
  };
  const documentStub = { createElement: () => probeCanvas, body: { appendChild() {} } };
  const canvas = createCanvasStub({ webglFails: true });
  canvas.ownerDocument = documentStub;

  createIsochroneRenderer(canvas);

  assert.equal(probeCanvas.getContextCalls, 1, 'the probe must request its context once');
  assert.equal(loseContextCalls, 1, 'the probe context must be explicitly released');
  assert.equal(probeCanvas.removed, true, 'the probe canvas must be taken back out of the page');
  resetWebGlRendererSupportCache();
});

test('a probe context that reports itself lost counts as no WebGL support', () => {
  resetWebGlRendererSupportCache();
  const probeCanvas = createContextCountingCanvas({ webgl2: true, lost: true });
  const documentStub = { createElement: () => probeCanvas, body: { appendChild() {} } };
  const canvas = createCanvasStub({ webglFails: true });
  canvas.ownerDocument = documentStub;

  const renderer = createIsochroneRenderer(canvas);

  assert.equal(renderer.mode, '2d');
  resetWebGlRendererSupportCache();
});

test('the probe canvas is attached to the document while it runs', () => {
  // Safari can immediately lose a context created on a detached canvas, which
  // would make the probe a false negative and silently drop every Safari user
  // to the 2D renderer.
  resetWebGlRendererSupportCache();
  const appended = [];
  const probeCanvas = createContextCountingCanvas({ webgl2: false });
  const documentStub = {
    createElement: () => probeCanvas,
    body: { appendChild(node) { appended.push(node); } },
  };
  const canvas = createCanvasStub({ webglFails: true });
  canvas.ownerDocument = documentStub;

  createIsochroneRenderer(canvas);

  assert.equal(appended.length, 1, 'the probe must be in the document');
  assert.equal(appended[0], probeCanvas);
  assert.equal(probeCanvas.removed, true, 'and must not be left there');
  resetWebGlRendererSupportCache();
});
