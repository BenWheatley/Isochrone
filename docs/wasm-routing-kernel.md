# WASM Routing Kernel

This document tracks the current WASM kernel used for performance-critical routing code.

## Scope of this setup

- Introduce a dedicated Rust crate for routing hot-path kernels:
  - `wasm/routing-kernel/Cargo.toml`
  - `wasm/routing-kernel/src/lib.rs`
- Expose kernel exports:
  - `precompute_edge_costs(...)` for per-mode edge traversal cost cache
  - `compute_travel_time_field(...)` for full-field travel-time search
- Provide a repeatable build script:
  - `wasm/build-routing-kernel.sh`
- Provide JS-side module loading and export validation:
  - `web/src/wasm/routing-kernel.js`

Runtime now requires this kernel for routing/search execution and edge-cost precompute. If WASM is unavailable, the app stops with:

`Your browser does not support WASM, this app requires WASM for performance reasons`

## Why this shape

- The current profiling shows route expansion dominates runtime.
- A clean ABI boundary is required before moving compute kernels into WASM.
- Edge-cost precomputation is a safe first kernel because it is deterministic and array-oriented.

## Implemented optimization

- Static graph metadata arrays are now cached in WASM memory and reused across repeated route runs.
- This removes repeated JS→WASM copies of node/edge structure arrays for each new source-node solve.
- Per-run output buffers are still copied back to JS (`outDistSeconds` / `outCostSeconds`), while static graph buffers stay resident until facade disposal.
- `compute_travel_time_field(...)` now consumes precomputed per-edge traversal ticks (`edgeCostTicks`) directly, so route runs no longer recompute edge mode/speed costs inside the Rust search loop.
- Tick arrays are built once per mode mask in JS and cached on the loaded graph object for reuse across repeated runs.
- WASM search workspace buffers (`dist_ticks`, `settled`, radix-heap buckets) are now reused across runs via thread-local workspace storage, reducing repeated allocation/initialization churn per solve.
- JS-side WASM output buffers are now cached per output typed-array identity, so repeated route runs stop allocating/deallocating output scratch pointers each solve.
- App-side route output arrays now use a two-buffer rotating scratch strategy, avoiding per-run distance-array allocation while preserving snapshot stability between consecutive runs.
- Kernel facade now supports shared-output result views (`outDistSecondsView`) so the app can consume solve output directly from WASM memory and skip per-run JS copy-back for route distances.

## Build command

```bash
./wasm/build-routing-kernel.sh
```

Expected output:
- `web/wasm/routing-kernel.wasm`

If `wasm32-unknown-unknown` stdlib is missing, the script fails fast with install guidance.

## Next integration milestones

1. Allocate typed-array views in WASM memory and benchmark copy-vs-shared-view tradeoffs for output arrays.
2. Keep parity tests for kernel output stability across map updates and schema changes.
