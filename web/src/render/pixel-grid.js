// CPU-side raster targets the renderers paint into: an RGBA pixel grid for
// the 2D canvas path, and a parallel grid of travel-time seconds for the GPU
// path (which colours from seconds in a shader rather than storing RGBA).
// Kept together with their validators and the canvas-sizing helper because
// they are the shared vocabulary every render path speaks.


export function syncCanvasToDisplaySize(canvas) {
  if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
    return false;
  }

  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return false;
  }

  const nextWidth = Math.max(1, Math.round(rect.width));
  const nextHeight = Math.max(1, Math.round(rect.height));
  const sizeChanged = canvas.width !== nextWidth || canvas.height !== nextHeight;
  if (sizeChanged) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
  }
  return sizeChanged;
}

export function validatePixelGrid(pixelGrid) {
  if (!pixelGrid || typeof pixelGrid !== 'object') {
    throw new Error('pixelGrid must be an object');
  }
  if (!Number.isInteger(pixelGrid.widthPx) || pixelGrid.widthPx <= 0) {
    throw new Error('pixelGrid.widthPx must be a positive integer');
  }
  if (!Number.isInteger(pixelGrid.heightPx) || pixelGrid.heightPx <= 0) {
    throw new Error('pixelGrid.heightPx must be a positive integer');
  }
  if (!(pixelGrid.rgba instanceof Uint8ClampedArray)) {
    throw new Error('pixelGrid.rgba must be a Uint8ClampedArray');
  }
  const expectedLength = pixelGrid.widthPx * pixelGrid.heightPx * 4;
  if (pixelGrid.rgba.length !== expectedLength) {
    throw new Error(
      `pixelGrid.rgba length mismatch: got ${pixelGrid.rgba.length}, expected ${expectedLength}`,
    );
  }
}


// Render grids are sized to what can actually be shown, not to the routing
// graph. Those differ wildly: a region whose ferries reach another country has
// a routing grid hundreds of kilometres across, while the map never zooms out
// past its own boundary. Portsmouth's graph is 20570 x 24802 cells - 2 GB as
// floats, and wider than any GPU will accept as a texture - for a city about
// 15 km across.
//
// Writes still arrive in graph pixel coordinates; the grid subtracts its
// origin, and anything outside falls out through the bounds check that was
// already there.

/** Largest render grid we will allocate, in cells (~64 MB as Float32). */
export const MAX_RENDER_GRID_CELLS = 16_000_000;

/**
 * Conservative cap on one grid axis. GL_MAX_TEXTURE_SIZE is 16384 on most
 * hardware and the travel-time grid is uploaded as a single texture, so a
 * wider grid could never be drawn even if it fitted in memory.
 */
export const MAX_RENDER_GRID_AXIS = 16_384;

function normalizeGridOrigin(options = {}) {
  const originXPx = Number.isInteger(options.originXPx) ? options.originXPx : 0;
  const originYPx = Number.isInteger(options.originYPx) ? options.originYPx : 0;
  return { originXPx, originYPx };
}

/**
 * The slice of graph pixel space a render grid needs to cover: the map's
 * most-zoomed-out view, clipped to the graph and to the budget above.
 *
 * Returns graph-pixel origin and size, so a caller can both allocate the grid
 * and translate draw coordinates into it.
 */
export function computeRenderGridExtent(graphHeader, fitBoundingBoxPx = null, options = {}) {
  const gridWidthPx = graphHeader?.gridWidthPx;
  const gridHeightPx = graphHeader?.gridHeightPx;
  if (!Number.isInteger(gridWidthPx) || gridWidthPx <= 0) {
    throw new Error('graphHeader.gridWidthPx must be a positive integer');
  }
  if (!Number.isInteger(gridHeightPx) || gridHeightPx <= 0) {
    throw new Error('graphHeader.gridHeightPx must be a positive integer');
  }
  const maxCells = Number.isFinite(options.maxCells) && options.maxCells > 0
    ? options.maxCells
    : MAX_RENDER_GRID_CELLS;
  const maxAxis = Number.isFinite(options.maxAxis) && options.maxAxis > 0
    ? options.maxAxis
    : MAX_RENDER_GRID_AXIS;

  let originXPx = 0;
  let originYPx = 0;
  let widthPx = gridWidthPx;
  let heightPx = gridHeightPx;

  if (
    fitBoundingBoxPx
    && Number.isFinite(fitBoundingBoxPx.minX)
    && Number.isFinite(fitBoundingBoxPx.minY)
    && Number.isFinite(fitBoundingBoxPx.maxX)
    && Number.isFinite(fitBoundingBoxPx.maxY)
  ) {
    // Pad to match the viewport's own fit padding, so the grid covers
    // everything the default view shows rather than stopping at its edge.
    const padding = Number.isFinite(options.paddingFactor) ? options.paddingFactor : 0.1;
    const boxWidth = Math.max(1, fitBoundingBoxPx.maxX - fitBoundingBoxPx.minX);
    const boxHeight = Math.max(1, fitBoundingBoxPx.maxY - fitBoundingBoxPx.minY);
    const padX = boxWidth * padding;
    const padY = boxHeight * padding;
    const minX = Math.max(0, Math.floor(fitBoundingBoxPx.minX - padX));
    const minY = Math.max(0, Math.floor(fitBoundingBoxPx.minY - padY));
    const maxX = Math.min(gridWidthPx, Math.ceil(fitBoundingBoxPx.maxX + padX));
    const maxY = Math.min(gridHeightPx, Math.ceil(fitBoundingBoxPx.maxY + padY));
    if (maxX > minX && maxY > minY) {
      originXPx = minX;
      originYPx = minY;
      widthPx = maxX - minX;
      heightPx = maxY - minY;
    }
  }

  // Budget. Clipping rather than downsampling keeps grid coordinates equal to
  // graph coordinates minus the origin, which is what lets every existing
  // painter carry on unchanged.
  widthPx = Math.min(widthPx, maxAxis);
  heightPx = Math.min(heightPx, maxAxis);
  if (widthPx * heightPx > maxCells) {
    const shrink = Math.sqrt(maxCells / (widthPx * heightPx));
    widthPx = Math.max(1, Math.floor(widthPx * shrink));
    heightPx = Math.max(1, Math.floor(heightPx * shrink));
  }

  return { originXPx, originYPx, widthPx, heightPx };
}

export function createPixelGrid(widthPx, heightPx, options = {}) {
  if (!Number.isInteger(widthPx) || widthPx <= 0) {
    throw new Error('pixel grid width must be a positive integer');
  }
  if (!Number.isInteger(heightPx) || heightPx <= 0) {
    throw new Error('pixel grid height must be a positive integer');
  }

  return {
    widthPx,
    heightPx,
    ...normalizeGridOrigin(options),
    rgba: new Uint8ClampedArray(widthPx * heightPx * 4),
  };
}

export function clearGrid(pixelGrid) {
  validatePixelGrid(pixelGrid);
  for (let i = 3; i < pixelGrid.rgba.length; i += 4) {
    pixelGrid.rgba[i] = 0;
  }
}

export function setPixel(pixelGrid, xPx, yPx, r, g, b, a) {
  validatePixelGrid(pixelGrid);

  const localX = xPx - (pixelGrid.originXPx ?? 0);
  const localY = yPx - (pixelGrid.originYPx ?? 0);
  if (localX < 0 || localY < 0 || localX >= pixelGrid.widthPx || localY >= pixelGrid.heightPx) {
    return false;
  }

  const offset = (localY * pixelGrid.widthPx + localX) * 4;
  pixelGrid.rgba[offset] = r;
  pixelGrid.rgba[offset + 1] = g;
  pixelGrid.rgba[offset + 2] = b;
  pixelGrid.rgba[offset + 3] = a;
  return true;
}
