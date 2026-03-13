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

## Build command

```bash
./wasm/build-routing-kernel.sh
```

Expected output:
- `web/wasm/routing-kernel.wasm`

If `wasm32-unknown-unknown` stdlib is missing, the script fails fast with install guidance.

## Next integration milestones (not implemented yet)

1. Allocate typed-array views in WASM memory and benchmark JS-to-WASM transfer overhead.
2. Reduce JS↔WASM copy overhead with persistent kernel-side buffers for repeated runs.
3. Keep parity tests for kernel output stability across map updates and schema changes.
