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

test('instantiateRoutingKernelWasmFromBytes validates exports from byte instantiation path', async () => {
  const fakeInstance = {
    exports: {
      memory: {},
      wasm_alloc() {
        return 1;
      },
      wasm_dealloc() {},
      precompute_edge_costs() {},
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
