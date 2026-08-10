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

export function validateTravelTimeGrid(travelTimeGrid) {
  if (!travelTimeGrid || typeof travelTimeGrid !== 'object') {
    throw new Error('travelTimeGrid must be an object');
  }
  if (!Number.isInteger(travelTimeGrid.widthPx) || travelTimeGrid.widthPx <= 0) {
    throw new Error('travelTimeGrid.widthPx must be a positive integer');
  }
  if (!Number.isInteger(travelTimeGrid.heightPx) || travelTimeGrid.heightPx <= 0) {
    throw new Error('travelTimeGrid.heightPx must be a positive integer');
  }
  if (!(travelTimeGrid.seconds instanceof Float32Array)) {
    throw new Error('travelTimeGrid.seconds must be a Float32Array');
  }
  const expectedLength = travelTimeGrid.widthPx * travelTimeGrid.heightPx;
  if (travelTimeGrid.seconds.length !== expectedLength) {
    throw new Error(
      `travelTimeGrid.seconds length mismatch: got ${travelTimeGrid.seconds.length}, expected ${expectedLength}`,
    );
  }
}

export function createPixelGrid(widthPx, heightPx) {
  if (!Number.isInteger(widthPx) || widthPx <= 0) {
    throw new Error('pixel grid width must be a positive integer');
  }
  if (!Number.isInteger(heightPx) || heightPx <= 0) {
    throw new Error('pixel grid height must be a positive integer');
  }

  return {
    widthPx,
    heightPx,
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

  if (xPx < 0 || yPx < 0 || xPx >= pixelGrid.widthPx || yPx >= pixelGrid.heightPx) {
    return false;
  }

  const offset = (yPx * pixelGrid.widthPx + xPx) * 4;
  pixelGrid.rgba[offset] = r;
  pixelGrid.rgba[offset + 1] = g;
  pixelGrid.rgba[offset + 2] = b;
  pixelGrid.rgba[offset + 3] = a;
  return true;
}

export function createTravelTimeGrid(widthPx, heightPx) {
  if (!Number.isInteger(widthPx) || widthPx <= 0) {
    throw new Error('travel time grid width must be a positive integer');
  }
  if (!Number.isInteger(heightPx) || heightPx <= 0) {
    throw new Error('travel time grid height must be a positive integer');
  }

  return {
    widthPx,
    heightPx,
    seconds: new Float32Array(widthPx * heightPx),
  };
}

export function clearTravelTimeGrid(travelTimeGrid) {
  validateTravelTimeGrid(travelTimeGrid);
  travelTimeGrid.seconds.fill(-1);
}

export function setTravelTimePixelMin(travelTimeGrid, xPx, yPx, seconds) {
  validateTravelTimeGrid(travelTimeGrid);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return false;
  }
  if (xPx < 0 || yPx < 0 || xPx >= travelTimeGrid.widthPx || yPx >= travelTimeGrid.heightPx) {
    return false;
  }

  const offset = yPx * travelTimeGrid.widthPx + xPx;
  const currentSeconds = travelTimeGrid.seconds[offset];
  if (currentSeconds < 0 || seconds < currentSeconds) {
    travelTimeGrid.seconds[offset] = seconds;
    return true;
  }
  return false;
}
