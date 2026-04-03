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

## OSM data pipeline

```bash
./data_pipeline/fetch-data.sh
```

- Compatibility wrapper for `./data_pipeline/region-data.py fetch`.
- Region configuration lives in `data_pipeline/regions.json`.
- Default configured locations are: Berlin, Paris, London, Rome, and Luxembourg (country).
- Fetch writes raw Overpass JSON under `data_pipeline/input/`, for example:
  - `berlin-routing.osm.json`
  - `berlin-district-boundaries.osm.json`
  - `luxembourg-country-routing.osm.json`
- To avoid hitting every configured region, filter with `--only`, for example:

```bash
./data_pipeline/fetch-data.sh --only paris
```

- Build canvas basemaps, binary graphs, and `.bin.gz` artifacts from the fetched inputs with:

```bash
./data_pipeline/region-data.py build > web/src/data/locations.json
```

- Or fetch and build in one run with:

```bash
./data_pipeline/region-data.py all > web/src/data/locations.json
```

- `build` and `all` print the UI-ready location manifest JSON to stdout.
- Full end-to-end process for turning a fetched region into web-loadable assets is documented in `docs/region-data-pipeline.md`.

## Headless routing benchmark

```bash
npm run --silent bench:routing -- \
  --graph data_pipeline/output/graph-walk.bin \
  --samples 24 \
  --modes walk,bike,car,all \
  --output-json data_pipeline/output/routing-benchmark.json
```

- Uses deterministic random source-node sampling (`--seed`, default `1337`).
- Runs routing headlessly in Node to isolate CPU/search behavior from browser rendering.
- Requires the WASM routing kernel (`web/wasm/routing-kernel.wasm`) for routing/search and edge-cost precompute.
- Reports per-mode phase timings: `precompute`, `tick-pack`, `search`, `dist-output`, and `total`.

Stable/low-variance benchmark mode:

```bash
npm run --silent bench:routing -- \
  --graph data_pipeline/output/graph-walk.bin \
  --samples 24 \
  --modes walk,bike,car,all \
  --stable \
  --warmup-rounds 3 \
  --measurement-rounds 5 \
  --max-relative-mad 0.05 \
  --output-json data_pipeline/output/routing-benchmark-stable.json
```

- Reuses the exact same sampled source nodes for all rounds.
- Discards warmup rounds and evaluates measured-round stability with median absolute deviation (MAD).
- Emits a `Stability gate: PASS|FAIL` summary per run and in JSON output.
- Optional paired baseline comparison: `--baseline-json <stable-report.json>`.

## WASM runtime build

```bash
make wasm-build
```

- Builds and post-optimizes Rust routing-kernel crate to `web/wasm/routing-kernel.wasm` (`wasm-opt -O4 --all-features`).
- Requires `wasm-opt` (`binaryen`) on PATH; install with `brew install binaryen` on macOS.
- Browser runtime requires this WASM kernel for routing/search execution.
- Browsers without WASM support are shown: `Your browser does not support WASM, this app requires WASM for performance reasons`.
- Interface and milestones are documented in `docs/wasm-routing-kernel.md`.

## Runtime data
- Web runtime loads `data_pipeline/output/graph-walk.bin.gz` by default.
- Top-bar location selector is populated from `web/src/data/locations.json`, where each entry defines a stable location id plus the graph and boundary asset filenames to load.
- The graph payload is gzip-compressed and decompressed in-browser before parsing.
- Clicking the map computes a full travel-time field across all reachable graph nodes (no walk-time cap).
- Desktop controls:
  - Primary click selects a new origin.
  - Primary drag pans the map.
  - Mouse wheel zooms at the pointer.
  - Secondary drag moves the selection point.
- Zoom/pan redraw the current routing snapshot; camera movement does not start a new route solve.
- Last selected start node is persisted in URL query params as `node=<graphNodeId>` and restored on reload.
- Selected transport modes and colour-cycle duration are also persisted in the URL as `modes=` and `cycle=`.
- Theme, pointer-button inversion, transport modes, and colour cycle controls are in the header **Options** menu.
- Page scrolling is disabled while interacting with the map viewport so touch gestures stay attached to the map.
- Current binary schema details and compatibility policy: `docs/graph-binary-schema-v2.md`.

## SVG export
- Export uses vector isochrone edge lines plus the boundary canvas layer.
- Export background is set to the current map background colour (same palette context as the canvas view).

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
