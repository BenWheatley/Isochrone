const REQUIRED_EXPORTS = [
  'memory',
  'wasm_alloc',
  'wasm_dealloc',
  'precompute_edge_costs',
  'compute_travel_time_field',
];
const DEFAULT_WASM_URL = new URL('../../wasm/routing-kernel.wasm', import.meta.url).toString();

export function hasWebAssemblySupport(runtimeGlobal = globalThis) {
  return Boolean(runtimeGlobal && runtimeGlobal.WebAssembly);
}

export function validateRoutingKernelExports(exportsObject) {
  if (!exportsObject || typeof exportsObject !== 'object') {
    throw new Error('WASM exports object is required');
  }

  for (const exportName of REQUIRED_EXPORTS) {
    if (!(exportName in exportsObject)) {
      throw new Error(`WASM export missing required symbol: ${exportName}`);
    }
  }
}

export async function instantiateRoutingKernelWasm(options = {}) {
  const {
    wasmUrl = DEFAULT_WASM_URL,
    fetchImpl = globalThis.fetch,
    webAssemblyObject = globalThis.WebAssembly,
  } = options;

  if (!hasWebAssemblySupport({ WebAssembly: webAssemblyObject })) {
    throw new Error('WebAssembly is not available in this runtime');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function');
  }

  const response = await fetchImpl(wasmUrl);
  if (!response || (typeof response.ok === 'boolean' && !response.ok)) {
    throw new Error(`Failed to fetch WASM module: ${wasmUrl}`);
  }

  let instance;
  let module;
  if (typeof webAssemblyObject.instantiateStreaming === 'function') {
    ({ instance, module } = await webAssemblyObject.instantiateStreaming(response, {}));
  } else {
    const bytes = await response.arrayBuffer();
    ({ instance, module } = await webAssemblyObject.instantiate(bytes, {}));
  }

  validateRoutingKernelExports(instance.exports);
  return {
    module,
    instance,
    exports: instance.exports,
  };
}

export async function instantiateRoutingKernelWasmFromBytes(
  wasmBytes,
  options = {},
) {
  const {
    webAssemblyObject = globalThis.WebAssembly,
  } = options;

  if (!hasWebAssemblySupport({ WebAssembly: webAssemblyObject })) {
    throw new Error('WebAssembly is not available in this runtime');
  }
  if (!(wasmBytes instanceof ArrayBuffer)) {
    throw new Error('wasmBytes must be an ArrayBuffer');
  }

  const { instance, module } = await webAssemblyObject.instantiate(wasmBytes, {});
  validateRoutingKernelExports(instance.exports);
  return {
    module,
    instance,
    exports: instance.exports,
  };
}

export function createWasmRoutingKernelFacade(exportsObject) {
  validateRoutingKernelExports(exportsObject);

  const temporaryAllocations = [];
  const cachedTypedArrayAllocations = new Map();
  const allocBytes = (byteLength) => {
    if (!Number.isInteger(byteLength) || byteLength < 0) {
      throw new Error('byteLength must be a non-negative integer');
    }
    if (byteLength === 0) {
      return 0;
    }
    const ptr = exportsObject.wasm_alloc(byteLength);
    if (!Number.isInteger(ptr) || ptr <= 0) {
      throw new Error(`WASM allocation failed for ${byteLength} bytes`);
    }
    temporaryAllocations.push({ ptr, byteLength });
    return ptr;
  };
  const getMemoryU8 = () => new Uint8Array(exportsObject.memory.buffer);
  const copyTypedArrayFromWasm = (targetTypedArray, ptr) => {
    if (targetTypedArray.byteLength === 0) {
      return;
    }
    const memoryU8 = getMemoryU8();
    const sourceU8 = memoryU8.subarray(ptr, ptr + targetTypedArray.byteLength);
    const targetU8 = new Uint8Array(
      targetTypedArray.buffer,
      targetTypedArray.byteOffset,
      targetTypedArray.byteLength,
    );
    targetU8.set(sourceU8);
  };
  const copyTypedArrayToCachedWasm = (typedArray) => {
    if (!typedArray || typeof typedArray.byteLength !== 'number') {
      throw new Error('typedArray must be an ArrayBuffer view');
    }
    if (typedArray.byteLength === 0) {
      return 0;
    }

    const cached = cachedTypedArrayAllocations.get(typedArray);
    if (cached && cached.byteLength === typedArray.byteLength) {
      return cached.ptr;
    }
    if (cached) {
      exportsObject.wasm_dealloc(cached.ptr, cached.byteLength);
      cachedTypedArrayAllocations.delete(typedArray);
    }

    const ptr = exportsObject.wasm_alloc(typedArray.byteLength);
    if (!Number.isInteger(ptr) || ptr <= 0) {
      throw new Error(`WASM allocation failed for ${typedArray.byteLength} bytes`);
    }
    const memoryU8 = getMemoryU8();
    const sourceU8 = new Uint8Array(
      typedArray.buffer,
      typedArray.byteOffset,
      typedArray.byteLength,
    );
    memoryU8.set(sourceU8, ptr);
    cachedTypedArrayAllocations.set(typedArray, {
      ptr,
      byteLength: typedArray.byteLength,
    });
    return ptr;
  };
  const releaseCachedTypedArrayAllocations = () => {
    for (const { ptr, byteLength } of cachedTypedArrayAllocations.values()) {
      exportsObject.wasm_dealloc(ptr, byteLength);
    }
    cachedTypedArrayAllocations.clear();
  };
  const freeAllocations = () => {
    while (temporaryAllocations.length > 0) {
      const { ptr, byteLength } = temporaryAllocations.pop();
      exportsObject.wasm_dealloc(ptr, byteLength);
    }
  };

  return {
    exports: exportsObject,
    precomputeEdgeCosts({
      outCostSecondsPtr,
      edgeModeMaskPtr,
      edgeRoadClassPtr,
      edgeMaxspeedKphPtr,
      edgeWalkCostSecondsPtr,
      edgeCount,
      allowedModeMask,
    }) {
      exportsObject.precompute_edge_costs(
        outCostSecondsPtr,
        edgeModeMaskPtr,
        edgeRoadClassPtr,
        edgeMaxspeedKphPtr,
        edgeWalkCostSecondsPtr,
        edgeCount,
        allowedModeMask,
      );
    },
    precomputeEdgeCostsForGraph({
      edgeModeMask,
      edgeRoadClassId,
      edgeMaxspeedKph,
      edgeWalkCostSeconds,
      outCostSeconds,
      allowedModeMask,
    }) {
      if (!(edgeModeMask instanceof Uint8Array)) {
        throw new Error('edgeModeMask must be a Uint8Array');
      }
      if (!(edgeRoadClassId instanceof Uint8Array)) {
        throw new Error('edgeRoadClassId must be a Uint8Array');
      }
      if (!(edgeMaxspeedKph instanceof Uint16Array)) {
        throw new Error('edgeMaxspeedKph must be a Uint16Array');
      }
      if (!(edgeWalkCostSeconds instanceof Uint16Array)) {
        throw new Error('edgeWalkCostSeconds must be a Uint16Array');
      }
      if (!(outCostSeconds instanceof Float32Array)) {
        throw new Error('outCostSeconds must be a Float32Array');
      }
      const edgeCount = outCostSeconds.length;
      if (
        edgeModeMask.length < edgeCount
        || edgeRoadClassId.length < edgeCount
        || edgeMaxspeedKph.length < edgeCount
        || edgeWalkCostSeconds.length < edgeCount
      ) {
        throw new Error('edge input arrays must each cover outCostSeconds.length');
      }
      if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
        throw new Error('allowedModeMask must be a positive 8-bit integer');
      }
      if (edgeCount === 0) {
        return;
      }

      try {
        const outPtr = allocBytes(outCostSeconds.byteLength);
        const edgeModeMaskPtr = copyTypedArrayToCachedWasm(edgeModeMask);
        const edgeRoadClassPtr = copyTypedArrayToCachedWasm(edgeRoadClassId);
        const edgeMaxspeedKphPtr = copyTypedArrayToCachedWasm(edgeMaxspeedKph);
        const edgeWalkCostSecondsPtr = copyTypedArrayToCachedWasm(edgeWalkCostSeconds);

        exportsObject.precompute_edge_costs(
          outPtr,
          edgeModeMaskPtr,
          edgeRoadClassPtr,
          edgeMaxspeedKphPtr,
          edgeWalkCostSecondsPtr,
          edgeCount,
          allowedModeMask,
        );
        copyTypedArrayFromWasm(outCostSeconds, outPtr);
      } finally {
        freeAllocations();
      }
    },
    computeTravelTimeFieldForGraph({
      nodeFirstEdgeIndex,
      nodeEdgeCount,
      edgeTargetNodeIndex,
      edgeModeMask,
      edgeRoadClassId,
      edgeMaxspeedKph,
      edgeWalkCostSeconds,
      outDistSeconds,
      sourceNodeIndex,
      allowedModeMask,
      timeLimitSeconds = Number.POSITIVE_INFINITY,
    }) {
      if (!(nodeFirstEdgeIndex instanceof Uint32Array)) {
        throw new Error('nodeFirstEdgeIndex must be a Uint32Array');
      }
      if (!(nodeEdgeCount instanceof Uint16Array)) {
        throw new Error('nodeEdgeCount must be a Uint16Array');
      }
      if (!(edgeTargetNodeIndex instanceof Uint32Array)) {
        throw new Error('edgeTargetNodeIndex must be a Uint32Array');
      }
      if (!(edgeModeMask instanceof Uint8Array)) {
        throw new Error('edgeModeMask must be a Uint8Array');
      }
      if (!(edgeRoadClassId instanceof Uint8Array)) {
        throw new Error('edgeRoadClassId must be a Uint8Array');
      }
      if (!(edgeMaxspeedKph instanceof Uint16Array)) {
        throw new Error('edgeMaxspeedKph must be a Uint16Array');
      }
      if (!(edgeWalkCostSeconds instanceof Uint16Array)) {
        throw new Error('edgeWalkCostSeconds must be a Uint16Array');
      }
      if (!(outDistSeconds instanceof Float32Array)) {
        throw new Error('outDistSeconds must be a Float32Array');
      }
      if (!Number.isInteger(sourceNodeIndex) || sourceNodeIndex < 0) {
        throw new Error('sourceNodeIndex must be a non-negative integer');
      }
      if (!Number.isInteger(allowedModeMask) || allowedModeMask <= 0 || allowedModeMask > 0xff) {
        throw new Error('allowedModeMask must be a positive 8-bit integer');
      }

      const nodeCount = outDistSeconds.length;
      const edgeCount = edgeTargetNodeIndex.length;
      if (sourceNodeIndex >= nodeCount) {
        throw new Error(`sourceNodeIndex out of range: ${sourceNodeIndex}`);
      }
      if (nodeFirstEdgeIndex.length < nodeCount || nodeEdgeCount.length < nodeCount) {
        throw new Error('node arrays must each cover outDistSeconds.length');
      }
      if (
        edgeModeMask.length < edgeCount
        || edgeRoadClassId.length < edgeCount
        || edgeMaxspeedKph.length < edgeCount
        || edgeWalkCostSeconds.length < edgeCount
      ) {
        throw new Error('edge metadata arrays must each cover edgeTargetNodeIndex.length');
      }

      const normalizedTimeLimitSeconds =
        Number.isFinite(timeLimitSeconds) && timeLimitSeconds > 0
          ? timeLimitSeconds
          : Number.POSITIVE_INFINITY;

      try {
        const outDistSecondsPtr = allocBytes(outDistSeconds.byteLength);
        const nodeFirstEdgeIndexPtr = copyTypedArrayToCachedWasm(nodeFirstEdgeIndex);
        const nodeEdgeCountPtr = copyTypedArrayToCachedWasm(nodeEdgeCount);
        const edgeTargetNodeIndexPtr = copyTypedArrayToCachedWasm(edgeTargetNodeIndex);
        const edgeModeMaskPtr = copyTypedArrayToCachedWasm(edgeModeMask);
        const edgeRoadClassPtr = copyTypedArrayToCachedWasm(edgeRoadClassId);
        const edgeMaxspeedKphPtr = copyTypedArrayToCachedWasm(edgeMaxspeedKph);
        const edgeWalkCostSecondsPtr = copyTypedArrayToCachedWasm(edgeWalkCostSeconds);

        const settledNodeCount = exportsObject.compute_travel_time_field(
          outDistSecondsPtr,
          nodeFirstEdgeIndexPtr,
          nodeEdgeCountPtr,
          nodeCount,
          edgeTargetNodeIndexPtr,
          edgeModeMaskPtr,
          edgeRoadClassPtr,
          edgeMaxspeedKphPtr,
          edgeWalkCostSecondsPtr,
          edgeCount,
          sourceNodeIndex,
          allowedModeMask,
          normalizedTimeLimitSeconds,
        );
        copyTypedArrayFromWasm(outDistSeconds, outDistSecondsPtr);
        return {
          settledNodeCount: Number.isInteger(settledNodeCount) && settledNodeCount >= 0
            ? settledNodeCount
            : 0,
        };
      } finally {
        freeAllocations();
      }
    },
    releaseCachedGraphBuffers() {
      releaseCachedTypedArrayAllocations();
    },
  };
}
