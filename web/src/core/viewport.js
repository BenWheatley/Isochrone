const DEFAULT_MAX_VIEWPORT_SCALE = 8;
const DEFAULT_MIN_VIEWPORT_SCALE = 1;
const DEFAULT_FIT_BOUNDING_BOX_PADDING_FACTOR = 1.05;

/**
 * scale:1/offsetXPx:0/offsetYPx:0 means "top-left of the full routing
 * grid" - fine when there's no fitBoundingBoxPx (resolveViewportFrame's
 * fitScale then already covers the whole grid), but wrong once fitScale is
 * computed from a district boundary that can sit anywhere within a
 * ferry-widened grid (see resolveFitScale below): panning to (0,0) would
 * show whatever's in the grid's top-left corner, not the boundary. When
 * options.fitBoundingBoxPx is supplied, offset the default viewport to the
 * padded box's own top-left corner instead, so it lines up with what
 * resolveViewportFrame will actually zoom in on.
 */
export function createDefaultMapViewport(options = {}) {
  const fitBoundingBoxPx = options.fitBoundingBoxPx ?? null;
  if (!fitBoundingBoxPx) {
    return {
      scale: 1,
      offsetXPx: 0,
      offsetYPx: 0,
    };
  }

  const paddingFactor = Number.isFinite(options.fitBoundingBoxPaddingFactor)
    ? options.fitBoundingBoxPaddingFactor
    : DEFAULT_FIT_BOUNDING_BOX_PADDING_FACTOR;
  const centerX = (fitBoundingBoxPx.minX + fitBoundingBoxPx.maxX) / 2;
  const centerY = (fitBoundingBoxPx.minY + fitBoundingBoxPx.maxY) / 2;
  const paddedHalfWidthPx = ((fitBoundingBoxPx.maxX - fitBoundingBoxPx.minX) * paddingFactor) / 2;
  const paddedHalfHeightPx = ((fitBoundingBoxPx.maxY - fitBoundingBoxPx.minY) * paddingFactor) / 2;

  return {
    scale: 1,
    offsetXPx: centerX - paddedHalfWidthPx,
    offsetYPx: centerY - paddedHalfHeightPx,
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
    viewport && typeof viewport === 'object'
      ? viewport
      : createDefaultMapViewport({
          fitBoundingBoxPx: options.fitBoundingBoxPx,
          fitBoundingBoxPaddingFactor: options.fitBoundingBoxPaddingFactor,
        });
  const scale = clamp(asFiniteOrFallback(sourceViewport.scale, 1), minScale, maxScale);
  const fitScale = resolveFitScale(graphHeader, frameWidthPx, frameHeightPx, options);
  if (!(fitScale > 0)) {
    throw new Error('fitScale must be positive');
  }
  const effectiveScale = fitScale * scale;
  const visibleWidthPx = frameWidthPx / effectiveScale;
  const visibleHeightPx = frameHeightPx / effectiveScale;

  // Panning is bounded by the same box the zoom-out limit uses, not by the
  // routing grid. A region whose ferries reach another country has a grid
  // hundreds of kilometres wide, and being able to scroll out to the far end
  // of a line that leaves the map shows nothing but empty space.
  const panBounds = resolvePanBounds(graphHeader, options);

  return {
    scale,
    offsetXPx: normalizeViewportAxis(
      asFiniteOrFallback(sourceViewport.offsetXPx, 0),
      panBounds.minXPx,
      panBounds.maxXPx,
      visibleWidthPx,
    ),
    offsetYPx: normalizeViewportAxis(
      asFiniteOrFallback(sourceViewport.offsetYPx, 0),
      panBounds.minYPx,
      panBounds.maxYPx,
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

/**
 * scale=1 normally means "the whole routing grid fits the frame" - but a
 * region's routing grid can be dominated by far-flung ferry endpoints well
 * beyond the area anyone actually wants to see by default (see
 * osm_graph_extract.py's grid-size-budgeted ferry inclusion). When
 * options.fitBoundingBoxPx is supplied (the district boundary's own pixel
 * bounding box, padded), scale=1 instead means "that boundary fits the
 * frame" - minScale/maxScale are untouched, so the zoom-out limit becomes
 * the boundary view itself. Panning is held to the same padded box (see
 * resolvePanBounds), so a ferry-widened region cannot scroll far past
 * anything worth looking at.
 */
function resolveFitScale(graphHeader, frameWidthPx, frameHeightPx, options) {
  const fitBoundingBoxPx = options.fitBoundingBoxPx ?? null;
  if (!fitBoundingBoxPx) {
    return Math.min(frameWidthPx / graphHeader.gridWidthPx, frameHeightPx / graphHeader.gridHeightPx);
  }

  const paddingFactor = Number.isFinite(options.fitBoundingBoxPaddingFactor)
    ? options.fitBoundingBoxPaddingFactor
    : DEFAULT_FIT_BOUNDING_BOX_PADDING_FACTOR;
  const boxWidthPx = Math.max(1, (fitBoundingBoxPx.maxX - fitBoundingBoxPx.minX) * paddingFactor);
  const boxHeightPx = Math.max(1, (fitBoundingBoxPx.maxY - fitBoundingBoxPx.minY) * paddingFactor);
  return Math.min(frameWidthPx / boxWidthPx, frameHeightPx / boxHeightPx);
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

function normalizeViewportAxis(sourceOffsetPx, minPx, maxPx, visibleSpanPx) {
  const spanPx = maxPx - minPx;
  if (visibleSpanPx >= spanPx) {
    // The whole box fits: centre it rather than pinning it to an edge.
    const centeredOffsetPx = minPx - (visibleSpanPx - spanPx) / 2;
    return Math.abs(centeredOffsetPx) < Number.EPSILON ? 0 : centeredOffsetPx;
  }
  return clamp(sourceOffsetPx, minPx, maxPx - visibleSpanPx);
}

/**
 * The graph-pixel box panning may not leave.
 *
 * Defaults to the whole grid, so a region without a fit box behaves as before;
 * with one, panning is held to the padded box that also sets the zoom-out
 * limit.
 */
function resolvePanBounds(graphHeader, options = {}) {
  const fitBoundingBoxPx = options.fitBoundingBoxPx ?? null;
  if (
    !fitBoundingBoxPx
    || !Number.isFinite(fitBoundingBoxPx.minX)
    || !Number.isFinite(fitBoundingBoxPx.minY)
    || !Number.isFinite(fitBoundingBoxPx.maxX)
    || !Number.isFinite(fitBoundingBoxPx.maxY)
  ) {
    return { minXPx: 0, minYPx: 0, maxXPx: graphHeader.gridWidthPx, maxYPx: graphHeader.gridHeightPx };
  }

  const paddingFactor = Number.isFinite(options.fitBoundingBoxPaddingFactor)
    ? options.fitBoundingBoxPaddingFactor
    : DEFAULT_FIT_BOUNDING_BOX_PADDING_FACTOR;
  const boxWidthPx = Math.max(1, fitBoundingBoxPx.maxX - fitBoundingBoxPx.minX);
  const boxHeightPx = Math.max(1, fitBoundingBoxPx.maxY - fitBoundingBoxPx.minY);
  // Same padding the fit scale applies, so the pannable area matches exactly
  // what the most-zoomed-out view shows.
  const padXPx = (boxWidthPx * paddingFactor - boxWidthPx) / 2;
  const padYPx = (boxHeightPx * paddingFactor - boxHeightPx) / 2;
  return {
    minXPx: fitBoundingBoxPx.minX - padXPx,
    minYPx: fitBoundingBoxPx.minY - padYPx,
    maxXPx: fitBoundingBoxPx.maxX + padXPx,
    maxYPx: fitBoundingBoxPx.maxY + padYPx,
  };
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
