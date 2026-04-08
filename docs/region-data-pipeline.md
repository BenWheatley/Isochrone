# Region Data Pipeline

This document describes the full pipeline for turning a place in OpenStreetMap into web-loadable assets for this app.

The pipeline now has one external source-of-truth config file and one Python entry point:
- config: `data_pipeline/regions.json`
- main command: `data_pipeline/region-data.py`

## What Exists Today

Implemented:
- External region configuration in `data_pipeline/regions.json`
- Raw Overpass download for routing and subdivision-boundary JSON via `data_pipeline/region-data.py fetch`
- Boundary simplification, graph export, and gzip packaging via `data_pipeline/region-data.py build`
- Combined fetch + build via `data_pipeline/region-data.py all`
- UI manifest emission on stdout in the format consumed by `web/src/data/locations.json`

Still manual:
- Choosing the correct projection (`epsg`) per region
- Copying or redirecting the generated manifest JSON into `web/src/data/locations.json`
- Publishing the new artifacts in `.github/workflows/pages.yml`

## Stage 1: Fetch Raw OSM JSON

Run:

```bash
./data_pipeline/region-data.py fetch
```

`region-data.py` prefers the repository `.venv/bin/python` when that virtualenv exists, so direct execution keeps using the project dependencies even if your shell is currently on another interpreter.

The location list is loaded from `data_pipeline/regions.json`.

Outputs go to `data_pipeline/input/` and are named:
- `<slug>-routing.osm.json`
- `<slug>-district-boundaries.osm.json`

Examples:
- `data_pipeline/input/paris-routing.osm.json`
- `data_pipeline/input/paris-district-boundaries.osm.json`

This stage only downloads raw Overpass API responses.

Query templates used by this stage:
- `docs/overpass_routing_query.sh`
- `docs/overpass_boundary_query.sh`

Boundary extracts are written in a download-friendly shape:
- relations with member refs
- ways with node refs
- nodes with coordinates

The build step reconstructs boundary polylines from those refs, so fetch does not depend on inline way geometry being present in the Overpass response.
The boundary query discovers subdivisions using both area containment and explicit `subarea` membership so it is more robust across regions whose administrative relations are modeled differently.

To avoid fetching every configured region, filter by id:

```bash
./data_pipeline/region-data.py fetch --only paris
```

## Stage 2-4: Build Renderable And Deployable Artifacts

One command now performs:
- boundary simplification
- routing graph export
- gzip packaging for web delivery

Run:

```bash
./data_pipeline/region-data.py build > web/src/data/locations.json
```

Notes:
- `build` reads raw inputs from `data_pipeline/input/`
- `build` writes generated artifacts to `data_pipeline/output/`
- `build` prints only the UI-ready locations manifest JSON to stdout
- progress logging goes to stderr
- `epsg`, `subdivisionAdminLevel`, output filenames, and relation selectors come from `data_pipeline/regions.json`
- Berlin still uses the legacy `graph-walk.bin` / `graph-walk.bin.gz` filenames because that is what the web runtime currently references by default

## Stage 5: Register The Region In The UI

The `build` and `all` commands already emit the correct manifest JSON for `web/src/data/locations.json`.

Example:

```bash
./data_pipeline/region-data.py build > web/src/data/locations.json
```

The top-bar location menu reads that file and loads the matching graph and boundary assets.

## Stage 6: Publish The New Assets

If the region should be available on GitHub Pages, update `.github/workflows/pages.yml` so it copies the new files into the site artifact.

Current workflow only publishes Berlin:
- `data_pipeline/output/berlin-district-boundaries-canvas.json`
- `data_pipeline/output/graph-walk.bin.gz`

For a new region such as Paris, add copies for:
- `data_pipeline/output/paris-district-boundaries-canvas.json`
- `data_pipeline/output/paris-graph.bin.gz`

## Paris Example

Assuming you only want Paris:

```bash
./data_pipeline/region-data.py fetch --only paris
./data_pipeline/region-data.py build --only paris > web/src/data/locations.json
```

This produces:
- `data_pipeline/input/paris-routing.osm.json`
- `data_pipeline/input/paris-district-boundaries.osm.json`
- `data_pipeline/output/paris-district-boundaries-canvas.json`
- `data_pipeline/output/paris-graph.bin`
- `data_pipeline/output/paris-graph.bin.gz`
- `data_pipeline/output/paris-graph-summary.json`

And `web/src/data/locations.json` receives:

```json
{
  "locations": [
    {
      "id": "paris",
      "name": "Paris",
      "graphFileName": "paris-graph.bin.gz",
      "boundaryFileName": "paris-district-boundaries-canvas.json"
    }
  ]
}
```

## Full Process Checklist

1. Edit `data_pipeline/regions.json` if the configured region list or per-region metadata should change
2. Fetch raw Overpass JSON with `./data_pipeline/region-data.py fetch`
3. Build canvas basemaps, binary graphs, gzip artifacts, and stdout manifest with `./data_pipeline/region-data.py build`
4. Redirect stdout to `web/src/data/locations.json` when the UI should load those regions
5. Update GitHub Pages workflow if the region should ship in the deployed site

That is the full process as the repository currently stands.
