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

test('resolveViewportFrame fits the (padded) bounding box instead of the full grid when provided', () => {
  // A grid dominated by a far ferry endpoint (400x300), versus a compact
  // 100x100 district boundary sitting in its corner.
  const graphHeader = createGraphHeader();
  const fitBoundingBoxPx = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  const frame = resolveViewportFrame(graphHeader, createDefaultMapViewport(), {
    frameWidthPx: 400,
    frameHeightPx: 400,
    fitBoundingBoxPx,
  });

  // 100 * 1.05 padding = 105; fitting 400px frame against a 105px box.
  assert.equal(frame.fitScale, 400 / 105);
  assert.ok(frame.fitScale > 400 / graphHeader.gridWidthPx);
});

test('resolveViewportFrame falls back to the full grid when fitBoundingBoxPx is absent', () => {
  const graphHeader = createGraphHeader();

  const frame = resolveViewportFrame(graphHeader, createDefaultMapViewport(), {
    frameWidthPx: 400,
    frameHeightPx: 300,
  });

  assert.equal(frame.fitScale, Math.min(400 / graphHeader.gridWidthPx, 300 / graphHeader.gridHeightPx));
});

test('resolveViewportFrame honors a custom fitBoundingBoxPaddingFactor', () => {
  const graphHeader = createGraphHeader();
  const fitBoundingBoxPx = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  const frame = resolveViewportFrame(graphHeader, createDefaultMapViewport(), {
    frameWidthPx: 400,
    frameHeightPx: 400,
    fitBoundingBoxPx,
    fitBoundingBoxPaddingFactor: 2,
  });

  assert.equal(frame.fitScale, 400 / 200);
});

test('a scale below 1 relative to the boundary fit can still reach the full grid', () => {
  // Production code (canvas-routing.js) keeps minScale fixed at 1 so the
  // boundary+padding view is the hard zoom-out limit - but the underlying
  // math should still be consistent if a caller ever wants to compute a
  // scale that reaches the full grid from the boundary-relative baseline.
  const graphHeader = createGraphHeader();
  const fitBoundingBoxPx = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const gridFitScale = Math.min(400 / graphHeader.gridWidthPx, 400 / graphHeader.gridHeightPx);

  const boundaryFrame = resolveViewportFrame(graphHeader, createDefaultMapViewport(), {
    frameWidthPx: 400,
    frameHeightPx: 400,
    fitBoundingBoxPx,
  });
  const scaleToReachFullGrid = gridFitScale / boundaryFrame.fitScale;

  const zoomedOutFrame = resolveViewportFrame(
    graphHeader,
    { scale: scaleToReachFullGrid, offsetXPx: 0, offsetYPx: 0 },
    {
      frameWidthPx: 400,
      frameHeightPx: 400,
      fitBoundingBoxPx,
      minScale: scaleToReachFullGrid,
    },
  );

  assert.ok(Math.abs(zoomedOutFrame.effectiveScale - gridFitScale) < 1e-9);
});

test('createDefaultMapViewport centers on the boundary box instead of the grid origin', () => {
  // A ferry-widened grid (2000x2000) with the actual district boundary
  // sitting far from (0,0), e.g. near the top-right corner - the bug this
  // guards against: panning to (0,0) by default would show empty space
  // nowhere near the region (as happened for Rhode Island).
  const graphHeader = { gridWidthPx: 2000, gridHeightPx: 2000 };
  const fitBoundingBoxPx = { minX: 1700, minY: 100, maxX: 1900, maxY: 300 };

  const defaultViewport = createDefaultMapViewport({ fitBoundingBoxPx });
  const frame = resolveViewportFrame(graphHeader, defaultViewport, {
    frameWidthPx: 400,
    frameHeightPx: 400,
    fitBoundingBoxPx,
  });

  const boxCenterX = (fitBoundingBoxPx.minX + fitBoundingBoxPx.maxX) / 2;
  const boxCenterY = (fitBoundingBoxPx.minY + fitBoundingBoxPx.maxY) / 2;
  const visibleCenterX = frame.offsetXPx + frame.visibleWidthPx / 2;
  const visibleCenterY = frame.offsetYPx + frame.visibleHeightPx / 2;

  // The visible window's center should land on (or very near) the
  // boundary's own center, not the grid's top-left corner.
  assert.ok(Math.abs(visibleCenterX - boxCenterX) < 50);
  assert.ok(Math.abs(visibleCenterY - boxCenterY) < 50);
});

test('panning is held to the padded fit box, not the routing grid', () => {
  // Portsmouth's grid spans a ferry route to France; the city sits in a small
  // corner of it. Panning used to range over the whole grid, so you could
  // scroll out along a line that leaves the map and find nothing there.
  const graphHeader = { gridWidthPx: 20570, gridHeightPx: 24802 };
  const fitBoundingBoxPx = { minX: 11000, minY: 23000, maxX: 12130, maxY: 24230 };
  const options = { frameWidthPx: 800, frameHeightPx: 600, fitBoundingBoxPx };

  // Try to pan far past the box, towards the far end of the ferry line.
  const frame = resolveViewportFrame(
    graphHeader,
    { scale: 4, offsetXPx: 0, offsetYPx: 0 },
    options,
  );

  assert.ok(frame.offsetXPx >= 10000, `panned off the box: ${frame.offsetXPx}`);
  assert.ok(frame.offsetYPx >= 22000, `panned off the box: ${frame.offsetYPx}`);

  const farFrame = resolveViewportFrame(
    graphHeader,
    { scale: 4, offsetXPx: 20000, offsetYPx: 24000 },
    options,
  );
  assert.ok(farFrame.offsetXPx + farFrame.visibleWidthPx <= 12200);
  assert.ok(farFrame.offsetYPx + farFrame.visibleHeightPx <= 24300);
});

test('without a fit box panning still ranges over the whole grid', () => {
  const graphHeader = { gridWidthPx: 1000, gridHeightPx: 800 };
  const options = { frameWidthPx: 400, frameHeightPx: 300 };

  const frame = resolveViewportFrame(
    graphHeader,
    { scale: 4, offsetXPx: 100000, offsetYPx: 100000 },
    options,
  );

  assert.ok(frame.offsetXPx + frame.visibleWidthPx <= 1000 + 1e-6);
  assert.ok(frame.offsetYPx + frame.visibleHeightPx <= 800 + 1e-6);
});
