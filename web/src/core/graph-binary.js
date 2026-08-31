import {
  BYTES_PER_MEBIBYTE,
  EDGE_RECORD_SIZE,
  GRAPH_MAGIC,
  HEADER_SIZE,
  NODE_RECORD_SIZE,
  STOP_RECORD_SIZE,
  SUPPORTED_GRAPH_VERSIONS,
  TEDGE_RECORD_SIZE,
  TRANSFER_RECORD_SIZE,
} from '../config/constants.js';

// Fetching and decoding the preprocessed graph binary produced by
// data_pipeline/. parseGraphBinary hands back typed-array views directly
// over the downloaded buffer (no per-record objects) because the node and
// edge tables are read in the routing hot path.

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

export async function maybeDecompressGzipBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('maybeDecompressGzipBuffer expects an ArrayBuffer');
  }

  const bytes = new Uint8Array(buffer);
  const isGzipMagic = bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
  if (!isGzipMagic) {
    return buffer;
  }

  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      'Browser does not support DecompressionStream for gzip graph payloads. ' +
        'Use an uncompressed graph binary or a browser with gzip stream support.',
    );
  }

  const compressedBlob = new Blob([buffer], { type: 'application/gzip' });
  const decompressedStream = compressedBlob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(decompressedStream).arrayBuffer();
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
  const version = view.getUint8(4);
  if (!SUPPORTED_GRAPH_VERSIONS.has(version)) {
    throw new Error(
      `unsupported graph binary version ${version}; supported graph binary versions: ${[
        ...SUPPORTED_GRAPH_VERSIONS,
      ].join(', ')}`,
    );
  }

  const nNodes = view.getUint32(8, true);
  const nEdges = view.getUint32(12, true);
  const nStops = view.getUint32(16, true);
  const nTedges = view.getUint32(20, true);
  const nodeTableOffset = view.getUint32(52, true);
  const edgeTableOffset = view.getUint32(56, true);
  const stopTableOffset = view.getUint32(60, true);
  // Transit edges follow the stop table immediately; there's no separate
  // header field for this (the 64-byte header is already full) — mirrors
  // data_pipeline's binary_reader.py transit_edge_table_offset().
  const tedgeTableOffset = stopTableOffset + nStops * STOP_RECORD_SIZE;

  const nodeTableEnd = nodeTableOffset + nNodes * NODE_RECORD_SIZE;
  const edgeTableEnd = edgeTableOffset + nEdges * EDGE_RECORD_SIZE;
  const stopTableEnd = stopTableOffset + nStops * STOP_RECORD_SIZE;
  const tedgeTableEnd = tedgeTableOffset + nTedges * TEDGE_RECORD_SIZE;

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
  if (stopTableEnd > buffer.byteLength) {
    throw new Error('graph binary stop table exceeds file size');
  }
  if (tedgeTableEnd > buffer.byteLength) {
    throw new Error('graph binary transit edge table exceeds file size');
  }
  if (nodeTableOffset % 4 !== 0 || edgeTableOffset % 4 !== 0) {
    throw new Error('graph binary table offsets must be 4-byte aligned');
  }
  if (stopTableOffset % 4 !== 0) {
    throw new Error('graph binary stop table offset must be 4-byte aligned');
  }

  const header = {
    magic,
    version,
    flags: view.getUint8(5),
    nNodes,
    nEdges,
    nStops,
    nTedges,
    originEasting: view.getFloat64(24, true),
    originNorthing: view.getFloat64(32, true),
    epsgCode: view.getUint16(40, true),
    gridWidthPx: view.getUint16(42, true),
    gridHeightPx: view.getUint16(44, true),
    pixelSizeM: view.getFloat32(48, true),
    nodeTableOffset,
    edgeTableOffset,
    stopTableOffset,
    tedgeTableOffset,
  };

  const nodeI32 = new Int32Array(buffer, nodeTableOffset, nNodes * 4);
  const nodeU32 = new Uint32Array(buffer, nodeTableOffset, nNodes * 4);
  const nodeU16 = new Uint16Array(buffer, nodeTableOffset, nNodes * 8);
  const edgeU32 = new Uint32Array(buffer, edgeTableOffset, nEdges * 3);
  const edgeU16 = new Uint16Array(buffer, edgeTableOffset, nEdges * 6);
  const edgeModeMask = new Uint8Array(nEdges);
  const edgeRoadClassId = new Uint8Array(nEdges);
  const edgeMaxspeedKph = new Uint16Array(nEdges);

  for (let edgeIndex = 0; edgeIndex < nEdges; edgeIndex += 1) {
    const packedMetadata = edgeU32[edgeIndex * 3 + 2];
    edgeModeMask[edgeIndex] = packedMetadata & 0xff;
    edgeRoadClassId[edgeIndex] = (packedMetadata >>> 8) & 0xff;
    edgeMaxspeedKph[edgeIndex] = (packedMetadata >>> 16) & 0xffff;
  }

  // Stop x_m/y_m (offsets from the same origin as node x_m/y_m) double as
  // the walk-attachment distance source: JS computes the stop-to-node walk
  // cost on the fly from these plus the node's own position, rather than
  // baking a redundant walk_attach_cost_seconds field into the binary.
  const stopX = new Int32Array(nStops);
  const stopY = new Int32Array(nStops);
  const stopNearestNodeIndex = new Uint32Array(nStops);
  const stopTransportType = new Uint8Array(nStops);
  // CSR range into the transfer table. Zero in a v2 payload, which is exactly
  // the right reading: that region has no walkable connections between stops.
  const stopFirstTransferIndex = new Uint32Array(nStops);
  const stopTransferCount = new Uint16Array(nStops);
  for (let stopIndex = 0; stopIndex < nStops; stopIndex += 1) {
    const recordOffset = stopTableOffset + stopIndex * STOP_RECORD_SIZE;
    stopX[stopIndex] = view.getInt32(recordOffset, true);
    stopY[stopIndex] = view.getInt32(recordOffset + 4, true);
    stopNearestNodeIndex[stopIndex] = view.getUint32(recordOffset + 8, true);
    stopFirstTransferIndex[stopIndex] = view.getUint32(recordOffset + 12, true);
    stopTransferCount[stopIndex] = view.getUint16(recordOffset + 16, true);
    stopTransportType[stopIndex] = view.getUint8(recordOffset + 18);
  }

  const tedgeFromStop = new Uint32Array(nTedges);
  const tedgeToStop = new Uint32Array(nTedges);
  const tedgeDepartureSeconds = new Uint32Array(nTedges);
  const tedgeTravelSeconds = new Uint16Array(nTedges);
  const tedgeServiceDayMask = new Uint32Array(nTedges);
  for (let tedgeIndex = 0; tedgeIndex < nTedges; tedgeIndex += 1) {
    const recordOffset = tedgeTableOffset + tedgeIndex * TEDGE_RECORD_SIZE;
    tedgeFromStop[tedgeIndex] = view.getUint32(recordOffset, true);
    tedgeToStop[tedgeIndex] = view.getUint32(recordOffset + 4, true);
    tedgeDepartureSeconds[tedgeIndex] = view.getUint32(recordOffset + 8, true);
    tedgeTravelSeconds[tedgeIndex] = view.getUint16(recordOffset + 12, true);
    tedgeServiceDayMask[tedgeIndex] = view.getUint32(recordOffset + 16, true);
  }

  // Walkable connections between stops, so a rider can change vehicle. The
  // table's offset is derived like the transit-edge table's, and its length
  // from the last stop's CSR range, because the 64-byte header is full.
  const transferTableOffset = tedgeTableOffset + nTedges * TEDGE_RECORD_SIZE;
  // The writer gives even an empty stop its running offset, so the last stop's
  // first+count is the total. Taken as a maximum rather than read off that one
  // stop so that a malformed table is caught by the bounds check below instead
  // of silently truncating.
  let nTransfers = 0;
  for (let stopIndex = 0; stopIndex < nStops; stopIndex += 1) {
    const end = stopFirstTransferIndex[stopIndex] + stopTransferCount[stopIndex];
    if (end > nTransfers) {
      nTransfers = end;
    }
  }
  if (transferTableOffset + nTransfers * TRANSFER_RECORD_SIZE > buffer.byteLength) {
    throw new Error('graph binary transfer table exceeds file size');
  }
  const transferToStopIndex = new Uint32Array(nTransfers);
  const transferWalkDistanceM = new Uint16Array(nTransfers);
  const transferMinSeconds = new Uint16Array(nTransfers);
  for (let transferIndex = 0; transferIndex < nTransfers; transferIndex += 1) {
    const recordOffset = transferTableOffset + transferIndex * TRANSFER_RECORD_SIZE;
    transferToStopIndex[transferIndex] = view.getUint32(recordOffset, true);
    transferWalkDistanceM[transferIndex] = view.getUint16(recordOffset + 4, true);
    transferMinSeconds[transferIndex] = view.getUint16(recordOffset + 6, true);
  }

  return {
    header,
    nodeI32,
    nodeU32,
    nodeU16,
    edgeU32,
    edgeU16,
    edgeModeMask,
    edgeRoadClassId,
    edgeMaxspeedKph,
    stopX,
    stopY,
    stopNearestNodeIndex,
    stopTransportType,
    stopFirstTransferIndex,
    stopTransferCount,
    transferToStopIndex,
    transferWalkDistanceM,
    transferMinSeconds,
    tedgeFromStop,
    tedgeToStop,
    tedgeDepartureSeconds,
    tedgeTravelSeconds,
    tedgeServiceDayMask,
  };
}


export function parseContentLength(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function formatMebibytes(bytes) {
  const safeBytes = Math.max(0, bytes);
  return `${(safeBytes / BYTES_PER_MEBIBYTE).toFixed(2)} MB`;
}
