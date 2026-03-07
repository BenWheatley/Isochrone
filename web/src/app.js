export const DEFAULT_BOUNDARY_BASEMAP_URL =
  '../data_pipeline/output/berlin-district-boundaries-canvas.json';
export const DEFAULT_GRAPH_BINARY_URL = '../data_pipeline/output/graph-walk.bin';
export const GRAPH_MAGIC = 0x49534f43;

const HEADER_SIZE = 64;
const NODE_RECORD_SIZE = 16;
const EDGE_RECORD_SIZE = 12;
const BYTES_PER_MEBIBYTE = 1024 * 1024;

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

  mapCanvas.style.pointerEvents = 'none';
  mapCanvas.dataset.graphLoaded = 'false';
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

    shell.loadingOverlay.textContent = 'Loading graph: 0.00 MB';
    shell.loadingOverlay.hidden = false;
    return renderSummary;
  } catch (error) {
    shell.loadingOverlay.hidden = false;
    shell.loadingOverlay.textContent = 'Failed to load district boundaries.';
    throw error;
  }
}

export async function fetchBinaryWithProgress(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const onProgress = options.onProgress ?? (() => {});

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available');
  }
  if (typeof onProgress !== 'function') {
    throw new Error('onProgress must be a function');
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch graph binary: HTTP ${response.status}`);
  }

  const totalBytes = parseContentLength(response.headers?.get('Content-Length'));

  if (!response.body || typeof response.body.getReader !== 'function') {
    const fallbackBuffer = await response.arrayBuffer();
    onProgress(fallbackBuffer.byteLength, totalBytes);
    return fallbackBuffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;

  onProgress(0, totalBytes);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }

    chunks.push(value);
    receivedBytes += value.byteLength;
    onProgress(receivedBytes, totalBytes);
  }

  const merged = new Uint8Array(receivedBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }

  onProgress(receivedBytes, totalBytes);
  return merged.buffer;
}

export function parseGraphBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('graph binary parser expects an ArrayBuffer');
  }
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(`graph binary is too small for header: ${buffer.byteLength} bytes`);
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== GRAPH_MAGIC) {
    throw new Error(
      `Invalid graph magic 0x${magic.toString(16).padStart(8, '0')}; expected 0x${GRAPH_MAGIC.toString(16)}`,
    );
  }

  const nNodes = view.getUint32(8, true);
  const nEdges = view.getUint32(12, true);
  const nodeTableOffset = view.getUint32(52, true);
  const edgeTableOffset = view.getUint32(56, true);
  const stopTableOffset = view.getUint32(60, true);

  const nodeTableEnd = nodeTableOffset + nNodes * NODE_RECORD_SIZE;
  const edgeTableEnd = edgeTableOffset + nEdges * EDGE_RECORD_SIZE;

  if (nodeTableOffset < HEADER_SIZE) {
    throw new Error('graph binary node table offset points inside header');
  }
  if (edgeTableOffset < nodeTableEnd) {
    throw new Error('graph binary edge table overlaps node table');
  }
  if (stopTableOffset < edgeTableEnd) {
    throw new Error('graph binary stop table overlaps edge table');
  }
  if (nodeTableEnd > buffer.byteLength) {
    throw new Error('graph binary node table exceeds file size');
  }
  if (edgeTableEnd > buffer.byteLength) {
    throw new Error('graph binary edge table exceeds file size');
  }
  if (stopTableOffset > buffer.byteLength) {
    throw new Error('graph binary stop table offset exceeds file size');
  }
  if (nodeTableOffset % 4 !== 0 || edgeTableOffset % 4 !== 0) {
    throw new Error('graph binary table offsets must be 4-byte aligned');
  }

  const header = {
    magic,
    version: view.getUint8(4),
    flags: view.getUint8(5),
    nNodes,
    nEdges,
    nStops: view.getUint32(16, true),
    nTedges: view.getUint32(20, true),
    originEasting: view.getFloat64(24, true),
    originNorthing: view.getFloat64(32, true),
    epsgCode: view.getUint16(40, true),
    gridWidthPx: view.getUint16(42, true),
    gridHeightPx: view.getUint16(44, true),
    pixelSizeM: view.getFloat32(48, true),
    nodeTableOffset,
    edgeTableOffset,
    stopTableOffset,
  };

  const nodeI32 = new Int32Array(buffer, nodeTableOffset, nNodes * 4);
  const nodeU32 = new Uint32Array(buffer, nodeTableOffset, nNodes * 4);
  const nodeU16 = new Uint16Array(buffer, nodeTableOffset, nNodes * 8);
  const edgeU32 = new Uint32Array(buffer, edgeTableOffset, nEdges * 3);
  const edgeU16 = new Uint16Array(buffer, edgeTableOffset, nEdges * 6);

  return {
    header,
    nodeI32,
    nodeU32,
    nodeU16,
    edgeU32,
    edgeU16,
  };
}

export async function loadGraphBinary(shell, options = {}) {
  const url = options.url ?? DEFAULT_GRAPH_BINARY_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  shell.loadingOverlay.hidden = false;
  shell.loadingOverlay.textContent = 'Loading graph: 0.00 MB';

  try {
    const buffer = await fetchBinaryWithProgress(url, {
      fetchImpl,
      onProgress(receivedBytes, totalBytes) {
        updateGraphLoadingText(shell.loadingOverlay, receivedBytes, totalBytes);
      },
    });

    const graph = parseGraphBinary(buffer);
    shell.mapCanvas.style.pointerEvents = 'auto';
    shell.mapCanvas.dataset.graphLoaded = 'true';
    shell.loadingOverlay.hidden = true;
    shell.loadingOverlay.textContent = '';
    return graph;
  } catch (error) {
    shell.mapCanvas.style.pointerEvents = 'none';
    shell.mapCanvas.dataset.graphLoaded = 'false';
    shell.loadingOverlay.hidden = false;
    shell.loadingOverlay.textContent = 'Failed to load graph binary.';
    throw error;
  }
}

export async function initializeMapData(shell, options = {}) {
  const boundaryOptions = options.boundaries ?? {};
  const graphOptions = options.graph ?? {};

  const boundarySummary = await loadAndRenderBoundaryBasemap(shell, boundaryOptions);
  const graph = await loadGraphBinary(shell, graphOptions);
  const pixelGrid = createPixelGrid(graph.header.gridWidthPx, graph.header.gridHeightPx);
  clearGrid(pixelGrid);

  return {
    boundarySummary,
    graph,
    pixelGrid,
  };
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

function updateGraphLoadingText(overlay, receivedBytes, totalBytes) {
  const receivedText = formatMebibytes(receivedBytes);
  if (totalBytes === null || totalBytes <= 0) {
    overlay.textContent = `Loading graph: ${receivedText}`;
    return;
  }

  const totalText = formatMebibytes(totalBytes);
  const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
  overlay.textContent = `Loading graph: ${receivedText} / ${totalText} (${percent}%)`;
}

function parseContentLength(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function formatMebibytes(bytes) {
  const safeBytes = Math.max(0, bytes);
  return `${(safeBytes / BYTES_PER_MEBIBYTE).toFixed(2)} MB`;
}

function validatePixelGrid(pixelGrid) {
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
    void initializeMapData(shell).catch((error) => {
      console.error(error);
    });
  });
}
