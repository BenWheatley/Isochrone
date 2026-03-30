const DEFAULT_MAX_VIEWPORT_SCALE = 8;
const DEFAULT_MIN_VIEWPORT_SCALE = 1;

export function createDefaultMapViewport() {
  return {
    scale: 1,
    offsetXPx: 0,
    offsetYPx: 0,
  };
}

export function normalizeMapViewport(graphHeader, viewport = null, options = {}) {
  const frame = resolveViewportFrame(graphHeader, viewport, options);
  return {
    scale: frame.scale,
    offsetXPx: frame.offsetXPx,
    offsetYPx: frame.offsetYPx,
  };
}

export function resolveViewportFrame(graphHeader, viewport = null, options = {}) {
  validateGraphViewportHeader(graphHeader);

  const minScale = Number.isFinite(options.minScale) ? options.minScale : DEFAULT_MIN_VIEWPORT_SCALE;
  const maxScale = Number.isFinite(options.maxScale) ? options.maxScale : DEFAULT_MAX_VIEWPORT_SCALE;
  if (!(minScale > 0) || !(maxScale >= minScale)) {
    throw new Error('viewport scale bounds are invalid');
  }

  const frameWidthPx = validatePositiveFinite(
    options.frameWidthPx ?? graphHeader.gridWidthPx,
    'frameWidthPx',
  );
  const frameHeightPx = validatePositiveFinite(
    options.frameHeightPx ?? graphHeader.gridHeightPx,
    'frameHeightPx',
  );
  const sourceViewport =
    viewport && typeof viewport === 'object' ? viewport : createDefaultMapViewport();
  const scale = clamp(asFiniteOrFallback(sourceViewport.scale, 1), minScale, maxScale);
  const fitScale = Math.min(
    frameWidthPx / graphHeader.gridWidthPx,
    frameHeightPx / graphHeader.gridHeightPx,
  );
  if (!(fitScale > 0)) {
    throw new Error('fitScale must be positive');
  }
  const effectiveScale = fitScale * scale;
  const visibleWidthPx = frameWidthPx / effectiveScale;
  const visibleHeightPx = frameHeightPx / effectiveScale;

  return {
    scale,
    offsetXPx: normalizeViewportAxis(
      asFiniteOrFallback(sourceViewport.offsetXPx, 0),
      graphHeader.gridWidthPx,
      visibleWidthPx,
    ),
    offsetYPx: normalizeViewportAxis(
      asFiniteOrFallback(sourceViewport.offsetYPx, 0),
      graphHeader.gridHeightPx,
      visibleHeightPx,
    ),
    frameWidthPx,
    frameHeightPx,
    fitScale,
    effectiveScale,
    visibleWidthPx,
    visibleHeightPx,
  };
}

export function mapScreenCanvasPixelToGraphPixel(viewportOrFrame, screenCanvasX, screenCanvasY) {
  const resolvedViewport = validateViewportOrFrame(viewportOrFrame);
  if (!Number.isFinite(screenCanvasX) || !Number.isFinite(screenCanvasY)) {
    throw new Error('screenCanvasX and screenCanvasY must be finite numbers');
  }

  return {
    xPx: resolvedViewport.offsetXPx + screenCanvasX / resolvedViewport.effectiveScale,
    yPx: resolvedViewport.offsetYPx + screenCanvasY / resolvedViewport.effectiveScale,
  };
}

export function panMapViewportByCanvasDelta(graphHeader, viewport, deltaCanvasX, deltaCanvasY, options = {}) {
  if (!Number.isFinite(deltaCanvasX) || !Number.isFinite(deltaCanvasY)) {
    throw new Error('deltaCanvasX and deltaCanvasY must be finite numbers');
  }
  const frame = resolveViewportFrame(graphHeader, viewport, options);
  return normalizeMapViewport(
    graphHeader,
    {
      scale: frame.scale,
      offsetXPx: frame.offsetXPx - deltaCanvasX / frame.effectiveScale,
      offsetYPx: frame.offsetYPx - deltaCanvasY / frame.effectiveScale,
    },
    options,
  );
}

export function zoomMapViewportAtCanvasPixel(
  graphHeader,
  viewport,
  anchorCanvasX,
  anchorCanvasY,
  zoomFactor,
  options = {},
) {
  if (!Number.isFinite(anchorCanvasX) || !Number.isFinite(anchorCanvasY)) {
    throw new Error('anchorCanvasX and anchorCanvasY must be finite numbers');
  }
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    throw new Error('zoomFactor must be a positive finite number');
  }

  const minScale = Number.isFinite(options.minScale) ? options.minScale : DEFAULT_MIN_VIEWPORT_SCALE;
  const maxScale = Number.isFinite(options.maxScale) ? options.maxScale : DEFAULT_MAX_VIEWPORT_SCALE;
  if (!(minScale > 0) || !(maxScale >= minScale)) {
    throw new Error('viewport scale bounds are invalid');
  }

  const frame = resolveViewportFrame(graphHeader, viewport, options);
  const anchorGraphPx = mapScreenCanvasPixelToGraphPixel(frame, anchorCanvasX, anchorCanvasY);
  const nextScale = clamp(frame.scale * zoomFactor, minScale, maxScale);
  const nextFitScale = frame.fitScale * nextScale;
  return normalizeMapViewport(
    graphHeader,
    {
      scale: nextScale,
      offsetXPx: anchorGraphPx.xPx - anchorCanvasX / nextFitScale,
      offsetYPx: anchorGraphPx.yPx - anchorCanvasY / nextFitScale,
    },
    options,
  );
}

function validateGraphViewportHeader(graphHeader) {
  if (!graphHeader || typeof graphHeader !== 'object') {
    throw new Error('graphHeader is required');
  }
  if (!Number.isFinite(graphHeader.gridWidthPx) || graphHeader.gridWidthPx <= 0) {
    throw new Error('graphHeader.gridWidthPx must be positive');
  }
  if (!Number.isFinite(graphHeader.gridHeightPx) || graphHeader.gridHeightPx <= 0) {
    throw new Error('graphHeader.gridHeightPx must be positive');
  }
}

function validateViewportOrFrame(viewport) {
  if (!viewport || typeof viewport !== 'object') {
    throw new Error('viewport is required');
  }
  const effectiveScale =
    Number.isFinite(viewport.effectiveScale) && viewport.effectiveScale > 0
      ? viewport.effectiveScale
      : validatePositiveFinite(viewport.scale, 'viewport.scale');
  if (!Number.isFinite(viewport.offsetXPx) || !Number.isFinite(viewport.offsetYPx)) {
    throw new Error('viewport offsets must be finite');
  }
  return {
    offsetXPx: viewport.offsetXPx,
    offsetYPx: viewport.offsetYPx,
    effectiveScale,
  };
}

function validatePositiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}

function normalizeViewportAxis(sourceOffsetPx, graphSpanPx, visibleSpanPx) {
  if (visibleSpanPx >= graphSpanPx) {
    const centeredOffsetPx = -(visibleSpanPx - graphSpanPx) / 2;
    return Math.abs(centeredOffsetPx) < Number.EPSILON ? 0 : centeredOffsetPx;
  }
  return clamp(sourceOffsetPx, 0, graphSpanPx - visibleSpanPx);
}

function asFiniteOrFallback(value, fallbackValue) {
  return Number.isFinite(value) ? value : fallbackValue;
}

function clamp(value, minValue, maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}
