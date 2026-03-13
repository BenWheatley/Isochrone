# Isochrone

Berlin isochrone web application with a Python preprocessing pipeline and a browser-based renderer.

## Quick start

```bash
make bootstrap
make precommit-install
make check
python -m http.server 8000
```

## Daily commands

```bash
make lint
make test
make review
```

## Headless routing benchmark

```bash
npm run --silent bench:routing -- \
  --graph data_pipeline/output/graph-walk.bin \
  --samples 24 \
  --modes walk,bike,car,all \
  --edge-kernel auto \
  --heap-strategies decrease-key,duplicate-push \
  --output-json data_pipeline/output/routing-benchmark.json
```

- Uses deterministic random source-node sampling (`--seed`, default `1337`).
- Runs routing headlessly in Node to isolate CPU/search behavior from browser rendering.
- Supports JS/WASM edge-cost precompute engines (`--edge-kernel js|wasm|auto`).
- Reports per-mode/per-heap wall-time and CPU-time summaries.

## WASM groundwork

```bash
make wasm-build
```

- Builds Rust routing-kernel crate to `web/wasm/routing-kernel.wasm`.
- Current runtime remains JS-only; this is setup for A/B benchmarking and staged migration.
- Interface and milestones are documented in `docs/wasm-routing-kernel.md`.

## Runtime data
- Web runtime loads `data_pipeline/output/graph-walk.bin.gz` by default.
- The graph payload is gzip-compressed and decompressed in-browser before parsing.
- Clicking the map computes a full travel-time field across all reachable graph nodes (no walk-time cap).
- Last selected start node is persisted in URL query params as `node=<graphNodeId>` and restored on reload.
- Current binary schema details and compatibility policy: `docs/graph-binary-schema-v2.md`.

## Deployment (GitHub Pages)
- Workflow: `.github/workflows/pages.yml`
- Trigger: push to `main` or manual dispatch (`workflow_dispatch`)
- Published artifact includes:
  - `web/index.html`
  - `web/src/*`
  - `data_pipeline/output/berlin-district-boundaries-canvas.json`
  - `data_pipeline/output/graph-walk.bin.gz`
- In repository settings, set Pages source to **GitHub Actions**.

## Repository structure
- `data_pipeline/`: Graph preprocessing and binary export logic
- `web/`: Browser app source (vanilla JS modules, no bundler)
- `docs/`: Design and process documentation
- `PLAN.md`: Delivery plan and architecture roadmap

## Agentic coding baseline
This repo is configured for autonomous-agent workflows with:
- single-command quality gates (`make check`)
- JS static analysis (`ESLint`) and runtime tests (`node --test`) included in `make check`
- explicit agent rules in `AGENTS.md`
- CI for Python + JS quality gates
- pre-commit hooks for fast local feedback
