export function validateGraphForNodePixels(graph) {
  if (!graph || typeof graph !== 'object') {
    throw new Error('graph must be an object');
  }
  if (!graph.header || typeof graph.header !== 'object') {
    throw new Error('graph.header is required');
  }
  if (!Number.isInteger(graph.header.nNodes) || graph.header.nNodes < 0) {
    throw new Error('graph.header.nNodes must be a non-negative integer');
  }
  if (!Number.isInteger(graph.header.gridWidthPx) || graph.header.gridWidthPx <= 0) {
    throw new Error('graph.header.gridWidthPx must be a positive integer');
  }
  if (!Number.isInteger(graph.header.gridHeightPx) || graph.header.gridHeightPx <= 0) {
    throw new Error('graph.header.gridHeightPx must be a positive integer');
  }
  if (!(graph.nodeI32 instanceof Int32Array)) {
    throw new Error('graph.nodeI32 must be an Int32Array');
  }
  if (graph.nodeI32.length < graph.header.nNodes * 4) {
    throw new Error('graph.nodeI32 is too short for node records');
  }
}

export function validateGraphForRouting(graph) {
  validateGraphForNodePixels(graph);

  if (!Number.isInteger(graph.header.nEdges) || graph.header.nEdges < 0) {
    throw new Error('graph.header.nEdges must be a non-negative integer');
  }
  if (!(graph.nodeU32 instanceof Uint32Array)) {
    throw new Error('graph.nodeU32 must be a Uint32Array');
  }
  if (!(graph.nodeU16 instanceof Uint16Array)) {
    throw new Error('graph.nodeU16 must be a Uint16Array');
  }
  if (!(graph.edgeU32 instanceof Uint32Array)) {
    throw new Error('graph.edgeU32 must be a Uint32Array');
  }
  if (!(graph.edgeU16 instanceof Uint16Array)) {
    throw new Error('graph.edgeU16 must be a Uint16Array');
  }
  if (!(graph.edgeModeMask instanceof Uint8Array)) {
    throw new Error('graph.edgeModeMask must be a Uint8Array');
  }
  if (!(graph.edgeRoadClassId instanceof Uint8Array)) {
    throw new Error('graph.edgeRoadClassId must be a Uint8Array');
  }
  if (!(graph.edgeMaxspeedKph instanceof Uint16Array)) {
    throw new Error('graph.edgeMaxspeedKph must be a Uint16Array');
  }

  if (graph.nodeU32.length < graph.header.nNodes * 4) {
    throw new Error('graph.nodeU32 is too short for node records');
  }
  if (graph.nodeU16.length < graph.header.nNodes * 8) {
    throw new Error('graph.nodeU16 is too short for node records');
  }
  if (graph.edgeU32.length < graph.header.nEdges * 3) {
    throw new Error('graph.edgeU32 is too short for edge records');
  }
  if (graph.edgeU16.length < graph.header.nEdges * 6) {
    throw new Error('graph.edgeU16 is too short for edge records');
  }
  if (graph.edgeModeMask.length < graph.header.nEdges) {
    throw new Error('graph.edgeModeMask is too short for edge records');
  }
  if (graph.edgeRoadClassId.length < graph.header.nEdges) {
    throw new Error('graph.edgeRoadClassId is too short for edge records');
  }
  if (graph.edgeMaxspeedKph.length < graph.header.nEdges) {
    throw new Error('graph.edgeMaxspeedKph is too short for edge records');
  }
}

export function validateGraphHeaderForBoundaryAlignment(graphHeader) {
  if (!graphHeader || typeof graphHeader !== 'object') {
    throw new Error('graphHeader must be an object');
  }
  if (!Number.isFinite(graphHeader.originEasting)) {
    throw new Error('graphHeader.originEasting must be finite');
  }
  if (!Number.isFinite(graphHeader.originNorthing)) {
    throw new Error('graphHeader.originNorthing must be finite');
  }
  if (!Number.isInteger(graphHeader.gridWidthPx) || graphHeader.gridWidthPx <= 0) {
    throw new Error('graphHeader.gridWidthPx must be a positive integer');
  }
  if (!Number.isInteger(graphHeader.gridHeightPx) || graphHeader.gridHeightPx <= 0) {
    throw new Error('graphHeader.gridHeightPx must be a positive integer');
  }
  if (!Number.isFinite(graphHeader.pixelSizeM) || graphHeader.pixelSizeM <= 0) {
    throw new Error('graphHeader.pixelSizeM must be a positive finite number');
  }
}
