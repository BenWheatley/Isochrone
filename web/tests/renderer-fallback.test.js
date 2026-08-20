import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIsochroneRenderer,
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
