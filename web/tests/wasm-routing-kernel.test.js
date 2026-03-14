import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWasmRoutingKernelFacade,
  hasWebAssemblySupport,
  instantiateRoutingKernelWasm,
  instantiateRoutingKernelWasmFromBytes,
  validateRoutingKernelExports,
} from '../src/wasm/routing-kernel.js';

test('hasWebAssemblySupport checks runtime feature availability', () => {
  assert.equal(hasWebAssemblySupport({}), false);
  assert.equal(hasWebAssemblySupport({ WebAssembly: {} }), true);
});

test('validateRoutingKernelExports rejects missing required exports', () => {
  assert.throws(
    () => validateRoutingKernelExports({}),
    /missing required symbol: memory/,
  );
});

test('createWasmRoutingKernelFacade forwards precompute call to wasm export', () => {
  const calls = [];
  const fakeExports = {
    memory: {},
    wasm_alloc() {
      return 1;
    },
    wasm_dealloc() {},
    precompute_edge_costs(...args) {
      calls.push(args);
    },
    compute_travel_time_field() {
      return 0;
    },
  };
  const facade = createWasmRoutingKernelFacade(fakeExports);

  facade.precomputeEdgeCosts({
    outCostSecondsPtr: 1,
    edgeModeMaskPtr: 2,
    edgeRoadClassPtr: 3,
    edgeMaxspeedKphPtr: 4,
    edgeWalkCostSecondsPtr: 5,
    edgeCount: 6,
    allowedModeMask: 7,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [1, 2, 3, 4, 5, 6, 7]);
});

test('instantiateRoutingKernelWasm uses instantiateStreaming and validates exports', async () => {
  const fakeInstance = {
    exports: {
      memory: {},
      wasm_alloc() {
        return 1;
      },
      wasm_dealloc() {},
      precompute_edge_costs() {},
      compute_travel_time_field() {
        return 0;
      },
    },
  };
  let fetchCalls = 0;
  const result = await instantiateRoutingKernelWasm({
    wasmUrl: '/wasm/routing-kernel.wasm',
    fetchImpl: async (url) => {
      fetchCalls += 1;
      assert.equal(url, '/wasm/routing-kernel.wasm');
      return { ok: true };
    },
    webAssemblyObject: {
      async instantiateStreaming() {
        return { instance: fakeInstance, module: { id: 'm' } };
      },
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(result.exports, fakeInstance.exports);
});

test('instantiateRoutingKernelWasm default URL resolves relative to module path', async () => {
  const fakeInstance = {
    exports: {
      memory: {},
      wasm_alloc() {
        return 1;
      },
      wasm_dealloc() {},
      precompute_edge_costs() {},
      compute_travel_time_field() {
        return 0;
      },
    },
  };

  let requestedUrl = null;
  await instantiateRoutingKernelWasm({
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return { ok: true };
    },
    webAssemblyObject: {
      async instantiateStreaming() {
        return { instance: fakeInstance, module: { id: 'default-path' } };
      },
    },
  });

  assert.ok(requestedUrl !== null);
  assert.ok(requestedUrl.endsWith('/wasm/routing-kernel.wasm'));
  assert.notEqual(requestedUrl, '/wasm/routing-kernel.wasm');
});

test('instantiateRoutingKernelWasmFromBytes validates exports from byte instantiation path', async () => {
  const fakeInstance = {
    exports: {
      memory: {},
      wasm_alloc() {
        return 1;
      },
      wasm_dealloc() {},
      precompute_edge_costs() {},
      compute_travel_time_field() {
        return 0;
      },
    },
  };

  const result = await instantiateRoutingKernelWasmFromBytes(new ArrayBuffer(8), {
    webAssemblyObject: {
      async instantiate() {
        return { instance: fakeInstance, module: { id: 'from-bytes' } };
      },
    },
  });

  assert.equal(result.exports, fakeInstance.exports);
});

test('precomputeEdgeCostsForGraph writes back wasm results to output array', () => {
  const memory = { buffer: new ArrayBuffer(4096) };
  let nextPtr = 256;
  const fakeExports = {
    memory,
    wasm_alloc(byteLength) {
      const ptr = nextPtr;
      nextPtr += byteLength;
      return ptr;
    },
    wasm_dealloc() {},
    precompute_edge_costs(
      outCostSecondsPtr,
      edgeModeMaskPtr,
      edgeRoadClassPtr,
      edgeMaxspeedKphPtr,
      edgeWalkCostSecondsPtr,
      edgeCount,
      allowedModeMask,
    ) {
      const modeView = new Uint8Array(memory.buffer, edgeModeMaskPtr, edgeCount);
      const roadView = new Uint8Array(memory.buffer, edgeRoadClassPtr, edgeCount);
      const speedView = new Uint16Array(memory.buffer, edgeMaxspeedKphPtr, edgeCount);
      const walkCostView = new Uint16Array(memory.buffer, edgeWalkCostSecondsPtr, edgeCount);
      const outView = new Float32Array(memory.buffer, outCostSecondsPtr, edgeCount);
      for (let index = 0; index < edgeCount; index += 1) {
        outView[index] = modeView[index] + roadView[index] + speedView[index] + walkCostView[index] + allowedModeMask;
      }
    },
    compute_travel_time_field() {
      return 0;
    },
  };
  const facade = createWasmRoutingKernelFacade(fakeExports);

  const outCostSeconds = new Float32Array(2);
  facade.precomputeEdgeCostsForGraph({
    edgeModeMask: new Uint8Array([1, 2]),
    edgeRoadClassId: new Uint8Array([3, 4]),
    edgeMaxspeedKph: new Uint16Array([5, 6]),
    edgeWalkCostSeconds: new Uint16Array([7, 8]),
    outCostSeconds,
    allowedModeMask: 9,
  });

  assert.deepEqual(Array.from(outCostSeconds), [25, 29]);
});

test('computeTravelTimeFieldForGraph writes back wasm results and settled count', () => {
  const memory = { buffer: new ArrayBuffer(8192) };
  let nextPtr = 256;
  const fakeExports = {
    memory,
    wasm_alloc(byteLength) {
      const ptr = nextPtr;
      nextPtr += byteLength;
      return ptr;
    },
    wasm_dealloc() {},
    precompute_edge_costs() {},
    compute_travel_time_field(
      outDistSecondsPtr,
      _nodeFirstEdgeIndexPtr,
      _nodeEdgeCountPtr,
      nodeCount,
      _edgeTargetNodeIndexPtr,
      _edgeCostTicksPtr,
      _edgeCount,
      sourceNodeIndex,
      _timeLimitSeconds,
    ) {
      const outView = new Float32Array(memory.buffer, outDistSecondsPtr, nodeCount);
      for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
        outView[nodeIndex] = Number.POSITIVE_INFINITY;
      }
      outView[sourceNodeIndex] = 0;
      if (nodeCount > 1) {
        outView[1] = 42;
      }
      return 2;
    },
  };
  const facade = createWasmRoutingKernelFacade(fakeExports);

  const outDistSeconds = new Float32Array(3);
  const result = facade.computeTravelTimeFieldForGraph({
    nodeFirstEdgeIndex: new Uint32Array([0, 1, 2]),
    nodeEdgeCount: new Uint16Array([1, 1, 0]),
    edgeTargetNodeIndex: new Uint32Array([1, 2]),
    edgeCostTicks: new Uint32Array([72_000, 72_000]),
    outDistSeconds,
    sourceNodeIndex: 0,
  });

  assert.equal(result.settledNodeCount, 2);
  assert.equal(outDistSeconds[0], 0);
  assert.equal(outDistSeconds[1], 42);
  assert.equal(outDistSeconds[2], Number.POSITIVE_INFINITY);
});

test('computeTravelTimeFieldForGraph can return shared output view from wasm memory', () => {
  const memory = { buffer: new ArrayBuffer(8192) };
  let nextPtr = 256;
  const fakeExports = {
    memory,
    wasm_alloc(byteLength) {
      const ptr = nextPtr;
      nextPtr += byteLength;
      return ptr;
    },
    wasm_dealloc() {},
    precompute_edge_costs() {},
    compute_travel_time_field(
      outDistSecondsPtr,
      _nodeFirstEdgeIndexPtr,
      _nodeEdgeCountPtr,
      nodeCount,
      _edgeTargetNodeIndexPtr,
      _edgeCostTicksPtr,
      _edgeCount,
      sourceNodeIndex,
    ) {
      const outView = new Float32Array(memory.buffer, outDistSecondsPtr, nodeCount);
      outView.fill(Number.POSITIVE_INFINITY);
      outView[sourceNodeIndex] = 0;
      return 1;
    },
  };
  const facade = createWasmRoutingKernelFacade(fakeExports);

  const outDistSeconds = new Float32Array(3);
  outDistSeconds.fill(12345);
  const result = facade.computeTravelTimeFieldForGraph({
    nodeFirstEdgeIndex: new Uint32Array([0, 1, 2]),
    nodeEdgeCount: new Uint16Array([1, 1, 0]),
    edgeTargetNodeIndex: new Uint32Array([1, 2]),
    edgeCostTicks: new Uint32Array([72_000, 72_000]),
    outDistSeconds,
    sourceNodeIndex: 0,
    returnSharedOutputView: true,
  });

  assert.equal(result.settledNodeCount, 1);
  assert.ok(result.outDistSecondsView instanceof Float32Array);
  assert.equal(result.outDistSecondsView[0], 0);
  assert.equal(result.outDistSecondsView[1], Number.POSITIVE_INFINITY);
  assert.equal(outDistSeconds[0], 12345);
});

test('computeTravelTimeFieldForGraph reuses cached graph buffers across runs', () => {
  const memory = { buffer: new ArrayBuffer(16384) };
  let nextPtr = 256;
  let allocCallCount = 0;
  let deallocCallCount = 0;
  const fakeExports = {
    memory,
    wasm_alloc(byteLength) {
      allocCallCount += 1;
      const ptr = (nextPtr + 7) & ~7;
      nextPtr = ptr;
      nextPtr += byteLength;
      return ptr;
    },
    wasm_dealloc() {
      deallocCallCount += 1;
    },
    precompute_edge_costs() {},
    compute_travel_time_field(
      outDistSecondsPtr,
      _nodeFirstEdgeIndexPtr,
      _nodeEdgeCountPtr,
      nodeCount,
      _edgeTargetNodeIndexPtr,
      _edgeCostTicksPtr,
      _edgeCount,
      sourceNodeIndex,
    ) {
      const outView = new Float32Array(memory.buffer, outDistSecondsPtr, nodeCount);
      for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
        outView[nodeIndex] = Number.POSITIVE_INFINITY;
      }
      outView[sourceNodeIndex] = 0;
      return 1;
    },
  };
  const facade = createWasmRoutingKernelFacade(fakeExports);

  const graphInputs = {
    nodeFirstEdgeIndex: new Uint32Array([0, 1, 2]),
    nodeEdgeCount: new Uint16Array([1, 1, 0]),
    edgeTargetNodeIndex: new Uint32Array([1, 2]),
    edgeCostTicks: new Uint32Array([72_000, 72_000]),
  };

  const firstOut = new Float32Array(3);
  facade.computeTravelTimeFieldForGraph({
    ...graphInputs,
    outDistSeconds: firstOut,
    sourceNodeIndex: 0,
  });

  const allocAfterFirstRun = allocCallCount;
  const deallocAfterFirstRun = deallocCallCount;
  assert.equal(allocAfterFirstRun, 5);
  assert.equal(deallocAfterFirstRun, 0);

  const secondOut = new Float32Array(3);
  facade.computeTravelTimeFieldForGraph({
    ...graphInputs,
    outDistSeconds: secondOut,
    sourceNodeIndex: 1,
  });

  assert.equal(allocCallCount, allocAfterFirstRun + 1);
  assert.equal(deallocCallCount, deallocAfterFirstRun);
  assert.equal(secondOut[1], 0);

  facade.releaseCachedGraphBuffers();
  assert.equal(deallocCallCount, allocCallCount);
});

test('computeTravelTimeFieldForGraph shared output views stay stable across alternating output buffers', () => {
  const memory = { buffer: new ArrayBuffer(16384) };
  let nextPtr = 256;
  const fakeExports = {
    memory,
    wasm_alloc(byteLength) {
      const ptr = (nextPtr + 7) & ~7;
      nextPtr = ptr;
      nextPtr += byteLength;
      return ptr;
    },
    wasm_dealloc() {},
    precompute_edge_costs() {},
    compute_travel_time_field(
      outDistSecondsPtr,
      _nodeFirstEdgeIndexPtr,
      _nodeEdgeCountPtr,
      nodeCount,
      _edgeTargetNodeIndexPtr,
      _edgeCostTicksPtr,
      _edgeCount,
      sourceNodeIndex,
    ) {
      const outView = new Float32Array(memory.buffer, outDistSecondsPtr, nodeCount);
      outView.fill(Number.POSITIVE_INFINITY);
      outView[sourceNodeIndex] = 0;
      return 1;
    },
  };
  const facade = createWasmRoutingKernelFacade(fakeExports);
  const graphInputs = {
    nodeFirstEdgeIndex: new Uint32Array([0, 1, 2]),
    nodeEdgeCount: new Uint16Array([1, 1, 0]),
    edgeTargetNodeIndex: new Uint32Array([1, 2]),
    edgeCostTicks: new Uint32Array([72_000, 72_000]),
  };

  const resultA = facade.computeTravelTimeFieldForGraph({
    ...graphInputs,
    outDistSeconds: new Float32Array(3),
    sourceNodeIndex: 0,
    returnSharedOutputView: true,
  });
  const resultB = facade.computeTravelTimeFieldForGraph({
    ...graphInputs,
    outDistSeconds: new Float32Array(3),
    sourceNodeIndex: 1,
    returnSharedOutputView: true,
  });

  assert.ok(resultA.outDistSecondsView instanceof Float32Array);
  assert.ok(resultB.outDistSecondsView instanceof Float32Array);
  assert.equal(resultA.outDistSecondsView[0], 0);
  assert.equal(resultA.outDistSecondsView[1], Number.POSITIVE_INFINITY);
  assert.equal(resultB.outDistSecondsView[0], Number.POSITIVE_INFINITY);
  assert.equal(resultB.outDistSecondsView[1], 0);
});

test('precomputeEdgeCostsForGraph reuses cached edge metadata buffers across runs', () => {
  const memory = { buffer: new ArrayBuffer(8192) };
  let nextPtr = 256;
  let allocCallCount = 0;
  let deallocCallCount = 0;
  const fakeExports = {
    memory,
    wasm_alloc(byteLength) {
      allocCallCount += 1;
      const ptr = (nextPtr + 7) & ~7;
      nextPtr = ptr;
      nextPtr += byteLength;
      return ptr;
    },
    wasm_dealloc() {
      deallocCallCount += 1;
    },
    precompute_edge_costs(
      outCostSecondsPtr,
      _edgeModeMaskPtr,
      _edgeRoadClassPtr,
      _edgeMaxspeedKphPtr,
      _edgeWalkCostSecondsPtr,
      edgeCount,
      allowedModeMask,
    ) {
      const outView = new Float32Array(memory.buffer, outCostSecondsPtr, edgeCount);
      for (let index = 0; index < edgeCount; index += 1) {
        outView[index] = allowedModeMask + index;
      }
    },
    compute_travel_time_field() {
      return 0;
    },
  };
  const facade = createWasmRoutingKernelFacade(fakeExports);

  const edgeInputs = {
    edgeModeMask: new Uint8Array([1, 2]),
    edgeRoadClassId: new Uint8Array([3, 4]),
    edgeMaxspeedKph: new Uint16Array([5, 6]),
    edgeWalkCostSeconds: new Uint16Array([7, 8]),
  };

  const firstOut = new Float32Array(2);
  facade.precomputeEdgeCostsForGraph({
    ...edgeInputs,
    outCostSeconds: firstOut,
    allowedModeMask: 9,
  });
  const allocAfterFirstRun = allocCallCount;
  const deallocAfterFirstRun = deallocCallCount;
  assert.equal(allocAfterFirstRun, 5);
  assert.equal(deallocAfterFirstRun, 0);

  const secondOut = new Float32Array(2);
  facade.precomputeEdgeCostsForGraph({
    ...edgeInputs,
    outCostSeconds: secondOut,
    allowedModeMask: 9,
  });
  assert.equal(allocCallCount, allocAfterFirstRun + 1);
  assert.equal(deallocCallCount, deallocAfterFirstRun);
  assert.deepEqual(Array.from(secondOut), [9, 10]);

  facade.releaseCachedGraphBuffers();
  assert.equal(deallocCallCount, allocCallCount);
});

test('computeTravelTimeFieldForGraph reuses cached output buffer for repeated writes to same array', () => {
  const memory = { buffer: new ArrayBuffer(16384) };
  let nextPtr = 256;
  let allocCallCount = 0;
  const fakeExports = {
    memory,
    wasm_alloc(byteLength) {
      allocCallCount += 1;
      const ptr = (nextPtr + 7) & ~7;
      nextPtr = ptr;
      nextPtr += byteLength;
      return ptr;
    },
    wasm_dealloc() {},
    precompute_edge_costs() {},
    compute_travel_time_field(
      outDistSecondsPtr,
      _nodeFirstEdgeIndexPtr,
      _nodeEdgeCountPtr,
      nodeCount,
      _edgeTargetNodeIndexPtr,
      _edgeCostTicksPtr,
      _edgeCount,
      sourceNodeIndex,
    ) {
      const outView = new Float32Array(memory.buffer, outDistSecondsPtr, nodeCount);
      outView.fill(Number.POSITIVE_INFINITY);
      outView[sourceNodeIndex] = 0;
      return 1;
    },
  };
  const facade = createWasmRoutingKernelFacade(fakeExports);

  const outDistSeconds = new Float32Array(3);
  const graphInputs = {
    nodeFirstEdgeIndex: new Uint32Array([0, 1, 2]),
    nodeEdgeCount: new Uint16Array([1, 1, 0]),
    edgeTargetNodeIndex: new Uint32Array([1, 2]),
    edgeCostTicks: new Uint32Array([72_000, 72_000]),
    outDistSeconds,
  };

  facade.computeTravelTimeFieldForGraph({
    ...graphInputs,
    sourceNodeIndex: 0,
  });
  const allocAfterFirstRun = allocCallCount;
  facade.computeTravelTimeFieldForGraph({
    ...graphInputs,
    sourceNodeIndex: 1,
  });

  assert.equal(allocAfterFirstRun, 5);
  assert.equal(allocCallCount, allocAfterFirstRun);
});
