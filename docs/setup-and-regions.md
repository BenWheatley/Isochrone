# Setup and Region Onboarding

This document covers local installation of the toolchain, the day-to-day
commands used during development, and the procedure for adding a further
region to the application. Readers seeking an overview of the project should
consult the [README](../README.md) instead.

## 1. Prerequisites

- Python 3.11 or later.
- Node.js 18 or later, used for the JavaScript test runner and linter. The
  browser application itself has no build step and no bundler.
- A Rust toolchain with the `wasm32-unknown-unknown` target, required only when
  rebuilding the routing kernel.
- `binaryen`, which supplies `wasm-opt`, likewise required only for kernel
  rebuilds. On macOS this may be installed with `brew install binaryen`.
- `curl`, used by the data pipeline to contact the Overpass API.

## 2. Installation

```bash
make bootstrap
make precommit-install
make check
```

`make bootstrap` provisions both the Python virtual environment and the Node
development dependencies. `make precommit-install` registers the pre-commit
hooks. `make check` runs the full quality gate and should pass before any
further work is undertaken.

To serve the application locally:

```bash
python -m http.server 8000
```

The application is then available at `http://localhost:8000/web/`.

## 3. Routine commands

```bash
make lint     # Python and JavaScript static analysis
make test     # Python, JavaScript and Rust test suites
make check    # lint and test combined; the gate used by CI
make review   # full diff review aid
```

## 4. Rebuilding the routing kernel

```bash
make wasm-build
```

This compiles the Rust crate under `wasm/routing-kernel/` and post-optimises
the result to `web/wasm/routing-kernel.wasm`. The browser runtime requires this
artifact; there is no JavaScript fallback for routing. A change to the kernel
source has no effect on the application until this command is run.

The kernel interface is described in
[WASM Routing Kernel](wasm-routing-kernel.md).

## 5. The data pipeline

Region configuration is held in `data_pipeline/regions.json`. Artifacts are
produced in two stages, fetch and build, each of which may be run for a single
region and for a subset of components.

```bash
./data_pipeline/region-data.py fetch --only paris
./data_pipeline/region-data.py build --only paris --components graph,boundary
```

For the authoritative list of options:

```bash
./data_pipeline/region-data.py --help
./data_pipeline/region-data.py <subcommand> --help
```

The executable prefers the repository's `.venv/bin/python` where that
virtual environment exists, so the script may be invoked directly after
`make bootstrap` irrespective of the interpreter active in the shell.

### 5.1 Fetch

Raw Overpass JSON is written beneath `data_pipeline/input/`, for example
`paris-routing.osm.json` and `paris-district-boundaries.osm.json`. Each fetch
prints the rendered Overpass QL and the request metadata before `curl` is
invoked.

Where a fetch fails — including the case in which Overpass returns HTTP 200
with an empty `elements` list, which is treated as a failure — diagnostic
artifacts are written alongside the intended output path:

- `<output>.failed-query.ql`
- `<output>.failed-response-body.txt`
- `<output>.failed-response-headers.txt`
- `<output>.failed-curl-stderr.txt`
- `<output>.failed-curl-stdout.txt`, where curl produced output

These files are the primary means of diagnosing a failed region, and should be
consulted before the query itself is suspected.

**Overpass is a shared, volunteer-operated service and imposes a limit of two
concurrent requests per address.** Scripts that contact it must pace themselves
and must distinguish a transient refusal from a genuine error; the reasoning
and the required behaviour are set out under "Talking to rate-limited public
APIs" in the [Agentic Coding Guidelines](agentic-coding-guidelines.md).
`data_pipeline/fetch-missing-regions.sh` is a worked example.

### 5.2 Build

```bash
./data_pipeline/region-data.py build > web/src/data/locations.json
```

The build produces the boundary canvas JSON, the binary graph, and the gzipped
graph, and prints the location manifest consumed by the application to standard
output. `build` and `all` both emit this manifest, which should not be
maintained by hand.

The query templates are `docs/overpass_routing_query.sh` and
`docs/overpass_boundary_query.sh`. The end-to-end procedure is described in
[Region Data Pipeline](region-data-pipeline.md).

## 6. Adding a region

1. **Identify the boundary relation.** Add an entry to
   `data_pipeline/regions.json` giving the region identifier, display name,
   artifact filenames, a `locationRelation` selector, a
   `subdivisionAdminLevel`, and the appropriate projected EPSG code.

   The selector must be verified against the data rather than assumed. Two
   pitfalls have each cost a rebuild in practice:

   - **Tag filters that match nothing.** Athens was configured as
     `rel(1370736)["name"="Athens"]["wikidata"="Q1524"]`, whereas the relation
     carries `name="Δήμος Αθηναίων"` and `wikidata=Q1224979`. The query was
     valid and returned no elements at all.
   - **Distinct relations sharing a name.** Mexico City has both a federal
     entity, `rel(1376330)` at admin level 4, and an unrelated admin level 8
     relation of the same name covering rather less ground.

   A single Overpass query confirms both the identity and the extent of a
   candidate relation, and is materially cheaper than a rebuild.

2. **Consider the extent.** The routing extract follows the relation. A region
   scoped to a city council when the surrounding conurbation was intended will
   produce a technically correct but useless map; Adelaide was initially
   configured as its central council area of some 4 × 5 km, in preference to
   the metropolitan area of 38 × 86 km.

3. **Set `coastal` where applicable.** A coastal region without this flag
   renders its sea as land.

4. **Fetch and build.**

   ```bash
   ./data_pipeline/region-data.py fetch --only <id>
   ./data_pipeline/region-data.py build --only <id> --components graph,boundary
   ```

5. **Regenerate the manifest** so the region appears in the picker, and
   confirm that the deployment workflow ships its artifacts.

### 6.1 Adding public transport

A region may additionally carry a GTFS feed. The procedure, the configuration
schema, the licensing obligations, and a survey of candidate feeds for the
configured regions are given in the
[Transit Feed Registry](transit_feed_registry.md).

In summary, a `transitFeed` block requires `baseUrl`, an `archiveFormat` of
either `zip` or `files`, a free-text `licence` note recording provenance, and
an `attribution` block naming the operator, the licence, and a source URL. The
attribution is not optional in practice: a pipeline test fails where a
configured feed lacks one, because publishing data licensed on condition of
attribution without that attribution is a breach of its licence.

## 7. Benchmarking

```bash
npm run --silent bench:routing -- \
  --graph data_pipeline/output/graph-walk.bin \
  --samples 24 \
  --modes walk,bike,car,all \
  --output-json data_pipeline/output/routing-benchmark.json
```

Routing is executed headlessly under Node, isolating search behaviour from
browser rendering. Source nodes are sampled deterministically via `--seed`,
which defaults to `1337`. Per-mode timings are reported for the `precompute`,
`tick-pack`, `search` and `dist-output` phases.

For comparisons between revisions, the stable mode reuses one sample set across
rounds, discards warmup rounds, and gates on the median absolute deviation of
the measured rounds:

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

A `Stability gate: PASS|FAIL` summary is emitted per run and recorded in the
JSON output. A prior report may be supplied via `--baseline-json` for a paired
comparison.

## 8. Deployment

Publication to GitHub Pages is performed by `.github/workflows/pages.yml`, on
push to `main` or by manual dispatch. The published artifact comprises the
application source, the localisation bundles, the self-hosted icon font and its
licence text, the routing kernel, and the graph and boundary artifacts for
every region listed in the manifest.

The Pages source must be set to **GitHub Actions** in the repository settings.
