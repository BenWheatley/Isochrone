# Isochrone

Berlin isochrone web application with a Python preprocessing pipeline and a browser-based renderer.

[Live App](https://benwheatley.github.io/Isochrone/)

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
./data_pipeline/region-data.py fetch
```

- For the current CLI options and examples, run `./data_pipeline/region-data.py --help` or `./data_pipeline/region-data.py <subcommand> --help`.
- The executable script prefers the repo's `.venv/bin/python` when that virtualenv exists, so `./data_pipeline/region-data.py ...` works after `make bootstrap` even if your interactive shell is using a different Python.
- Region configuration lives in `data_pipeline/regions.json`.
- Default configured locations are: Berlin, Paris, London, Rome, and Luxembourg (country).
- `subdivisionDiscoveryModes` in `data_pipeline/regions.json` controls how boundary subdivisions are discovered for each region. The default is `["area", "subarea"]`; regions such as London can use `["subarea"]` to avoid expensive area scans.
- Fetch writes raw Overpass JSON under `data_pipeline/input/`, for example:
  - `berlin-routing.osm.json`
  - `berlin-district-boundaries.osm.json`
  - `luxembourg-country-routing.osm.json`
- Each fetch prints the rendered Overpass QL plus request metadata before `curl` runs.
- If a fetch fails, the pipeline writes debug artifacts next to the intended output path:
  - `<output>.failed-query.ql`
  - `<output>.failed-curl-stderr.txt`
  - `<output>.failed-response-body.txt`
  - `<output>.failed-response-headers.txt`
  - `<output>.failed-curl-stdout.txt` when curl emitted stdout
- The query renderer templates live at:
  - `docs/overpass_routing_query.sh`
  - `docs/overpass_boundary_query.sh`
- Boundary extracts are intentionally download-friendly: relation members, way node refs, and node coordinates. The build step reconstructs polylines from those refs instead of relying on inline way geometry.
- To avoid hitting every configured region, filter with `--only`, for example:

```bash
./data_pipeline/region-data.py fetch --only paris
```

- Fetch routing ways only:

```bash
./data_pipeline/region-data.py fetch --only luxembourg-country --components ways
```

- Fetch subdivision boundaries only:

```bash
./data_pipeline/region-data.py fetch --only luxembourg-country --components boundaries
```

- Build canvas basemaps, binary graphs, and `.bin.gz` artifacts from the fetched inputs with:

```bash
./data_pipeline/region-data.py build > web/src/data/locations.json
```

- Build the routing graph only from an already-fetched routing extract:

```bash
./data_pipeline/region-data.py build --only luxembourg-country --components graph
```

- Build the boundary canvas JSON only from an already-fetched boundary extract:

```bash
./data_pipeline/region-data.py build --only luxembourg-country --components boundary
```

- Or fetch and build in one run with:

```bash
./data_pipeline/region-data.py all > web/src/data/locations.json
```

- `all` also supports partial runs via `--fetch-components` and `--build-components`.

- `build` and `all` print the UI-ready location manifest JSON to stdout.
- Full end-to-end process for turning a fetched region into web-loadable assets is documented in [Region Data Pipeline](docs/region-data-pipeline.md).

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
- Interface and milestones are documented in [WASM Routing Kernel](docs/wasm-routing-kernel.md).

## Runtime data
- Web runtime loads `data_pipeline/output/graph-walk.bin.gz` by default.
- Top-bar location selector is populated from `web/src/data/locations.json`, where each entry defines a stable location id, canonical display name, optional localized display-name overrides, plus the graph and boundary asset filenames to load.
- `data_pipeline/regions.json` is the source of truth for region display names and localized variants; `web/src/data/locations.json` is generated from it by `./data_pipeline/region-data.py build` or `./data_pipeline/region-data.py all` and should not be hand-maintained for naming changes.
- The graph payload is gzip-compressed and decompressed in-browser before parsing.
- Clicking the map computes a full travel-time field across all reachable graph nodes (no walk-time cap).
- Desktop controls:
  - Primary click selects a new origin.
  - Primary drag pans the map.
  - Mouse wheel zooms at the pointer.
  - Secondary drag moves the selection point.
- Zoom/pan redraw the current routing snapshot; camera movement does not start a new route solve.
- Selected region is persisted in URL query params as `region=<locationId>`.
- Last selected start node is persisted in URL query params as `node=<graphNodeId>` and restored on reload; switching region clears `node` while preserving the other URL params.
- Selected transport modes and colour-cycle duration are also persisted in the URL as `modes=` and `cycle=`.
- UI language can be forced from the URL as `lang=en`, `lang=de`, or `lang=fr`.
- Theme, pointer-button inversion, transport modes, and colour cycle controls are in the header **Options** menu.
- Page scrolling is disabled while interacting with the map viewport so touch gestures stay attached to the map.
- Current binary schema details and compatibility policy: [Graph Binary Schema v2](docs/graph-binary-schema-v2.md).

## SVG export
- Export uses vector isochrone edge lines and vector boundary geometry.
- Export uses the full region extent from the graph/boundary data, not the current zoomed viewport.
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
