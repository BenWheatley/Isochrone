# AGENTS.md

Client-side walking/biking/driving isochrone map. Python data pipeline turns OSM
extracts into a compact binary graph + boundary JSON; a vanilla-JS ES-module
frontend (no bundler) loads and renders it. See [PLAN.md](PLAN.md) for the
project roadmap and [docs/](docs/) for architecture notes on the binary schema,
region pipeline, and WASM routing kernel.

## Canonical commands

- `make bootstrap` — create `.venv`, `pip install -e ".[dev]"`, `npm ci`
- `make check` — `make lint && make test`; this is what CI runs, run it before
  calling anything done
- `make lint` — ruff check/format --check + mypy (`data_pipeline/src`) + eslint
  (`web/src`, `web/tests`)
- `make test` — pytest (`data_pipeline/tests`) + `node --test web/tests`
- `make review` — prints git status/diff/whitespace-check output for a manual
  self-review pass; it's not a linter, actually read what it prints
- `make wasm-build` — builds the Rust routing kernel to `web/wasm/*.wasm`.
  Requires the `wasm32-unknown-unknown` Rust target and Binaryen (`wasm-opt`).
  Not part of `make check`; only the GitHub Pages deploy workflow runs it in
  CI. Rebuild manually after touching `wasm/routing-kernel/`
- `make precommit-install` — wires up `.pre-commit-config.yaml` (whitespace/EOF
  fixers, ruff, ruff-format on Python files only — it doesn't cover JS or run
  tests, `make check` is still required)

## Project layout

- `data_pipeline/` — Python pipeline (`src/isochrone_pipeline/`), CLI entrypoint
  `region-data.py`, tests in `tests/`
- `web/` — vanilla ES-module frontend, no build step; `web/src/app.js` is the
  entrypoint, `web/tests/` uses `node --test`
- `wasm/routing-kernel/` — Rust routing kernel compiled to WASM for the hot
  routing loop
- `docs/` — architecture notes; `.github/workflows/` — CI (`ci.yml`) and
  GitHub Pages deploy (`pages.yml`)

## Repo-specific things that aren't obvious from the code alone

- **Regions are config-driven, not per-location code.** `data_pipeline/regions.json`
  is the single source of truth for every supported location (relation
  selector, EPSG, admin levels, etc.). `web/src/data/locations.json` is the
  *generated* manifest the frontend reads — it's the stdout of
  `region-data.py build` (see its `--help` for the exact invocation), stripped
  to UI-relevant fields. Prefer regenerating it over hand-editing; if you do
  hand-edit it, keep the shape identical to what `build` would emit.
- **Coastal regions need an explicit flag.** A region whose water is mostly
  legal boundary lines through open water (bays, straits) rather than
  coastline should get `"coastal": true` (+ optional `"coastSource"`) in
  `regions.json`. This clips OSM water polygons to the region's own bbox and
  adds them as `water_features` so the basemap shows real coast instead of
  boundary lines running through open water. The source archive (~900 MB) is
  cached at `data_pipeline/.cache/water-polygons/` (gitignored) so it's
  downloaded once total, not once per build.
- **`data_pipeline/input/` and `data_pipeline/output/` are regenerable and
  mostly untracked.** They're rebuilt from Overpass/OSM data via
  `region-data.py fetch` / `build`; don't be surprised when they're missing
  locally, and don't hand-maintain their contents.
- **Tests must not touch the network**, and this is enforced, not just a
  convention: `data_pipeline/tests/conftest.py` and `web/tests/no-network.js`
  both install a guard that raises on any real socket/subprocess network call
  before the test suite runs (`data_pipeline/no_network_guard.py` is the
  Python implementation). Use local fixtures or monkeypatch the network
  boundary (see `test_water_polygons.py` for the pattern) instead of hitting
  Overpass or the water-polygon archive in tests.
- **The binary graph format is versioned** (`docs/graph-binary-schema-v2.md`).
  If you touch the schema, update both the Python writer/reader and the JS
  parser together, and bump the version if the layout changes.

## Non-negotiables

- Prefer standard library / existing project utilities over new dependencies.
- Remove dead code and stale TODOs in files you touch.
- Avoid broad refactors unless the task explicitly requires them.
- Keep changes deterministic; avoid hidden side effects.
- Cover new behavior with tests; don't regress existing behavior.
- Update `README.md` / `docs/` / `PLAN.md` when behavior, interfaces, or
  project status changes.
