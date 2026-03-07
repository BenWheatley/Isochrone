export const DEFAULT_BOUNDARY_BASEMAP_URL =
  '../data_pipeline/output/berlin-district-boundaries-canvas.json';

export function minutesToSeconds(minutes) {
  if (minutes < 0) {
    throw new Error('minutes must be non-negative');
  }

  return Math.round(minutes * 60);
}

export function initializeAppShell(doc) {
  const resolvedDocument = doc ?? globalThis.document;
  if (!resolvedDocument) {
    throw new Error('document is not available');
  }

  const mapCanvas = resolvedDocument.getElementById('map');
  const boundaryCanvas = resolvedDocument.getElementById('boundaries');
  const loadingOverlay = resolvedDocument.getElementById('loading');

  if (!mapCanvas || mapCanvas.tagName !== 'CANVAS') {
    throw new Error('index.html is missing <canvas id="map">');
  }
  if (!boundaryCanvas || boundaryCanvas.tagName !== 'CANVAS') {
    throw new Error('index.html is missing <canvas id="boundaries">');
  }
  if (!loadingOverlay || loadingOverlay.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="loading">');
  }

  sizeCanvasToCssPixels(mapCanvas);
  sizeCanvasToCssPixels(boundaryCanvas);

  loadingOverlay.hidden = false;
  loadingOverlay.textContent = 'Loading district boundaries...';

  return { mapCanvas, boundaryCanvas, loadingOverlay };
}

export function parseBoundaryBasemapPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('boundary payload must be an object');
  }

  const coordinateSpace = payload.coordinate_space;
  if (!coordinateSpace || typeof coordinateSpace !== 'object') {
    throw new Error('boundary payload is missing coordinate_space');
  }

  const width = asFiniteNumber(coordinateSpace.width, 'coordinate_space.width');
  const height = asFiniteNumber(coordinateSpace.height, 'coordinate_space.height');

  if (width <= 0 || height <= 0) {
    throw new Error('coordinate_space width/height must be positive');
  }

  const rawFeatures = payload.features;
  if (!Array.isArray(rawFeatures)) {
    throw new Error('boundary payload is missing features[]');
  }

  const features = rawFeatures
    .map((feature, featureIndex) => {
      if (!feature || typeof feature !== 'object') {
        throw new Error(`features[${featureIndex}] must be an object`);
      }

      const name = typeof feature.name === 'string' ? feature.name : `feature_${featureIndex}`;
      const relationId = Number.isFinite(feature.relation_id) ? feature.relation_id : null;

      if (!Array.isArray(feature.paths)) {
        throw new Error(`features[${featureIndex}].paths must be an array`);
      }

      const paths = feature.paths
        .map((path, pathIndex) => {
          if (!Array.isArray(path)) {
            throw new Error(`features[${featureIndex}].paths[${pathIndex}] must be an array`);
          }

          const points = path.map((point, pointIndex) =>
            parseCoordinatePair(
              point,
              `features[${featureIndex}].paths[${pathIndex}][${pointIndex}]`,
            ),
          );

          return points;
        })
        .filter((path) => path.length >= 2);

      return {
        name,
        relationId,
        paths,
      };
    })
    .filter((feature) => feature.paths.length > 0);

  if (features.length === 0) {
    throw new Error('boundary payload has no drawable paths');
  }

  return {
    coordinateSpace: {
      width,
      height,
    },
    features,
  };
}

export function createBoundaryCanvasTransform(coordinateSpace, canvasWidth, canvasHeight) {
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error('canvas width/height must be positive');
  }

  const scale = Math.min(
    canvasWidth / coordinateSpace.width,
    canvasHeight / coordinateSpace.height,
  );
  const offsetX = (canvasWidth - coordinateSpace.width * scale) / 2;
  const offsetY = (canvasHeight - coordinateSpace.height * scale) / 2;

  return { scale, offsetX, offsetY };
}

export function mapBoundaryPathToCanvas(path, transform) {
  return path.map(([x, y]) => [
    transform.offsetX + x * transform.scale,
    transform.offsetY + y * transform.scale,
  ]);
}

export function drawBoundaryBasemap(boundaryCanvas, payload) {
  if (!boundaryCanvas || typeof boundaryCanvas.getContext !== 'function') {
    throw new Error('boundaryCanvas must provide getContext("2d")');
  }

  sizeCanvasToCssPixels(boundaryCanvas);

  const parsed = parseBoundaryBasemapPayload(payload);
  const context = boundaryCanvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to get 2D context for boundary canvas');
  }

  const transform = createBoundaryCanvasTransform(
    parsed.coordinateSpace,
    boundaryCanvas.width,
    boundaryCanvas.height,
  );

  context.clearRect(0, 0, boundaryCanvas.width, boundaryCanvas.height);
  context.fillStyle = 'rgba(19, 94, 137, 0.10)';
  context.strokeStyle = 'rgba(19, 94, 137, 0.85)';
  context.lineWidth = 1.2;
  context.lineJoin = 'round';
  context.lineCap = 'round';

  let renderedPathCount = 0;

  for (const feature of parsed.features) {
    for (const path of feature.paths) {
      const mappedPath = mapBoundaryPathToCanvas(path, transform);
      if (mappedPath.length < 2) {
        continue;
      }

      context.beginPath();
      context.moveTo(mappedPath[0][0], mappedPath[0][1]);
      for (let i = 1; i < mappedPath.length; i += 1) {
        context.lineTo(mappedPath[i][0], mappedPath[i][1]);
      }

      if (isClosedPath(mappedPath)) {
        context.closePath();
        context.fill();
      }

      context.stroke();
      renderedPathCount += 1;
    }
  }

  return {
    featureCount: parsed.features.length,
    pathCount: renderedPathCount,
  };
}

export async function loadAndRenderBoundaryBasemap(shell, options = {}) {
  const url = options.url ?? DEFAULT_BOUNDARY_BASEMAP_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available');
  }

  shell.loadingOverlay.textContent = 'Loading district boundaries...';
  shell.loadingOverlay.hidden = false;

  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`failed to fetch district boundaries: HTTP ${response.status}`);
    }

    const payload = await response.json();
    const renderSummary = drawBoundaryBasemap(shell.boundaryCanvas, payload);

    shell.loadingOverlay.textContent = 'Map ready.';
    shell.loadingOverlay.hidden = true;
    return renderSummary;
  } catch (error) {
    shell.loadingOverlay.hidden = false;
    shell.loadingOverlay.textContent = 'Failed to load district boundaries.';
    throw error;
  }
}

function sizeCanvasToCssPixels(canvas) {
  if (typeof canvas.getBoundingClientRect !== 'function') {
    return;
  }

  const { width, height } = canvas.getBoundingClientRect();
  if (width < 2 || height < 2) {
    return;
  }

  const nextWidth = Math.round(width);
  const nextHeight = Math.round(height);

  if (canvas.width !== nextWidth) {
    canvas.width = nextWidth;
  }
  if (canvas.height !== nextHeight) {
    canvas.height = nextHeight;
  }
}

function parseCoordinatePair(value, context) {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${context} must be [x, y]`);
  }

  const x = asFiniteNumber(value[0], `${context}[0]`);
  const y = asFiniteNumber(value[1], `${context}[1]`);
  return [x, y];
}

function asFiniteNumber(value, context) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}

function isClosedPath(path) {
  if (path.length < 3) {
    return false;
  }

  const first = path[0];
  const last = path[path.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

if (typeof window !== 'undefined' && typeof globalThis.document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const shell = initializeAppShell(globalThis.document);
    void loadAndRenderBoundaryBasemap(shell).catch((error) => {
      console.error(error);
    });
  });
}
