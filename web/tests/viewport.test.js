import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultMapViewport,
  mapScreenCanvasPixelToGraphPixel,
  panMapViewportByCanvasDelta,
  resolveViewportFrame,
  zoomMapViewportAtCanvasPixel,
} from '../src/core/viewport.js';

function createGraphHeader() {
  return {
    gridWidthPx: 400,
    gridHeightPx: 300,
  };
}

test('zoomMapViewportAtCanvasPixel keeps the anchor point fixed in graph space', () => {
  const graphHeader = createGraphHeader();
  const viewport = createDefaultMapViewport();
  const anchorCanvasX = 160;
  const anchorCanvasY = 120;

  const anchorBefore = mapScreenCanvasPixelToGraphPixel(viewport, anchorCanvasX, anchorCanvasY);
  const zoomedViewport = zoomMapViewportAtCanvasPixel(
    graphHeader,
    viewport,
    anchorCanvasX,
    anchorCanvasY,
    2,
    {
      frameWidthPx: 400,
      frameHeightPx: 300,
    },
  );
  const zoomedFrame = resolveViewportFrame(graphHeader, zoomedViewport, {
    frameWidthPx: 400,
    frameHeightPx: 300,
  });
  const anchorAfter = mapScreenCanvasPixelToGraphPixel(
    zoomedFrame,
    anchorCanvasX,
    anchorCanvasY,
  );

  assert.deepEqual(zoomedViewport, {
    scale: 2,
    offsetXPx: 80,
    offsetYPx: 60,
  });
  assert.equal(anchorAfter.xPx, anchorBefore.xPx);
  assert.equal(anchorAfter.yPx, anchorBefore.yPx);
});

test('panMapViewportByCanvasDelta follows grab direction and clamps to graph bounds', () => {
  const graphHeader = createGraphHeader();
  const viewport = {
    scale: 2,
    offsetXPx: 80,
    offsetYPx: 60,
  };

  const pannedViewport = panMapViewportByCanvasDelta(graphHeader, viewport, 40, 20, {
    frameWidthPx: 400,
    frameHeightPx: 300,
  });
  assert.deepEqual(pannedViewport, {
    scale: 2,
    offsetXPx: 60,
    offsetYPx: 50,
  });

  const clampedViewport = panMapViewportByCanvasDelta(graphHeader, viewport, -1000, -1000, {
    frameWidthPx: 400,
    frameHeightPx: 300,
  });
  assert.deepEqual(clampedViewport, {
    scale: 2,
    offsetXPx: 200,
    offsetYPx: 150,
  });
});

test('resolveViewportFrame centers the graph inside a wider display frame and preserves center-anchor zoom', () => {
  const graphHeader = createGraphHeader();
  const frame = resolveViewportFrame(graphHeader, createDefaultMapViewport(), {
    frameWidthPx: 800,
    frameHeightPx: 300,
  });

  assert.equal(frame.fitScale, 1);
  assert.equal(frame.effectiveScale, 1);
  assert.equal(frame.offsetXPx, -200);
  assert.equal(Object.is(frame.offsetYPx, -0) ? 0 : frame.offsetYPx, 0);

  const anchorCanvasX = 400;
  const anchorCanvasY = 150;
  const anchorBefore = mapScreenCanvasPixelToGraphPixel(frame, anchorCanvasX, anchorCanvasY);
  assert.equal(anchorBefore.xPx, 200);
  assert.equal(anchorBefore.yPx, 150);

  const zoomedViewport = zoomMapViewportAtCanvasPixel(
    graphHeader,
    createDefaultMapViewport(),
    anchorCanvasX,
    anchorCanvasY,
    2,
    {
      frameWidthPx: 800,
      frameHeightPx: 300,
    },
  );
  const zoomedFrame = resolveViewportFrame(graphHeader, zoomedViewport, {
    frameWidthPx: 800,
    frameHeightPx: 300,
  });
  const anchorAfter = mapScreenCanvasPixelToGraphPixel(zoomedFrame, anchorCanvasX, anchorCanvasY);

  assert.equal(anchorAfter.xPx, anchorBefore.xPx);
  assert.equal(anchorAfter.yPx, anchorBefore.yPx);
  assert.equal(zoomedFrame.effectiveScale, 2);
  assert.equal(zoomedFrame.offsetXPx, 0);
});

test('zoomMapViewportAtCanvasPixel keeps the anchor fixed when already clamped at max zoom', () => {
  const graphHeader = createGraphHeader();
  const viewport = {
    scale: 8,
    offsetXPx: 100,
    offsetYPx: 80,
  };
  const anchorCanvasX = 275;
  const anchorCanvasY = 180;
  const frameBefore = resolveViewportFrame(graphHeader, viewport, {
    frameWidthPx: 400,
    frameHeightPx: 300,
    minScale: 1,
    maxScale: 8,
  });
  const anchorBefore = mapScreenCanvasPixelToGraphPixel(frameBefore, anchorCanvasX, anchorCanvasY);

  const zoomedViewport = zoomMapViewportAtCanvasPixel(
    graphHeader,
    viewport,
    anchorCanvasX,
    anchorCanvasY,
    1.25,
    {
      frameWidthPx: 400,
      frameHeightPx: 300,
      minScale: 1,
      maxScale: 8,
    },
  );
  const frameAfter = resolveViewportFrame(graphHeader, zoomedViewport, {
    frameWidthPx: 400,
    frameHeightPx: 300,
    minScale: 1,
    maxScale: 8,
  });
  const anchorAfter = mapScreenCanvasPixelToGraphPixel(frameAfter, anchorCanvasX, anchorCanvasY);

  assert.equal(zoomedViewport.scale, 8);
  assert.equal(anchorAfter.xPx, anchorBefore.xPx);
  assert.equal(anchorAfter.yPx, anchorBefore.yPx);
});
